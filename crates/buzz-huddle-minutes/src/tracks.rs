//! Rebuild each person's audio on one meeting timeline (step 2).
//!
//! Every recorded frame is placed at its `t_ms` (relay receive time) shifted
//! by its session's start, so all sessions share the meeting clock that
//! starts at the first session's `started_at`. A frame is "a person" through
//! the session's join records: `(peer_index, epoch)` → pubkey.
//!
//! Receive times jitter and arrive in bursts, so frames are not written at
//! their exact `t_ms`: each sender stream is laid down back to back in talk
//! spurts, and each spurt is anchored at its least-delayed frame (see
//! `place_stream`). The sender's `ts_48k` is never used; `seq` only to count
//! lost frames.

use std::collections::{BTreeMap, HashMap};

use buzz_huddle_recording::{decode_chunk, Record};

use crate::collect::Meeting;
use crate::media::split_frame;

/// Decode rate. Opus is decoded at its native 48 kHz, mono.
pub const SAMPLE_RATE: u32 = 48_000;
const SAMPLES_PER_MS: u64 = 48;
/// A frame that arrives this much later than its talk spurt predicts starts
/// a new spurt (a pause in sending, not a delivery burst).
pub const RESYNC_MS: u64 = 100;
/// Largest `seq` gap (lost frames) filled with concealment. Bigger gaps are
/// kept as silence of the same length.
pub const MAX_CONCEALED_FRAMES: u16 = 5;
/// A long talk spurt is re-anchored every this many frames (30 s).
const ANCHOR_BLOCK_FRAMES: usize = 1_500;
/// This many frames in a row whose `seq` is behind the last one mean the
/// sender restarted its counter, not that they are late.
const SEQ_RESTART_FRAMES: u32 = 25;
/// A stretch longer than this without any frame (muted, push-to-talk, out
/// of the room) splits a track into separate sounding regions.
pub const REGION_GAP_MS: u64 = 1_000;
/// Opus never decodes more than 120 ms per packet.
const MAX_FRAME_SAMPLES: usize = 5_760;
/// Clients send 20 ms frames; concealment fills one frame per lost `seq`.
/// (With no packet, libopus conceals as many samples as the buffer holds,
/// so the buffer must be cut to one frame.)
const CONCEAL_SAMPLES: usize = 960;

/// What one placed frame said about speech. Hints only: the worker finds
/// speech with VAD, these are kept for callers that want a cheap first look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHint {
    /// Where the frame was written, meeting ms.
    pub t_ms: u64,
    /// Decoded length, ms.
    pub duration_ms: u32,
    /// Sender level in dBov (v2 and later).
    pub level_dbov: Option<i8>,
    /// Sender tagged the frame as DTX.
    pub dtx: bool,
}

/// One frame routed to a person, still encoded.
#[derive(Debug, Clone, Copy)]
struct SpeakerFrame<'a> {
    t_ms: u64,
    stream: StreamId,
    protocol_version: u8,
    frame: &'a [u8],
}

/// One sender stream: one occupancy of one routing slot in one session.
/// A rejoin is a new stream with a fresh decoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct StreamId {
    session: usize,
    peer_index: u8,
    epoch: u8,
}

/// Everything one person sent across the meeting, before decoding.
#[derive(Debug, Clone)]
pub struct SpeakerFrames<'a> {
    /// Hex x-only pubkey.
    pub pubkey: String,
    /// First time the person was seen in the room, meeting ms.
    pub first_seen_ms: u64,
    frames: Vec<SpeakerFrame<'a>>,
}

/// Counters from routing frames to people.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DemuxStats {
    /// Frame records read.
    pub frames: u64,
    /// Frames whose `(peer_index, epoch)` had no join record.
    pub unknown_sender: u64,
    /// Frames dropped because an earlier session already covered that
    /// person at that time (two pods recording during an owner change).
    pub overlap_skipped: u64,
    /// Chunks that ended in a broken record (records before it were kept).
    pub broken_chunks: u64,
}

/// Frames routed to people.
#[derive(Debug, Clone)]
pub struct Demuxed<'a> {
    /// People in order of first appearance on the meeting clock.
    pub speakers: Vec<SpeakerFrames<'a>>,
    /// Routing counters.
    pub stats: DemuxStats,
}

/// Counters from decoding one person.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DecodeStats {
    /// Frames written.
    pub decoded: u64,
    /// Frames that were too short or that Opus refused.
    pub undecodable: u64,
    /// Duplicate or late frames (v2 `seq` not ahead of the last one).
    pub out_of_order: u64,
    /// Times a sender's `seq` jumped back and stayed back (counter restart).
    pub seq_restarts: u64,
    /// Lost frames filled with concealment.
    pub concealed: u64,
    /// Lost frames beyond [`MAX_CONCEALED_FRAMES`], kept as silence.
    pub lost_silent: u64,
    /// Talk spurts (continuous sending stretches) across all streams.
    pub spurts: u64,
}

/// One person's audio on the meeting timeline.
#[derive(Debug, Clone)]
pub struct SpeakerTrack {
    /// Hex x-only pubkey.
    pub pubkey: String,
    /// Meeting ms of `pcm[0]`.
    pub start_ms: u64,
    /// 48 kHz mono samples; silence where nothing was sent.
    pub pcm: Vec<f32>,
    /// One hint per written frame.
    pub hints: Vec<FrameHint>,
    /// Decode counters.
    pub stats: DecodeStats,
}

#[derive(Default)]
struct Coverage {
    /// End of this person's frames in sessions already finished, meeting ms.
    earlier_sessions_end: u64,
    /// End of this person's frames in the session being read.
    this_session_end: u64,
}

/// Route every frame of the meeting to a person.
pub fn demux(meeting: &Meeting) -> Demuxed<'_> {
    let meeting_start = meeting.started_at_unix_ms();
    let mut stats = DemuxStats::default();
    let mut order: Vec<String> = Vec::new();
    let mut speakers: HashMap<String, SpeakerFrames<'_>> = HashMap::new();
    let mut coverage: HashMap<String, Coverage> = HashMap::new();

    for (session_index, session) in meeting.sessions.iter().enumerate() {
        for cover in coverage.values_mut() {
            cover.earlier_sessions_end = cover.earlier_sessions_end.max(cover.this_session_end);
            cover.this_session_end = 0;
        }
        let offset = session.started_at_unix_ms.saturating_sub(meeting_start);
        let mut roster: BTreeMap<(u8, u8), String> = BTreeMap::new();
        if let Some(manifest) = &session.manifest {
            for participant in &manifest.participants {
                let first_seen = offset + u64::from(participant.joined_t_ms);
                note_person(&mut speakers, &mut order, &participant.pubkey, first_seen);
            }
        }
        for chunk in &session.chunks {
            let Ok((_, records)) = decode_chunk(&chunk.bytes) else {
                stats.broken_chunks += 1;
                continue;
            };
            for record in records {
                let record = match record {
                    Ok(record) => record,
                    Err(_) => {
                        stats.broken_chunks += 1;
                        break;
                    }
                };
                let t_ms = offset + u64::from(record.t_ms());
                match record {
                    Record::Join {
                        peer_index,
                        epoch,
                        pubkey,
                        ..
                    } => {
                        let pubkey = hex::encode(pubkey);
                        note_person(&mut speakers, &mut order, &pubkey, t_ms);
                        roster.insert((peer_index, epoch), pubkey);
                    }
                    Record::Leave { .. } => {}
                    Record::Frame {
                        peer_index,
                        epoch,
                        payload,
                        ..
                    } => {
                        stats.frames += 1;
                        let Some(pubkey) = roster.get(&(peer_index, epoch)) else {
                            stats.unknown_sender += 1;
                            continue;
                        };
                        let cover = coverage.entry(pubkey.clone()).or_default();
                        if t_ms < cover.earlier_sessions_end {
                            stats.overlap_skipped += 1;
                            continue;
                        }
                        cover.this_session_end = cover.this_session_end.max(t_ms + 20);
                        if let Some(person) = speakers.get_mut(pubkey) {
                            person.frames.push(SpeakerFrame {
                                t_ms,
                                stream: StreamId {
                                    session: session_index,
                                    peer_index,
                                    epoch,
                                },
                                protocol_version: session.protocol_version,
                                frame: payload,
                            });
                        }
                    }
                }
            }
        }
    }

    let mut speakers: Vec<SpeakerFrames<'_>> = order
        .into_iter()
        .filter_map(|pubkey| speakers.remove(&pubkey))
        .collect();
    speakers.sort_by_key(|person| person.first_seen_ms);
    Demuxed { speakers, stats }
}

fn note_person<'a>(
    speakers: &mut HashMap<String, SpeakerFrames<'a>>,
    order: &mut Vec<String>,
    pubkey: &str,
    seen_ms: u64,
) {
    match speakers.get_mut(pubkey) {
        Some(person) => person.first_seen_ms = person.first_seen_ms.min(seen_ms),
        None => {
            order.push(pubkey.to_string());
            speakers.insert(
                pubkey.to_string(),
                SpeakerFrames {
                    pubkey: pubkey.to_string(),
                    first_seen_ms: seen_ms,
                    frames: Vec::new(),
                },
            );
        }
    }
}

/// What one placed step of a stream decodes.
#[derive(Clone, Copy)]
enum Step<'a> {
    /// A received Opus packet, with its level and DTX hint.
    Packet(&'a [u8], Option<i8>, bool),
    /// One concealed (lost or undecodable) frame.
    Conceal,
}

/// One step of a stream with its place on the meeting clock (samples).
struct Planned<'a> {
    step: Step<'a>,
    at: u64,
}

impl SpeakerFrames<'_> {
    /// Number of frames routed to this person.
    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    /// Decode this person's frames onto the meeting timeline. Places are
    /// worked out from packet lengths first, then each stream is decoded
    /// straight into the track, so only one copy of the audio is held.
    pub fn decode(&self) -> Result<SpeakerTrack, opus::Error> {
        let mut streams: BTreeMap<StreamId, Vec<&SpeakerFrame<'_>>> = BTreeMap::new();
        for frame in &self.frames {
            streams.entry(frame.stream).or_default().push(frame);
        }
        let mut stats = DecodeStats::default();
        let plans: Vec<Vec<Planned<'_>>> = streams
            .values()
            .map(|frames| plan_stream(frames, &mut stats))
            .collect();

        let start_ms = plans
            .iter()
            .flatten()
            .map(|planned| planned.at / SAMPLES_PER_MS)
            .min()
            .unwrap_or(0);
        let base = start_ms * SAMPLES_PER_MS;
        let mut pcm: Vec<f32> = Vec::new();
        let mut hints = Vec::with_capacity(self.frames.len());
        let mut buf = vec![0f32; MAX_FRAME_SAMPLES];
        for plan in &plans {
            let mut decoder = opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono)?;
            for planned in plan {
                let n = match planned.step {
                    Step::Packet(packet, level_dbov, dtx) => {
                        match decoder.decode_float(packet, &mut buf, false) {
                            Ok(n) => {
                                stats.decoded += 1;
                                hints.push(FrameHint {
                                    t_ms: planned.at / SAMPLES_PER_MS,
                                    duration_ms: u32::try_from(n as u64 / SAMPLES_PER_MS)
                                        .unwrap_or(u32::MAX),
                                    level_dbov,
                                    dtx,
                                });
                                n
                            }
                            Err(_) => {
                                stats.undecodable += 1;
                                decoder.decode_float(&[], &mut buf[..CONCEAL_SAMPLES], false)?
                            }
                        }
                    }
                    Step::Conceal => {
                        decoder.decode_float(&[], &mut buf[..CONCEAL_SAMPLES], false)?
                    }
                };
                add_at(&mut pcm, planned.at - base, &buf[..n]);
            }
        }
        hints.sort_by_key(|hint| hint.t_ms);
        Ok(SpeakerTrack {
            pubkey: self.pubkey.clone(),
            start_ms,
            pcm,
            hints,
            stats,
        })
    }
}

/// Lay one sender stream out on the meeting clock, without decoding.
///
/// For a received frame, `receive − samples produced before it` is when its
/// talk spurt would have started had this frame arrived without delay.
/// Delays only push that value up, so a spurt is anchored at the smallest
/// value among its frames — the least-delayed one. A burst (frames held
/// back, then delivered together) is a short upward blip and cannot move the
/// anchor; a pause in sending (mute, push-to-talk) is a lasting jump and
/// starts a new spurt once the value passes the spurt's anchor by
/// [`RESYNC_MS`]. Lost frames (v2 `seq` jumps) still count as produced — as
/// concealment up to [`MAX_CONCEALED_FRAMES`], as silence beyond — so loss
/// does not pull later audio early.
fn plan_stream<'a>(frames: &[&SpeakerFrame<'a>], stats: &mut DecodeStats) -> Vec<Planned<'a>> {
    // (step, receive position for received frames, samples before it)
    let mut steps: Vec<(Step<'a>, Option<u64>, u64)> = Vec::with_capacity(frames.len());
    let mut produced = 0u64;
    let mut last_seq: Option<u16> = None;
    let mut frames_behind = 0u32;
    let mut last_len = CONCEAL_SAMPLES as u64;
    let mut last_receive: Option<u64> = None;
    for frame in frames {
        let receive = frame.t_ms * SAMPLES_PER_MS;
        let Some((header, packet)) = split_frame(frame.protocol_version, frame.frame) else {
            stats.undecodable += 1;
            continue;
        };
        if let (Some(header), Some(last)) = (header, last_seq) {
            let step = header.seq.wrapping_sub(last);
            let behind = step == 0 || step > u16::MAX / 2;
            if behind && frames_behind + 1 < SEQ_RESTART_FRAMES {
                frames_behind += 1;
                stats.out_of_order += 1;
                continue;
            }
            let restarted = behind;
            frames_behind = 0;
            if restarted {
                // The sender restarted its counter: no gap to fill.
                stats.seq_restarts += 1;
            }
            let missing = if restarted { 0 } else { step - 1 };
            if missing <= MAX_CONCEALED_FRAMES {
                for _ in 0..missing {
                    steps.push((Step::Conceal, None, produced));
                    produced += CONCEAL_SAMPLES as u64;
                    stats.concealed += 1;
                }
            } else {
                // Silence for the lost frames — but never longer than the
                // time that actually passed between the two frames, so a
                // sender's `seq` leaping ahead cannot open a huge hole.
                let claimed = u64::from(missing) * last_len;
                let passed = last_receive
                    .map_or(claimed, |before| receive.saturating_sub(before + last_len));
                produced += claimed.min(passed);
                stats.lost_silent += u64::from(missing);
            }
        }
        if let Some(header) = header {
            last_seq = Some(header.seq);
        }
        let (step, len) = match opus::packet::get_nb_samples(packet, SAMPLE_RATE) {
            Ok(len) => (
                Step::Packet(
                    packet,
                    header.map(|h| h.level_dbov),
                    header.is_some_and(|h| h.is_dtx()),
                ),
                len as u64,
            ),
            Err(_) => (Step::Conceal, CONCEAL_SAMPLES as u64),
        };
        steps.push((step, Some(receive), produced));
        produced += len;
        last_len = len;
        last_receive = Some(receive);
    }

    // Spurts, each anchored at its least-delayed frame. A long spurt is
    // re-anchored every ANCHOR_BLOCK_FRAMES so a sender clock that runs a
    // little fast or slow against the relay's cannot pile up an offset (a
    // single anchor would drift 0.36 s per hour at 100 ppm).
    let resync = i128::from(RESYNC_MS * SAMPLES_PER_MS);
    let mut anchors: Vec<i128> = Vec::new();
    let mut in_block = 0usize;
    let mut block_of = Vec::with_capacity(steps.len());
    for &(_, receive, before) in &steps {
        if let Some(receive) = receive {
            let implied = i128::from(receive) - i128::from(before);
            match anchors.last_mut() {
                Some(anchor) if implied <= *anchor + resync && in_block < ANCHOR_BLOCK_FRAMES => {
                    *anchor = (*anchor).min(implied);
                    in_block += 1;
                }
                Some(anchor) if implied <= *anchor + resync => {
                    // Same spurt, next block.
                    anchors.push(implied);
                    in_block = 1;
                }
                _ => {
                    anchors.push(implied);
                    in_block = 1;
                    stats.spurts += 1;
                }
            }
        }
        // A concealed frame rides with the block of the frame before it.
        block_of.push(anchors.len().saturating_sub(1));
    }
    steps
        .into_iter()
        .zip(block_of)
        .filter_map(|((step, _, before), block)| {
            let anchor = *anchors.get(block)?;
            let at = u64::try_from((anchor + i128::from(before)).max(0)).unwrap_or(0);
            Some(Planned { step, at })
        })
        .collect()
}

impl SpeakerTrack {
    /// Stretches where frames actually arrived, as half-open meeting-ms
    /// ranges. Between them the track is digital silence (no frames at all);
    /// speech detection runs only inside them. Silero fed many seconds of
    /// exact zeros (a muted stretch) stops ending speech at later pauses, so
    /// those stretches must never reach it.
    pub fn sounding_regions(&self, max_gap_ms: u64) -> Vec<(u64, u64)> {
        let mut frames: Vec<(u64, u64)> = self
            .hints
            .iter()
            .map(|hint| (hint.t_ms, hint.t_ms + u64::from(hint.duration_ms)))
            .collect();
        frames.sort_unstable();
        let mut regions: Vec<(u64, u64)> = Vec::new();
        for (start, end) in frames {
            match regions.last_mut() {
                Some(last) if start <= last.1 + max_gap_ms => last.1 = last.1.max(end),
                _ => regions.push((start, end)),
            }
        }
        regions
    }
}

/// Add `samples` into the track at `offset`. Added, not copied: the same
/// person on two devices at once is two streams, and neither may erase the
/// other.
fn add_at(pcm: &mut Vec<f32>, offset: u64, samples: &[f32]) {
    let offset = usize::try_from(offset).unwrap_or(usize::MAX);
    let end = offset.saturating_add(samples.len());
    if pcm.len() < end {
        pcm.resize(end, 0.0);
    }
    for (out, &sample) in pcm[offset..end].iter_mut().zip(samples) {
        *out += sample;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::MediaHeader;

    /// A one-byte Opus packet (TOC 0xF8: CELT fullband, 20 ms, mono).
    const PACKET_20MS: u8 = 0xf8;

    fn frame_bytes(seq: u16) -> Vec<u8> {
        let mut bytes = MediaHeader {
            seq,
            ts_48k: u32::from(seq) * 960,
            level_dbov: -40,
            flags: 0,
        }
        .encode()
        .to_vec();
        bytes.push(PACKET_20MS);
        bytes
    }

    /// `(seq, receive ms)` → planned positions in ms.
    fn plan(sent: &[(u16, u64)]) -> (Vec<u64>, DecodeStats) {
        let bytes: Vec<Vec<u8>> = sent.iter().map(|&(seq, _)| frame_bytes(seq)).collect();
        let stream = StreamId {
            session: 0,
            peer_index: 0,
            epoch: 1,
        };
        let frames: Vec<SpeakerFrame<'_>> = sent
            .iter()
            .zip(&bytes)
            .map(|(&(_, t_ms), frame)| SpeakerFrame {
                t_ms,
                stream,
                protocol_version: 2,
                frame,
            })
            .collect();
        let refs: Vec<&SpeakerFrame<'_>> = frames.iter().collect();
        let mut stats = DecodeStats::default();
        let positions = plan_stream(&refs, &mut stats)
            .iter()
            .map(|planned| planned.at / SAMPLES_PER_MS)
            .collect();
        (positions, stats)
    }

    #[test]
    fn a_delivery_burst_does_not_push_later_audio_late() {
        // Sent every 20 ms from 1 000 ms, received 40 ms later — except
        // frames 30..36, held back and delivered together with frame 36.
        let sent: Vec<(u16, u64)> = (0..100u16)
            .map(|i| {
                let on_time = 1_040 + 20 * u64::from(i);
                let receive = if (30..36).contains(&i) {
                    1_040 + 20 * 36
                } else {
                    on_time
                };
                (i, receive)
            })
            .collect();
        let (positions, stats) = plan(&sent);
        let expected: Vec<u64> = (0..100).map(|i| 1_040 + 20 * i).collect();
        assert_eq!(positions, expected);
        assert_eq!(stats.concealed + stats.lost_silent + stats.out_of_order, 0);
    }

    #[test]
    fn a_pause_in_sending_starts_a_new_spurt_at_its_receive_time() {
        // 50 frames, then the sender is muted for 3 s; seq just continues.
        let mut sent: Vec<(u16, u64)> =
            (0..50u16).map(|i| (i, 1_000 + 20 * u64::from(i))).collect();
        sent.extend((50..60u16).map(|i| (i, 4_000 + 20 * u64::from(i))));
        let (positions, stats) = plan(&sent);
        assert_eq!(positions[49], 1_980);
        assert_eq!(positions[50], 5_000);
        assert_eq!(positions[59], 5_180);
        assert_eq!(stats.spurts, 2);
    }

    #[test]
    fn lost_frames_keep_later_audio_in_place() {
        // seq 20..23 lost (concealed), seq 40..60 lost (too many: silence).
        let sent: Vec<(u16, u64)> = (0..80u16)
            .filter(|i| !(20..23).contains(i) && !(40..60).contains(i))
            .map(|i| (i, 500 + 20 * u64::from(i)))
            .collect();
        let (positions, stats) = plan(&sent);
        // 3 concealed frames are planned too (between seq 19 and 23).
        assert_eq!(stats.concealed, 3);
        assert_eq!(stats.lost_silent, 20);
        assert_eq!(stats.spurts, 1);
        let received_at: Vec<u64> = sent.iter().map(|&(_, t)| t).collect();
        let mut real = positions.clone();
        real.retain(|p| received_at.contains(p));
        assert_eq!(real, received_at);
        assert_eq!(positions.len(), sent.len() + 3);
    }

    #[test]
    fn a_sender_clock_off_by_300_ppm_does_not_pile_up_an_offset() {
        // Ten minutes of continuous sending (DTX keeps frames flowing).
        // Each frame really takes 20 ms × (1 ± 300 ppm) of relay time.
        for ppm in [-300.0f64, 300.0] {
            let period = 20.0 * (1.0 + ppm * 1e-6);
            let sent: Vec<(u16, u64)> = (0..30_000u32)
                .map(|i| {
                    let captured = 1_000.0 + period * f64::from(i);
                    ((i % 65_536) as u16, (captured + 40.0).round() as u64)
                })
                .collect();
            let (positions, stats) = plan(&sent);
            let worst = sent
                .iter()
                .zip(&positions)
                .map(|(&(_, receive), &at)| at.abs_diff(receive))
                .max()
                .unwrap_or(0);
            // One 30 s block drifts 9 ms at 300 ppm; a single anchor would
            // have drifted 180 ms over the ten minutes.
            assert!(worst <= 12, "{ppm} ppm: worst {worst} ms");
            assert_eq!(stats.spurts, 1, "{ppm} ppm");
        }
    }

    #[test]
    fn a_seq_that_restarts_is_followed_after_a_short_wait() {
        // seq 0..50, then the sender restarts at 0 without rejoining.
        let mut sent: Vec<(u16, u64)> =
            (0..50u16).map(|i| (i, 1_000 + 20 * u64::from(i))).collect();
        sent.extend((0..50u16).map(|i| (i, 2_000 + 20 * u64::from(i))));
        let (positions, stats) = plan(&sent);
        assert_eq!(stats.seq_restarts, 1);
        assert_eq!(stats.out_of_order, u64::from(SEQ_RESTART_FRAMES - 1));
        assert_eq!(positions.len(), 50 + 50 - (SEQ_RESTART_FRAMES as usize - 1));
        assert_eq!(*positions.last().expect("frames"), 2_980);
    }

    #[test]
    fn overlapping_audio_is_added_not_replaced() {
        let mut pcm = Vec::new();
        add_at(&mut pcm, 2, &[0.25, 0.25]);
        add_at(&mut pcm, 3, &[0.5, 0.5]);
        assert_eq!(pcm, [0.0, 0.0, 0.25, 0.75, 0.5]);
    }

    #[test]
    fn a_seq_leap_cannot_open_a_hole_longer_than_the_time_that_passed() {
        // 50 frames, then seq leaps ahead by 30 000 while the frames keep
        // arriving every 20 ms.
        let mut sent: Vec<(u16, u64)> =
            (0..50u16).map(|i| (i, 1_000 + 20 * u64::from(i))).collect();
        sent.extend((0..50u16).map(|i| (30_050 + i, 2_000 + 20 * u64::from(i))));
        let (positions, stats) = plan(&sent);
        assert_eq!(stats.lost_silent, 30_000);
        // Without the cap the second half would sit 600 s away; with it,
        // every frame is where it arrived.
        let received: Vec<u64> = sent.iter().map(|&(_, t)| t).collect();
        assert_eq!(positions, received);
    }

    #[test]
    fn duplicates_are_dropped() {
        let sent = [(0, 100), (1, 120), (1, 121), (2, 140)];
        let (positions, stats) = plan(&sent);
        assert_eq!(positions, [100, 120, 140]);
        assert_eq!(stats.out_of_order, 1);
    }
}
