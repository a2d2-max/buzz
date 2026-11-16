//! Where the transcriber plugs in (step 4). The real engine is
//! [`crate::chirp::ChirpStt`]; [`TruthStt`] is a test double that answers
//! from a fake meeting's answer sheet.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::sim::Truth;
use crate::transcript::SttInfo;

/// Text written for a piece the engine could not transcribe. The piece stays
/// in the script so nothing disappears silently.
pub const FAILED_TEXT: &str = "받아쓰기 실패";

/// One piece to transcribe.
#[derive(Debug, Clone, Copy)]
pub struct SttRequest<'a> {
    /// Hex pubkey of the speaker (the track the audio came from).
    pub speaker: &'a str,
    /// Start of the audio sent (speech plus padding), ms from the meeting
    /// start.
    pub start_ms: u64,
    /// End of the audio sent, ms from the meeting start.
    pub end_ms: u64,
    /// The audio, 16 kHz mono: one natural speech unit with padding.
    pub pcm_16k: &'a [f32],
    /// Ask for the time of each word. Only a piece that may hold more than
    /// one speaker needs them (its words are shared out by time); every
    /// other request goes out exactly as without them.
    pub word_times: bool,
}

/// One word and where it is in the audio sent: ms from the start of the
/// request's audio (not the meeting clock), so it stays right whatever the
/// meeting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Word {
    /// Start, ms from the start of the audio sent.
    pub start_ms: u64,
    /// End, ms from the start of the audio sent.
    pub end_ms: u64,
    /// The word as written (punctuation included).
    pub text: String,
}

/// What the engine returned for one piece.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SttOutput {
    /// Transcribed text (may be empty for silence).
    pub text: String,
    /// Seconds billed for this request.
    pub billed_seconds: u64,
    /// The words with their times when [`SttRequest::word_times`] asked for
    /// them (possibly empty), `None` when it did not.
    pub words: Option<Vec<Word>>,
}

/// Kinds of transcription failure; each is handled differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SttErrorKind {
    /// Credentials, permission or setup (project, API, recognizer)
    /// refused. Nothing will work: stop.
    Auth,
    /// The project's quota is used up ("quota exhausted" for the day or
    /// month), not a per-minute limit. More requests make it worse: stop.
    Quota,
    /// A per-minute request limit (HTTP 429): wait longer, then retry.
    RateLimited,
    /// The engine refused this audio. Retrying will not help: mark the
    /// piece as failed for good.
    Rejected,
    /// Network trouble or a server hiccup: retry, then try again next run.
    Transient,
}

impl SttErrorKind {
    /// Short name for logs and reports.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Quota => "quota",
            Self::RateLimited => "rate-limited",
            Self::Rejected => "rejected",
            Self::Transient => "transient",
        }
    }
}

impl std::fmt::Display for SttErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a piece could not be transcribed. Carries a kind and a short code
/// (e.g. an HTTP status and error reason), never audio or text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("transcription failed ({kind}): {code}")]
pub struct SttError {
    /// How to handle it.
    pub kind: SttErrorKind,
    /// Engine error code, e.g. `HTTP 429 RESOURCE_EXHAUSTED`.
    pub code: String,
}

impl SttError {
    /// Error of `kind` with `code`.
    pub fn new(kind: SttErrorKind, code: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
        }
    }
}

/// A speech-to-text engine.
pub trait SpeechToText {
    /// Engine identity for the `stt` block (`billed_seconds` is filled in by
    /// the caller).
    fn info(&self) -> SttInfo;

    /// Transcribe one piece. One piece is one request.
    fn transcribe(
        &self,
        request: SttRequest<'_>,
    ) -> impl Future<Output = Result<SttOutput, SttError>> + Send;
}

/// A piece must overlap a sentence this much for [`TruthStt`] to hear it.
const TRUTH_MIN_OVERLAP_MS: u64 = 300;

/// Failures [`TruthStt`] injects: every `every`-th distinct piece (1-based,
/// in request order, up to piece `last_piece`) fails its first
/// `failing_attempts` attempts with `kind`. Retries of the same piece count
/// as further attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fault {
    /// Kind of the injected error.
    pub kind: SttErrorKind,
    /// Which pieces fail.
    pub every: usize,
    /// How many attempts of such a piece fail (`u32::MAX` = always).
    pub failing_attempts: u32,
    /// No piece after this one fails (`usize::MAX` = no limit).
    pub last_piece: usize,
}

/// Test double: returns the answer-sheet text of each sentence of the
/// requested speaker that overlaps the piece by at least 300 ms and has not
/// been returned before. Pieces of one person arrive in time order, so a
/// sentence the VAD split in two goes to its first piece — once.
///
/// Asked for word times, it hears words instead, like a real engine: each
/// sentence's words are spread evenly over the sentence's time, and a piece
/// gets every word of the speaker whose middle is inside the audio sent (in
/// time order). Pieces' audio never overlaps, so each word is heard once.
#[derive(Debug)]
pub struct TruthStt {
    utterances: Vec<(String, u64, u64, String)>,
    given: Mutex<HashSet<usize>>,
    fault: Option<Fault>,
    /// (speaker, start_ms) → (piece number, attempts so far).
    attempts: Mutex<HashMap<(String, u64), (usize, u32)>>,
}

impl TruthStt {
    /// Double answering from `truth`.
    pub fn new(truth: &Truth) -> Self {
        let mut utterances: Vec<_> = truth
            .utterances
            .iter()
            .map(|u| (u.speaker.clone(), u.start_ms, u.end_ms, u.text.clone()))
            .collect();
        utterances.sort_by_key(|u| u.1);
        Self {
            utterances,
            given: Mutex::new(HashSet::new()),
            fault: None,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    /// Inject failures (see [`Fault`]).
    pub fn with_fault(mut self, fault: Fault) -> Self {
        self.fault = (fault.every > 0).then_some(fault);
        self
    }
}

impl SpeechToText for TruthStt {
    fn info(&self) -> SttInfo {
        SttInfo {
            engine: "fake-truth".into(),
            region: "local".into(),
            language: "ko-KR".into(),
            billed_seconds: 0,
        }
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        let lock_error = || SttError::new(SttErrorKind::Transient, "answer sheet lock poisoned");
        if let Some(fault) = self.fault {
            let mut attempts = self.attempts.lock().map_err(|_| lock_error())?;
            let next = attempts.len() + 1;
            let entry = attempts
                .entry((request.speaker.to_string(), request.start_ms))
                .or_insert((next, 0));
            entry.1 += 1;
            if entry.0 % fault.every == 0
                && entry.0 <= fault.last_piece
                && entry.1 <= fault.failing_attempts
            {
                return Err(SttError::new(fault.kind, "injected"));
            }
        }
        let billed_seconds = (request.end_ms - request.start_ms).div_ceil(1_000);
        if request.word_times {
            let mut words = Vec::new();
            for (speaker, start, end, text) in &self.utterances {
                if speaker != request.speaker {
                    continue;
                }
                let parts: Vec<&str> = text.split_whitespace().collect();
                let n = parts.len() as u64;
                for (i, part) in (0u64..).zip(&parts) {
                    let a = start + (end - start) * i / n;
                    let b = start + (end - start) * (i + 1) / n;
                    let middle = (a + b) / 2;
                    if (request.start_ms..request.end_ms).contains(&middle) {
                        words.push(Word {
                            start_ms: a.max(request.start_ms) - request.start_ms,
                            end_ms: b.min(request.end_ms) - request.start_ms,
                            text: (*part).to_string(),
                        });
                    }
                }
            }
            words.sort_by_key(|w| w.start_ms);
            let text = words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            return Ok(SttOutput {
                text,
                billed_seconds,
                words: Some(words),
            });
        }
        let mut given = self.given.lock().map_err(|_| lock_error())?;
        let mut texts = Vec::new();
        for (index, (speaker, start, end, text)) in self.utterances.iter().enumerate() {
            let overlap = request
                .end_ms
                .min(*end)
                .saturating_sub(request.start_ms.max(*start));
            if speaker == request.speaker
                && overlap >= TRUTH_MIN_OVERLAP_MS.min(end - start)
                && given.insert(index)
            {
                texts.push(text.as_str());
            }
        }
        let text = texts.join(" ");
        Ok(SttOutput {
            text,
            billed_seconds,
            words: None,
        })
    }
}
