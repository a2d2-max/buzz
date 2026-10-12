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
use buzz_huddle_minutes::gcs_minutes::GcsMinutes;
use buzz_huddle_minutes::ledger::LEDGER_KEY_FORMAT;
use buzz_huddle_minutes::models::{
    ensure_silero_vad, sha256_hex, silero_vad_path, SILERO_VAD_SHA256,
};
use buzz_huddle_minutes::pipeline::{MinutesSettings, SttPolicy};
use buzz_huddle_minutes::runner::{
    run_meeting, Done, LocalMinutes, MeetingError, MinutesHome, RunOptions,
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
            let token_source = || -> anyhow::Result<TokenSource> {
                Ok(match gcp_auth {
                    GcpAuth::Metadata => TokenSource::metadata_server(),
                    GcpAuth::Gcloud => TokenSource::gcloud(),
                    GcpAuth::Env => TokenSource::static_from_env()
                        .with_context(|| format!("{STATIC_TOKEN_ENV} is not set"))?,
                })
            };
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
            let code = match (out, minutes_bucket, &gcs) {
                (Some(out), _, _) => {
                    let home = LocalMinutes::open(&out)?;
                    process_channels(&home, &run, &mut detector).await
                }
                (None, Some(bucket), Some(gcs)) => {
                    let home = GcsMinutes::new(gcs.clone(), bucket);
                    process_channels(&home, &run, &mut detector).await
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
    }
    Ok(ExitCode::SUCCESS)
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
) -> ExitCode {
    let (mut failed, mut locked, mut unreadable_channels) = (0usize, 0usize, 0usize);
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
            let done = run_meeting(
                home,
                run.store,
                meeting,
                detector,
                run.stt,
                run.settings,
                run.options,
            )
            .await;
            let (output, script, audio) = match done {
                Ok(Done::Written {
                    output,
                    script,
                    audio,
                }) => (output, script, audio),
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
    if failed > 0 || unreadable_channels > 0 {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
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
