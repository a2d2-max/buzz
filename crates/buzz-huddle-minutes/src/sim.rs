//! Fake huddle recordings with a known answer sheet, for end-to-end tests
//! now and the long-audio Chirp 3 comparison later.
//!
//! Three people (A, B, C) take turns reading sentences. The output is what
//! the relay would have written — `.bhr` chunks and a manifest, Opus in v2
//! frames exactly like the desktop client sends them — plus the answer sheet
//! (who said what, when) and one WAV per person with only that person's
//! sentences joined together.
//!
//! The scenario covers: people joining at different times, overlapping
//! speech, a long silence, a muted stretch (no frames at all), a person
//! leaving and rejoining (same routing slot, new epoch), a mesh owner change
//! that splits the meeting into two sessions which both record the same
//! 0.6 s, a different `(peer_index, epoch)` → person mapping in the second
//! session, and a second session without `manifest.json` (its pod died).
//! The network adds latency, jitter, short bursts and lost frames.

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::{bail, Context};
use buzz_huddle_recording::{
    chunk_key, format_utc_millis, manifest_key, ChunkHeader, EndReason, Manifest, ManifestChunk,
    ManifestParticipant, Record, FORMAT,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::audio::{read_wav_mono_i16, resample, write_wav_mono_i16};
use crate::media::{level_dbov, MediaHeader, FLAG_DTX};
use crate::vad::SpeechDetector;

/// Value of [`Truth::format`].
pub const TRUTH_FORMAT: &str = "huddle-fake-meeting-truth/1";
/// Sentences the scenario needs.
pub const SENTENCES: usize = 19;
/// Meeting start of every fake meeting: 2026-10-12T05:00:00.000Z.
pub const BASE_UNIX_MS: u64 = 1_791_781_200_000;
/// Background noise every client adds (uniform, about -71 dBFS RMS).
const NOISE_FLOOR: f32 = 0.000_5;
/// Chunk length, as the relay's default `BUZZ_HUDDLE_RECORDING_CHUNK_SECS`.
const CHUNK_MS: u64 = 30_000;
const LABELS: [&str; 3] = ["A", "B", "C"];
/// Turns: (person, sentences, pause before in ms; negative = starts that
/// much before the previous turn ends).
const TURNS: [(usize, usize, i64); 14] = [
    (0, 2, 2_000),
    (1, 1, 700),
    (0, 1, -1_200),
    (2, 2, 900),
    (1, 1, -1_500),
    (0, 1, 12_000),
    (2, 1, 800),
    (1, 2, 1_000),
    (0, 2, 900), // the owner change happens during this turn
    (2, 1, 700),
    (1, 1, 800),
    (0, 1, -1_000),
    (2, 2, 900),
    (1, 1, 800),
];

/// The answer sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Truth {
    /// Always [`TRUTH_FORMAT`].
    pub format: String,
    /// Community id used in the storage path.
    pub community_id: Uuid,
    /// Huddle channel id.
    pub channel_id: Uuid,
    /// Storage prefix.
    pub prefix: String,
    /// Meeting start, UTC.
    pub started_at: String,
    /// Meeting length, ms.
    pub duration_ms: u64,
    /// The people.
    pub speakers: Vec<TruthSpeaker>,
    /// The recording sessions.
    pub sessions: Vec<TruthSession>,
    /// Every sentence, in start order.
    pub utterances: Vec<TruthUtterance>,
}

/// One person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TruthSpeaker {
    /// `A`, `B`, `C`.
    pub label: String,
    /// Hex x-only pubkey (32 made-up bytes).
    pub pubkey: String,
    /// This person's sentences joined, relative to the output folder.
    pub wav: String,
}

/// One recording session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TruthSession {
    /// Session id.
    pub session_id: Uuid,
    /// Start, ms from the meeting start.
    pub start_ms: u64,
    /// End, ms from the meeting start.
    pub end_ms: u64,
    /// Whether `manifest.json` was written.
    pub manifest: bool,
}

/// One sentence. `start_ms`/`end_ms` are where the speech is, not where the
/// clip is: they come from running speech detection on the clean clip alone
/// (see [`mark_speech`]). A check against them measures what the recording,
/// rebuild and timeline do to the audio, not the detector's own accuracy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TruthUtterance {
    /// Source clip id.
    pub id: String,
    /// Hex pubkey of the speaker.
    pub speaker: String,
    /// Speaker label.
    pub label: String,
    /// Speech start, ms from the meeting start.
    pub start_ms: u64,
    /// Speech end, ms from the meeting start.
    pub end_ms: u64,
    /// What was said.
    pub text: String,
    /// Start inside the speaker's joined WAV, ms.
    pub speaker_wav_start_ms: u64,
    /// End inside the speaker's joined WAV, ms.
    pub speaker_wav_end_ms: u64,
    /// Speech units inside the sentence (the same detection on the clean
    /// clip), `[start, end]` ms from the meeting start.
    pub speech_units_ms: Vec<[u64; 2]>,
}

/// One sentence of source audio, edges trimmed.
#[derive(Debug, Clone)]
pub struct Clip {
    /// Clip id.
    pub id: String,
    /// What is said.
    pub text: String,
    /// 16 kHz mono.
    pub pcm_16k: Vec<f32>,
    /// First speech sample (see [`mark_speech`]).
    pub speech_start: usize,
    /// One past the last speech sample.
    pub speech_end: usize,
    /// Speech units inside the clip, `(start, end)` samples.
    pub speech_units: Vec<(usize, usize)>,
}

impl Clip {
    fn speech_ms(&self) -> (u64, u64) {
        (
            self.speech_start as u64 * 1_000 / 16_000,
            self.speech_end as u64 * 1_000 / 16_000,
        )
    }
}

/// Find where the speech is in each clip by running `detector` on the clip
/// alone — with 1 s of the meeting's noise floor before and after it, as in
/// the meeting (without that lead-in Silero caught one soft onset 530 ms
/// late) — from the first span's start to the last span's end. Energy rules
/// do not work on these recordings: some have a noise floor only 12 dB
/// under the speech, others keep seconds of quiet noise at the edges.
pub fn mark_speech<D: SpeechDetector>(clips: &mut [Clip], detector: &mut D) -> anyhow::Result<()> {
    const PAD: usize = 16_000;
    let mut rng = Rng(0x5eed);
    for clip in clips {
        let mut padded: Vec<f32> = (0..PAD).map(|_| rng.signed_unit() * NOISE_FLOOR).collect();
        padded.extend_from_slice(&clip.pcm_16k);
        padded.extend((0..PAD).map(|_| rng.signed_unit() * NOISE_FLOOR));
        let spans = detector.detect(&padded)?;
        let (Some(first), Some(last)) = (spans.first(), spans.last()) else {
            bail!("no speech found in clip {}", clip.id);
        };
        clip.speech_start = first.start.saturating_sub(PAD);
        clip.speech_end = last.end.saturating_sub(PAD).min(clip.pcm_16k.len());
        let len = clip.pcm_16k.len();
        clip.speech_units = spans
            .iter()
            .map(|s| {
                (
                    s.start.saturating_sub(PAD).min(len),
                    s.end.saturating_sub(PAD).min(len),
                )
            })
            .filter(|(a, b)| b > a)
            .collect();
        if clip.speech_end <= clip.speech_start {
            bail!("no speech found inside clip {}", clip.id);
        }
    }
    Ok(())
}

/// A generated meeting: files to write (path relative to the output folder)
/// and the answer sheet (also among the files as `truth.json`).
#[derive(Debug, Clone)]
pub struct FakeMeeting {
    /// The answer sheet.
    pub truth: Truth,
    /// `(relative path, bytes)`.
    pub files: Vec<(String, Vec<u8>)>,
}

#[derive(Deserialize)]
struct BenchLine {
    id: String,
    audio: String,
    text: String,
}

/// Read the first `count` clips of a scripts/huddle-stt-bench manifest
/// (`{"id","audio","text"}` per line, 16-bit PCM 16 kHz mono WAV).
/// Edges quieter than 35 dB under the loudest 10 ms are trimmed, and each
/// clip is brought to the same loudness (loudest 10 ms at -20 dBFS), the
/// way a client's gain control would.
pub fn load_bench_clips(manifest: &Path, count: usize) -> anyhow::Result<Vec<Clip>> {
    let text = std::fs::read_to_string(manifest)
        .with_context(|| format!("read {}", manifest.display()))?;
    let dir = manifest.parent().unwrap_or(Path::new("."));
    let mut clips = Vec::with_capacity(count);
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if clips.len() == count {
            break;
        }
        let entry: BenchLine = serde_json::from_str(line).context("manifest line")?;
        let path = dir.join(&entry.audio);
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let (rate, pcm) = read_wav_mono_i16(&bytes)?;
        if rate != 16_000 {
            bail!("{}: {rate} Hz, expected 16000", path.display());
        }
        let pcm_16k = level_and_trim(&pcm);
        clips.push(Clip {
            id: entry.id,
            text: entry.text,
            speech_start: 0,
            speech_end: pcm_16k.len(),
            speech_units: Vec::new(),
            pcm_16k,
        });
    }
    if clips.len() < count {
        bail!(
            "{} has {} clips, need {count}",
            manifest.display(),
            clips.len()
        );
    }
    Ok(clips)
}

fn level_and_trim(pcm: &[f32]) -> Vec<f32> {
    const FRAME: usize = 160;
    let rms: Vec<f32> = pcm
        .chunks(FRAME)
        .map(|frame| (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt())
        .collect();
    let peak = rms.iter().copied().fold(0.0f32, f32::max);
    if peak <= 0.0 {
        return Vec::new();
    }
    let threshold = peak * 10f32.powf(-35.0 / 20.0);
    let first = rms.iter().position(|&r| r >= threshold).unwrap_or(0);
    let last = rms.iter().rposition(|&r| r >= threshold).unwrap_or(0);
    let gain = (0.1 / peak).min(10f32.powf(30.0 / 20.0));
    pcm[first * FRAME..((last + 1) * FRAME).min(pcm.len())]
        .iter()
        .map(|s| s * gain)
        .collect()
}

/// Deterministic random numbers (splitmix64), so a seed always gives the
/// same meeting.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, n)`.
    fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n.max(1)
    }

    /// Uniform in `[-1, 1)`.
    fn signed_unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 23) as f32 - 1.0
    }
}

fn digest(parts: &[&str]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hasher.finalize().into()
}

fn uuid_from(parts: &[&str]) -> Uuid {
    let hash = digest(parts);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    Uuid::from_bytes(bytes)
}

/// One stay of one person in one session's room.
#[derive(Debug, Clone, Copy)]
struct Occupancy {
    session: usize,
    speaker: usize,
    peer_index: u8,
    epoch: u8,
    join_ms: u64,
    leave_ms: u64,
}

enum Event {
    Join(Occupancy),
    Leave(Occupancy),
    Frame {
        peer_index: u8,
        epoch: u8,
        payload: Vec<u8>,
    },
}

/// Build the fake meeting from [`SENTENCES`] clips.
pub fn build_fake_meeting(clips: &[Clip], seed: u64, prefix: &str) -> anyhow::Result<FakeMeeting> {
    if clips.len() < SENTENCES {
        bail!("need {SENTENCES} clips, got {}", clips.len());
    }
    let seed_text = seed.to_string();
    let mut rng = Rng(seed);
    let community_id = uuid_from(&["huddle-fake-meeting", &seed_text, "community"]);
    let channel_id = uuid_from(&["huddle-fake-meeting", &seed_text, "channel"]);
    let pubkeys: Vec<[u8; 32]> = LABELS
        .iter()
        .map(|label| digest(&["huddle-fake-meeting", &seed_text, "speaker", label]))
        .collect();

    // 1. Lay the sentences out on the meeting clock by their speech, not by
    //    their clip edges (pauses and overlaps are between words).
    let mut utterances: Vec<(usize, u64, &Clip)> = Vec::with_capacity(SENTENCES);
    let mut turn_bounds = Vec::with_capacity(TURNS.len());
    let mut clip_iter = clips.iter();
    let mut previous_end: i64 = 0;
    for &(speaker, sentences, pause) in &TURNS {
        let mut t = u64::try_from((previous_end + pause).max(0))?;
        let turn_start = t;
        for i in 0..sentences {
            if i > 0 {
                t += 700 + rng.below(400);
            }
            let clip = clip_iter.next().context("ran out of clips")?;
            let (speech_from, speech_to) = clip.speech_ms();
            t = t.max(speech_from);
            utterances.push((speaker, t, clip));
            t += speech_to - speech_from;
        }
        turn_bounds.push((turn_start, t));
        previous_end = i64::try_from(t)?;
    }
    let last_end = turn_bounds.last().map_or(0, |b| b.1);

    // 2. Who is in which room when.
    let turn_start = |i: usize| turn_bounds[i].0;
    let turn_end = |i: usize| turn_bounds[i].1;
    let c_join = turn_start(3).saturating_sub(3_000);
    let c_leave = turn_end(6) + 1_500;
    let c_rejoin = c_leave + 3_000;
    let first_sentence_of_turn_8 = utterances
        .iter()
        .find(|(_, start, _)| *start == turn_start(8))
        .map(|(_, start, clip)| {
            let (from, to) = clip.speech_ms();
            start + (to - from) / 2
        })
        .context("turn 8")?;
    let s1_end = first_sentence_of_turn_8 + 300;
    let s2_start = s1_end - 600;
    if c_rejoin >= s2_start || turn_start(9) <= s1_end {
        bail!("clips too short for the scenario timeline");
    }
    let b_leave = last_end + 1_500;
    let a_leave = last_end + 2_500;
    let s2_end = last_end + 3_500;
    let mutes = [
        Vec::new(),
        vec![(turn_end(4) + 1_000, turn_start(7).saturating_sub(1_500))],
        Vec::new(),
    ];
    let occupancies = [
        // Session 1: A slot 0, B slot 1, C slot 2 (leaves and rejoins on slot 2).
        occ(0, 0, 0, 1, 0, s1_end),
        occ(0, 1, 1, 1, 1_000, s1_end),
        occ(0, 2, 2, 1, c_join, c_leave),
        occ(0, 2, 2, 2, c_rejoin, s1_end),
        // Session 2 on the new owner: C slot 0, A slot 1, B slot 2.
        occ(1, 2, 0, 1, s2_start, s2_end),
        occ(1, 0, 1, 1, s2_start + 50, a_leave),
        occ(1, 1, 2, 1, s2_start + 100, b_leave),
    ];
    let sessions = [
        (
            uuid_from(&["huddle-fake-meeting", &seed_text, "session", "1"]),
            0,
            s1_end,
            true,
        ),
        (
            uuid_from(&["huddle-fake-meeting", &seed_text, "session", "2"]),
            s2_start,
            s2_end,
            false,
        ),
    ];

    // 3. Each person's clean signal at 48 kHz on the meeting clock.
    let total_48k = usize::try_from((s2_end + 1_000) * 48)?;
    let mut signals = vec![vec![0f32; total_48k]; LABELS.len()];
    for (speaker, start, clip) in &utterances {
        let up = resample(&clip.pcm_16k, 16_000, 48_000)?;
        // `start` is where the speech begins; the clip's quiet lead-in goes
        // before it. Added, so a lead-in never cuts the previous tail.
        let offset = usize::try_from((start - clip.speech_ms().0) * 48)?;
        let end = (offset + up.len()).min(total_48k);
        for (out, sample) in signals[*speaker][offset..end].iter_mut().zip(&up) {
            *out += sample;
        }
    }

    // 4. What each session's relay receives, then its chunks.
    let mut files = Vec::new();
    let mut truth_sessions = Vec::new();
    for (index, &(session_id, start_ms, end_ms, with_manifest)) in sessions.iter().enumerate() {
        let mut events: Vec<(u64, u8, u64, Event)> = Vec::new();
        let mut order = 0u64;
        for occupancy in occupancies.iter().filter(|o| o.session == index) {
            events.push((occupancy.join_ms, 0, order, Event::Join(*occupancy)));
            order += 1;
            if occupancy.leave_ms < end_ms {
                events.push((occupancy.leave_ms, 2, order, Event::Leave(*occupancy)));
                order += 1;
            }
            for (receive_ms, payload) in client_frames(
                occupancy,
                &signals[occupancy.speaker],
                &mutes[occupancy.speaker],
                &mut rng,
            )? {
                if receive_ms >= occupancy.leave_ms.min(end_ms) {
                    continue;
                }
                let frame = Event::Frame {
                    peer_index: occupancy.peer_index,
                    epoch: occupancy.epoch,
                    payload,
                };
                events.push((receive_ms, 1, order, frame));
                order += 1;
            }
        }
        events.sort_by_key(|(t, rank, order, _)| (*t, *rank, *order));
        let (chunks, manifest_chunks) = write_chunks(
            &events,
            &pubkeys,
            prefix,
            community_id,
            channel_id,
            session_id,
            BASE_UNIX_MS + start_ms,
            start_ms,
        )?;
        let chunk_count = chunks.len();
        for (seq, bytes) in chunks.into_iter().enumerate() {
            let key = chunk_key(
                prefix,
                community_id,
                channel_id,
                session_id,
                u32::try_from(seq)?,
            );
            files.push((format!("recordings/{key}"), bytes));
        }
        if with_manifest {
            let manifest = Manifest {
                format: FORMAT.into(),
                community_id,
                channel_id,
                parent_channel_id: Some(uuid_from(&["huddle-fake-meeting", &seed_text, "parent"])),
                session_id,
                started_at: format_utc_millis(BASE_UNIX_MS + start_ms),
                ended_at: format_utc_millis(BASE_UNIX_MS + end_ms),
                duration_ms: end_ms - start_ms,
                protocol_version: 2,
                end_reason: EndReason::Shutdown,
                chunks: manifest_chunks,
                participants: occupancies
                    .iter()
                    .filter(|o| o.session == index)
                    .map(|o| ManifestParticipant {
                        pubkey: hex::encode(pubkeys[o.speaker]),
                        peer_index: o.peer_index,
                        epoch: o.epoch,
                        joined_t_ms: ms_u32(o.join_ms - start_ms),
                        left_t_ms: ms_u32(o.leave_ms.min(end_ms) - start_ms),
                    })
                    .collect(),
                dropped_frames: 0,
                lost_chunks: 0,
            };
            let key = manifest_key(prefix, community_id, channel_id, session_id);
            files.push((
                format!("recordings/{key}"),
                serde_json::to_vec_pretty(&manifest)?,
            ));
        }
        debug_assert!(chunk_count > 0);
        truth_sessions.push(TruthSession {
            session_id,
            start_ms,
            end_ms,
            manifest: with_manifest,
        });
    }

    // 5. Per-person WAVs (sentences only, 1 s apart) and the answer sheet.
    let mut speaker_wavs: Vec<Vec<f32>> = vec![Vec::new(); LABELS.len()];
    let mut truth_utterances = Vec::with_capacity(utterances.len());
    for (speaker, start, clip) in &utterances {
        let wav = &mut speaker_wavs[*speaker];
        if !wav.is_empty() {
            wav.extend(std::iter::repeat_n(0.0, 16_000));
        }
        let clip_at = wav.len() as u64 * 1_000 / 16_000;
        wav.extend_from_slice(&clip.pcm_16k);
        let (speech_from, speech_to) = clip.speech_ms();
        truth_utterances.push(TruthUtterance {
            id: clip.id.clone(),
            speaker: hex::encode(pubkeys[*speaker]),
            label: LABELS[*speaker].into(),
            start_ms: *start,
            end_ms: start + (speech_to - speech_from),
            text: clip.text.clone(),
            speaker_wav_start_ms: clip_at + speech_from,
            speaker_wav_end_ms: clip_at + speech_to,
            speech_units_ms: clip
                .speech_units
                .iter()
                .map(|&(a, b)| {
                    let to_ms = |x: usize| x as u64 * 1_000 / 16_000;
                    [
                        start + to_ms(a) - speech_from,
                        start + to_ms(b) - speech_from,
                    ]
                })
                .collect(),
        });
    }
    truth_utterances.sort_by_key(|u| u.start_ms);
    let mut bench_manifest = String::new();
    let mut truth_speakers = Vec::with_capacity(LABELS.len());
    for (speaker, label) in LABELS.iter().enumerate() {
        let wav = format!("speakers/{label}.wav");
        files.push((
            wav.clone(),
            write_wav_mono_i16(16_000, &speaker_wavs[speaker]),
        ));
        let text = truth_utterances
            .iter()
            .filter(|u| u.label == *label)
            .map(|u| u.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let line = serde_json::json!({
            "id": format!("fake-meeting-{seed}-{label}"),
            "audio": format!("{label}.wav"),
            "text": text,
        });
        bench_manifest.push_str(&line.to_string());
        bench_manifest.push('\n');
        truth_speakers.push(TruthSpeaker {
            label: (*label).into(),
            pubkey: hex::encode(pubkeys[speaker]),
            wav,
        });
    }
    files.push((
        "speakers/manifest.jsonl".into(),
        bench_manifest.into_bytes(),
    ));

    let truth = Truth {
        format: TRUTH_FORMAT.into(),
        community_id,
        channel_id,
        prefix: prefix.into(),
        started_at: format_utc_millis(BASE_UNIX_MS),
        duration_ms: s2_end,
        speakers: truth_speakers,
        sessions: truth_sessions,
        utterances: truth_utterances,
    };
    files.push(("truth.json".into(), serde_json::to_vec_pretty(&truth)?));
    Ok(FakeMeeting { truth, files })
}

fn occ(
    session: usize,
    speaker: usize,
    peer_index: u8,
    epoch: u8,
    join_ms: u64,
    leave_ms: u64,
) -> Occupancy {
    Occupancy {
        session,
        speaker,
        peer_index,
        epoch,
        join_ms,
        leave_ms,
    }
}

fn ms_u32(ms: u64) -> u32 {
    u32::try_from(ms).unwrap_or(u32::MAX)
}

/// What one client sends during one stay, as the relay receives it:
/// `(receive time on the meeting clock, v2 frame)`. Encoder settings and
/// header fields follow `desktop/src-tauri/src/huddle/relay_api.rs`.
fn client_frames(
    occupancy: &Occupancy,
    signal: &[f32],
    mutes: &[(u64, u64)],
    rng: &mut Rng,
) -> anyhow::Result<Vec<(u64, Vec<u8>)>> {
    let mut encoder = opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip)?;
    encoder.set_bitrate(opus::Bitrate::Bits(32_000))?;
    encoder.set_dtx(true)?;
    let mut out = Vec::new();
    let mut packet = vec![0u8; 4_000];
    let mut pcm = vec![0f32; 960];
    let mut seq: u16 = 0;
    let mut ts_48k: u32 = 0;
    let mut burst_left = 0u32;
    let mut burst_release = 0u64;
    let mut last_receive = 0u64;
    let mut capture = occupancy.join_ms;
    while capture + 20 <= occupancy.leave_ms {
        let send_ms = capture + 20;
        let muted = mutes
            .iter()
            .any(|&(from, to)| (from..to).contains(&send_ms));
        let offset = usize::try_from(capture * 48)?;
        capture += 20;
        if muted {
            continue;
        }
        for (i, sample) in pcm.iter_mut().enumerate() {
            let clean = signal.get(offset + i).copied().unwrap_or(0.0);
            *sample = clean + rng.signed_unit() * NOISE_FLOOR;
        }
        let level = level_dbov(&pcm);
        let n = encoder.encode_float(&pcm, &mut packet)?;
        if n == 0 {
            continue;
        }
        let header = MediaHeader {
            seq,
            ts_48k,
            level_dbov: level,
            flags: if n <= 2 { FLAG_DTX } else { 0 },
        };
        seq = seq.wrapping_add(1);
        ts_48k = ts_48k.wrapping_add(960);
        // Network: 30–50 ms latency, now and then a burst of 6 frames held
        // back 120 ms, and 0.4 % of frames lost. One client's frames come
        // over one WebSocket, so they never overtake each other.
        let mut receive = send_ms + 30 + rng.below(21);
        if burst_left == 0 && rng.below(250) == 0 {
            burst_left = 6;
            burst_release = receive + 120;
        }
        if burst_left > 0 {
            burst_left -= 1;
            receive = receive.max(burst_release);
        }
        receive = receive.max(last_receive);
        last_receive = receive;
        if rng.below(250) == 0 {
            continue;
        }
        let mut frame = header.encode().to_vec();
        frame.extend_from_slice(&packet[..n]);
        out.push((receive, frame));
    }
    Ok(out)
}

/// Cut one session's events into `.bhr` chunks the way the recorder does:
/// a new chunk every [`CHUNK_MS`], each opening with the current roster.
#[allow(clippy::too_many_arguments)]
fn write_chunks(
    events: &[(u64, u8, u64, Event)],
    pubkeys: &[[u8; 32]],
    prefix: &str,
    community_id: Uuid,
    channel_id: Uuid,
    session_id: Uuid,
    session_start_unix_ms: u64,
    session_start_ms: u64,
) -> anyhow::Result<(Vec<Vec<u8>>, Vec<ManifestChunk>)> {
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut manifest_chunks: Vec<ManifestChunk> = Vec::new();
    let mut roster: BTreeSet<(u8, u8, usize)> = BTreeSet::new();
    let mut open_window: Option<u64> = None;
    for (meeting_ms, _, _, event) in events {
        let t_ms = ms_u32(meeting_ms.saturating_sub(session_start_ms));
        let window = u64::from(t_ms) / CHUNK_MS;
        if open_window != Some(window) {
            open_window = Some(window);
            let seq = u32::try_from(chunks.len())?;
            let mut bytes = ChunkHeader {
                protocol_version: 2,
                session_id,
                chunk_seq: seq,
                session_start_unix_ms,
            }
            .encode()
            .to_vec();
            let mut records = 0u64;
            for &(peer_index, epoch, speaker) in &roster {
                Record::Join {
                    t_ms,
                    peer_index,
                    epoch,
                    pubkey: pubkeys[speaker],
                }
                .encode_into(&mut bytes)?;
                records += 1;
            }
            chunks.push(bytes);
            manifest_chunks.push(ManifestChunk {
                seq,
                key: chunk_key(prefix, community_id, channel_id, session_id, seq),
                bytes: 0,
                records,
                first_t_ms: t_ms,
                last_t_ms: t_ms,
            });
        }
        let (Some(bytes), Some(entry)) = (chunks.last_mut(), manifest_chunks.last_mut()) else {
            continue;
        };
        match event {
            Event::Join(o) => {
                roster.insert((o.peer_index, o.epoch, o.speaker));
                Record::Join {
                    t_ms,
                    peer_index: o.peer_index,
                    epoch: o.epoch,
                    pubkey: pubkeys[o.speaker],
                }
                .encode_into(bytes)?;
            }
            Event::Leave(o) => {
                roster.remove(&(o.peer_index, o.epoch, o.speaker));
                Record::Leave {
                    t_ms,
                    peer_index: o.peer_index,
                    epoch: o.epoch,
                    pubkey: pubkeys[o.speaker],
                }
                .encode_into(bytes)?;
            }
            Event::Frame {
                peer_index,
                epoch,
                payload,
            } => Record::Frame {
                t_ms,
                peer_index: *peer_index,
                epoch: *epoch,
                payload,
            }
            .encode_into(bytes)?,
        }
        entry.records += 1;
        entry.last_t_ms = t_ms;
    }
    for (bytes, entry) in chunks.iter().zip(&mut manifest_chunks) {
        entry.bytes = bytes.len() as u64;
    }
    Ok((chunks, manifest_chunks))
}

/// Write a fake meeting under `out_dir`.
pub fn write_fake_meeting(out_dir: &Path, meeting: &FakeMeeting) -> anyhow::Result<()> {
    for (relative, bytes) in &meeting.files {
        let path = out_dir.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
    }
    Ok(())
}
