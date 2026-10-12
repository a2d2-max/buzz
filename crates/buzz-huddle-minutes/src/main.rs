//! `buzz-huddle-minutes` — run the minutes worker on a local recording
//! folder, build fake meetings, and check scripts against answer sheets.
//!
//! Output on stderr is counts only: no speech text, no pubkeys, no secrets.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::{HashMap, HashSet};

use anyhow::Context;

use buzz_huddle_minutes::audio::read_wav_mono_i16;
use buzz_huddle_minutes::check::{check, check_mix, Tolerance};
use buzz_huddle_minutes::collect::collect_meetings;
use buzz_huddle_minutes::models::{ensure_silero_vad, silero_vad_path};
use buzz_huddle_minutes::pipeline::{build_minutes, mixed_audio_key, MinutesSettings, SttPolicy};
use buzz_huddle_minutes::sim::{
    build_fake_meeting, load_bench_clips, mark_speech, write_fake_meeting, Truth, SENTENCES,
};
use buzz_huddle_minutes::store::{LocalStore, RecordingStore};
use buzz_huddle_minutes::stt::{Fault, SttErrorKind, TruthStt};
use buzz_huddle_minutes::transcript::Transcript;
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
        /// Answer sheet for the fake transcriber (the only engine so far).
        #[arg(long)]
        stt_truth: PathBuf,
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

/// `--stt-fail-kind` values.
#[derive(Clone, Copy, clap::ValueEnum)]
enum FailKind {
    Auth,
    Quota,
    Rejected,
    Transient,
}

impl From<FailKind> for SttErrorKind {
    fn from(kind: FailKind) -> Self {
        match kind {
            FailKind::Auth => Self::Auth,
            FailKind::Quota => Self::Quota,
            FailKind::Rejected => Self::Rejected,
            FailKind::Transient => Self::Transient,
        }
    }
}

/// Every session id already in a script under `out`, with its file name.
/// An unreadable script is an error: skipping it could process a meeting
/// twice.
fn processed_sessions(out: &Path) -> anyhow::Result<Vec<(Uuid, String)>> {
    let mut processed = Vec::new();
    for entry in std::fs::read_dir(out)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".transcript.json") {
            continue;
        }
        let transcript: Transcript = serde_json::from_slice(&std::fs::read(entry.path())?)
            .with_context(|| format!("read {}", entry.path().display()))?;
        for session in transcript.session_ids {
            processed.push((session, name.clone()));
        }
    }
    Ok(processed)
}

/// Write a file readable by its owner only (0600), atomically.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let partial = path.with_extension("partial");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&partial)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&partial, path)
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
            let meeting = build_fake_meeting(&clips, seed, &prefix)?;
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
            max_segment_ms,
            pad_ms,
        } => {
            let store = LocalStore::new(&recordings);
            let quiet_ms = quiet_minutes * 60_000;
            let gap_ms = meeting_gap_minutes * 60_000;
            let collected = collect_meetings(&store, &prefix, community, channel, gap_ms).await?;
            let now = now_unix_ms();
            let model = silero_vad_path(&cache.unwrap_or_else(default_cache));
            let mut detector = SileroVad::new(&model, SileroSettings::default())
                .context("run `buzz-huddle-minutes fetch-models` first")?;
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
                });
            }
            std::fs::create_dir_all(&out)?;
            let processed = processed_sessions(&out)?;
            eprintln!(
                "meetings in this channel: {} | sessions with nothing readable outside any meeting: {}",
                collected.meetings.len(),
                collected.unplaced_sessions.len()
            );
            let mut failed_meetings = 0usize;
            for (m, meeting) in collected.meetings.iter().enumerate() {
                let first = meeting
                    .sessions
                    .first()
                    .map(|session| session.session_id)
                    .unwrap_or_default();
                // One script per meeting, named after its first session.
                let name = format!("{first}.transcript.json");
                let transcript_path = out.join(&name);
                // `--overwrite` may replace this meeting's own script, never
                // another script that shares a session with it.
                let already: HashSet<Uuid> = processed
                    .iter()
                    .filter(|(_, file)| !(overwrite && **file == name))
                    .map(|(session, _)| *session)
                    .collect();
                if let Some(skip) = meeting.skip_reason(&already, now, quiet_ms) {
                    eprintln!("meeting {m}: skipped ({})", skip.as_str());
                    continue;
                }
                let audio_key = mixed_audio_key(&prefix, meeting);
                let settings = MinutesSettings {
                    segment_plan: SegmentPlan {
                        max_segment_ms,
                        pad_ms,
                    },
                    stt: SttPolicy::default(),
                    audio_key: audio_key.clone(),
                    now_unix_ms: now,
                };
                let output = match build_minutes(meeting, &mut detector, &stt, &settings).await {
                    Ok(output) => output,
                    Err(error) => {
                        failed_meetings += 1;
                        eprintln!("meeting {m}: not written: {error}");
                        if error.stops_the_run() {
                            eprintln!("stopping: later meetings would fail the same way");
                            return Ok(ExitCode::FAILURE);
                        }
                        continue;
                    }
                };
                store.put(&audio_key, output.mixed_audio).await?;
                write_private(
                    &transcript_path,
                    &serde_json::to_vec_pretty(&output.transcript)?,
                )?;

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
                    "  frames {} unknown {} overlap-skipped {} broken-chunks {} | stt retries {} gave up [{}]",
                    report.demux.frames,
                    report.demux.unknown_sender,
                    report.demux.overlap_skipped,
                    report.demux.broken_chunks,
                    report.stt_retries,
                    by_kind.join(", ")
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
                eprintln!("  transcript: {}", transcript_path.display());
                eprintln!("  mixed audio: {}", recordings.join(&audio_key).display());
            }
            if failed_meetings > 0 {
                eprintln!("{failed_meetings} meeting(s) not written");
                return Ok(ExitCode::FAILURE);
            }
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
