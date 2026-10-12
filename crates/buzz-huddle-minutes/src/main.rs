//! `buzz-huddle-minutes` — run the minutes worker on a local recording
//! folder, build fake meetings, and check scripts against answer sheets.
//!
//! Output on stderr is counts only: no speech text, no pubkeys, no secrets.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context;

use buzz_gcp::gcs::Gcs;
use buzz_gcp::token::{TokenSource, Tokens, STATIC_TOKEN_ENV};
use buzz_huddle_minutes::audio::read_wav_mono_i16;
use buzz_huddle_minutes::check::{cer, check, check_mix, Tolerance};
use buzz_huddle_minutes::chirp::ChirpStt;
use buzz_huddle_minutes::collect::{find_channels, plan_meetings, CollectError};
use buzz_huddle_minutes::followup::{
    FollowUps, FollowedUp, NotionStep, Step as FollowStep, SummaryStep,
};
use buzz_huddle_minutes::gcs_minutes::GcsMinutes;
use buzz_huddle_minutes::ledger::LEDGER_KEY_FORMAT;
use buzz_huddle_minutes::models::{
    ensure_silero_vad, sha256_hex, silero_vad_path, SILERO_VAD_SHA256,
};
use buzz_huddle_minutes::pipeline::{MinutesSettings, SttPolicy};
use buzz_huddle_minutes::runner::{
    create_private_dir, run_meeting_with, write_private, Done, LocalMinutes, MeetingError,
    MinutesHome, RunOptions,
};
use buzz_huddle_minutes::sim::{
    build_fake_meeting, load_bench_clips, mark_speech, write_fake_meeting, Truth, SENTENCES,
};
use buzz_huddle_minutes::store::{
    GcsStore, LocalStore, ObjectInfo, PutNew, RecordingStore, StoreError,
};
use buzz_huddle_minutes::stt::{
    Fault, SpeechToText, SttError, SttErrorKind, SttOutput, SttRequest, TruthStt,
};
use buzz_huddle_minutes::transcript::{SttInfo, Transcript};
use buzz_huddle_minutes::vad::{SegmentPlan, SileroSettings, SileroVad};
use buzz_huddle_minutes::{notion, summary};
use clap::{Parser, Subcommand};
use uuid::Uuid;

#[derive(Parser)]
#[command(about = "Huddle minutes worker (local recordings)")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
// Parsed once at start; the size of the biggest variant does not matter.
#[allow(clippy::large_enum_variant)]
enum Command {
    /// Download the Silero VAD model into the cache and check its sha256.
    FetchModels {
        /// Cache folder (default: this crate's .cache).
        #[arg(long)]
        cache: Option<PathBuf>,
    },
    /// Build a fake meeting recording with an answer sheet.
    FakeMeeting {
        /// scripts/huddle-stt-bench manifest with at least 19 clips.
        #[arg(long)]
        clips: Option<PathBuf>,
        /// Output folder (recordings/, speakers/, truth.json).
        #[arg(long)]
        out: PathBuf,
        /// Random seed for jitter, losses and pauses.
        #[arg(long, default_value_t = 1)]
        seed: u64,
        /// Storage prefix inside recordings/.
        #[arg(long, default_value = "huddles")]
        prefix: String,
        /// Cache folder holding models/silero_vad.onnx.
        #[arg(long)]
        cache: Option<PathBuf>,
        /// Meeting start, UTC ms (default: now, so the meeting is fresh).
        #[arg(long)]
        start_ms: Option<u64>,
    },
    /// Make the script and mixed audio of each finished meeting of one huddle
    /// channel, or of every channel (`--all`). Settings can also come from
    /// `BUZZ_MINUTES_*` environment variables (Cloud Run).
    Process {
        /// Folder laid out like the recording bucket.
        #[arg(
            long,
            env = "BUZZ_MINUTES_RECORDINGS_DIR",
            required_unless_present = "recordings_bucket"
        )]
        recordings: Option<PathBuf>,
        /// The recording bucket on Cloud Storage, instead of a folder.
        #[arg(
            long,
            env = "BUZZ_MINUTES_RECORDINGS_BUCKET",
            conflicts_with = "recordings"
        )]
        recordings_bucket: Option<String>,
        /// Storage prefix.
        #[arg(long, env = "BUZZ_MINUTES_PREFIX", default_value = "huddles")]
        prefix: String,
        /// Every community and channel found under the prefix.
        #[arg(long, env = "BUZZ_MINUTES_ALL", conflicts_with_all = ["community", "channel"])]
        all: bool,
        /// Community id.
        #[arg(long, env = "BUZZ_MINUTES_COMMUNITY", required_unless_present = "all")]
        community: Option<Uuid>,
        /// Huddle channel id.
        #[arg(long, env = "BUZZ_MINUTES_CHANNEL", required_unless_present = "all")]
        channel: Option<Uuid>,
        /// Folder for scripts, ledgers and locks (never the recording
        /// bucket).
        #[arg(
            long,
            env = "BUZZ_MINUTES_OUT_DIR",
            required_unless_present = "minutes_bucket"
        )]
        out: Option<PathBuf>,
        /// The minutes bucket (e.g. a2d2-huddle-minutes) for scripts,
        /// ledgers and holds, instead of a folder.
        #[arg(long, env = "BUZZ_MINUTES_BUCKET", conflicts_with = "out")]
        minutes_bucket: Option<String>,
        /// Answer sheet for the fake transcriber.
        #[arg(long, required_unless_present = "chirp_project")]
        stt_truth: Option<PathBuf>,
        /// Transcribe with Chirp 3 in this Google Cloud project instead.
        #[arg(long, env = "BUZZ_MINUTES_CHIRP_PROJECT", conflicts_with = "stt_truth")]
        chirp_project: Option<String>,
        /// Where Google access tokens come from.
        #[arg(long, env = "BUZZ_MINUTES_GCP_AUTH", value_enum, default_value_t = GcpAuth::Metadata)]
        gcp_auth: GcpAuth,
        /// The Silero VAD model file (default: models/silero_vad.onnx in
        /// the cache). Its sha256 is checked before anything else.
        #[arg(long, env = "BUZZ_MINUTES_VAD_MODEL")]
        vad_model: Option<PathBuf>,
        /// Start no new meeting after this many minutes; the rest waits for
        /// the next run. Keep it well under the 2-hour hold.
        #[arg(long, env = "BUZZ_MINUTES_TIME_LIMIT_MINUTES", default_value_t = 50)]
        time_limit_minutes: u64,
        /// After the script, summarize it with Gemini (costs money).
        #[arg(long, env = "BUZZ_MINUTES_SUMMARY", value_enum, default_value_t = Switch::Off)]
        summary: Switch,
        /// Gemini model for the summary.
        #[arg(long, env = "BUZZ_MINUTES_SUMMARY_MODEL", default_value = summary::DEFAULT_MODEL)]
        summary_model: String,
        /// After the summary, write the Notion page (token: NOTION_TOKEN).
        #[arg(long, env = "BUZZ_MINUTES_NOTION", value_enum, default_value_t = Switch::Off)]
        notion: Switch,
        /// Make every N-th piece fail transcription (fake transcriber).
        #[arg(long)]
        stt_fail_every: Option<usize>,
        /// Kind of the injected failure.
        #[arg(long, value_enum, default_value_t = FailKind::Rejected)]
        stt_fail_kind: FailKind,
        /// How many attempts of a failing piece fail.
        #[arg(long, default_value_t = u32::MAX)]
        stt_fail_attempts: u32,
        /// Cache folder holding models/silero_vad.onnx.
        #[arg(long, env = "BUZZ_MINUTES_CACHE")]
        cache: Option<PathBuf>,
        /// A meeting is over after this many minutes with nothing written.
        #[arg(long, env = "BUZZ_MINUTES_QUIET_MINUTES", default_value_t = 10)]
        quiet_minutes: u64,
        /// Sessions further apart than this many minutes are separate
        /// meetings.
        #[arg(long, env = "BUZZ_MINUTES_MEETING_GAP_MINUTES", default_value_t = 10)]
        meeting_gap_minutes: u64,
        /// Replace existing scripts.
        #[arg(long)]
        overwrite: bool,
        /// Take this as the current time, UTC ms (default: the clock). Every
        /// age and quiet-time decision uses it.
        #[arg(long)]
        now_ms: Option<u64>,
        /// Longest piece sent to the transcriber, ms.
        #[arg(long, default_value_t = SegmentPlan::default().max_segment_ms)]
        max_segment_ms: u64,
        /// Padding on each side of the audio sent to the transcriber, ms.
        /// The script keeps the unpadded speech times.
        #[arg(long, default_value_t = SegmentPlan::default().pad_ms)]
        pad_ms: u64,
    },
    /// Compare a script with an answer sheet; exit 1 if it does not pass.
    Check {
        /// transcript.json.
        #[arg(long)]
        transcript: PathBuf,
        /// truth.json.
        #[arg(long)]
        truth: PathBuf,
        /// A piece may start this much before its sentence, ms.
        #[arg(long, default_value_t = Tolerance::default().start_early_ms)]
        start_early_ms: i64,
        /// A piece may start this much after its sentence, ms.
        #[arg(long, default_value_t = Tolerance::default().start_late_ms)]
        start_late_ms: i64,
        /// A piece may end this much before its sentence, ms.
        #[arg(long, default_value_t = Tolerance::default().end_early_ms)]
        end_early_ms: i64,
        /// A piece may end this much after its sentence, ms.
        #[arg(long, default_value_t = Tolerance::default().end_late_ms)]
        end_late_ms: i64,
        /// The mixed audio WAV, to check where it puts each sentence
        /// (needs the speakers/ WAVs next to truth.json).
        #[arg(long)]
        mix: Option<PathBuf>,
    },
    /// 스크립트를 Gemini 로 요약해 `huddle-summary/1` JSON(0600)으로 쓴다.
    Summarize {
        /// transcript.json.
        #[arg(long)]
        transcript: PathBuf,
        /// 요약을 쓸 곳.
        #[arg(long)]
        out: PathBuf,
        /// 모델 이름.
        #[arg(long, default_value = summary::DEFAULT_MODEL)]
        model: String,
        /// GCP 프로젝트.
        #[arg(long, default_value = summary::DEFAULT_PROJECT)]
        project: String,
        /// Vertex AI 위치.
        #[arg(long, default_value = summary::DEFAULT_LOCATION)]
        location: String,
        /// Google 접근 토큰을 어디서 받나(Cloud Run 은 metadata, 개발 맥은 gcloud).
        #[arg(long, value_enum, default_value_t = GcpAuth::Metadata)]
        gcp_auth: GcpAuth,
        /// 생각 수준. 안 주면 medium.
        #[arg(long, value_enum, default_value_t = ThinkingArg::Medium)]
        thinking_level: ThinkingArg,
        /// 답(생각 포함) 토큰 상한.
        #[arg(long, default_value_t = summary::DEFAULT_MAX_OUTPUT_TOKENS)]
        max_output_tokens: u32,
        /// 입력 단가(100만 토큰당 달러). 출력 단가와 같이 주면 아는 단가 대신 쓴다.
        #[arg(long, requires = "output_usd_per_mtok")]
        input_usd_per_mtok: Option<f64>,
        /// 출력 단가(100만 토큰당 달러, 생각 토큰 포함).
        #[arg(long, requires = "input_usd_per_mtok")]
        output_usd_per_mtok: Option<f64>,
    },
    /// 스크립트와 요약을 노션 "허들 회의록" DB 에 쓴다(세션이 겹치는 페이지를 찾아
    /// 고치거나 만든다). 손으로 시험할 때 쓰는 명령이라 회의 잠금은 잡지 않는다
    /// (작업기 안에서는 `notion::publish_held`). 노션 토큰은 환경 변수
    /// NOTION_TOKEN 으로 받는다(Cloud Run 은 Secret Manager 를 이 변수로 붙인다).
    PublishNotion {
        /// transcript.json.
        #[arg(long)]
        transcript: PathBuf,
        /// summarize 가 쓴 요약.
        #[arg(long)]
        summary: PathBuf,
        /// 노션 기록 파일(page id). 있으면 그 id 부터 쓰고, 쓴 뒤 남긴다.
        #[arg(long)]
        record: Option<PathBuf>,
        /// 제목 앞에 붙일 말(예: "[시험] ").
        #[arg(long, default_value = "")]
        title_prefix: String,
        /// 다 쓴 뒤 "처리 상태".
        #[arg(long, value_enum, default_value_t = StatusArg::Done)]
        status: StatusArg,
        /// "종류". 안 주면 비워 둔다.
        #[arg(long, value_enum)]
        kind: Option<KindArg>,
        /// "채널" 칸에 쓸 이름(기본: channel id).
        #[arg(long)]
        channel_name: Option<String>,
        /// 스크립트 시각에 거는 재생 링크 모양({channel_id}, {start_ms}).
        #[arg(long, default_value = notion::DEFAULT_PLAYBACK_LINK)]
        playback_link: String,
    },
    /// 오래 "처리 중"으로 남은 노션 회의 페이지를 찾는다(있으면 1 로 끝남).
    /// 노션 토큰은 환경 변수 NOTION_TOKEN 으로 받는다.
    NotionStale {
        /// 이만큼(분) 넘게 안 고친 "처리 중" 페이지.
        #[arg(long, default_value_t = 60)]
        older_than_minutes: u64,
    },
}

/// `--thinking-level` 값.
#[derive(Clone, Copy, clap::ValueEnum)]
enum ThinkingArg {
    Low,
    Medium,
    High,
}

impl ThinkingArg {
    fn as_str(self) -> &'static str {
        match self {
            Self::Low => "LOW",
            Self::Medium => "MEDIUM",
            Self::High => "HIGH",
        }
    }
}

/// `--status` 값.
#[derive(Clone, Copy, clap::ValueEnum)]
enum StatusArg {
    InProgress,
    Done,
    Failed,
}

/// `--kind` 값.
#[derive(Clone, Copy, clap::ValueEnum)]
enum KindArg {
    Channel,
    Dm,
}

/// 환경 변수에서 토큰을 읽는다. 값은 어디에도 찍지 않는다.
fn token_from_env(name: &str) -> anyhow::Result<String> {
    match std::env::var(name) {
        Ok(token) if !token.trim().is_empty() => Ok(token.trim().to_string()),
        _ => anyhow::bail!("set {name} (the value is never printed)"),
    }
}

/// `--gcp-auth` values.
#[derive(Clone, Copy, clap::ValueEnum)]
enum GcpAuth {
    /// The metadata server (GCE, GKE, Cloud Run).
    Metadata,
    /// `gcloud auth print-access-token` (a developer machine).
    Gcloud,
    /// The BUZZ_GCP_ACCESS_TOKEN environment variable (tests).
    Env,
}

/// `--stt-fail-kind` values.
#[derive(Clone, Copy, clap::ValueEnum)]
enum FailKind {
    Auth,
    Quota,
    RateLimited,
    Rejected,
    Transient,
}

impl From<FailKind> for SttErrorKind {
    fn from(kind: FailKind) -> Self {
        match kind {
            FailKind::Auth => Self::Auth,
            FailKind::Quota => Self::Quota,
            FailKind::RateLimited => Self::RateLimited,
            FailKind::Rejected => Self::Rejected,
            FailKind::Transient => Self::Transient,
        }
    }
}

/// The VAD model's sha256, when it is the exact model the ledger keys
/// assume; a changed or broken file is refused instead of silently
/// re-cutting (and paying for) every piece.
fn verified_model(model: &Path) -> anyhow::Result<String> {
    let bytes = std::fs::read(model).with_context(|| format!("read {}", model.display()))?;
    let digest = sha256_hex(&bytes);
    if digest != SILERO_VAD_SHA256 {
        anyhow::bail!(
            "{} has sha256 {digest}, expected {SILERO_VAD_SHA256}; run `buzz-huddle-minutes fetch-models`",
            model.display()
        );
    }
    Ok(digest)
}

/// Settings version for ledger keys: the key format, how pieces are cut,
/// the exact VAD model and the transcriber (engine, region, language). The model's sha256 is checked here too, so a
/// changed or broken model file is refused instead of silently re-cutting.
fn ledger_version(plan: &SegmentPlan, model_digest: &str, stt: &SttInfo) -> String {
    let vad = SileroSettings::default();
    format!(
        "{LEDGER_KEY_FORMAT};max={};pad={};vad={},{},{},{},{};model={model_digest};stt={},{},{}",
        plan.max_segment_ms,
        plan.pad_ms,
        vad.threshold,
        vad.min_silence_s,
        vad.cut_silence_s,
        vad.min_speech_s,
        vad.max_speech_s,
        stt.engine,
        stt.region,
        stt.language
    )
}

fn default_cache() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(".cache")
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> anyhow::Result<ExitCode> {
    match cli.command {
        Command::FetchModels { cache } => {
            let path = ensure_silero_vad(&cache.unwrap_or_else(default_cache)).await?;
            eprintln!("silero vad: {}", path.display());
        }
        Command::FakeMeeting {
            clips,
            out,
            seed,
            prefix,
            cache,
            start_ms,
        } => {
            let clips = clips.unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../scripts/huddle-stt-bench/.cache/fleurs-ko-test/manifest.jsonl")
            });
            let mut clips = load_bench_clips(&clips, SENTENCES)?;
            let model = silero_vad_path(&cache.unwrap_or_else(default_cache));
            let mut detector = SileroVad::new(&model, SileroSettings::default())
                .context("run `buzz-huddle-minutes fetch-models` first")?;
            mark_speech(&mut clips, &mut detector)?;
            let start = start_ms.unwrap_or_else(now_unix_ms);
            let meeting = build_fake_meeting(&clips, seed, &prefix, start)?;
            write_fake_meeting(&out, &meeting)?;
            let truth = &meeting.truth;
            eprintln!(
                "fake meeting: {} ms, {} sentences, {} sessions, {} files",
                truth.duration_ms,
                truth.utterances.len(),
                truth.sessions.len(),
                meeting.files.len()
            );
            println!(
                "--recordings {} --prefix {} --community {} --channel {} --stt-truth {}",
                out.join("recordings").display(),
                truth.prefix,
                truth.community_id,
                truth.channel_id,
                out.join("truth.json").display()
            );
        }
        Command::Process {
            recordings,
            recordings_bucket,
            prefix,
            all,
            community,
            channel,
            out,
            minutes_bucket,
            stt_truth,
            chirp_project,
            gcp_auth,
            vad_model,
            time_limit_minutes,
            summary: summary_switch,
            summary_model,
            notion: notion_switch,
            stt_fail_every,
            stt_fail_kind,
            stt_fail_attempts,
            cache,
            quiet_minutes,
            meeting_gap_minutes,
            overwrite,
            now_ms,
            max_segment_ms,
            pad_ms,
        } => {
            // Before anything else: the exact model the ledger keys assume.
            let model =
                vad_model.unwrap_or_else(|| silero_vad_path(&cache.unwrap_or_else(default_cache)));
            let model_digest = verified_model(&model)?;
            let token_source = || gcp_token_source(gcp_auth);
            let gcs = if recordings_bucket.is_some() || minutes_bucket.is_some() {
                Some(Arc::new(Gcs::new(Tokens::new(token_source()?)?)?))
            } else {
                None
            };
            let (store, audio_home) = match (&recordings, &recordings_bucket, &gcs) {
                (Some(dir), _, _) => (
                    AnyStore::Local(LocalStore::new(dir)),
                    format!("{}/", dir.display()),
                ),
                (None, Some(bucket), Some(gcs)) => (
                    AnyStore::Gcs(GcsStore::new(gcs.clone(), bucket.clone())),
                    format!("gs://{bucket}/"),
                ),
                _ => anyhow::bail!("give --recordings or --recordings-bucket"),
            };
            let quiet_ms = quiet_minutes * 60_000;
            let gap_ms = meeting_gap_minutes * 60_000;
            let deadline = Instant::now() + Duration::from_secs(time_limit_minutes * 60);
            let now = now_ms.unwrap_or_else(now_unix_ms);
            let mut detector = SileroVad::new(&model, SileroSettings::default())
                .context("run `buzz-huddle-minutes fetch-models` first")?;
            let stt = match (stt_truth, chirp_project) {
                (Some(stt_truth), _) => {
                    let truth: Truth = serde_json::from_slice(
                        &std::fs::read(&stt_truth)
                            .with_context(|| format!("read {}", stt_truth.display()))?,
                    )?;
                    let mut stt = TruthStt::new(&truth);
                    if let Some(every) = stt_fail_every {
                        stt = stt.with_fault(Fault {
                            kind: stt_fail_kind.into(),
                            every,
                            failing_attempts: stt_fail_attempts,
                            last_piece: usize::MAX,
                        });
                    }
                    AnyStt::Truth(stt)
                }
                (None, Some(project)) => {
                    // A developer's gcloud login has no project of its own:
                    // bill this one.
                    let quota = matches!(gcp_auth, GcpAuth::Gcloud).then(|| project.clone());
                    AnyStt::Chirp(
                        ChirpStt::new(Tokens::new(token_source()?)?, &project, quota)
                            .map_err(anyhow::Error::msg)?,
                    )
                }
                (None, None) => anyhow::bail!("give --stt-truth or --chirp-project"),
            };
            let plan = SegmentPlan {
                max_segment_ms,
                pad_ms,
            };
            let settings = MinutesSettings {
                segment_plan: plan,
                stt: SttPolicy::default(),
                ledger_version: ledger_version(&plan, &model_digest, &stt.info()),
                audio_key: String::new(),
                now_unix_ms: now,
            };
            let options = RunOptions {
                prefix: prefix.clone(),
                now_unix_ms: now,
                quiet_ms,
                overwrite,
            };
            let channels = match (all, community, channel) {
                (true, _, _) => find_channels(&store, &prefix).await?,
                (false, Some(community), Some(channel)) => vec![(community, channel)],
                _ => anyhow::bail!("give --all, or --community and --channel"),
            };
            eprintln!("channels: {}", channels.len());
            let run = Run {
                store: &store,
                channels: &channels,
                gap_ms,
                stt: &stt,
                settings: &settings,
                options: &options,
                audio_home: &audio_home,
                deadline,
            };
            // After the script: summary and Notion page, each only when on.
            let follow_http = reqwest::Client::builder()
                .timeout(notion::NOTION_TIMEOUT.max(Duration::from_secs(300)))
                .build()?;
            let summary_tokens = match summary_switch {
                Switch::On => Some(Tokens::new(token_source()?)?),
                Switch::Off => None,
            };
            let gemini_settings = summary::GeminiSettings::new(&summary_model);
            let notion_token = match notion_switch {
                Switch::On => Some(token_from_env("NOTION_TOKEN")?),
                Switch::Off => None,
            };
            let notion_settings = notion::NotionSettings::default();
            let names = summary::PubkeyPrefixNames;
            let mut follow = FollowUps {
                summary: summary_tokens.as_ref().map(|tokens| SummaryStep {
                    http: &follow_http,
                    settings: &gemini_settings,
                    tokens,
                }),
                notion: match &notion_token {
                    Some(token) => Some(NotionStep {
                        client: notion::NotionClient::new(&follow_http, &notion_settings, token)?,
                        title_prefix: String::new(),
                        channel_label: None,
                        kind: None,
                    }),
                    None => None,
                },
                names: &names,
            };
            let follow =
                (follow.summary.is_some() || follow.notion.is_some()).then_some(&mut follow);
            let code = match (out, minutes_bucket, &gcs) {
                (Some(out), _, _) => {
                    let home = LocalMinutes::open(&out)?;
                    process_channels(&home, &run, &mut detector, follow).await
                }
                (None, Some(bucket), Some(gcs)) => {
                    let home = GcsMinutes::new(gcs.clone(), bucket);
                    process_channels(&home, &run, &mut detector, follow).await
                }
                _ => anyhow::bail!("give --out or --minutes-bucket"),
            };
            return Ok(code);
        }
        Command::Check {
            transcript,
            truth,
            start_early_ms,
            start_late_ms,
            end_early_ms,
            end_late_ms,
            mix,
        } => {
            let transcript: Transcript = serde_json::from_slice(&std::fs::read(&transcript)?)?;
            let truth_dir = truth.parent().map(Path::to_path_buf).unwrap_or_default();
            let truth: Truth = serde_json::from_slice(&std::fs::read(&truth)?)?;
            let tolerance = Tolerance {
                start_early_ms,
                start_late_ms,
                end_early_ms,
                end_late_ms,
            };
            let report = check(&transcript, &truth, tolerance);
            println!("{}", serde_json::to_string_pretty(&report)?);
            // Reported, not judged: real transcribers make mistakes.
            println!(
                "{}",
                serde_json::to_string_pretty(&cer(&transcript, &truth))?
            );
            let mut pass = report.pass;
            if let Some(mix) = mix {
                let (_, mix) = read_wav_mono_i16(&std::fs::read(&mix)?)?;
                let mut speakers = HashMap::new();
                for speaker in &truth.speakers {
                    let (_, pcm) =
                        read_wav_mono_i16(&std::fs::read(truth_dir.join(&speaker.wav))?)?;
                    speakers.insert(speaker.label.clone(), pcm);
                }
                let mix_report = check_mix(&mix, &truth, &speakers);
                println!("{}", serde_json::to_string_pretty(&mix_report)?);
                pass &= mix_report.pass;
            }
            if !pass {
                return Ok(ExitCode::FAILURE);
            }
        }
        Command::Summarize {
            transcript,
            out,
            model,
            project,
            location,
            gcp_auth,
            thinking_level,
            max_output_tokens,
            input_usd_per_mtok,
            output_usd_per_mtok,
        } => {
            let tokens = Tokens::new(gcp_token_source(gcp_auth)?)?;
            let transcript: Transcript = serde_json::from_slice(
                &std::fs::read(&transcript)
                    .with_context(|| format!("read {}", transcript.display()))?,
            )?;
            let mut settings = summary::GeminiSettings::new(&model);
            settings.project = project;
            settings.location = location;
            settings.thinking_level = Some(thinking_level.as_str().to_string());
            settings.max_output_tokens = max_output_tokens;
            if let (Some(input), Some(output)) = (input_usd_per_mtok, output_usd_per_mtok) {
                settings.price = Some(summary::Price {
                    input_usd_per_mtok: input,
                    output_usd_per_mtok: output,
                });
            }
            let http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()?;
            let names = summary::PubkeyPrefixNames;
            let result = summary::summarize(&http, &settings, &tokens, &transcript, &names).await?;
            if let Some(parent) = out.parent().filter(|p| !p.as_os_str().is_empty()) {
                create_private_dir(parent)?;
            }
            write_private(&out, &serde_json::to_vec_pretty(&result)?)?;
            let usage = &result.usage;
            let firm = result
                .action_items
                .iter()
                .filter(|item| item.status == summary::ItemStatus::Firm)
                .count();
            eprintln!(
                "summary: model {} ({}) | input {} output {} thinking {} tokens in {} call(s){} | cost {}",
                result.model,
                usage.model_version.as_deref().unwrap_or("?"),
                usage.input_tokens,
                usage.output_tokens,
                usage.thinking_tokens,
                usage.calls,
                if usage.compact { ", asked again shorter" } else { "" },
                usage
                    .cost_usd
                    .map_or("unknown price".to_string(), |usd| format!("${usd:.6}"))
            );
            let fixed = &result.corrections;
            eprintln!(
                "  decisions {} | action items {} (firm {firm}) | topics {}",
                result.decisions.len(),
                result.action_items.len(),
                result.topics.len()
            );
            eprintln!(
                "  corrections {}: evidence snapped {} dropped {} | assignee cleared {} | due cleared {} disagreed {} time dropped {} | firm→unsure {}",
                fixed.total(),
                fixed.evidence_snapped,
                fixed.evidence_dropped,
                fixed.assignee_cleared,
                fixed.due_cleared,
                fixed.due_disagreed,
                fixed.due_time_dropped,
                fixed.status_downgraded
            );
            eprintln!("  out: {}", out.display());
        }
        Command::PublishNotion {
            transcript,
            summary: summary_path,
            record,
            title_prefix,
            status,
            kind,
            channel_name,
            playback_link,
        } => {
            let token = token_from_env("NOTION_TOKEN")?;
            let transcript: Transcript = serde_json::from_slice(
                &std::fs::read(&transcript)
                    .with_context(|| format!("read {}", transcript.display()))?,
            )?;
            let summary: summary::Summary = serde_json::from_slice(
                &std::fs::read(&summary_path)
                    .with_context(|| format!("read {}", summary_path.display()))?,
            )?;
            // 지난번에 남긴 page id(있으면 그것부터). 못 읽으면 없는 것으로.
            let known = record
                .as_ref()
                .and_then(|path| std::fs::read(path).ok())
                .and_then(|bytes| serde_json::from_slice::<notion::NotionRecord>(&bytes).ok())
                .map(|record| record.page_id);
            let settings = notion::NotionSettings {
                playback_link,
                ..notion::NotionSettings::default()
            };
            let http = reqwest::Client::builder()
                .timeout(notion::NOTION_TIMEOUT)
                .build()?;
            let mut client = notion::NotionClient::new(&http, &settings, &token)?;
            let names = summary::PubkeyPrefixNames;
            let page = notion::MeetingPage {
                transcript: &transcript,
                summary: Some(&summary),
                names: &names,
                title_prefix: &title_prefix,
                channel_label: channel_name.as_deref(),
                kind: kind.map(|kind| match kind {
                    KindArg::Channel => notion::MeetingKind::Channel,
                    KindArg::Dm => notion::MeetingKind::Dm,
                }),
                status: match status {
                    StatusArg::InProgress => notion::ProcessingStatus::InProgress,
                    StatusArg::Done => notion::ProcessingStatus::Done,
                    StatusArg::Failed => notion::ProcessingStatus::Failed,
                },
            };
            // 실패해도 그때까지 만든 페이지·줄 id 를 찍는다.
            let mut report = notion::PublishReport::default();
            let result = notion::publish(&mut client, &page, known.as_deref(), &mut report).await;
            eprintln!(
                "notion: page {} ({}) | duplicates trashed {} | blocks {} in {} requests, old blocks deleted {}, checks kept {}, body attempts {} | people rows added {} linked {} | requests {}",
                if report.page_id.is_empty() { "-" } else { &report.page_id },
                if report.created { "created" } else { "found" },
                report.trashed_duplicates.len(),
                report.blocks,
                report.append_requests,
                report.deleted_old_blocks,
                report.kept_checked,
                report.body_attempts,
                report.people_rows_added.len(),
                report.people_linked,
                client.requests
            );
            for page_id in &report.trashed_duplicates {
                eprintln!("  duplicate page trashed: {page_id}");
            }
            for row in &report.people_rows_added {
                eprintln!("  people row added: {row}");
            }
            if let Some(error) = &report.people_error {
                eprintln!("  people db skipped (no mentions this time): {error}");
            }
            if !notion::linkable_in_body(&settings.playback_link) {
                eprintln!("  script times are plain text: Notion only links http(s) in page text");
            }
            if let (Some(path), false) = (&record, report.page_id.is_empty()) {
                let json = serde_json::to_vec_pretty(&notion::NotionRecord::new(
                    &transcript,
                    &report.page_id,
                ))?;
                write_private(path, &json)?;
            }
            if report.stuck_in_progress {
                eprintln!(
                    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
                );
                eprintln!(
                    "!!! notion page {} could not be marked 실패 and may stay 처리 중: check it by hand",
                    report.page_id
                );
                eprintln!(
                    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
                );
            }
            result?;
        }
        Command::NotionStale { older_than_minutes } => {
            let token = token_from_env("NOTION_TOKEN")?;
            let settings = notion::NotionSettings::default();
            let http = reqwest::Client::builder()
                .timeout(notion::NOTION_TIMEOUT)
                .build()?;
            let mut client = notion::NotionClient::new(&http, &settings, &token)?;
            let stale = notion::find_stale(
                &mut client,
                std::time::Duration::from_secs(older_than_minutes * 60),
                chrono::Utc::now(),
            )
            .await?;
            eprintln!(
                "pages still 처리 중 after {older_than_minutes} minutes: {}",
                stale.len()
            );
            for page in &stale {
                println!(
                    "{}\t{}\t{}",
                    page.page_id, page.last_edited_time, page.huddle_key
                );
            }
            if !stale.is_empty() {
                return Ok(ExitCode::FAILURE);
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// `--gcp-auth` 에 맞는 토큰 출처.
fn gcp_token_source(auth: GcpAuth) -> anyhow::Result<TokenSource> {
    Ok(match auth {
        GcpAuth::Metadata => TokenSource::metadata_server(),
        GcpAuth::Gcloud => TokenSource::gcloud(),
        GcpAuth::Env => TokenSource::static_from_env()
            .with_context(|| format!("{STATIC_TOKEN_ENV} is not set"))?,
    })
}

/// What one `process` run works through.
struct Run<'a> {
    store: &'a AnyStore,
    channels: &'a [(Uuid, Uuid)],
    gap_ms: u64,
    stt: &'a AnyStt,
    settings: &'a MinutesSettings,
    options: &'a RunOptions,
    audio_home: &'a str,
    /// No new meeting is started after this.
    deadline: Instant,
}

/// Run every meeting of every channel of `run`. A channel that cannot be
/// read is counted and the next one goes on; credentials, permission or
/// quota refused stop everything. Past the deadline nothing new starts and
/// what is left waits for the next run. The exit code says whether every
/// meeting tried went through.
async fn process_channels<H: MinutesHome>(
    home: &H,
    run: &Run<'_>,
    detector: &mut SileroVad,
    mut follow: Option<&mut FollowUps<'_>>,
) -> ExitCode {
    let (mut failed, mut locked, mut unreadable_channels) = (0usize, 0usize, 0usize);
    let mut follow_failed = 0usize;
    let mut audio_kept = 0usize;
    let mut left: Option<(usize, usize)> = None;
    'channels: for (c, &(community, channel)) in run.channels.iter().enumerate() {
        let channel_id = format!("{community}/{channel}");
        if Instant::now() >= run.deadline {
            left = Some((run.channels.len() - c, 0));
            break;
        }
        let planned = match plan_meetings(
            run.store,
            &run.options.prefix,
            community,
            channel,
            run.gap_ms,
        )
        .await
        {
            Ok(planned) => planned,
            // A channel folder with no session (only mixed audio left).
            Err(CollectError::NoSessions(_)) => continue,
            Err(error) => {
                let error = MeetingError::from(error);
                unreadable_channels += 1;
                eprintln!("{channel_id}: not read: {error}");
                if error.stops_the_run() {
                    eprintln!("stopping: later channels would fail the same way");
                    return ExitCode::FAILURE;
                }
                continue;
            }
        };
        eprintln!(
            "{channel_id}: meetings {} | sessions with nothing readable outside any meeting: {}",
            planned.meetings.len(),
            planned.unplaced_sessions.len()
        );
        for (m, meeting) in planned.meetings.iter().enumerate() {
            if Instant::now() >= run.deadline {
                left = Some((run.channels.len() - c - 1, planned.meetings.len() - m));
                break 'channels;
            }
            let done = run_meeting_with(
                home,
                run.store,
                meeting,
                detector,
                run.stt,
                run.settings,
                run.options,
                follow.as_deref_mut(),
            )
            .await;
            let (output, script, audio, followed) = match done {
                Ok(Done::Written {
                    output,
                    script,
                    audio,
                    follow,
                }) => (output, script, audio, follow),
                Ok(Done::FollowedUp(followed)) => {
                    eprintln!(
                        "{channel_id} meeting {m}: script already there | {}",
                        follow_line(&followed)
                    );
                    if followed.has_failure() {
                        follow_failed += 1;
                    }
                    continue;
                }
                Ok(Done::Skipped(skip)) => {
                    eprintln!("{channel_id} meeting {m}: skipped ({})", skip.as_str());
                    continue;
                }
                Ok(Done::Locked) => {
                    locked += 1;
                    eprintln!("{channel_id} meeting {m}: skipped (another worker holds it)");
                    continue;
                }
                Err(error) => {
                    failed += 1;
                    eprintln!("{channel_id} meeting {m}: not written: {error}");
                    if error.stops_the_run() {
                        eprintln!("stopping: later meetings would fail the same way");
                        return ExitCode::FAILURE;
                    }
                    continue;
                }
            };
            let report = &output.report;
            let losses = &report.losses;
            eprintln!(
            "{channel_id} meeting {m}: sessions {} | lost chunks {} missing chunks {} unreadable chunks {} unreadable manifests {} unreadable sessions {} dropped frames {} failed pieces {}",
            meeting.sessions.len(),
            losses.lost_chunks,
            losses.missing_chunks,
            losses.unreadable_chunks,
            losses.unreadable_manifests,
            losses.unreadable_sessions,
            losses.dropped_frames,
            losses.failed_segments
        );
            let by_kind: Vec<String> = report
                .stt_failures_by_kind
                .iter()
                .map(|(kind, count)| format!("{kind} {count}"))
                .collect();
            eprintln!(
            "  frames {} unknown {} overlap-skipped {} broken-chunks {} | unplaced unreadable sessions in channel {}",
            report.demux.frames,
            report.demux.unknown_sender,
            report.demux.overlap_skipped,
            report.demux.broken_chunks,
            report.unplaced_sessions_in_channel
        );
            eprintln!(
            "  stt run {} | requests {} reused from ledger {} retries {} gave up [{}] | unreadable ledger lines {}",
            report.run,
            report.stt_requests,
            report.stt_reused,
            report.stt_retries,
            by_kind.join(", "),
            report.ledger_unreadable_lines
        );
            for (i, speaker) in report.speakers.iter().enumerate() {
                eprintln!(
                "  person {i}: frames {} decoded {} concealed {} lost-silent {} spurts {} out-of-order {} undecodable {} | regions {} speech spans {} pieces {} stt failures {}",
                speaker.frames,
                speaker.decode.decoded,
                speaker.decode.concealed,
                speaker.decode.lost_silent,
                speaker.decode.spurts,
                speaker.decode.out_of_order,
                speaker.decode.undecodable,
                speaker.sounding_regions,
                speaker.speech_spans,
                speaker.segments,
                speaker.stt_failures
            );
            }
            eprintln!("  transcript: {script}");
            let audio = match audio {
                PutNew::Written => "written",
                PutNew::Same => "already there",
                PutNew::Other => {
                    audio_kept += 1;
                    "already there with other bytes, kept"
                }
            };
            eprintln!(
                "  mixed audio: {}{} ({audio})",
                run.audio_home, output.transcript.audio.key
            );
            if let Some(followed) = followed {
                eprintln!("  {}", follow_line(&followed));
                if followed.has_failure() {
                    follow_failed += 1;
                }
            }
        }
    }
    if let Some((channels, meetings)) = left {
        eprintln!(
            "time limit reached: {meetings} meeting(s) of this channel and {channels} channel(s) left for the next run"
        );
    }
    if audio_kept > 0 {
        eprintln!("{audio_kept} mixed audio file(s) already there with other bytes, kept");
    }
    if locked > 0 {
        eprintln!("{locked} meeting(s) held by another worker");
    }
    if unreadable_channels > 0 {
        eprintln!("{unreadable_channels} channel(s) not read");
    }
    if failed > 0 {
        eprintln!("{failed} meeting(s) not written");
    }
    if follow_failed > 0 {
        eprintln!("{follow_failed} meeting(s) with a summary or Notion page failed (tried again next run)");
    }
    if failed > 0 || unreadable_channels > 0 || follow_failed > 0 {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// One log line for the steps after the script (no text, no ids).
fn follow_line(followed: &FollowedUp) -> String {
    let step = |step: &FollowStep| match step {
        FollowStep::Off => "off".to_string(),
        FollowStep::AlreadyDone => "already done".to_string(),
        FollowStep::Done => "done".to_string(),
        FollowStep::Waiting => "waiting for the summary".to_string(),
        FollowStep::Failed(error) => format!("failed: {error}"),
    };
    format!(
        "summary {} | notion {}",
        step(&followed.summary),
        step(&followed.notion)
    )
}

/// `--summary` / `--notion` values.
#[derive(Clone, Copy, clap::ValueEnum)]
enum Switch {
    On,
    Off,
}

/// The transcriber chosen on the command line.
enum AnyStt {
    Truth(TruthStt),
    Chirp(ChirpStt),
}

impl SpeechToText for AnyStt {
    fn info(&self) -> SttInfo {
        match self {
            Self::Truth(stt) => stt.info(),
            Self::Chirp(stt) => stt.info(),
        }
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        match self {
            Self::Truth(stt) => stt.transcribe(request).await,
            Self::Chirp(stt) => stt.transcribe(request).await,
        }
    }
}

/// Where the recordings are.
enum AnyStore {
    Local(LocalStore),
    Gcs(GcsStore),
}

impl RecordingStore for AnyStore {
    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        match self {
            Self::Local(store) => store.list(prefix).await,
            Self::Gcs(store) => store.list(prefix).await,
        }
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>, StoreError> {
        match self {
            Self::Local(store) => store.get(key).await,
            Self::Gcs(store) => store.get(key).await,
        }
    }

    async fn get_start(&self, key: &str, len: u64) -> Result<Vec<u8>, StoreError> {
        match self {
            Self::Local(store) => store.get_start(key, len).await,
            Self::Gcs(store) => store.get_start(key, len).await,
        }
    }

    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<(), StoreError> {
        match self {
            Self::Local(store) => store.put(key, bytes).await,
            Self::Gcs(store) => store.put(key, bytes).await,
        }
    }

    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<PutNew, StoreError> {
        match self {
            Self::Local(store) => store.put_new(key, bytes).await,
            Self::Gcs(store) => store.put_new(key, bytes).await,
        }
    }

    async fn folders(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        match self {
            Self::Local(store) => store.folders(prefix).await,
            Self::Gcs(store) => store.folders(prefix).await,
        }
    }
}
