//! Where the transcriber plugs in (step 4). The real engine (Chirp 3) comes
//! later; [`TruthStt`] is a test double that answers from a fake meeting's
//! answer sheet.

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

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
}

/// What the engine returned for one piece.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SttOutput {
    /// Transcribed text (may be empty for silence).
    pub text: String,
    /// Seconds billed for this request.
    pub billed_seconds: u64,
}

/// Why a piece could not be transcribed. Carries no audio or text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SttError {
    /// The engine answered with an error.
    #[error("transcription failed: {0}")]
    Engine(String),
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

/// Test double: returns the answer-sheet text of each sentence of the
/// requested speaker that overlaps the piece by at least 300 ms and has not
/// been returned before. Pieces of one person arrive in time order, so a
/// sentence the VAD split in two goes to its first piece — once.
#[derive(Debug)]
pub struct TruthStt {
    utterances: Vec<(String, u64, u64, String)>,
    given: Mutex<HashSet<usize>>,
    fail_every: Option<usize>,
    calls: AtomicUsize,
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
            fail_every: None,
            calls: AtomicUsize::new(0),
        }
    }

    /// Make every `n`-th call fail (1-based), to exercise the failure path.
    pub fn failing_every(mut self, n: usize) -> Self {
        self.fail_every = (n > 0).then_some(n);
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
        let call = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
        if self.fail_every.is_some_and(|n| call.is_multiple_of(n)) {
            return Err(SttError::Engine("simulated failure".into()));
        }
        let mut given = self
            .given
            .lock()
            .map_err(|_| SttError::Engine("answer sheet lock poisoned".into()))?;
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
            billed_seconds: (request.end_ms - request.start_ms).div_ceil(1_000),
        })
    }
}
