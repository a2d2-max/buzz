//! `buzz-huddle-minutes` — run the minutes worker on a local recording
//! folder, build fake meetings, and check scripts against answer sheets.
//!
//! Output on stderr is counts only: no speech text, no pubkeys, no secrets.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::HashMap;

use anyhow::Context;

use buzz_huddle_minutes::audio::read_wav_mono_i16;
use buzz_huddle_minutes::check::{check, check_mix, Tolerance};
use buzz_huddle_minutes::collect::collect_meetings;
use buzz_huddle_minutes::ledger::LEDGER_KEY_FORMAT;
use buzz_huddle_minutes::models::{
    ensure_model, ensure_silero_vad, sha256_hex, silero_vad_path, SILERO_VAD_SHA256,
    SPEAKER_EMBEDDING, SPEAKER_SEGMENTATION,
};
use buzz_huddle_minutes::pipeline::{mixed_audio_key, MinutesSettings, SttPolicy};
use buzz_huddle_minutes::runner::{run_meeting, Done, LocalMinutes, RunOptions};
use buzz_huddle_minutes::sim::{
    build_fake_meeting, load_bench_clips, mark_speech, write_fake_meeting, Truth, SENTENCES,
};
use buzz_huddle_minutes::speakers::{report_line, SpeakerArgs};
use buzz_huddle_minutes::store::LocalStore;
use buzz_huddle_minutes::stt::{
    Fault, SpeechToText, SttError, SttErrorKind, SttOutput, SttRequest, TruthStt,
};
use buzz_huddle_minutes::transcript::{SttInfo, Transcript};
use buzz_huddle_minutes::vad::{SegmentPlan, SileroSettings, SileroVad};
use buzz_huddle_minutes::voices::{run_command as run_voices, VoicesCommand};
use clap::{Parser, Subcommand};
use uuid::Uuid;

#[derive(Parser)]
#[command(about = "Huddle minutes worker (local recordings)")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Download the Silero VAD and speaker models into the cache and check
    /// their sha256.
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
    /// Make the script and mixed audio of each finished meeting in a huddle
    /// channel (`<first session id>.transcript.json` per meeting).
    Process {
        /// Folder laid out like the recording bucket.
        #[arg(long)]
        recordings: PathBuf,
        /// Storage prefix.
        #[arg(long, default_value = "huddles")]
        prefix: String,
        /// Community id.
        #[arg(long)]
        community: Uuid,
        /// Huddle channel id.
        #[arg(long)]
        channel: Uuid,
        /// Where the scripts go (never the recording bucket).
        #[arg(long)]
        out: PathBuf,
        /// Answer sheet for the fake transcriber. Without it (a real
        /// recording) every piece gets placeholder text with its length, so
        /// speakers and pieces can be checked before a real engine is wired.
        #[arg(long)]
        stt_truth: Option<PathBuf>,
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
        #[arg(long)]
        cache: Option<PathBuf>,
        /// A meeting is over after this many minutes with nothing written.
        #[arg(long, default_value_t = 10)]
        quiet_minutes: u64,
        /// Sessions further apart than this many minutes are separate
        /// meetings.
        #[arg(long, default_value_t = 10)]
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
        /// Speakers inside a track, naming, voice profiles.
        #[command(flatten)]
        speaker_args: SpeakerArgs,
    },
    /// Stored voice profiles: list them or forget one person's.
    Voices {
        #[command(subcommand)]
        command: VoicesCommand,
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

/// Settings version for ledger keys: the key format, how pieces are cut
/// and the exact VAD model. The model's sha256 is checked here too, so a
/// changed or broken model file is refused instead of silently re-cutting.
fn ledger_version(plan: &SegmentPlan, model: &Path) -> anyhow::Result<String> {
    let bytes = std::fs::read(model).with_context(|| format!("read {}", model.display()))?;
    let digest = sha256_hex(&bytes);
    if digest != SILERO_VAD_SHA256 {
        anyhow::bail!(
            "{} has sha256 {digest}, expected {SILERO_VAD_SHA256}; run `buzz-huddle-minutes fetch-models`",
            model.display()
        );
    }
    let vad = SileroSettings::default();
    Ok(format!(
        "{LEDGER_KEY_FORMAT};max={};pad={};vad={},{},{},{},{};model={digest}",
        plan.max_segment_ms,
        plan.pad_ms,
        vad.threshold,
        vad.min_silence_s,
        vad.cut_silence_s,
        vad.min_speech_s,
        vad.max_speech_s
    ))
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

/// The transcriber of `process`: the answer sheet of a fake meeting, or
/// placeholder text for a real recording until a real engine is wired.
enum CliStt {
    Truth(TruthStt),
    Placeholder,
}

impl SpeechToText for CliStt {
    fn info(&self) -> SttInfo {
        match self {
            Self::Truth(stt) => stt.info(),
            Self::Placeholder => SttInfo {
                engine: "placeholder".into(),
                region: "local".into(),
                language: "ko-KR".into(),
                billed_seconds: 0,
            },
        }
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        match self {
            Self::Truth(stt) => stt.transcribe(request).await,
            Self::Placeholder => Ok(SttOutput {
                text: format!(
                    "(받아쓰기 대역 {:.1}초)",
                    (request.end_ms - request.start_ms) as f64 / 1_000.0
                ),
                billed_seconds: 0,
            }),
        }
    }
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
            let cache = cache.unwrap_or_else(default_cache);
            let path = ensure_silero_vad(&cache).await?;
            eprintln!("silero vad: {}", path.display());
            for model in [SPEAKER_SEGMENTATION, SPEAKER_EMBEDDING] {
                let path = ensure_model(&cache, &model).await?;
                eprintln!("speaker model: {}", path.display());
            }
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
            prefix,
            community,
            channel,
            out,
            stt_truth,
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
            speaker_args,
        } => {
            let store = LocalStore::new(&recordings);
            let quiet_ms = quiet_minutes * 60_000;
            let gap_ms = meeting_gap_minutes * 60_000;
            let collected = collect_meetings(&store, &prefix, community, channel, gap_ms).await?;
            let now = now_ms.unwrap_or_else(now_unix_ms);
            let cache = cache.unwrap_or_else(default_cache);
            let model = silero_vad_path(&cache);
            let mut detector = SileroVad::new(&model, SileroSettings::default())
                .context("run `buzz-huddle-minutes fetch-models` first")?;
            let stt = match &stt_truth {
                Some(path) => {
                    let truth: Truth = serde_json::from_slice(
                        &std::fs::read(path).with_context(|| format!("read {}", path.display()))?,
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
                    CliStt::Truth(stt)
                }
                None => CliStt::Placeholder,
            };
            let minutes = LocalMinutes::open(&out)?;
            let plan = SegmentPlan {
                max_segment_ms,
                pad_ms,
            };
            let settings = MinutesSettings {
                segment_plan: plan,
                stt: SttPolicy::default(),
                // Placeholder text must never be reused for a real engine.
                ledger_version: match &stt {
                    CliStt::Truth(_) => ledger_version(&plan, &model)?,
                    CliStt::Placeholder => {
                        format!("{};stt=placeholder", ledger_version(&plan, &model)?)
                    }
                },
                audio_key: String::new(),
                now_unix_ms: now,
                speakers: speaker_args.settings(&cache)?,
            };
            let options = RunOptions {
                prefix: prefix.clone(),
                now_unix_ms: now,
                quiet_ms,
                overwrite,
            };
            eprintln!(
                "meetings in this channel: {} | sessions with nothing readable outside any meeting: {}",
                collected.meetings.len(),
                collected.unplaced_sessions.len()
            );
            let (mut failed, mut locked) = (0usize, 0usize);
            for (m, meeting) in collected.meetings.iter().enumerate() {
                let done = run_meeting(
                    &minutes,
                    &store,
                    meeting,
                    &mut detector,
                    &stt,
                    &settings,
                    &options,
                )
                .await;
                let (output, transcript_path) = match done {
                    Ok(Done::Written {
                        output,
                        transcript_path,
                    }) => (output, transcript_path),
                    Ok(Done::Skipped(skip)) => {
                        eprintln!("meeting {m}: skipped ({})", skip.as_str());
                        continue;
                    }
                    Ok(Done::Locked) => {
                        locked += 1;
                        eprintln!("meeting {m}: skipped (another worker holds it)");
                        continue;
                    }
                    Err(error) => {
                        failed += 1;
                        eprintln!("meeting {m}: not written: {error}");
                        if error.stops_the_run() {
                            eprintln!("stopping: later meetings would fail the same way");
                            return Ok(ExitCode::FAILURE);
                        }
                        continue;
                    }
                };
                let report = &output.report;
                let losses = &report.losses;
                eprintln!(
                    "meeting {m}: sessions {} | lost chunks {} missing chunks {} unreadable chunks {} unreadable manifests {} unreadable sessions {} dropped frames {} failed pieces {}",
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
                eprintln!("  {}", report_line(&report.speakers_split));
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
                eprintln!("  transcript: {}", transcript_path.display());
                eprintln!(
                    "  mixed audio: {}",
                    recordings.join(mixed_audio_key(&prefix, meeting)).display()
                );
            }
            if locked > 0 {
                eprintln!("{locked} meeting(s) held by another worker");
            }
            if failed > 0 {
                eprintln!("{failed} meeting(s) not written");
                return Ok(ExitCode::FAILURE);
            }
        }
        Command::Voices { command } => run_voices(command).await?,
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
