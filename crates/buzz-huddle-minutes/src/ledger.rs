//! What was already paid for: every transcription outcome of a meeting,
//! kept beside its script so a rerun never sends a finished piece again.
//!
//! One JSON line per event, appended as it happens, so a crash or a stop on
//! an auth error keeps everything before it:
//!
//! ```text
//! {"kind":"run","number":2}       (written when run 2 finished transcribing)
//! {"kind":"done","key":"…","text":"…","billed_seconds":3}
//! {"kind":"rejected","key":"…","code":"…"}
//! ```
//!
//! A transient failure is not written: the next run sends that piece again.
//! The file holds transcribed text, so it is written 0600 like the script.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A finished piece.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Transcribed.
    Done {
        /// The text.
        text: String,
        /// Seconds the engine billed for it.
        billed_seconds: u64,
    },
    /// The engine refused this audio; sending it again will not help.
    Rejected {
        /// Engine error code.
        code: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Line {
    Run {
        number: u32,
    },
    Done {
        key: String,
        text: String,
        billed_seconds: u64,
    },
    Rejected {
        key: String,
        code: String,
    },
}

/// Transcription outcomes of one meeting, and how many runs it has had.
#[derive(Debug, Default)]
pub struct SttLedger {
    outcomes: HashMap<String, Outcome>,
    runs: u32,
    unreadable_lines: u64,
    file: Option<std::fs::File>,
}

impl SttLedger {
    /// A ledger that lives only in memory (tests, one-off runs).
    pub fn in_memory() -> Self {
        Self::default()
    }

    /// The ledger at `path`: earlier outcomes are read back, new ones are
    /// appended. Created 0600 when missing. A line that cannot be read (a
    /// crash in the middle of a write) is skipped and counted.
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let mut ledger = Self::default();
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error),
        };
        for line in text.lines() {
            match serde_json::from_str::<Line>(line) {
                Ok(line) => ledger.apply(line),
                Err(_) => ledger.unreadable_lines += 1,
            }
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        // A torn last line must not swallow the next one.
        if !text.is_empty() && !text.ends_with('\n') {
            file.write_all(b"\n")?;
        }
        ledger.file = Some(file);
        Ok(ledger)
    }

    fn apply(&mut self, line: Line) {
        match line {
            Line::Run { number } => self.runs = self.runs.max(number),
            Line::Done {
                key,
                text,
                billed_seconds,
            } => {
                self.outcomes.insert(
                    key,
                    Outcome::Done {
                        text,
                        billed_seconds,
                    },
                );
            }
            Line::Rejected { key, code } => {
                self.outcomes.insert(key, Outcome::Rejected { code });
            }
        }
    }

    fn append(&mut self, line: &Line) -> std::io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            let mut text = serde_json::to_string(line).map_err(std::io::Error::other)?;
            text.push('\n');
            // One write per line: a crash leaves at most one torn line.
            file.write_all(text.as_bytes())?;
        }
        Ok(())
    }

    /// Runs that went through the whole transcription step. A run that
    /// stopped on an auth error, crashed, or failed before transcribing is
    /// not counted.
    pub fn runs(&self) -> u32 {
        self.runs
    }

    /// Lines that could not be read back.
    pub fn unreadable_lines(&self) -> u64 {
        self.unreadable_lines
    }

    /// Note that run `number` went through the whole transcription step.
    pub fn finish_run(&mut self, number: u32) -> std::io::Result<()> {
        self.append(&Line::Run { number })?;
        self.runs = self.runs.max(number);
        Ok(())
    }

    /// What is known about the piece with `key`.
    pub fn outcome(&self, key: &str) -> Option<&Outcome> {
        self.outcomes.get(key)
    }

    /// Record a finished piece.
    pub fn record(&mut self, key: &str, outcome: Outcome) -> std::io::Result<()> {
        let line = match &outcome {
            Outcome::Done {
                text,
                billed_seconds,
            } => Line::Done {
                key: key.to_string(),
                text: text.clone(),
                billed_seconds: *billed_seconds,
            },
            Outcome::Rejected { code } => Line::Rejected {
                key: key.to_string(),
                code: code.clone(),
            },
        };
        self.append(&line)?;
        self.outcomes.insert(key.to_string(), outcome);
        Ok(())
    }
}

/// Format of [`piece_key`]; part of every settings version.
pub const LEDGER_KEY_FORMAT: &str = "huddle-minutes-ledger-key/1";

/// Key of one piece (hex sha256): the settings version, who, where it was
/// cut (the audio sent, ms on the meeting clock), and the recorded Opus
/// frames inside that stretch with their places. It is made from what was
/// recorded, not from decoded audio, so another CPU, decoder or resampler
/// gives the same key; other settings or other cuts give another one.
pub fn piece_key(
    version: &str,
    speaker: &str,
    start_ms: u64,
    end_ms: u64,
    frames: &[(u64, [u8; 16])],
) -> String {
    let mut hasher = Sha256::new();
    for part in [version, speaker] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hasher.update(start_ms.to_be_bytes());
    hasher.update(end_ms.to_be_bytes());
    hasher.update((frames.len() as u64).to_be_bytes());
    for (t_ms, digest) in frames {
        hasher.update(t_ms.to_be_bytes());
        hasher.update(digest);
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAMES: [(u64, [u8; 16]); 2] = [(0, [1; 16]), (20, [2; 16])];

    #[test]
    fn a_reopened_ledger_remembers_runs_and_outcomes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("m.stt.jsonl");
        let done = piece_key("v1", "aa", 0, 1_000, &FRAMES);
        let refused = piece_key("v1", "aa", 2_000, 3_000, &FRAMES);
        {
            let mut ledger = SttLedger::open(&path).expect("open");
            assert_eq!(ledger.runs(), 0);
            ledger
                .record(
                    &done,
                    Outcome::Done {
                        text: "말".into(),
                        billed_seconds: 1,
                    },
                )
                .expect("record");
            ledger
                .record(
                    &refused,
                    Outcome::Rejected {
                        code: "HTTP 400".into(),
                    },
                )
                .expect("record");
            ledger.finish_run(1).expect("run");
        }
        // A torn last line from a crash is skipped, not fatal.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open");
        file.write_all(b"{\"kind\":\"done\",\"ke").expect("write");
        drop(file);

        let mut ledger = SttLedger::open(&path).expect("reopen");
        assert_eq!(ledger.runs(), 1);
        assert_eq!(ledger.unreadable_lines(), 1);
        assert_eq!(
            ledger.outcome(&done),
            Some(&Outcome::Done {
                text: "말".into(),
                billed_seconds: 1
            })
        );
        assert!(matches!(
            ledger.outcome(&refused),
            Some(Outcome::Rejected { .. })
        ));
        ledger.finish_run(2).expect("run");
        drop(ledger);
        // The run after the torn line is on a line of its own.
        let ledger = SttLedger::open(&path).expect("reopen");
        assert_eq!(ledger.runs(), 2);
        assert_eq!(ledger.unreadable_lines(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    /// The key is made of settings, speaker, cut and recorded frames —
    /// there is no audio input to change with a CPU or a library — and
    /// changes when any of those change.
    #[test]
    fn the_key_follows_settings_cut_and_recorded_frames() {
        let key = piece_key("v1", "aa", 0, 1_000, &FRAMES);
        assert_eq!(key, piece_key("v1", "aa", 0, 1_000, &FRAMES));
        // A hash: the pubkey is not readable in it.
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(key, piece_key("v2", "aa", 0, 1_000, &FRAMES));
        assert_ne!(key, piece_key("v1", "bb", 0, 1_000, &FRAMES));
        assert_ne!(key, piece_key("v1", "aa", 0, 1_001, &FRAMES));
        assert_ne!(key, piece_key("v1", "aa", 0, 1_000, &FRAMES[..1]));
        let mut other = FRAMES;
        other[1].1[0] ^= 1;
        assert_ne!(key, piece_key("v1", "aa", 0, 1_000, &other));
        // Version and speaker are length-prefixed: no ambiguity.
        assert_ne!(
            piece_key("v1a", "a", 0, 1_000, &FRAMES),
            piece_key("v1", "aa", 0, 1_000, &FRAMES)
        );
    }
}
