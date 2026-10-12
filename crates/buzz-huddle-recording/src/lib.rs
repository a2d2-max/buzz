#![deny(unsafe_code)]
#![warn(missing_docs)]
//! `buzz-huddle-recording/1` — the storage format shared by the relay's
//! huddle recorder (the writer) and the minutes worker (the reader).
//!
//! The contract is `docs/huddle-recording.md`. A recording session is a set of
//! chunk objects (`chunk-{seq:06}.bhr`) plus one `manifest.json` written last:
//!
//! ```text
//! {prefix}/{community_id}/{channel_id}/{session_id}/chunk-000000.bhr
//! {prefix}/{community_id}/{channel_id}/{session_id}/manifest.json
//! ```
//!
//! A chunk is a fixed 36-byte [`ChunkHeader`] followed by [`Record`]s up to the
//! end of the object. Every integer is big-endian. The relay never decodes
//! Opus: frame payloads are the client frame bytes exactly as received.

mod manifest;

pub use manifest::{EndReason, Manifest, ManifestChunk, ManifestParticipant};

use uuid::Uuid;

/// Value of [`Manifest::format`]. Bump it whenever the layout changes.
pub const FORMAT: &str = "buzz-huddle-recording/1";
/// First four bytes of every chunk.
pub const MAGIC: [u8; 4] = *b"BHR1";
/// Chunk layout version carried in the header.
pub const FORMAT_VERSION: u8 = 1;
/// Size of [`ChunkHeader`] on the wire.
pub const CHUNK_HEADER_LEN: usize = 36;
/// Record type: one relayed audio frame.
pub const RECORD_FRAME: u8 = 1;
/// Record type: a participant is present (joined, or re-stated at a chunk start).
pub const RECORD_JOIN: u8 = 2;
/// Record type: a participant left.
pub const RECORD_LEAVE: u8 = 3;
/// Bytes before a frame payload: `type u8, t_ms u32, peer_index u8, epoch u8, len u16`.
pub const FRAME_RECORD_OVERHEAD: usize = 9;
/// Size of a join/leave record: `type u8, t_ms u32, peer_index u8, epoch u8, pubkey[32]`.
pub const ROSTER_RECORD_LEN: usize = 39;
/// Largest frame payload a record can carry (`len` is a `u16`).
pub const MAX_FRAME_PAYLOAD: usize = u16::MAX as usize;
/// Content type the writer uses for chunk objects.
pub const CHUNK_CONTENT_TYPE: &str = "application/octet-stream";
/// Content type the writer uses for `manifest.json`.
pub const MANIFEST_CONTENT_TYPE: &str = "application/json";

/// The fixed header at the start of every chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkHeader {
    /// Huddle audio protocol version pinned on the room; `0` when unknown.
    pub protocol_version: u8,
    /// Recording session this chunk belongs to.
    pub session_id: Uuid,
    /// Position of this chunk inside its session, from `0`.
    pub chunk_seq: u32,
    /// Wall-clock session start, UTC milliseconds since the Unix epoch.
    pub session_start_unix_ms: u64,
}

impl ChunkHeader {
    /// Encode the header into its 36-byte wire form.
    pub fn encode(&self) -> [u8; CHUNK_HEADER_LEN] {
        let mut out = [0u8; CHUNK_HEADER_LEN];
        out[0..4].copy_from_slice(&MAGIC);
        out[4] = FORMAT_VERSION;
        out[5] = self.protocol_version;
        // out[6..8] is reserved and stays zero.
        out[8..24].copy_from_slice(self.session_id.as_bytes());
        out[24..28].copy_from_slice(&self.chunk_seq.to_be_bytes());
        out[28..36].copy_from_slice(&self.session_start_unix_ms.to_be_bytes());
        out
    }

    /// Decode a header from the first 36 bytes of `buf`. The reserved bytes
    /// are ignored so a later writer may use them without breaking readers.
    pub fn decode(buf: &[u8]) -> Result<Self, DecodeError> {
        let Some(header) = buf.get(..CHUNK_HEADER_LEN) else {
            return Err(DecodeError::ShortHeader(buf.len()));
        };
        let magic = [header[0], header[1], header[2], header[3]];
        if magic != MAGIC {
            return Err(DecodeError::BadMagic(magic));
        }
        if header[4] != FORMAT_VERSION {
            return Err(DecodeError::UnsupportedVersion(header[4]));
        }
        let mut session_id = [0u8; 16];
        session_id.copy_from_slice(&header[8..24]);
        Ok(Self {
            protocol_version: header[5],
            session_id: Uuid::from_bytes(session_id),
            chunk_seq: u32::from_be_bytes([header[24], header[25], header[26], header[27]]),
            session_start_unix_ms: u64::from_be_bytes([
                header[28], header[29], header[30], header[31], header[32], header[33], header[34],
                header[35],
            ]),
        })
    }
}

/// One record inside a chunk. `t_ms` is milliseconds since the session start,
/// measured on the relay's monotonic clock at the moment the relay received
/// the event — not the sender's `ts_48k`, which stops while a peer is muted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Record<'a> {
    /// `type=1`: one frame exactly as the relay received it from the client
    /// (v2 and later: 8-byte media header + Opus; v1: Opus only).
    Frame {
        /// Receive time, ms since session start.
        t_ms: u32,
        /// Sender's routing index in the room.
        peer_index: u8,
        /// Sender's per-index occupancy epoch.
        epoch: u8,
        /// Client frame bytes.
        payload: &'a [u8],
    },
    /// `type=2`: a participant is present. Written when someone joins and
    /// again for every current participant at the start of each chunk.
    Join {
        /// Event time, ms since session start.
        t_ms: u32,
        /// Participant's routing index.
        peer_index: u8,
        /// Participant's per-index occupancy epoch.
        epoch: u8,
        /// Raw 32-byte x-only pubkey.
        pubkey: [u8; 32],
    },
    /// `type=3`: a participant left.
    Leave {
        /// Event time, ms since session start.
        t_ms: u32,
        /// Participant's routing index.
        peer_index: u8,
        /// Participant's per-index occupancy epoch.
        epoch: u8,
        /// Raw 32-byte x-only pubkey.
        pubkey: [u8; 32],
    },
}

impl Record<'_> {
    /// Event time in ms since the session start.
    pub fn t_ms(&self) -> u32 {
        match self {
            Record::Frame { t_ms, .. } | Record::Join { t_ms, .. } | Record::Leave { t_ms, .. } => {
                *t_ms
            }
        }
    }

    /// Number of bytes [`Self::encode_into`] appends.
    pub fn encoded_len(&self) -> usize {
        match self {
            Record::Frame { payload, .. } => FRAME_RECORD_OVERHEAD + payload.len(),
            Record::Join { .. } | Record::Leave { .. } => ROSTER_RECORD_LEN,
        }
    }

    /// Append the record's wire form to `out`. A frame payload longer than
    /// [`MAX_FRAME_PAYLOAD`] is refused and `out` is left untouched.
    pub fn encode_into(&self, out: &mut Vec<u8>) -> Result<(), EncodeError> {
        match *self {
            Record::Frame {
                t_ms,
                peer_index,
                epoch,
                payload,
            } => {
                let len = u16::try_from(payload.len())
                    .map_err(|_| EncodeError::PayloadTooLong(payload.len()))?;
                out.reserve(FRAME_RECORD_OVERHEAD + payload.len());
                out.push(RECORD_FRAME);
                out.extend_from_slice(&t_ms.to_be_bytes());
                out.push(peer_index);
                out.push(epoch);
                out.extend_from_slice(&len.to_be_bytes());
                out.extend_from_slice(payload);
            }
            Record::Join {
                t_ms,
                peer_index,
                epoch,
                pubkey,
            } => encode_roster(out, RECORD_JOIN, t_ms, peer_index, epoch, &pubkey),
            Record::Leave {
                t_ms,
                peer_index,
                epoch,
                pubkey,
            } => encode_roster(out, RECORD_LEAVE, t_ms, peer_index, epoch, &pubkey),
        }
        Ok(())
    }
}

fn encode_roster(out: &mut Vec<u8>, kind: u8, t_ms: u32, peer_index: u8, epoch: u8, pk: &[u8; 32]) {
    out.reserve(ROSTER_RECORD_LEN);
    out.push(kind);
    out.extend_from_slice(&t_ms.to_be_bytes());
    out.push(peer_index);
    out.push(epoch);
    out.extend_from_slice(pk);
}

/// Why a record could not be encoded.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EncodeError {
    /// A frame payload does not fit the `u16` length field.
    #[error("frame payload is {0} bytes; a record holds at most {MAX_FRAME_PAYLOAD}")]
    PayloadTooLong(usize),
}

/// Why chunk bytes could not be decoded.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// Fewer bytes than a header.
    #[error("chunk is {0} bytes, shorter than the {CHUNK_HEADER_LEN}-byte header")]
    ShortHeader(usize),
    /// The first four bytes are not `BHR1`.
    #[error("chunk magic is {0:?}, expected BHR1")]
    BadMagic([u8; 4]),
    /// A chunk layout this reader does not know.
    #[error("unsupported chunk format version {0}")]
    UnsupportedVersion(u8),
    /// A record type this reader does not know.
    #[error("unknown record type {kind} at byte {offset}")]
    UnknownRecord {
        /// The type byte read.
        kind: u8,
        /// Offset of the record inside the chunk.
        offset: usize,
    },
    /// The chunk ends in the middle of a record.
    #[error("record at byte {offset} is truncated")]
    Truncated {
        /// Offset of the record inside the chunk.
        offset: usize,
    },
}

/// Decode a whole chunk: its header and a lazy iterator over its records.
pub fn decode_chunk(buf: &[u8]) -> Result<(ChunkHeader, Records<'_>), DecodeError> {
    let header = ChunkHeader::decode(buf)?;
    Ok((
        header,
        Records {
            buf,
            offset: CHUNK_HEADER_LEN,
            failed: false,
        },
    ))
}

/// Iterator over the records of a chunk. Yields an error once and then stops
/// when the bytes are malformed, so a reader can keep everything before it.
pub struct Records<'a> {
    buf: &'a [u8],
    offset: usize,
    failed: bool,
}

impl<'a> Iterator for Records<'a> {
    type Item = Result<Record<'a>, DecodeError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.offset >= self.buf.len() {
            return None;
        }
        let start = self.offset;
        let result = decode_record(self.buf, start);
        match &result {
            Ok((_, len)) => self.offset = start + len,
            Err(_) => self.failed = true,
        }
        Some(result.map(|(record, _)| record))
    }
}

fn decode_record(buf: &[u8], offset: usize) -> Result<(Record<'_>, usize), DecodeError> {
    let truncated = DecodeError::Truncated { offset };
    let rest = &buf[offset..];
    let prefix = rest.get(..7).ok_or(truncated.clone())?;
    let kind = prefix[0];
    let t_ms = u32::from_be_bytes([prefix[1], prefix[2], prefix[3], prefix[4]]);
    let peer_index = prefix[5];
    let epoch = prefix[6];
    match kind {
        RECORD_FRAME => {
            let len_bytes = rest.get(7..9).ok_or(truncated.clone())?;
            let len = usize::from(u16::from_be_bytes([len_bytes[0], len_bytes[1]]));
            let payload = rest
                .get(FRAME_RECORD_OVERHEAD..FRAME_RECORD_OVERHEAD + len)
                .ok_or(truncated)?;
            Ok((
                Record::Frame {
                    t_ms,
                    peer_index,
                    epoch,
                    payload,
                },
                FRAME_RECORD_OVERHEAD + len,
            ))
        }
        RECORD_JOIN | RECORD_LEAVE => {
            let key = rest.get(7..ROSTER_RECORD_LEN).ok_or(truncated)?;
            let mut pubkey = [0u8; 32];
            pubkey.copy_from_slice(key);
            let record = if kind == RECORD_JOIN {
                Record::Join {
                    t_ms,
                    peer_index,
                    epoch,
                    pubkey,
                }
            } else {
                Record::Leave {
                    t_ms,
                    peer_index,
                    epoch,
                    pubkey,
                }
            };
            Ok((record, ROSTER_RECORD_LEN))
        }
        kind => Err(DecodeError::UnknownRecord { kind, offset }),
    }
}

/// `{prefix}/{community_id}/{channel_id}/{session_id}` — the folder holding
/// one session's chunks and manifest.
pub fn session_path(
    prefix: &str,
    community_id: Uuid,
    channel_id: Uuid,
    session_id: Uuid,
) -> String {
    format!("{prefix}/{community_id}/{channel_id}/{session_id}")
}

/// Object key of chunk `seq` (`…/chunk-{seq:06}.bhr`).
pub fn chunk_key(
    prefix: &str,
    community_id: Uuid,
    channel_id: Uuid,
    session_id: Uuid,
    seq: u32,
) -> String {
    format!(
        "{}/chunk-{seq:06}.bhr",
        session_path(prefix, community_id, channel_id, session_id)
    )
}

/// Object key of the session manifest (`…/manifest.json`).
pub fn manifest_key(
    prefix: &str,
    community_id: Uuid,
    channel_id: Uuid,
    session_id: Uuid,
) -> String {
    format!(
        "{}/manifest.json",
        session_path(prefix, community_id, channel_id, session_id)
    )
}

/// Format UTC milliseconds as the manifest's timestamp form
/// (`2026-10-12T05:00:00.000Z`). Out-of-range values clamp to the epoch.
pub fn format_utc_millis(unix_ms: u64) -> String {
    let millis = i64::try_from(unix_ms).unwrap_or(i64::MAX);
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> ChunkHeader {
        ChunkHeader {
            protocol_version: 2,
            session_id: Uuid::from_u128(0x0011_2233_4455_6677_8899_aabb_ccdd_eeff),
            chunk_seq: 0x0102_0304,
            session_start_unix_ms: 0x0102_0304_0506_0708,
        }
    }

    /// Pins the 36-byte header layout byte for byte. A reordered or resized
    /// field breaks every reader, so this must change only with `FORMAT`.
    #[test]
    fn header_golden_bytes() {
        let expected: [u8; CHUNK_HEADER_LEN] = [
            b'B', b'H', b'R', b'1', // magic
            0x01, // format_version
            0x02, // protocol_version
            0x00, 0x00, // reserved
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, // session_id
            0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, //
            0x01, 0x02, 0x03, 0x04, // chunk_seq
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, // session_start_unix_ms
        ];
        assert_eq!(header().encode(), expected);
        assert_eq!(ChunkHeader::decode(&expected), Ok(header()));
    }

    /// Pins the byte layout of all three record types.
    #[test]
    fn record_golden_bytes() {
        let mut out = Vec::new();
        Record::Frame {
            t_ms: 0x0a0b_0c0d,
            peer_index: 7,
            epoch: 3,
            payload: &[0xde, 0xad, 0xbe],
        }
        .encode_into(&mut out)
        .expect("frame fits");
        assert_eq!(
            out,
            [0x01, 0x0a, 0x0b, 0x0c, 0x0d, 0x07, 0x03, 0x00, 0x03, 0xde, 0xad, 0xbe]
        );

        for (record, kind) in [
            (
                Record::Join {
                    t_ms: 1,
                    peer_index: 2,
                    epoch: 9,
                    pubkey: [0x11; 32],
                },
                0x02,
            ),
            (
                Record::Leave {
                    t_ms: 1,
                    peer_index: 2,
                    epoch: 9,
                    pubkey: [0x11; 32],
                },
                0x03,
            ),
        ] {
            let mut out = Vec::new();
            record.encode_into(&mut out).expect("roster record encodes");
            let mut expected = vec![kind, 0x00, 0x00, 0x00, 0x01, 0x02, 0x09];
            expected.extend_from_slice(&[0x11; 32]);
            assert_eq!(out, expected);
            assert_eq!(out.len(), record.encoded_len());
        }
    }

    #[test]
    fn chunk_round_trips() {
        let records = [
            Record::Join {
                t_ms: 0,
                peer_index: 0,
                epoch: 0,
                pubkey: [0xaa; 32],
            },
            Record::Frame {
                t_ms: 20,
                peer_index: 0,
                epoch: 0,
                payload: &[1, 2, 3, 4, 5, 6, 7, 8, 9],
            },
            Record::Frame {
                t_ms: 40,
                peer_index: 0,
                epoch: 0,
                payload: &[],
            },
            Record::Leave {
                t_ms: 60,
                peer_index: 0,
                epoch: 0,
                pubkey: [0xaa; 32],
            },
        ];
        let mut buf = header().encode().to_vec();
        for record in &records {
            record.encode_into(&mut buf).expect("encode");
        }
        let (decoded_header, iter) = decode_chunk(&buf).expect("decode");
        assert_eq!(decoded_header, header());
        let decoded: Vec<_> = iter.collect::<Result<_, _>>().expect("records decode");
        assert_eq!(decoded, records);
    }

    #[test]
    fn header_errors_are_reported() {
        assert_eq!(
            ChunkHeader::decode(&[0u8; 10]),
            Err(DecodeError::ShortHeader(10))
        );
        let mut bad_magic = header().encode();
        bad_magic[0] = b'X';
        assert_eq!(
            ChunkHeader::decode(&bad_magic),
            Err(DecodeError::BadMagic(*b"XHR1"))
        );
        let mut bad_version = header().encode();
        bad_version[4] = 2;
        assert_eq!(
            ChunkHeader::decode(&bad_version),
            Err(DecodeError::UnsupportedVersion(2))
        );
    }

    /// A torn tail keeps the good prefix and reports exactly one error.
    #[test]
    fn truncated_and_unknown_records_stop_iteration() {
        let mut buf = header().encode().to_vec();
        Record::Frame {
            t_ms: 1,
            peer_index: 0,
            epoch: 0,
            payload: &[9, 9],
        }
        .encode_into(&mut buf)
        .expect("encode");
        let good_len = buf.len();
        buf.extend_from_slice(&[RECORD_FRAME, 0, 0, 0, 2, 0, 0, 0, 5, 1]); // len 5, 1 byte present

        let (_, records) = decode_chunk(&buf).expect("header");
        let items: Vec<_> = records.collect();
        assert_eq!(items.len(), 2);
        assert!(items[0].is_ok());
        assert_eq!(items[1], Err(DecodeError::Truncated { offset: good_len }));

        let mut unknown = header().encode().to_vec();
        unknown.extend_from_slice(&[0x7f, 0, 0, 0, 0, 0, 0]);
        let (_, mut records) = decode_chunk(&unknown).expect("header");
        assert_eq!(
            records.next(),
            Some(Err(DecodeError::UnknownRecord {
                kind: 0x7f,
                offset: CHUNK_HEADER_LEN
            }))
        );
        assert_eq!(records.next(), None);
    }

    #[test]
    fn oversized_payload_is_refused_without_writing() {
        let payload = vec![0u8; MAX_FRAME_PAYLOAD + 1];
        let mut out = vec![0xee];
        let result = Record::Frame {
            t_ms: 0,
            peer_index: 0,
            epoch: 0,
            payload: &payload,
        }
        .encode_into(&mut out);
        assert_eq!(
            result,
            Err(EncodeError::PayloadTooLong(MAX_FRAME_PAYLOAD + 1))
        );
        assert_eq!(out, vec![0xee]);
    }

    #[test]
    fn object_keys_follow_the_contract() {
        let community = Uuid::from_u128(1);
        let channel = Uuid::from_u128(2);
        let session = Uuid::from_u128(3);
        let base = format!("huddles/{community}/{channel}/{session}");
        assert_eq!(
            chunk_key("huddles", community, channel, session, 0),
            format!("{base}/chunk-000000.bhr")
        );
        assert_eq!(
            chunk_key("huddles", community, channel, session, 42),
            format!("{base}/chunk-000042.bhr")
        );
        assert_eq!(
            manifest_key("huddles", community, channel, session),
            format!("{base}/manifest.json")
        );
    }

    #[test]
    fn timestamps_use_utc_millis() {
        assert_eq!(format_utc_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_utc_millis(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
    }
}
