//! Chirp 3 on Google Cloud Speech-to-Text v2: one `recognize` request per
//! piece, on the default recognizer `_` in the `us` region.
//!
//! The audio goes as raw LINEAR16, 16 kHz mono (no WAV header). Nothing is
//! set about data logging. Errors are sorted by the HTTP status, the gRPC
//! status and the `ErrorInfo` reason of the answer; logs get those codes
//! only, never audio or text.

use std::time::Duration;

use base64::Engine as _;
use buzz_gcp::token::Tokens;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;

use crate::stt::{SpeechToText, SttError, SttErrorKind, SttOutput, SttRequest};
use crate::transcript::SttInfo;

/// Engine name in the script's `stt` block.
pub const CHIRP_ENGINE: &str = "google-chirp_3";
/// Processing region (a multi-region outside Korea).
pub const CHIRP_REGION: &str = "us";
/// Language code.
pub const CHIRP_LANGUAGE: &str = "ko-KR";
/// The regional endpoint.
pub const CHIRP_URL: &str = "https://us-speech.googleapis.com";

/// Chirp 3 as a [`SpeechToText`].
#[derive(Debug)]
pub struct ChirpStt {
    http: reqwest::Client,
    tokens: Tokens,
    url: String,
    quota_project: Option<String>,
}

impl ChirpStt {
    /// Chirp 3 in `project`. `quota_project` goes out as
    /// `x-goog-user-project` (needed with a developer's gcloud login, whose
    /// requests have no project of their own).
    pub fn new(
        tokens: Tokens,
        project: &str,
        quota_project: Option<String>,
    ) -> Result<Self, String> {
        Self::with_base_url(tokens, project, quota_project, CHIRP_URL)
    }

    /// The same against a server at `base_url` (tests).
    pub fn with_base_url(
        tokens: Tokens,
        project: &str,
        quota_project: Option<String>,
        base_url: &str,
    ) -> Result<Self, String> {
        let plain = |s: &str| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        if !plain(project) || quota_project.as_deref().is_some_and(|q| !plain(q)) {
            return Err(format!("not a project id: {project:?}"));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("http client: {error}"))?;
        Ok(Self {
            http,
            tokens,
            url: format!(
                "{}/v2/projects/{project}/locations/{CHIRP_REGION}/recognizers/_:recognize",
                base_url.trim_end_matches('/')
            ),
            quota_project,
        })
    }

    async fn send(&self, body: &serde_json::Value) -> Result<reqwest::Response, SttError> {
        let token = self
            .tokens
            .token()
            .await
            .map_err(|error| SttError::new(SttErrorKind::Auth, format!("token: {error}")))?;
        let mut builder = self
            .http
            .post(&self.url)
            .bearer_auth(token.secret())
            .json(body);
        if let Some(project) = &self.quota_project {
            builder = builder.header("x-goog-user-project", project);
        }
        builder.send().await.map_err(|error| {
            let what = if error.is_timeout() {
                "timeout"
            } else if error.is_connect() {
                "connect"
            } else {
                "send"
            };
            SttError::new(SttErrorKind::Transient, what)
        })
    }
}

/// The request body for one piece.
fn request_body(pcm_16k: &[f32]) -> serde_json::Value {
    let mut bytes = Vec::with_capacity(pcm_16k.len() * 2);
    for sample in pcm_16k {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    json!({
        "config": {
            "explicitDecodingConfig": {
                "encoding": "LINEAR16",
                "sampleRateHertz": 16_000,
                "audioChannelCount": 1,
            },
            "languageCodes": [CHIRP_LANGUAGE],
            "model": "chirp_3",
            "features": { "enableAutomaticPunctuation": true },
        },
        "content": base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[derive(Deserialize)]
struct Answer {
    #[serde(default)]
    results: Vec<AnswerResult>,
    metadata: Option<AnswerMetadata>,
}

#[derive(Deserialize)]
struct AnswerResult {
    #[serde(default)]
    alternatives: Vec<Alternative>,
}

#[derive(Deserialize)]
struct Alternative {
    #[serde(default)]
    transcript: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerMetadata {
    total_billed_duration: Option<String>,
}

/// Text and billed seconds of an answer. The first alternative of each
/// result, joined with spaces; `totalBilledDuration` (`"4s"`, `"4.5s"`)
/// rounded up.
fn read_answer(answer: Answer) -> Result<SttOutput, SttError> {
    let text = answer
        .results
        .iter()
        .filter_map(|result| result.alternatives.first())
        .map(|alternative| alternative.transcript.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let billed = answer
        .metadata
        .and_then(|metadata| metadata.total_billed_duration)
        .unwrap_or_else(|| "0s".to_string());
    let seconds: f64 = billed
        .strip_suffix('s')
        .and_then(|number| number.parse().ok())
        .filter(|seconds: &f64| seconds.is_finite() && *seconds >= 0.0)
        .ok_or_else(|| SttError::new(SttErrorKind::Transient, "bad totalBilledDuration"))?;
    Ok(SttOutput {
        text,
        billed_seconds: seconds.ceil() as u64,
    })
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    status: String,
    #[serde(default)]
    details: Vec<ErrorDetail>,
}

#[derive(Deserialize)]
struct ErrorDetail {
    #[serde(rename = "@type", default)]
    kind: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    metadata: std::collections::HashMap<String, String>,
}

/// One `google.rpc.ErrorInfo` of an error answer: reason and the quota it
/// names (`quota_limit` and `quota_metric` joined), if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorReason {
    /// `ErrorInfo.reason`, e.g. `RATE_LIMIT_EXCEEDED`.
    pub reason: String,
    /// The quota named in the metadata.
    pub quota: String,
}

/// How to handle an error answer.
///
/// - 401, `UNAUTHENTICATED`, 403 and setup errors (`NOT_FOUND`,
///   `FAILED_PRECONDITION`: no recognizer, API off, …): nothing will work,
///   stop ([`SttErrorKind::Auth`]).
/// - 429 / `RESOURCE_EXHAUSTED`: `RATE_LIMIT_EXCEEDED` on a per-minute (or
///   unnamed) quota is a rate limit; on a per-day quota, or any other
///   reason, the quota is used up ([`SttErrorKind::Quota`]). No reason at
///   all: a rate limit (retrying costs nothing; a failed request is not
///   billed).
/// - 400 `INVALID_ARGUMENT`: this audio is refused ([`SttErrorKind::Rejected`]).
/// - Anything else (5xx, 408, `UNAVAILABLE`, …): transient. Never final, so
///   an error nobody expected is retried, not written off.
pub fn classify(status: u16, grpc_status: &str, reasons: &[ErrorReason]) -> SttErrorKind {
    let exhausted = status == 429 || grpc_status == "RESOURCE_EXHAUSTED";
    if exhausted || (status == 403 && reasons.iter().any(|r| r.reason == "RATE_LIMIT_EXCEEDED")) {
        let per_day = |quota: &str| {
            let quota = quota.to_ascii_lowercase();
            quota.contains("perday") || quota.contains("per_day") || quota.contains("daily")
        };
        return match reasons.first() {
            None => SttErrorKind::RateLimited,
            Some(r) if r.reason == "RATE_LIMIT_EXCEEDED" && !per_day(&r.quota) => {
                SttErrorKind::RateLimited
            }
            Some(_) => SttErrorKind::Quota,
        };
    }
    match (status, grpc_status) {
        (401, _) | (_, "UNAUTHENTICATED") | (403, _) | (_, "PERMISSION_DENIED") => {
            SttErrorKind::Auth
        }
        (404, _) | (_, "NOT_FOUND") | (_, "FAILED_PRECONDITION") => SttErrorKind::Auth,
        (400, "INVALID_ARGUMENT") | (400, "") => SttErrorKind::Rejected,
        _ => SttErrorKind::Transient,
    }
}

/// The error of a failed answer: kind, and a code of HTTP status, gRPC
/// status and reasons (no message text).
async fn read_error(response: reqwest::Response) -> SttError {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let (grpc_status, reasons) = match serde_json::from_str::<ErrorEnvelope>(&body) {
        Ok(envelope) => (
            envelope.error.status,
            envelope
                .error
                .details
                .into_iter()
                .filter(|detail| detail.kind.ends_with("google.rpc.ErrorInfo"))
                .map(|detail| ErrorReason {
                    reason: detail.reason,
                    quota: ["quota_limit", "quota_metric"]
                        .iter()
                        .filter_map(|key| detail.metadata.get(*key))
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(" "),
                })
                .collect::<Vec<_>>(),
        ),
        Err(_) => (String::new(), Vec::new()),
    };
    let kind = classify(status, &grpc_status, &reasons);
    let mut code = format!("HTTP {status}");
    for part in
        std::iter::once(grpc_status.as_str()).chain(reasons.iter().map(|r| r.reason.as_str()))
    {
        if !part.is_empty() {
            code.push(' ');
            code.push_str(part);
        }
    }
    SttError::new(kind, code)
}

impl SpeechToText for ChirpStt {
    fn info(&self) -> SttInfo {
        SttInfo {
            engine: CHIRP_ENGINE.into(),
            region: CHIRP_REGION.into(),
            language: CHIRP_LANGUAGE.into(),
            billed_seconds: 0,
        }
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        let body = request_body(request.pcm_16k);
        let mut response = self.send(&body).await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            // An expired or revoked token: once more with a new one.
            self.tokens.forget().await;
            response = self.send(&body).await?;
        }
        if !response.status().is_success() {
            return Err(read_error(response).await);
        }
        let answer: Answer = response
            .json()
            .await
            .map_err(|_| SttError::new(SttErrorKind::Transient, "unreadable answer"))?;
        read_answer(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(reason: &str, quota: &str) -> ErrorReason {
        ErrorReason {
            reason: reason.into(),
            quota: quota.into(),
        }
    }

    #[test]
    fn errors_are_sorted_by_status_and_reason() {
        use SttErrorKind::*;
        let per_minute = reason(
            "RATE_LIMIT_EXCEEDED",
            "RecognizeRequestsPerMinutePerProject speech.googleapis.com/recognize_requests",
        );
        let per_day = reason("RATE_LIMIT_EXCEEDED", "RecognizeRequestsPerDayPerProject x");
        let cases: [(u16, &str, Vec<ErrorReason>, SttErrorKind); 14] = [
            (
                429,
                "RESOURCE_EXHAUSTED",
                vec![per_minute.clone()],
                RateLimited,
            ),
            (429, "RESOURCE_EXHAUSTED", vec![], RateLimited),
            (429, "RESOURCE_EXHAUSTED", vec![per_day], Quota),
            (
                429,
                "RESOURCE_EXHAUSTED",
                vec![reason("QUOTA_EXCEEDED", "")],
                Quota,
            ),
            (403, "PERMISSION_DENIED", vec![per_minute], RateLimited),
            (
                403,
                "PERMISSION_DENIED",
                vec![reason("IAM_PERMISSION_DENIED", "")],
                Auth,
            ),
            (
                403,
                "PERMISSION_DENIED",
                vec![reason("SERVICE_DISABLED", "")],
                Auth,
            ),
            (401, "UNAUTHENTICATED", vec![], Auth),
            (404, "NOT_FOUND", vec![], Auth),
            (400, "FAILED_PRECONDITION", vec![], Auth),
            (400, "INVALID_ARGUMENT", vec![], Rejected),
            (503, "UNAVAILABLE", vec![], Transient),
            (500, "INTERNAL", vec![], Transient),
            (409, "ABORTED", vec![], Transient),
        ];
        for (status, grpc, reasons, expected) in cases {
            assert_eq!(
                classify(status, grpc, &reasons),
                expected,
                "{status} {grpc} {reasons:?}"
            );
        }
    }

    #[test]
    fn answers_join_first_alternatives_and_round_billing_up() {
        let answer: Answer = serde_json::from_value(json!({
            "results": [
                {"alternatives": [{"transcript": " 안녕하세요 "}, {"transcript": "x"}]},
                {"alternatives": []},
                {"alternatives": [{"transcript": "반갑습니다."}]}
            ],
            "metadata": {"totalBilledDuration": "4.2s", "requestId": "r"}
        }))
        .expect("answer");
        assert_eq!(
            read_answer(answer).expect("read"),
            SttOutput {
                text: "안녕하세요 반갑습니다.".into(),
                billed_seconds: 5
            }
        );
        let silent: Answer =
            serde_json::from_value(json!({"metadata": {"totalBilledDuration": "3s"}}))
                .expect("answer");
        assert_eq!(
            read_answer(silent).expect("read"),
            SttOutput {
                text: String::new(),
                billed_seconds: 3
            }
        );
    }

    #[test]
    fn the_audio_goes_as_16_bit_little_endian_without_a_header() {
        let body = request_body(&[0.0, 1.0, -1.0, 0.5, 2.0]);
        let content = body["content"].as_str().expect("content");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content)
            .expect("base64");
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(samples, [0, 32_767, -32_767, 16_384, 32_767]);
        let config = &body["config"];
        assert_eq!(config["model"], "chirp_3");
        assert_eq!(config["languageCodes"], json!(["ko-KR"]));
        assert_eq!(
            config["explicitDecodingConfig"],
            json!({"encoding": "LINEAR16", "sampleRateHertz": 16_000, "audioChannelCount": 1})
        );
        // Nothing beyond these: no logging or other options.
        let mut keys: Vec<_> = config.as_object().expect("object").keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "explicitDecodingConfig",
                "features",
                "languageCodes",
                "model"
            ]
        );
    }
}
