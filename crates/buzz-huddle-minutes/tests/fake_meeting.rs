//! End to end on a fake meeting: build recordings with an answer sheet,
//! run the worker on them, compare the script with the answer sheet.
//!
//! These tests need no model or downloaded audio: the sentences are
//! synthetic tones and speech detection is a simple energy detector. The
//! same flow with FLEURS speech and Silero runs from the command line
//! (`fake-meeting` → `process` → `check`) and in the ignored test below.

use std::path::{Path, PathBuf};

use std::collections::{BTreeMap, HashMap};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use buzz_gcp::fake::FakeGcs;
use buzz_gcp::gcs::Gcs;
use buzz_gcp::token::{AccessToken, TokenSource, Tokens};
use buzz_huddle_minutes::audio::read_wav_mono_i16;
use buzz_huddle_minutes::check::{audio_match, cer, check, check_mix, Tolerance};
use buzz_huddle_minutes::collect::{collect_meetings, plan_meetings, Meeting, MeetingPlan, Skip};
use buzz_huddle_minutes::gcs_minutes::{GcsLedger, GcsMinutes, LEASE_FORMAT};
use buzz_huddle_minutes::ledger::{Ledger, Outcome, SttLedger};
use buzz_huddle_minutes::media::{level_dbov, split_frame, MediaHeader, FLAG_DTX};
use buzz_huddle_minutes::models::silero_vad_path;
use buzz_huddle_minutes::pipeline::{
    build_minutes, MinutesError, MinutesOutput, MinutesSettings, SttPolicy,
};
use buzz_huddle_minutes::runner::{run_meeting, Done, LocalMinutes, MeetingError, RunOptions};
use buzz_huddle_minutes::sim::{
    build_fake_meeting, load_bench_clips, mark_speech, write_fake_meeting, Clip, FakeMeeting,
    Truth, BASE_UNIX_MS, SENTENCES,
};
use buzz_huddle_minutes::store::{LocalStore, RecordingStore};
use buzz_huddle_minutes::stt::{
    Fault, SpeechToText, SttError, SttErrorKind, SttOutput, SttRequest, TruthStt, FAILED_TEXT,
};
use buzz_huddle_minutes::transcript::{SttInfo, Transcript};
use buzz_huddle_minutes::vad::{
    SegmentPlan, SileroSettings, SileroVad, SpeechDetector, SpeechSpan, VadError,
};
use buzz_huddle_recording::{
    chunk_key, decode_chunk, format_utc_millis, manifest_key, ChunkHeader, EndReason, Manifest,
    ManifestChunk, ManifestParticipant, Record, CHUNK_HEADER_LEN, FORMAT,
};
use uuid::Uuid;

/// Test double: 10 ms frames louder than -45 dBFS are speech; pauses up to
/// 200 ms are bridged; spans shorter than 100 ms are dropped.
struct EnergyDetector;

impl SpeechDetector for EnergyDetector {
    fn detect(&mut self, pcm_16k: &[f32]) -> Result<Vec<SpeechSpan>, VadError> {
        const FRAME: usize = 160;
        let threshold = 10f32.powf(-45.0 / 20.0);
        let mut spans: Vec<SpeechSpan> = Vec::new();
        for (i, frame) in pcm_16k.chunks(FRAME).enumerate() {
            let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
            if rms < threshold {
                continue;
            }
            let (start, end) = (i * FRAME, i * FRAME + frame.len());
            match spans.last_mut() {
                Some(last) if start <= last.end + 20 * FRAME => last.end = end,
                _ => spans.push(SpeechSpan { start, end }),
            }
        }
        spans.retain(|span| span.len() >= 10 * FRAME);
        Ok(spans)
    }
}

/// Nineteen "sentences": 3–5 tone "words" of 200–350 ms with 90–200 ms
/// between them (lengths differ word to word, like speech, so each stretch
/// of audio has its own loudness pattern), a pitch per sentence, 300 ms of
/// near-silence on each side.
fn synthetic_clips() -> Vec<Clip> {
    (0..SENTENCES)
        .map(|n| {
            let words = 3 + n % 3;
            let pitch = 150.0 + 13.0 * n as f32;
            let mut pcm = vec![0.0f32; 4_800];
            for w in 0..words {
                let word = 16 * (200 + (n * 37 + w * 53) % 151);
                let gap = 16 * (90 + (n * 29 + w * 41) % 111);
                pcm.extend((0..word).map(|i| {
                    let t = i as f32 / 16_000.0;
                    let envelope = (std::f32::consts::PI * i as f32 / word as f32).sin();
                    0.2 * envelope
                        * ((std::f32::consts::TAU * pitch * t).sin()
                            + 0.5 * (std::f32::consts::TAU * 2.0 * pitch * t).sin())
                }));
                if w + 1 < words {
                    pcm.extend(std::iter::repeat_n(0.0, gap));
                }
            }
            pcm.extend(std::iter::repeat_n(0.0, 4_800));
            let len = pcm.len();
            Clip {
                id: format!("tone-{n:02}"),
                text: format!("문장 {n:02} 번"),
                pcm_16k: pcm,
                speech_start: 0,
                speech_end: len,
                speech_units: Vec::new(),
            }
        })
        .collect()
}

/// Settings for tests: default pieces and policy, no waiting between retries.
fn settings() -> MinutesSettings {
    MinutesSettings {
        segment_plan: SegmentPlan::default(),
        stt: SttPolicy {
            retry_delay_ms: 0,
            rate_limit_delay_ms: 0,
            ..SttPolicy::default()
        },
        ledger_version: "test".into(),
        audio_key: "mixed.wav".into(),
        now_unix_ms: 0,
    }
}

async fn run_worker<D: SpeechDetector, T: SpeechToText>(
    dir: &Path,
    meeting: &FakeMeeting,
    detector: &mut D,
    stt: &T,
) -> MinutesOutput {
    try_worker(dir, meeting, detector, stt)
        .await
        .expect("build minutes")
}

async fn try_worker<D: SpeechDetector, T: SpeechToText>(
    dir: &Path,
    meeting: &FakeMeeting,
    detector: &mut D,
    stt: &T,
) -> Result<MinutesOutput, MinutesError> {
    let gathered = gather(dir, meeting).await;
    build_minutes(
        &gathered,
        detector,
        stt,
        &mut SttLedger::in_memory(),
        &settings(),
    )
    .await
}

/// Write the fake meeting and read it back as one meeting of two sessions.
async fn gather(dir: &Path, meeting: &FakeMeeting) -> Meeting {
    write_fake_meeting(dir, meeting).expect("write fake meeting");
    let store = LocalStore::new(dir.join("recordings"));
    let truth = &meeting.truth;
    let mut meetings = collect_meetings(
        &store,
        &truth.prefix,
        truth.community_id,
        truth.channel_id,
        10 * 60_000,
    )
    .await
    .expect("collect")
    .meetings;
    assert_eq!(meetings.len(), 1, "both sessions belong to one meeting");
    let gathered = meetings.remove(0);
    assert_eq!(gathered.sessions.len(), 2);
    assert!(
        gathered.sessions[0].manifest.is_some(),
        "session 1 has a manifest"
    );
    assert!(
        gathered.sessions[1].manifest.is_none(),
        "session 2 is chunks only"
    );
    gathered
}

/// Write the fake meeting and plan it (nothing loaded yet): what the runner
/// takes.
async fn plan_fake(dir: &Path, meeting: &FakeMeeting) -> MeetingPlan {
    write_fake_meeting(dir, meeting).expect("write fake meeting");
    let truth = &meeting.truth;
    let mut planned = plan_meetings(
        &LocalStore::new(dir.join("recordings")),
        &truth.prefix,
        truth.community_id,
        truth.channel_id,
        10 * 60_000,
    )
    .await
    .expect("plan")
    .meetings;
    assert_eq!(planned.len(), 1);
    planned.remove(0)
}

fn speaker_wavs(meeting: &FakeMeeting) -> HashMap<String, Vec<f32>> {
    meeting
        .truth
        .speakers
        .iter()
        .map(|speaker| {
            let bytes = meeting
                .files
                .iter()
                .find(|(path, _)| *path == speaker.wav)
                .map(|(_, bytes)| bytes)
                .expect("speaker WAV is among the files");
            let (_, pcm) = read_wav_mono_i16(bytes).expect("speaker WAV");
            (speaker.label.clone(), pcm)
        })
        .collect()
}

fn fake_meeting(seed: u64) -> FakeMeeting {
    let mut clips = synthetic_clips();
    mark_speech(&mut clips, &mut EnergyDetector).expect("mark speech");
    build_fake_meeting(&clips, seed, "huddles", BASE_UNIX_MS).expect("build fake meeting")
}

#[tokio::test]
async fn script_matches_the_answer_sheet() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let stt = TruthStt::new(&meeting.truth);
    let output = run_worker(dir.path(), &meeting, &mut EnergyDetector, &stt).await;

    let routed = &output.report.demux;
    assert_eq!(routed.unknown_sender, 0);
    assert_eq!(routed.broken_chunks, 0);
    assert!(
        routed.overlap_skipped > 0,
        "the owner change overlap is recorded twice"
    );

    let report = check(&output.transcript, &meeting.truth, Tolerance::default());
    // The answer-sheet transcriber hears every sentence once, word for word.
    let rate = cer(&output.transcript, &meeting.truth);
    assert_eq!((rate.edits, rate.cer), (0, 0.0), "{rate:?}");
    assert!(rate.truth_chars > 0);
    // One character heard wrong is one edit.
    let mut misheard = output.transcript.clone();
    let line = misheard
        .segments
        .iter_mut()
        .find(|segment| !segment.text.is_empty())
        .expect("a line with text");
    line.text = std::iter::once('갑')
        .chain(line.text.chars().skip(1))
        .collect();
    assert_eq!(cer(&misheard, &meeting.truth).edits, 1);
    assert!(report.pass, "{report:#?}");
    assert_eq!(report.sentences_found, SENTENCES);

    // Everyone is listed in join order (A, B, C) with speech.
    let speakers: Vec<&str> = meeting
        .truth
        .speakers
        .iter()
        .map(|s| s.pubkey.as_str())
        .collect();
    let listed: Vec<&str> = output
        .transcript
        .participants
        .iter()
        .map(|p| p.pubkey.as_str())
        .collect();
    assert_eq!(listed, speakers);
    assert!(output
        .transcript
        .participants
        .iter()
        .all(|p| p.speech_ms > 0));

    // The mix covers the whole meeting at 16 kHz and puts every sentence
    // where the answer sheet says, all at the same small delay.
    let (rate, mix) = read_wav_mono_i16(&output.mixed_audio).expect("mixed audio is a WAV");
    assert_eq!(rate, 16_000);
    // Both end with the meeting: the mix is exactly as long, no line ends after.
    let duration_ms = output.transcript.duration_ms;
    assert_eq!(mix.len() as u64, duration_ms * 16);
    assert!(output
        .transcript
        .segments
        .iter()
        .all(|s| s.start_ms <= s.end_ms && s.end_ms <= duration_ms));
    let mix_report = check_mix(&mix, &meeting.truth, &speaker_wavs(&meeting));
    assert!(mix_report.pass, "{mix_report:#?}");
}

fn fault(kind: SttErrorKind, every: usize, failing_attempts: u32) -> Fault {
    Fault {
        kind,
        every,
        failing_attempts,
        last_piece: usize::MAX,
    }
}

/// A few pieces the engine refuses stay in the script as "받아쓰기 실패",
/// are counted in the losses, and nothing is dropped.
#[tokio::test]
async fn a_few_refused_pieces_stay_in_the_script_marked() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let stt = TruthStt::new(&meeting.truth).with_fault(fault(SttErrorKind::Rejected, 12, u32::MAX));
    let output = run_worker(dir.path(), &meeting, &mut EnergyDetector, &stt).await;

    let pieces: usize = output.report.speakers.iter().map(|s| s.segments).sum();
    let failures: usize = output.report.speakers.iter().map(|s| s.stt_failures).sum();
    let marked = output
        .transcript
        .segments
        .iter()
        .filter(|s| s.text == FAILED_TEXT)
        .count();
    assert_eq!(
        output.transcript.segments.len(),
        pieces,
        "no piece is dropped"
    );
    assert!(failures > 0);
    assert_eq!(failures, pieces / 12);
    assert_eq!(marked, failures);
    assert_eq!(output.transcript.losses.failed_segments, failures as u64);
    assert_eq!(output.report.stt_retries, 0, "a refusal is not retried");
    assert_eq!(
        output.report.stt_failures_by_kind,
        [(SttErrorKind::Rejected, failures as u64)]
    );
}

/// Test double wrapper: counts the requests that reach the engine.
struct Counting<'a, T> {
    inner: &'a T,
    sent: AtomicUsize,
}

impl<'a, T> Counting<'a, T> {
    fn new(inner: &'a T) -> Self {
        Self {
            inner,
            sent: AtomicUsize::new(0),
        }
    }

    fn sent(&self) -> usize {
        self.sent.load(Ordering::Relaxed)
    }
}

impl<T: SpeechToText + Sync> SpeechToText for Counting<'_, T> {
    fn info(&self) -> SttInfo {
        self.inner.info()
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        self.sent.fetch_add(1, Ordering::Relaxed);
        self.inner.transcribe(request).await
    }
}

/// Run the worker on an already gathered meeting with a given ledger.
async fn run_again<T: SpeechToText>(
    meeting: &Meeting,
    stt: &T,
    ledger: &mut SttLedger,
) -> Result<MinutesOutput, MinutesError> {
    build_minutes(meeting, &mut EnergyDetector, stt, ledger, &settings()).await
}

/// A refused piece is final: written as "받아쓰기 실패" on the first run
/// however many there are, and never sent again.
#[tokio::test]
async fn refused_pieces_never_hold_a_meeting_back() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let gathered = gather(dir.path(), &meeting).await;
    let truth_stt =
        TruthStt::new(&meeting.truth).with_fault(fault(SttErrorKind::Rejected, 3, u32::MAX));
    let stt = Counting::new(&truth_stt);
    let mut ledger = SttLedger::in_memory();
    let first = run_again(&gathered, &stt, &mut ledger)
        .await
        .expect("written on the first run");
    let pieces = first.transcript.segments.len();
    assert_eq!(first.transcript.losses.failed_segments, (pieces / 3) as u64);
    assert_eq!(stt.sent(), pieces, "one request per piece, no retries");

    let again = run_again(&gathered, &stt, &mut ledger)
        .await
        .expect("rerun");
    assert_eq!(stt.sent(), pieces, "nothing sent again");
    assert_eq!(again.report.stt_reused, pieces as u64);
    assert_eq!(again.transcript.segments, first.transcript.segments);
}

/// Credentials or quota refused: the meeting stops at once and the whole
/// run is told to stop.
#[tokio::test]
async fn auth_or_quota_failure_stops_at_once() {
    for kind in [SttErrorKind::Auth, SttErrorKind::Quota] {
        let meeting = fake_meeting(7);
        let dir = tempfile::tempdir().expect("tempdir");
        let stt = TruthStt::new(&meeting.truth).with_fault(fault(kind, 2, u32::MAX));
        let result = try_worker(dir.path(), &meeting, &mut EnergyDetector, &stt).await;
        match result {
            Err(error @ MinutesError::SttStopped(stopped)) => {
                assert_eq!(stopped, kind);
                assert!(error.stops_the_run());
            }
            other => panic!("{kind}: {other:?}"),
        }
    }
}

/// Transient failures and per-minute rate limits are retried inside the
/// run; a piece that recovers costs nothing more.
#[tokio::test]
async fn transient_failures_and_rate_limits_are_retried_within_a_run() {
    for kind in [SttErrorKind::Transient, SttErrorKind::RateLimited] {
        // Every 2nd piece fails twice, then works.
        let meeting = fake_meeting(7);
        let dir = tempfile::tempdir().expect("tempdir");
        let stt = TruthStt::new(&meeting.truth).with_fault(fault(kind, 2, 2));
        let output = run_worker(dir.path(), &meeting, &mut EnergyDetector, &stt).await;
        let pieces: usize = output.report.speakers.iter().map(|s| s.segments).sum();
        assert_eq!(output.transcript.losses.failed_segments, 0, "{kind}");
        assert_eq!(output.report.stt_retries, (pieces / 2 * 2) as u64, "{kind}");
        assert!(check(&output.transcript, &meeting.truth, Tolerance::default()).pass);
    }
}

/// Pieces still failing transiently after their retries hold the meeting
/// back; the next run sends exactly those pieces and nothing else.
#[tokio::test]
async fn a_deferred_meeting_resends_only_the_failed_pieces() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let gathered = gather(dir.path(), &meeting).await;
    // Every 5th piece fails 4 attempts (1 + 3 retries), then works.
    let truth_stt = TruthStt::new(&meeting.truth).with_fault(fault(SttErrorKind::Transient, 5, 4));
    let stt = Counting::new(&truth_stt);
    let mut ledger = SttLedger::in_memory();
    let failed = match run_again(&gathered, &stt, &mut ledger).await {
        Err(MinutesError::SttRetryLater {
            failed,
            pieces,
            run: 1,
            ..
        }) => {
            assert_eq!(failed, pieces / 5);
            assert_eq!(stt.sent(), pieces + failed * 3);
            failed
        }
        other => panic!("{other:?}"),
    };
    let before = stt.sent();
    let output = run_again(&gathered, &stt, &mut ledger)
        .await
        .expect("written on run 2");
    assert_eq!(stt.sent() - before, failed, "only the failed pieces");
    assert_eq!(output.report.run, 2);
    assert_eq!(output.transcript.losses.failed_segments, 0);
    assert!(check(&output.transcript, &meeting.truth, Tolerance::default()).pass);
}

/// A piece that never recovers: the meeting waits for its last run, then
/// is written with the failure marked.
#[tokio::test]
async fn after_the_last_run_the_meeting_is_written_with_failures_marked() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let gathered = gather(dir.path(), &meeting).await;
    let truth_stt =
        TruthStt::new(&meeting.truth).with_fault(fault(SttErrorKind::Transient, 5, u32::MAX));
    let stt = Counting::new(&truth_stt);
    let mut ledger = SttLedger::in_memory();
    for run in 1..SttPolicy::default().max_runs {
        let before = stt.sent();
        match run_again(&gathered, &stt, &mut ledger).await {
            Err(MinutesError::SttRetryLater {
                run: got, failed, ..
            }) => {
                assert_eq!(got, run);
                if run > 1 {
                    assert_eq!(stt.sent() - before, failed * 4, "only the failing pieces");
                }
            }
            other => panic!("run {run}: {other:?}"),
        }
    }
    let output = run_again(&gathered, &stt, &mut ledger)
        .await
        .expect("written on the last run");
    let pieces = output.transcript.segments.len();
    assert_eq!(output.report.run, SttPolicy::default().max_runs);
    assert_eq!(
        output.transcript.losses.failed_segments,
        (pieces / 5) as u64
    );
    let marked = output
        .transcript
        .segments
        .iter()
        .filter(|s| s.text == FAILED_TEXT)
        .count();
    assert_eq!(marked, pieces / 5);
}

/// Stopping on an auth error keeps what was already paid for: the next run
/// (a new process reading the ledger file) sends only the pieces not
/// finished before the stop.
#[tokio::test]
async fn an_auth_stop_keeps_what_was_paid_for() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let gathered = gather(dir.path(), &meeting).await;
    // The 7th piece's first attempt is refused credentials (that piece only).
    let truth_stt = TruthStt::new(&meeting.truth).with_fault(Fault {
        last_piece: 7,
        ..fault(SttErrorKind::Auth, 7, 1)
    });
    let stt = Counting::new(&truth_stt);
    let ledger_dir = tempfile::tempdir().expect("tempdir");
    let path = ledger_dir.path().join("meeting.stt.jsonl");
    {
        let mut ledger = SttLedger::open(&path).expect("ledger");
        let result = run_again(&gathered, &stt, &mut ledger).await;
        assert!(matches!(
            result,
            Err(MinutesError::SttStopped(SttErrorKind::Auth))
        ));
        assert_eq!(stt.sent(), 7);
    }
    let mut ledger = SttLedger::open(&path).expect("ledger");
    let output = run_again(&gathered, &stt, &mut ledger)
        .await
        .expect("rerun");
    let pieces = output.transcript.segments.len();
    assert_eq!(
        stt.sent() - 7,
        pieces - 6,
        "the 6 finished pieces are not sent again"
    );
    assert_eq!(output.report.stt_reused, 6);
    assert!(check(&output.transcript, &meeting.truth, Tolerance::default()).pass);
}

/// One request as sent: speaker, audio start and end (ms), audio.
type SentPiece = (String, u64, u64, Vec<f32>);

/// Test double: remembers each request and answers with its number, so
/// every script line can be matched to what was sent.
#[derive(Default)]
struct RecordsRequests {
    seen: std::sync::Mutex<Vec<SentPiece>>,
}

impl SpeechToText for RecordsRequests {
    fn info(&self) -> SttInfo {
        SaysSomething.info()
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        let mut seen = self.seen.lock().expect("lock");
        seen.push((
            request.speaker.to_string(),
            request.start_ms,
            request.end_ms,
            request.pcm_16k.to_vec(),
        ));
        Ok(SttOutput {
            text: format!("#{}", seen.len() - 1),
            billed_seconds: 0,
        })
    }
}

/// Each person's clean speech on the meeting clock (16 kHz), from the
/// answer sheet and the per-person WAVs, keyed by pubkey.
fn clean_tracks(meeting: &FakeMeeting) -> HashMap<String, Vec<f32>> {
    let wavs = speaker_wavs(meeting);
    let len = usize::try_from(meeting.truth.duration_ms * 16).expect("len") + 16_000;
    let mut tracks: HashMap<String, Vec<f32>> = HashMap::new();
    for sentence in &meeting.truth.utterances {
        let wav = &wavs[&sentence.label];
        let from = usize::try_from(sentence.speaker_wav_start_ms * 16).expect("from");
        let to = usize::try_from(sentence.speaker_wav_end_ms * 16).expect("to");
        let at = usize::try_from(sentence.start_ms * 16).expect("at");
        let track = tracks
            .entry(sentence.speaker.clone())
            .or_insert_with(|| vec![0.0; len]);
        for (out, sample) in track[at..].iter_mut().zip(&wav[from..to]) {
            *out += sample;
        }
    }
    tracks
}

/// The padding goes on the audio sent, never into the script's times, and
/// the audio sent is the right person's at the right time:
/// - each line starts and ends inside its request, by exactly the padding
///   wherever there was room, and the audio is as long as its times say;
/// - the audio matches that person's clean speech at that time (loudness
///   envelope, at the network delay) far better than anyone else's.
#[tokio::test]
async fn padding_reaches_the_transcriber_but_not_the_script() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let stt = RecordsRequests::default();
    let output = run_worker(dir.path(), &meeting, &mut EnergyDetector, &stt).await;
    let seen = stt.seen.lock().expect("lock").clone();
    let clean = clean_tracks(&meeting);
    let pad = SegmentPlan::default().pad_ms;
    let mut full_pad = 0;
    // Limits = what this meeting measures (seed 7: weakest own 0.985,
    // smallest lead 0.371, latest 60 ms) with a little room for another
    // CPU's Opus decoder. The measured values are printed on every run.
    const MIN_OWN: f64 = 0.95;
    const MIN_LEAD: f64 = 0.3;
    const MAX_LATE_MS: i64 = 100;
    let (mut min_own, mut min_lead, mut max_late) = (f64::MAX, f64::MAX, 0);
    for segment in &output.transcript.segments {
        let n: usize = segment.text[1..].parse().expect("request number");
        let (speaker, start, end, audio) = &seen[n];
        let (start, end) = (*start, *end);
        assert_eq!(speaker, &segment.speaker);
        assert!(
            start <= segment.start_ms && segment.start_ms - start <= pad,
            "{segment:?}"
        );
        assert!(
            end >= segment.end_ms && end - segment.end_ms <= pad,
            "{segment:?}"
        );
        let expected = usize::try_from((end - start) * 16).expect("samples");
        assert!(
            audio.len().abs_diff(expected) < 16,
            "{} vs {expected}",
            audio.len()
        );
        if segment.start_ms - start == pad && end - segment.end_ms == pad {
            full_pad += 1;
        }

        let (late_ms, own) = audio_match(audio, &clean[speaker], start, 200)
            .unwrap_or_else(|| panic!("no match for {segment:?}"));
        min_own = min_own.min(own);
        max_late = max_late.max(late_ms);
        assert!(
            own >= MIN_OWN,
            "{segment:?}: correlation {own:.3} with its own speech"
        );
        assert!(
            (0..=MAX_LATE_MS).contains(&late_ms),
            "{segment:?}: {late_ms} ms off its own speech"
        );
        for (other, track) in clean.iter().filter(|(who, _)| *who != speaker) {
            if let Some((_, theirs)) = audio_match(audio, track, start, 200) {
                min_lead = min_lead.min(own - theirs);
                assert!(
                    own > theirs + MIN_LEAD,
                    "{segment:?}: {own:.3} vs {theirs:.3} with {other}"
                );
            }
        }
    }
    eprintln!(
        "audio match: weakest own {min_own:.3}, smallest lead {min_lead:.3}, latest {max_late} ms"
    );
    let lines = output.transcript.segments.len();
    assert!(
        full_pad * 10 >= lines * 9,
        "{full_pad} of {lines} lines have the full padding"
    );
}

type Roster = BTreeMap<(u8, u8), [u8; 32]>;

/// Where a chunk of the rewritten session came from.
enum Origin {
    /// A recorded chunk, by its original number.
    Recorded(u32),
    /// An added keepalive: record count and `t_ms`.
    Keepalive(u64, u32),
}

/// The fake meeting with roster-only "keepalive" chunks added the way the
/// recorder writes them while everyone is muted: in session 1 one between
/// its first two chunks (later chunks and the manifest renumbered), and in
/// session 2 (chunks only, still someone in the room) two at the end, 30 s
/// apart. Returns the meeting and how much later session 2 now ends.
fn with_keepalives(meeting: &FakeMeeting) -> (FakeMeeting, u64) {
    let truth = &meeting.truth;
    let folder = |session: Uuid| {
        format!(
            "recordings/{}/{}/{}/{session}/",
            truth.prefix, truth.community_id, truth.channel_id
        )
    };
    let mut files: Vec<(String, Vec<u8>)> = meeting.files.clone();
    let mut later = 0;
    for (index, session) in truth.sessions.iter().enumerate() {
        let dir = folder(session.session_id);
        let mut chunks: Vec<Vec<u8>> = Vec::new();
        let mut manifest: Option<Manifest> = None;
        files.retain(|(path, bytes)| {
            if !path.starts_with(&dir) {
                return true;
            }
            if path.ends_with("manifest.json") {
                manifest = Some(serde_json::from_slice(bytes).expect("manifest"));
            } else {
                chunks.push(bytes.clone());
            }
            false
        });
        chunks.sort_by_key(|bytes| decode_chunk(bytes).expect("chunk").0.chunk_seq);

        // Roster and last t_ms after each chunk, read back from the records.
        let mut roster = Roster::new();
        let mut after: Vec<(Roster, u32)> = Vec::new();
        let mut last_t = 0;
        for bytes in &chunks {
            for record in decode_chunk(bytes).expect("chunk").1 {
                let record = record.expect("record");
                last_t = record.t_ms();
                match record {
                    Record::Join {
                        peer_index,
                        epoch,
                        pubkey,
                        ..
                    } => {
                        roster.insert((peer_index, epoch), pubkey);
                    }
                    Record::Leave {
                        peer_index, epoch, ..
                    } => {
                        roster.remove(&(peer_index, epoch));
                    }
                    Record::Frame { .. } => {}
                }
            }
            after.push((roster.clone(), last_t));
        }
        let header = decode_chunk(&chunks[0]).expect("chunk").0;
        let with_seq = |bytes: &[u8], seq: u32| {
            let mut bytes = bytes.to_vec();
            bytes[..CHUNK_HEADER_LEN].copy_from_slice(
                &ChunkHeader {
                    chunk_seq: seq,
                    ..header
                }
                .encode(),
            );
            bytes
        };
        let keepalive = |t_ms: u32, roster: &Roster| {
            let mut bytes = header.encode().to_vec();
            for (&(peer_index, epoch), &pubkey) in roster {
                Record::Join {
                    t_ms,
                    peer_index,
                    epoch,
                    pubkey,
                }
                .encode_into(&mut bytes)
                .expect("record");
            }
            (bytes, roster.len() as u64, t_ms)
        };
        let mut out: Vec<(Vec<u8>, Origin)> = Vec::new();
        for (i, bytes) in chunks.iter().enumerate() {
            out.push((bytes.clone(), Origin::Recorded(i as u32)));
            if index == 0 && i == 0 {
                assert!(chunks.len() >= 2, "session 1 has a chunk after the first");
                let (bytes, records, t) = keepalive(after[0].1, &after[0].0);
                out.push((bytes, Origin::Keepalive(records, t)));
            }
        }
        if index == 1 {
            let (roster_end, t_end) = &after[after.len() - 1];
            assert!(
                !roster_end.is_empty(),
                "someone is still in the room at the end"
            );
            for step in [30_000, 60_000] {
                let (bytes, records, t) = keepalive(t_end + step, roster_end);
                out.push((bytes, Origin::Keepalive(records, t)));
            }
            later = 60_000;
        }
        let mut manifest_chunks = Vec::new();
        for (seq, (bytes, origin)) in out.into_iter().enumerate() {
            let seq = seq as u32;
            let key = chunk_key(
                &truth.prefix,
                truth.community_id,
                truth.channel_id,
                session.session_id,
                seq,
            );
            let bytes = with_seq(&bytes, seq);
            if let Some(manifest) = &manifest {
                let (records, first_t_ms, last_t_ms) = match origin {
                    Origin::Recorded(old_seq) => {
                        let old = manifest
                            .chunks
                            .iter()
                            .find(|c| c.seq == old_seq)
                            .expect("manifest lists every chunk");
                        (old.records, old.first_t_ms, old.last_t_ms)
                    }
                    Origin::Keepalive(records, t) => (records, t, t),
                };
                manifest_chunks.push(ManifestChunk {
                    seq,
                    key: key.clone(),
                    bytes: bytes.len() as u64,
                    records,
                    first_t_ms,
                    last_t_ms,
                });
            }
            files.push((format!("recordings/{key}"), bytes));
        }
        if let Some(mut manifest) = manifest {
            manifest.chunks = manifest_chunks;
            let key = format!("{}manifest.json", dir);
            files.push((key, serde_json::to_vec_pretty(&manifest).expect("manifest")));
        }
    }
    (
        FakeMeeting {
            truth: truth.clone(),
            files,
        },
        later,
    )
}

#[tokio::test]
async fn roster_only_keepalive_chunks_change_nothing_but_the_end() {
    let meeting = fake_meeting(7);
    let plain_dir = tempfile::tempdir().expect("tempdir");
    let plain = run_worker(
        plain_dir.path(),
        &meeting,
        &mut EnergyDetector,
        &TruthStt::new(&meeting.truth),
    )
    .await;

    let (alive, later) = with_keepalives(&meeting);
    let alive_dir = tempfile::tempdir().expect("tempdir");
    let output = run_worker(
        alive_dir.path(),
        &alive,
        &mut EnergyDetector,
        &TruthStt::new(&alive.truth),
    )
    .await;

    // Same frames, same people, same pieces and text.
    assert_eq!(output.report.demux, plain.report.demux);
    assert_eq!(output.transcript.segments, plain.transcript.segments);
    assert_eq!(
        output.transcript.participants,
        plain.transcript.participants
    );
    // Nothing reads as lost or broken.
    let store = LocalStore::new(alive_dir.path().join("recordings"));
    let truth = &alive.truth;
    let meetings = collect_meetings(
        &store,
        &truth.prefix,
        truth.community_id,
        truth.channel_id,
        10 * 60_000,
    )
    .await
    .expect("collect")
    .meetings;
    assert_eq!(meetings.len(), 1);
    assert_eq!(meetings[0].losses(), Default::default());
    // The fixture really added three roster-only chunks, and all were read.
    let chunk_files = |m: &FakeMeeting| m.files.iter().filter(|(p, _)| p.ends_with(".bhr")).count();
    assert_eq!(chunk_files(&alive), chunk_files(&meeting) + 3);
    let read: usize = meetings[0].sessions.iter().map(|s| s.chunks.len()).sum();
    assert_eq!(read, chunk_files(&alive));
    // The meeting now ends at the last keepalive: everyone was still there.
    assert_eq!(
        output.transcript.duration_ms,
        plain.transcript.duration_ms + later
    );
    assert!(check(&output.transcript, truth, Tolerance::default()).pass);
}

/// Test double: says "말" for every piece, so pieces can be counted
/// without an answer sheet.
struct SaysSomething;

impl SpeechToText for SaysSomething {
    fn info(&self) -> SttInfo {
        SttInfo {
            engine: "says-something".into(),
            region: "local".into(),
            language: "ko-KR".into(),
            billed_seconds: 0,
        }
    }

    async fn transcribe(&self, _: SttRequest<'_>) -> Result<SttOutput, SttError> {
        Ok(SttOutput {
            text: "말".into(),
            billed_seconds: 0,
        })
    }
}

/// Writes one session's chunks the way the recorder does: a chunk holds at
/// most 30 s of records and opens by re-stating the roster as `type=2`;
/// a keepalive chunk holds only that re-statement. Chunk numbers follow on.
struct SessionWriter {
    header: ChunkHeader,
    roster: Roster,
    open: Option<(Vec<u8>, u32, u32)>,
    sealed: Vec<(Vec<u8>, u32)>,
}

impl SessionWriter {
    fn new(session_id: Uuid, start_unix_ms: u64) -> Self {
        Self {
            header: ChunkHeader {
                protocol_version: 2,
                session_id,
                chunk_seq: 0,
                session_start_unix_ms: start_unix_ms,
            },
            roster: Roster::new(),
            open: None,
            sealed: Vec::new(),
        }
    }

    fn open_chunk(&mut self, t_ms: u32) {
        let seq = u32::try_from(self.sealed.len()).expect("seq");
        let mut bytes = ChunkHeader {
            chunk_seq: seq,
            ..self.header
        }
        .encode()
        .to_vec();
        for (&(peer_index, epoch), &pubkey) in &self.roster {
            Record::Join {
                t_ms,
                peer_index,
                epoch,
                pubkey,
            }
            .encode_into(&mut bytes)
            .expect("record");
        }
        self.open = Some((bytes, t_ms, t_ms));
    }

    fn seal(&mut self) {
        if let Some((bytes, _, last)) = self.open.take() {
            self.sealed.push((bytes, last));
        }
    }

    fn push(&mut self, record: Record<'_>) {
        let t_ms = record.t_ms();
        if self
            .open
            .as_ref()
            .is_some_and(|(_, opened, _)| t_ms - opened >= 30_000)
        {
            self.seal();
        }
        if self.open.is_none() {
            self.open_chunk(t_ms);
        }
        if let Some((bytes, _, last)) = self.open.as_mut() {
            record.encode_into(bytes).expect("record");
            *last = t_ms;
        }
        match record {
            Record::Join {
                peer_index,
                epoch,
                pubkey,
                ..
            } => {
                self.roster.insert((peer_index, epoch), pubkey);
            }
            Record::Leave {
                peer_index, epoch, ..
            } => {
                self.roster.remove(&(peer_index, epoch));
            }
            Record::Frame { .. } => {}
        }
    }

    fn keepalive(&mut self, t_ms: u32) {
        self.seal();
        self.open_chunk(t_ms);
        self.seal();
    }

    fn finish(mut self) -> Vec<(Vec<u8>, u32)> {
        self.seal();
        self.sealed
    }
}

/// One person's v2 frames, sent every 20 ms over `[from, to)` ms of the
/// session and received 40 ms later; a tone over `[talk.0, talk.1)`, DTX
/// silence otherwise.
fn sent_frames(from: u32, to: u32, talk: (u32, u32), pitch: f32) -> Vec<(u32, Vec<u8>)> {
    let mut encoder =
        opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip).expect("opus");
    encoder.set_dtx(true).expect("dtx");
    let mut packet = vec![0u8; 4_000];
    let mut out = Vec::new();
    for (n, captured) in (from..to).step_by(20).enumerate() {
        let pcm: Vec<f32> = (0..960)
            .map(|i| {
                let t = captured as f32 / 1_000.0 + i as f32 / 48_000.0;
                let on = (talk.0..talk.1).contains(&captured);
                if on {
                    0.2 * (std::f32::consts::TAU * pitch * t).sin()
                } else {
                    0.0
                }
            })
            .collect();
        let len = encoder.encode_float(&pcm, &mut packet).expect("encode");
        let seq = u16::try_from(n % 65_536).expect("seq");
        let mut frame = MediaHeader {
            seq,
            ts_48k: u32::try_from(n).expect("n") * 960,
            level_dbov: level_dbov(&pcm),
            flags: if len <= 2 { FLAG_DTX } else { 0 },
        }
        .encode()
        .to_vec();
        frame.extend_from_slice(&packet[..len]);
        out.push((captured + 20 + 40, frame));
    }
    out
}

/// Session records of two people (slots 0 and 1) sending `frames`, in
/// receive order, after both joined at `t = 0`.
fn talk_into(writer: &mut SessionWriter, people: [[u8; 32]; 2], frames: [Vec<(u32, Vec<u8>)>; 2]) {
    for (peer_index, pubkey) in people.iter().enumerate() {
        writer.push(Record::Join {
            t_ms: 0,
            peer_index: u8::try_from(peer_index).expect("slot"),
            epoch: 1,
            pubkey: *pubkey,
        });
    }
    let mut all: Vec<(u32, u8, &[u8])> = Vec::new();
    for (peer_index, frames) in frames.iter().enumerate() {
        for (t, frame) in frames {
            all.push((*t, u8::try_from(peer_index).expect("slot"), frame));
        }
    }
    all.sort_by_key(|&(t, peer, _)| (t, peer));
    for (t_ms, peer_index, payload) in all {
        writer.push(Record::Frame {
            t_ms,
            peer_index,
            epoch: 1,
            payload,
        });
    }
}

/// Write objects into a local store with write times as the recorder would
/// have uploaded them (`session start + last t_ms + 1 s`), keeping only
/// those written by `until` (UTC ms).
async fn store_objects(dir: &Path, objects: &[(String, Vec<u8>, u64)], until: u64) -> LocalStore {
    let store = LocalStore::new(dir);
    for (key, bytes, written) in objects.iter().filter(|o| o.2 <= until) {
        store.put(key, bytes.clone()).await.expect("put");
        let file = std::fs::File::options()
            .write(true)
            .open(dir.join(key))
            .expect("open");
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(*written))
            .expect("set write time");
    }
    store
}

/// Everyone muted for 11 minutes. Session 1 (chunks only: its pod dies at
/// the end of the mute) holds 6 s of talk, then nothing but a roster-only
/// keepalive every 30 s; session 2 starts on a new owner right after and
/// holds 12 s more with talk. Without the keepalives session 1 would end
/// after 6 s: an 11-minute hole that splits the meeting in two, and a
/// meeting that looks over 10 minutes into the mute.
#[tokio::test]
async fn an_eleven_minute_mute_with_keepalives_stays_one_live_meeting() {
    const MINUTE: u64 = 60_000;
    let (prefix, community, channel) = ("h", Uuid::from_u128(1), Uuid::from_u128(2));
    let people = [[0xa1; 32], [0xb2; 32]];
    let t0 = 1_791_781_200_000u64;
    let mute = (6_000u32, 666_000u32);
    let s2_start = t0 + 667_000;
    let (s1, s2) = (Uuid::from_u128(10), Uuid::from_u128(11));

    // Session 1: A talks 0.5–4.5 s, both muted from 6 s for 11 minutes.
    let mut writer = SessionWriter::new(s1, t0);
    talk_into(
        &mut writer,
        people,
        [
            sent_frames(0, mute.0, (500, 4_500), 220.0),
            sent_frames(0, mute.0, (0, 0), 0.0),
        ],
    );
    let mut keepalive_ts = Vec::new();
    for t in (mute.0 + 30_000..=mute.1).step_by(30_000) {
        writer.keepalive(t);
        keepalive_ts.push(t);
    }
    assert_eq!(keepalive_ts.len(), 22);
    let session_1 = writer.finish();

    // Session 2: B talks 3–7 s, both leave at 12 s, manifest written.
    let mut writer = SessionWriter::new(s2, s2_start);
    talk_into(
        &mut writer,
        people,
        [
            sent_frames(0, 12_000, (0, 0), 0.0),
            sent_frames(0, 12_000, (3_000, 7_000), 330.0),
        ],
    );
    for (peer_index, pubkey) in people.iter().enumerate() {
        writer.push(Record::Leave {
            t_ms: 12_000,
            peer_index: u8::try_from(peer_index).expect("slot"),
            epoch: 1,
            pubkey: *pubkey,
        });
    }
    let session_2 = writer.finish();

    let mut objects: Vec<(String, Vec<u8>, u64)> = Vec::new();
    for (session, start, chunks) in [(s1, t0, &session_1), (s2, s2_start, &session_2)] {
        for (seq, (bytes, last)) in chunks.iter().enumerate() {
            let seq = u32::try_from(seq).expect("seq");
            assert_eq!(decode_chunk(bytes).expect("chunk").0.chunk_seq, seq);
            let key = chunk_key(prefix, community, channel, session, seq);
            objects.push((key, bytes.clone(), start + u64::from(*last) + 1_000));
        }
    }
    let manifest = Manifest {
        format: FORMAT.into(),
        community_id: community,
        channel_id: channel,
        parent_channel_id: None,
        session_id: s2,
        started_at: format_utc_millis(s2_start),
        ended_at: format_utc_millis(s2_start + 12_000),
        duration_ms: 12_000,
        protocol_version: 2,
        end_reason: EndReason::RoomEmpty,
        chunks: Vec::new(),
        participants: people
            .iter()
            .enumerate()
            .map(|(i, pubkey)| ManifestParticipant {
                pubkey: hex::encode(pubkey),
                peer_index: u8::try_from(i).expect("slot"),
                epoch: 1,
                joined_t_ms: 0,
                left_t_ms: 12_000,
            })
            .collect(),
        dropped_frames: 0,
        lost_chunks: 0,
    };
    objects.push((
        manifest_key(prefix, community, channel, s2),
        serde_json::to_vec(&manifest).expect("manifest"),
        s2_start + 13_000,
    ));
    // Session 1 is its talk chunk(s) followed by the 22 keepalives, each only
    // the two-person roster: no frame records.
    let talk_chunks = session_1.len() - keepalive_ts.len();
    for (bytes, _) in &session_1[talk_chunks..] {
        let records: Vec<_> = decode_chunk(bytes)
            .expect("chunk")
            .1
            .map(|r| r.expect("record"))
            .collect();
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|r| matches!(r, Record::Join { .. })));
    }
    let is_keepalive = |key: &str| {
        (talk_chunks..session_1.len()).any(|seq| {
            let seq = u32::try_from(seq).expect("seq");
            key == chunk_key(prefix, community, channel, s1, seq)
        })
    };
    let without_keepalives: Vec<_> = objects
        .iter()
        .filter(|o| !is_keepalive(&o.0))
        .cloned()
        .collect();
    assert_eq!(objects.len() - without_keepalives.len(), 22);

    // (b) Halfway and 10.5 minutes into the mute the meeting is not over;
    // without keepalives it would look over at 10.5 minutes.
    for minutes_in in [5.5f64, 10.5] {
        let now = t0 + u64::from(mute.0) + (minutes_in * 60_000.0) as u64;
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_objects(dir.path(), &objects, now).await;
        let meetings = collect_meetings(&store, prefix, community, channel, 10 * MINUTE)
            .await
            .expect("collect")
            .meetings;
        assert_eq!(meetings.len(), 1);
        assert!(
            !meetings[0].is_quiet(now, 10 * MINUTE),
            "{minutes_in} min into the mute"
        );
    }
    let now = t0 + u64::from(mute.0) + 630_000;
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_objects(dir.path(), &without_keepalives, now).await;
    let meetings = collect_meetings(&store, prefix, community, channel, 10 * MINUTE)
        .await
        .expect("collect")
        .meetings;
    assert!(
        meetings[0].is_quiet(now, 10 * MINUTE),
        "without keepalives it looks over"
    );

    // (a) The whole recording is one meeting; without keepalives, two.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_objects(dir.path(), &objects, u64::MAX).await;
    let mut meetings = collect_meetings(&store, prefix, community, channel, 10 * MINUTE)
        .await
        .expect("collect")
        .meetings;
    assert_eq!(meetings.len(), 1, "one meeting across the mute");
    assert_eq!(meetings[0].sessions.len(), 2);
    assert_eq!(meetings[0].losses(), Default::default());
    let plain_dir = tempfile::tempdir().expect("tempdir");
    let plain = store_objects(plain_dir.path(), &without_keepalives, u64::MAX).await;
    let split = collect_meetings(&plain, prefix, community, channel, 10 * MINUTE)
        .await
        .expect("collect")
        .meetings;
    assert_eq!(
        split.len(),
        2,
        "without keepalives the mute splits the meeting"
    );

    // (c) No speech pieces inside the mute, nothing broken or unknown, and
    // both people's talk is there.
    let meeting = meetings.remove(0);
    let output = build_minutes(
        &meeting,
        &mut EnergyDetector,
        &SaysSomething,
        &mut SttLedger::in_memory(),
        &settings(),
    )
    .await
    .expect("build minutes");
    assert_eq!(output.report.demux.broken_chunks, 0);
    assert_eq!(output.report.demux.unknown_sender, 0);
    let segments = &output.transcript.segments;
    let in_mute = |s: &&buzz_huddle_minutes::transcript::Segment| {
        s.start_ms < u64::from(mute.1) && s.end_ms > u64::from(mute.0) + 100
    };
    assert_eq!(segments.iter().filter(in_mute).count(), 0, "{segments:#?}");
    for pubkey in &people {
        let who = hex::encode(pubkey);
        assert!(segments.iter().any(|s| s.speaker == who), "{who} talked");
    }
    assert_eq!(output.transcript.duration_ms, 667_000 + 12_000);
}

/// The FLEURS meeting from the command line, as a test. Needs the
/// scripts/huddle-stt-bench FLEURS cache and `buzz-huddle-minutes
/// fetch-models`. Hard checks (speakers, every sentence once, order, no
/// false alarms) must hold on every seed; the time limits may miss on a
/// sentence whose onset Silero sometimes skips (see the report).
#[tokio::test]
#[ignore = "needs the FLEURS cache from scripts/huddle-stt-bench and the Silero model"]
async fn fleurs_meeting_with_silero() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let model = silero_vad_path(&root.join(".cache"));
    let manifest = root.join("../../scripts/huddle-stt-bench/.cache/fleurs-ko-test/manifest.jsonl");
    let mut clips = load_bench_clips(&manifest, SENTENCES).expect("FLEURS clips");
    let mut silero = SileroVad::new(&model, SileroSettings::default()).expect("Silero model");
    mark_speech(&mut clips, &mut silero).expect("mark speech");
    let mut out_of_limits = 0;
    for seed in 1..=8 {
        let meeting = build_fake_meeting(&clips, seed, "huddles", BASE_UNIX_MS).expect("build");
        let dir = tempfile::tempdir().expect("tempdir");
        let stt = TruthStt::new(&meeting.truth);
        let output = run_worker(dir.path(), &meeting, &mut silero, &stt).await;
        let report = check(&output.transcript, &meeting.truth, Tolerance::default());
        let (_, mix) = read_wav_mono_i16(&output.mixed_audio).expect("mixed audio");
        let mix_report = check_mix(&mix, &meeting.truth, &speaker_wavs(&meeting));
        eprintln!(
            "seed {seed}: pass {} pieces {} units {} under-half {} min-coverage {:.2} start {:?} end {:?} | mix pass {} lag {}..{} median {} min-corr {:.3}",
            report.pass,
            report.segments,
            report.speech_units,
            report.speech_units_under_half_covered,
            report.min_unit_coverage,
            report.start_error_ms,
            report.end_error_ms,
            mix_report.pass,
            mix_report.lag_min_ms,
            mix_report.lag_max_ms,
            mix_report.lag_median_ms,
            mix_report.min_correlation
        );
        assert!(mix_report.pass, "seed {seed}: {mix_report:#?}");
        assert_eq!(report.speech_units_under_half_covered, 0, "seed {seed}");
        assert_eq!(report.speaker_wrong, 0, "seed {seed}");
        assert_eq!(report.false_alarms, 0, "seed {seed}");
        assert_eq!(report.sentences_found, SENTENCES, "seed {seed}");
        assert_eq!(report.order_inversions, 0, "seed {seed}");
        out_of_limits += report.groups_out_of_tolerance;
    }
    assert!(
        out_of_limits <= 1,
        "{out_of_limits} groups outside the time limits"
    );
}

/// Runner options for a meeting of [`fake_meeting`]: an hour after it
/// started, no waiting for quiet (its files were written just now).
fn run_options(truth: &Truth) -> RunOptions {
    RunOptions {
        prefix: truth.prefix.clone(),
        now_unix_ms: BASE_UNIX_MS + 3_600_000,
        quiet_ms: 0,
        overwrite: false,
    }
}

/// Which of the two workers a child process of
/// [`two_workers_at_once_pay_for_one_run`] is ("0" or "1").
const LOCK_CHILD: &str = "BUZZ_MINUTES_TEST_LOCK_CHILD";
/// The folder the two workers share.
const LOCK_DIR: &str = "BUZZ_MINUTES_TEST_LOCK_DIR";

/// Test double wrapper: the first request waits (up to 20 s) until `file`
/// exists. The worker holding the meeting is then still in the middle of
/// transcribing when the other worker reaches the meeting, without relying
/// on timing.
struct WaitsForFile<'a, T> {
    inner: Counting<'a, T>,
    file: PathBuf,
    waited: AtomicBool,
}

impl<T: SpeechToText + Sync> SpeechToText for WaitsForFile<'_, T> {
    fn info(&self) -> SttInfo {
        self.inner.info()
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        if !self.waited.swap(true, Ordering::Relaxed) {
            let deadline = Instant::now() + Duration::from_secs(20);
            while !self.file.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        self.inner.transcribe(request).await
    }
}

/// One of the two workers of [`two_workers_at_once_pay_for_one_run`]. Does
/// nothing when run on its own.
#[tokio::test]
async fn lock_child() {
    let Ok(n) = std::env::var(LOCK_CHILD) else {
        return;
    };
    let n: usize = n.parse().expect("child number");
    let dir = PathBuf::from(std::env::var(LOCK_DIR).expect("shared folder"));
    let truth: Truth =
        serde_json::from_slice(&std::fs::read(dir.join("truth.json")).expect("truth"))
            .expect("truth json");
    let store = LocalStore::new(dir.join("recordings"));
    let meeting = plan_meetings(
        &store,
        &truth.prefix,
        truth.community_id,
        truth.channel_id,
        10 * 60_000,
    )
    .await
    .expect("plan")
    .meetings
    .remove(0);
    let truth_stt = TruthStt::new(&truth);
    let stt = WaitsForFile {
        inner: Counting::new(&truth_stt),
        file: dir.join(format!("child-{}.txt", 1 - n)),
        waited: AtomicBool::new(false),
    };
    let minutes = LocalMinutes::open(&dir.join("minutes")).expect("minutes folder");
    let done = run_meeting(
        &minutes,
        &store,
        &meeting,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &run_options(&truth),
    )
    .await;
    // A failure is a result too: what was sent is reported either way.
    let outcome = match done {
        Ok(Done::Written { .. }) => "written".to_string(),
        Ok(Done::Locked) => "locked".to_string(),
        Ok(Done::Skipped(skip)) => format!("skipped-{skip:?}"),
        Err(_) => "failed".to_string(),
    };
    std::fs::write(
        dir.join(format!("child-{n}.txt")),
        format!("{outcome} {}", stt.inner.sent()),
    )
    .expect("result");
}

/// Two workers on the same meeting at the same time, as two processes: one
/// transcribes it, the other sends nothing, so the requests add up to one
/// run. (Without the lock both would wait out the 20 s, then both pay.)
#[test]
fn two_workers_at_once_pay_for_one_run() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    write_fake_meeting(dir.path(), &meeting).expect("write fake meeting");
    let exe = std::env::current_exe().expect("test binary");
    let children: Vec<_> = (0..2)
        .map(|n| {
            Command::new(&exe)
                .args(["lock_child", "--exact", "--nocapture"])
                .env(LOCK_CHILD, n.to_string())
                .env(LOCK_DIR, dir.path())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("start worker")
        })
        .collect();
    for child in children {
        let output = child.wait_with_output().expect("worker");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let mut results: Vec<(String, usize)> = (0..2)
        .map(|n| {
            let text = std::fs::read_to_string(dir.path().join(format!("child-{n}.txt")))
                .expect("worker result");
            let (outcome, sent) = text.split_once(' ').expect("outcome and count");
            (outcome.to_string(), sent.parse().expect("count"))
        })
        .collect();
    results.sort();

    let minutes = dir.path().join("minutes");
    let scripts: Vec<PathBuf> = std::fs::read_dir(&minutes)
        .expect("minutes folder")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.to_string_lossy().ends_with(".transcript.json"))
        .collect();
    assert_eq!(scripts.len(), 1);
    let transcript: Transcript =
        serde_json::from_slice(&std::fs::read(&scripts[0]).expect("script")).expect("json");
    let pieces = transcript.segments.len();
    assert!(pieces > 0);
    // The money: the two workers together paid for one run.
    let sent: usize = results.iter().map(|(_, sent)| sent).sum();
    assert_eq!(sent, pieces, "{results:?}");
    // One wrote the script. The other found the meeting held (the usual
    // case: the holder waits for it) or, had it started more than the
    // holder's wait late, already done — never transcribed it again.
    let outcomes: Vec<&str> = results
        .iter()
        .map(|(outcome, _)| outcome.as_str())
        .collect();
    assert!(
        outcomes == ["locked", "written"] || outcomes == ["skipped-AlreadyProcessed", "written"],
        "{results:?}"
    );
}

/// Test double: speech detection that always fails.
struct FailingDetector;

impl SpeechDetector for FailingDetector {
    fn detect(&mut self, _: &[f32]) -> Result<Vec<SpeechSpan>, VadError> {
        Err(VadError::CreateFailed)
    }
}

/// A ledger that cannot be opened fails that meeting before anything is
/// sent (going on without it could pay twice), without stopping the run.
#[tokio::test]
async fn an_unopenable_ledger_fails_the_meeting_before_sending() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let plan = plan_fake(dir.path(), &meeting).await;
    let first = plan.first_session_id();
    let minutes = LocalMinutes::open(&dir.path().join("minutes")).expect("minutes folder");
    // A folder where the ledger file should be.
    std::fs::create_dir(minutes.ledger_path(first)).expect("folder");
    let store = LocalStore::new(dir.path().join("recordings"));
    let truth_stt = TruthStt::new(&meeting.truth);
    let stt = Counting::new(&truth_stt);
    let result = run_meeting(
        &minutes,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &run_options(&meeting.truth),
    )
    .await;
    match result {
        Err(error @ MeetingError::Ledger(_)) => assert!(!error.stops_the_run()),
        other => panic!("{other:?}"),
    }
    assert_eq!(stt.sent(), 0);
    assert!(!minutes.transcript_path(first).exists());
}

/// The runner on one meeting with a ledger file:
/// - a run that stopped before transcribing (speech detection failed) or
///   in the middle (credentials refused) is not counted as a run;
/// - a torn line left by a crash is counted in the report;
/// - once written, the meeting is skipped and nothing is sent again.
#[tokio::test]
async fn only_finished_runs_count_and_torn_ledger_lines_are_reported() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let plan = plan_fake(dir.path(), &meeting).await;
    let first = plan.first_session_id();
    let minutes = LocalMinutes::open(&dir.path().join("minutes")).expect("minutes folder");
    let store = LocalStore::new(dir.path().join("recordings"));
    let options = run_options(&meeting.truth);
    // A crash in an earlier process left half a line.
    std::fs::write(minutes.ledger_path(first), b"{\"kind\":\"done\",\"ke").expect("torn line");

    let truth_stt = TruthStt::new(&meeting.truth);
    let stt = Counting::new(&truth_stt);
    let result = run_meeting(
        &minutes,
        &store,
        &plan,
        &mut FailingDetector,
        &stt,
        &settings(),
        &options,
    )
    .await;
    assert!(
        matches!(result, Err(MeetingError::Minutes(MinutesError::Vad(_)))),
        "{result:?}"
    );
    assert_eq!(stt.sent(), 0);

    // The 3rd piece's first attempt is refused credentials.
    let refusing = TruthStt::new(&meeting.truth).with_fault(Fault {
        last_piece: 3,
        ..fault(SttErrorKind::Auth, 3, 1)
    });
    let stt = Counting::new(&refusing);
    let result = run_meeting(
        &minutes,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &options,
    )
    .await;
    assert!(
        matches!(
            result,
            Err(MeetingError::Minutes(MinutesError::SttStopped(
                SttErrorKind::Auth
            )))
        ),
        "{result:?}"
    );
    assert_eq!(stt.sent(), 3);

    let stt = Counting::new(&truth_stt);
    let done = run_meeting(
        &minutes,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &options,
    )
    .await
    .expect("written");
    let Done::Written { output, .. } = done else {
        panic!("{done:?}");
    };
    assert_eq!(output.report.run, 1, "the two stopped runs do not count");
    assert_eq!(output.report.stt_reused, 2);
    assert_eq!(stt.sent(), output.transcript.segments.len() - 2);
    assert_eq!(output.report.ledger_unreadable_lines, 1);

    let stt = Counting::new(&truth_stt);
    let done = run_meeting(
        &minutes,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &options,
    )
    .await
    .expect("skipped");
    assert!(
        matches!(done, Done::Skipped(Skip::AlreadyProcessed)),
        "{done:?}"
    );
    assert_eq!(stt.sent(), 0);
}

/// Flip the lowest bit of the last Opus byte of the loudest recorded frame
/// (the middle of a word, so speech detection cuts the same).
fn flip_loudest_frame(meeting: &mut Meeting) {
    // (level, session, chunk, byte to flip)
    let mut loudest: Option<(i8, usize, usize, usize)> = None;
    for (s, session) in meeting.sessions.iter().enumerate() {
        for (c, chunk) in session.chunks.iter().enumerate() {
            let (_, records) = decode_chunk(&chunk.bytes).expect("chunk");
            for record in records {
                let Record::Frame { payload, .. } = record.expect("record") else {
                    continue;
                };
                let Some((Some(header), _)) = split_frame(session.protocol_version, payload) else {
                    continue;
                };
                let at =
                    payload.as_ptr() as usize - chunk.bytes.as_ptr() as usize + payload.len() - 1;
                if loudest.is_none_or(|(level, ..)| header.level_dbov > level) {
                    loudest = Some((header.level_dbov, s, c, at));
                }
            }
        }
    }
    let (_, s, c, at) = loudest.expect("a frame");
    meeting.sessions[s].chunks[c].bytes[at] ^= 1;
}

/// The ledger key is made from the recorded frames, the cut and the
/// settings version:
/// - one recorded frame changed by one bit: only the piece holding it is
///   sent again, and the cuts stay the same;
/// - another settings version: every piece is sent again.
#[tokio::test]
async fn the_ledger_key_follows_recorded_frames_and_settings() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let mut gathered = gather(dir.path(), &meeting).await;
    let truth_stt = TruthStt::new(&meeting.truth);
    let stt = Counting::new(&truth_stt);
    let mut ledger = SttLedger::in_memory();
    let before = run_again(&gathered, &stt, &mut ledger)
        .await
        .expect("first run");
    let pieces = stt.sent();
    assert_eq!(pieces, before.transcript.segments.len());

    flip_loudest_frame(&mut gathered);
    let after = run_again(&gathered, &stt, &mut ledger)
        .await
        .expect("changed frame");
    assert_eq!(stt.sent() - pieces, 1, "only the piece holding the frame");
    let cuts = |output: &MinutesOutput| -> Vec<(String, u64, u64)> {
        output
            .transcript
            .segments
            .iter()
            .map(|s| (s.speaker.clone(), s.start_ms, s.end_ms))
            .collect()
    };
    assert_eq!(cuts(&after), cuts(&before));

    let sent = stt.sent();
    let other = MinutesSettings {
        ledger_version: "test-2".into(),
        ..settings()
    };
    build_minutes(&gathered, &mut EnergyDetector, &stt, &mut ledger, &other)
        .await
        .expect("new settings");
    assert_eq!(stt.sent() - sent, pieces);
}

/// Test double wrapper: each request lets the runtime turn a few times
/// before answering, and the most requests in flight at once is kept.
struct InFlight<'a, T> {
    inner: &'a T,
    now: AtomicUsize,
    most: AtomicUsize,
}

impl<T: SpeechToText + Sync> SpeechToText for InFlight<'_, T> {
    fn info(&self) -> SttInfo {
        self.inner.info()
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        let now = self.now.fetch_add(1, Ordering::Relaxed) + 1;
        self.most.fetch_max(now, Ordering::Relaxed);
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
        let output = self.inner.transcribe(request).await;
        self.now.fetch_sub(1, Ordering::Relaxed);
        output
    }
}

/// Pieces go out four at a time (the policy's `concurrency`), and the
/// script is the same as when they go one by one.
#[tokio::test]
async fn up_to_four_requests_are_in_flight_at_once() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let gathered = gather(dir.path(), &meeting).await;
    let mut scripts = Vec::new();
    for concurrency in [4, 1] {
        // A fresh answer sheet: it hands out each sentence once.
        let truth_stt = TruthStt::new(&meeting.truth);
        let stt = InFlight {
            inner: &truth_stt,
            now: AtomicUsize::new(0),
            most: AtomicUsize::new(0),
        };
        let settings = MinutesSettings {
            stt: SttPolicy {
                concurrency,
                ..settings().stt
            },
            ..settings()
        };
        let output = build_minutes(
            &gathered,
            &mut EnergyDetector,
            &stt,
            &mut SttLedger::in_memory(),
            &settings,
        )
        .await
        .expect("written");
        assert_eq!(stt.most.load(Ordering::Relaxed), concurrency);
        assert!(check(&output.transcript, &meeting.truth, Tolerance::default()).pass);
        scripts.push(output.transcript.segments);
    }
    assert_eq!(scripts[0], scripts[1]);
    assert_eq!(SttPolicy::default().concurrency, 4);
}

const MINUTES_BUCKET: &str = "minutes";

/// The minutes bucket on a fake Cloud Storage, with holds timed by `clock`.
async fn gcs_home(clock: fn() -> u64) -> (GcsMinutes, FakeGcs, Arc<Gcs>) {
    let fake = FakeGcs::start(3_600).await;
    fake.accept_token("t");
    let tokens = Tokens::new(TokenSource::Static(AccessToken::new("t"))).expect("tokens");
    let gcs = Arc::new(Gcs::with_base_url(tokens, fake.url()).expect("client"));
    (
        GcsMinutes::new(gcs.clone(), MINUTES_BUCKET).with_clock(clock),
        fake,
        gcs,
    )
}

/// One hour after the fake meeting started (its runner options' now).
fn an_hour_in() -> u64 {
    BASE_UNIX_MS + 3_600_000
}

fn generations(fake: &FakeGcs) -> BTreeMap<String, u64> {
    fake.objects(MINUTES_BUCKET)
        .into_iter()
        .map(|(name, stored)| (name, stored.generation))
        .collect()
}

/// A meeting through the minutes bucket: the script under `transcripts/`,
/// one piece object per piece, `runs/1` and `bundles/1.jsonl` at the end,
/// the lease gone, no pubkey in any name. Run again (replacing the script):
/// nothing is sent, everything comes from the bundle, and no object of the
/// first run is written again.
#[tokio::test]
async fn a_meeting_goes_through_the_minutes_bucket() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let plan = plan_fake(dir.path(), &meeting).await;
    let store = LocalStore::new(dir.path().join("recordings"));
    let (home, fake, _) = gcs_home(an_hour_in).await;
    let truth_stt = TruthStt::new(&meeting.truth);
    let stt = Counting::new(&truth_stt);
    let options = run_options(&meeting.truth);
    let done = run_meeting(
        &home,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &options,
    )
    .await
    .expect("written");
    let Done::Written { output, script } = done else {
        panic!("{done:?}");
    };
    let pieces = output.transcript.segments.len();
    assert_eq!(stt.sent(), pieces);
    let ledger = GcsMinutes::ledger_prefix(&plan);
    assert_eq!(
        script,
        format!("gs://{MINUTES_BUCKET}/{}", GcsMinutes::script_key(&plan))
    );
    let names: Vec<String> = fake.objects(MINUTES_BUCKET).into_keys().collect();
    let count = |part: &str| {
        names
            .iter()
            .filter(|name| name.starts_with(&format!("{ledger}{part}")))
            .count()
    };
    assert_eq!(count("pieces/"), pieces);
    assert_eq!(count("runs/"), 1);
    assert_eq!(count("bundles/"), 1);
    assert_eq!(count("lease"), 0, "the hold is let go");
    assert!(names.contains(&GcsMinutes::script_key(&plan)));
    for speaker in &meeting.truth.speakers {
        assert!(
            names.iter().all(|name| !name.contains(&speaker.pubkey)),
            "a pubkey in an object name"
        );
    }

    let first_run = generations(&fake);
    let reads_before = fake.media_reads();
    let stt = Counting::new(&truth_stt);
    let again = run_meeting(
        &home,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &RunOptions {
            overwrite: true,
            ..options.clone()
        },
    )
    .await
    .expect("written again");
    let Done::Written { output, .. } = again else {
        panic!("{again:?}");
    };
    assert_eq!(stt.sent(), 0);
    assert_eq!(output.report.stt_reused, pieces as u64);
    assert_eq!(output.report.run, 2);
    // The ledger came from the bundle (one read), not piece by piece; the
    // other read is the script, checked for its sessions.
    assert_eq!(fake.media_reads() - reads_before, 2);
    let second_run = generations(&fake);
    for (name, generation) in &first_run {
        if name.starts_with(&ledger) {
            assert_eq!(second_run.get(name), Some(generation), "{name} rewritten");
        }
    }

    // Without replacing, the meeting is done.
    let stt = Counting::new(&truth_stt);
    let skipped = run_meeting(
        &home,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &options,
    )
    .await
    .expect("skipped");
    assert!(
        matches!(skipped, Done::Skipped(Skip::AlreadyProcessed)),
        "{skipped:?}"
    );
    assert_eq!(stt.sent(), 0);
}

fn lease(expires_at_unix_ms: u64) -> Vec<u8> {
    serde_json::json!({
        "format": LEASE_FORMAT,
        "holder": Uuid::from_u128(99),
        "expires_at": "-",
        "expires_at_unix_ms": expires_at_unix_ms,
    })
    .to_string()
    .into_bytes()
}

/// A meeting another worker holds is left alone until its lease expires;
/// then it is taken over, processed, and let go.
#[tokio::test]
async fn a_held_meeting_waits_for_its_lease_to_expire() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let plan = plan_fake(dir.path(), &meeting).await;
    let store = LocalStore::new(dir.path().join("recordings"));
    let (home, fake, _) = gcs_home(an_hour_in).await;
    let name = format!("{}lease", GcsMinutes::ledger_prefix(&plan));
    let truth_stt = TruthStt::new(&meeting.truth);

    let held = fake.insert(MINUTES_BUCKET, &name, lease(an_hour_in() + 1));
    let stt = Counting::new(&truth_stt);
    let done = run_meeting(
        &home,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &run_options(&meeting.truth),
    )
    .await
    .expect("locked");
    assert!(matches!(done, Done::Locked), "{done:?}");
    assert_eq!(stt.sent(), 0);
    assert_eq!(
        fake.objects(MINUTES_BUCKET)[&name].generation,
        held,
        "someone else's lease left alone"
    );

    fake.insert(MINUTES_BUCKET, &name, lease(an_hour_in() - 1));
    let done = run_meeting(
        &home,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &run_options(&meeting.truth),
    )
    .await
    .expect("written");
    assert!(matches!(done, Done::Written { .. }), "{done:?}");
    assert!(!fake.objects(MINUTES_BUCKET).contains_key(&name));
}

/// With the ledger in the bucket: an auth stop keeps what was paid for and
/// counts no run; a piece object that cannot be read is counted and that
/// piece sent again; nothing in `ledger/` is overwritten, not even the
/// unreadable object.
#[tokio::test]
async fn the_bucket_ledger_keeps_paid_pieces_and_counts_unreadable_ones() {
    let meeting = fake_meeting(7);
    let dir = tempfile::tempdir().expect("tempdir");
    let plan = plan_fake(dir.path(), &meeting).await;
    let store = LocalStore::new(dir.path().join("recordings"));
    let (home, fake, gcs) = gcs_home(an_hour_in).await;
    let prefix = GcsMinutes::ledger_prefix(&plan);
    let refusing = TruthStt::new(&meeting.truth).with_fault(Fault {
        last_piece: 3,
        ..fault(SttErrorKind::Auth, 3, 1)
    });
    let stt = Counting::new(&refusing);
    let result = run_meeting(
        &home,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &run_options(&meeting.truth),
    )
    .await;
    assert!(
        matches!(
            result,
            Err(MeetingError::Minutes(MinutesError::SttStopped(
                SttErrorKind::Auth
            )))
        ),
        "{result:?}"
    );
    let paid: Vec<String> = fake
        .objects(MINUTES_BUCKET)
        .into_keys()
        .filter(|name| name.starts_with(&format!("{prefix}pieces/")))
        .collect();
    assert_eq!(paid.len(), 2);
    assert!(fake
        .objects(MINUTES_BUCKET)
        .keys()
        .all(|name| !name.contains("/runs/") && !name.ends_with("lease")));

    // One of the two paid pieces gets torn.
    let torn = fake.insert(MINUTES_BUCKET, &paid[0], b"{\"kind\":\"do".to_vec());
    let truth_stt = TruthStt::new(&meeting.truth);
    let stt = Counting::new(&truth_stt);
    let done = run_meeting(
        &home,
        &store,
        &plan,
        &mut EnergyDetector,
        &stt,
        &settings(),
        &run_options(&meeting.truth),
    )
    .await
    .expect("written");
    let Done::Written { output, .. } = done else {
        panic!("{done:?}");
    };
    let pieces = output.transcript.segments.len();
    assert_eq!(output.report.run, 1, "the stopped run does not count");
    assert_eq!(output.report.ledger_unreadable_lines, 1);
    assert_eq!(output.report.stt_reused, 1);
    assert_eq!(stt.sent(), pieces - 1);
    assert_eq!(
        fake.objects(MINUTES_BUCKET)[&paid[0]].generation,
        torn,
        "never overwritten"
    );

    // A piece written twice keeps its first answer.
    let mut ledger = GcsLedger::open(gcs, MINUTES_BUCKET.into(), prefix.clone())
        .await
        .expect("open");
    let name = format!("{prefix}pieces/{}", "f".repeat(64));
    fake.insert(
        MINUTES_BUCKET,
        &name,
        format!(
            "{{\"kind\":\"done\",\"key\":\"{}\",\"text\":\"first\",\"billed_seconds\":1}}",
            "f".repeat(64)
        )
        .into_bytes(),
    );
    let before = fake.objects(MINUTES_BUCKET)[&name].clone();
    ledger
        .record(
            &"f".repeat(64),
            Outcome::Done {
                text: "second".into(),
                billed_seconds: 1,
            },
        )
        .await
        .expect("record");
    assert_eq!(fake.objects(MINUTES_BUCKET)[&name], before);
}
