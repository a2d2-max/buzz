//! The client media header that rides in front of Opus from protocol v2 on.
//!
//! Layout (8 bytes, big-endian), same as `desktop/src-tauri/src/huddle/wire.rs`:
//! `seq u16, ts_48k u32, level_dbov i8, flags u8` with `flags` bit 0 = DTX.
//! The worker never times audio with `ts_48k` (it stops while a peer is
//! muted); `seq` is used only to spot lost frames inside one stream, and
//! `level`/DTX only as speech hints.

/// Size of the v2 media header.
pub const V2_HEADER_LEN: usize = 8;
/// `flags` bit for a DTX / comfort-noise frame.
pub const FLAG_DTX: u8 = 0x01;

/// Parsed v2 media header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaHeader {
    /// Sender sequence number, +1 per sent packet, wrapping.
    pub seq: u16,
    /// Sender 48 kHz media time, +960 per 20 ms frame.
    pub ts_48k: u32,
    /// Sender-measured level in dBov, clamped into `-127..=0`.
    pub level_dbov: i8,
    /// Raw flags byte.
    pub flags: u8,
}

impl MediaHeader {
    /// Wire form, ready to prepend to an Opus packet.
    pub fn encode(self) -> [u8; V2_HEADER_LEN] {
        let mut out = [0u8; V2_HEADER_LEN];
        out[0..2].copy_from_slice(&self.seq.to_be_bytes());
        out[2..6].copy_from_slice(&self.ts_48k.to_be_bytes());
        out[6] = self.level_dbov.to_be_bytes()[0];
        out[7] = self.flags;
        out
    }

    /// True when the sender tagged the frame as DTX.
    pub fn is_dtx(self) -> bool {
        self.flags & FLAG_DTX != 0
    }
}

/// Split a recorded client frame into its media header (v2 and later) and
/// the Opus packet. `protocol_version` is the chunk header's value: `1` means
/// a bare Opus packet; anything else (including `0` = unknown, which the relay
/// writes only when the room never pinned a version) is read as v2.
/// Returns `None` for a v2 frame too short to hold a header and a packet.
pub fn split_frame(protocol_version: u8, frame: &[u8]) -> Option<(Option<MediaHeader>, &[u8])> {
    if protocol_version == 1 {
        return (!frame.is_empty()).then_some((None, frame));
    }
    if frame.len() <= V2_HEADER_LEN {
        return None;
    }
    let raw_level = i8::from_be_bytes([frame[6]]);
    let header = MediaHeader {
        seq: u16::from_be_bytes([frame[0], frame[1]]),
        ts_48k: u32::from_be_bytes([frame[2], frame[3], frame[4], frame[5]]),
        level_dbov: if (-127..=0).contains(&raw_level) {
            raw_level
        } else {
            -127
        },
        flags: frame[7],
    };
    Some((Some(header), &frame[V2_HEADER_LEN..]))
}

/// RMS level of a frame in dBov, clamped into `-127..=0` — the same formula
/// the desktop client puts in the header.
pub fn level_dbov(samples: &[f32]) -> i8 {
    if samples.is_empty() {
        return -127;
    }
    let mean_square = samples
        .iter()
        .map(|&s| f64::from(s) * f64::from(s))
        .sum::<f64>()
        / samples.len() as f64;
    if mean_square <= 0.0 {
        return -127;
    }
    let db = 10.0 * mean_square.log10();
    if !db.is_finite() || db <= -127.0 {
        -127
    } else if db >= 0.0 {
        0
    } else {
        // In range -127..0 after the checks above.
        db.round() as i8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trips_and_matches_desktop_layout() {
        let header = MediaHeader {
            seq: 0x0102,
            ts_48k: 0x0304_0506,
            level_dbov: -30,
            flags: FLAG_DTX,
        };
        let mut frame = header.encode().to_vec();
        assert_eq!(frame, [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xe2, 0x01]);
        frame.extend_from_slice(&[0xf8, 0xff]);
        let (parsed, opus) = split_frame(2, &frame).expect("v2 frame");
        assert_eq!(parsed, Some(header));
        assert!(header.is_dtx());
        assert_eq!(opus, &[0xf8, 0xff]);
    }

    #[test]
    fn v1_frames_have_no_header_and_short_v2_frames_are_refused() {
        assert_eq!(split_frame(1, &[9, 9]), Some((None, &[9u8, 9][..])));
        assert_eq!(split_frame(1, &[]), None);
        assert_eq!(split_frame(2, &[0; V2_HEADER_LEN]), None);
        assert_eq!(split_frame(3, &[0; 4]), None);
    }

    #[test]
    fn out_of_range_level_reads_as_silence() {
        let mut frame = MediaHeader {
            seq: 0,
            ts_48k: 0,
            level_dbov: 0,
            flags: 0,
        }
        .encode()
        .to_vec();
        frame[6] = 5; // +5 dBov is not a valid level
        frame.push(0xf8);
        let (header, _) = split_frame(2, &frame).expect("frame");
        assert_eq!(header.expect("v2").level_dbov, -127);
    }

    #[test]
    fn level_matches_full_scale_and_silence() {
        assert_eq!(level_dbov(&[0.0; 960]), -127);
        assert_eq!(level_dbov(&[1.0; 960]), 0);
        assert_eq!(level_dbov(&[0.1; 960]), -20);
    }
}
