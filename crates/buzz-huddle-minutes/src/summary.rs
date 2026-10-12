//! 회의 요약(설계 7번). 스크립트(`huddle-transcript/1`)를 Vertex AI Gemini 에
//! 보내 제목·요약·결정사항·할 일·주제별 정리를 받고, 모델이 지어낸 것을 코드로
//! 걸러 낸다.
//!
//! 늘 지킬 것: **AI 가 담당자·기한을 지어내지 않는다.**
//! - 근거 시각(`evidence_start_ms`)은 실제 스크립트 줄의 `start_ms` 여야 한다.
//!   아니면 가까운 줄로 붙이고, 너무 멀면 버린다.
//! - 담당자는 참석자여야 하고, 그 근거 글(`assignee_quote`)이 근거 줄 근처에
//!   실제로 있어야 한다. 아니면 비우고 "애매".
//! - 기한은 근거 글(`due_quote`)이 근거 줄 근처에 실제로 있어야 하고, 날짜는
//!   그 글에서 코드가 직접 읽어 낸다(회의 날짜 KST 기준). 못 읽으면 비우고 "애매".
//! - 코드는 "확정"을 "애매"로 내릴 수만 있고 올리지는 않는다.
//!
//! 토큰은 밖에서 받는다. 토큰 값과 회의 내용은 로그·오류에 남기지 않는다.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::stt::FAILED_TEXT;
use crate::transcript::Transcript;

/// [`Summary::format`] 값.
pub const SUMMARY_FORMAT: &str = "huddle-summary/1";
/// 기본 요약 모델.
pub const DEFAULT_MODEL: &str = "gemini-3.8-flash";
/// 기본 GCP 프로젝트.
pub const DEFAULT_PROJECT: &str = "a2d2-lab";
/// 기본 Vertex AI 위치.
pub const DEFAULT_LOCATION: &str = "global";
/// Vertex AI 주소.
pub const VERTEX_BASE_URL: &str = "https://aiplatform.googleapis.com";
/// 근거 시각이 실제 줄과 이만큼(ms) 안쪽으로 어긋나면 가장 가까운 줄로 붙인다.
/// 더 멀면 버린다.
pub const EVIDENCE_SNAP_MS: u64 = 30_000;
/// 담당자·기한 근거 글을 찾는 범위: 근거 줄 앞뒤로 이만큼의 줄.
pub const QUOTE_WINDOW_LINES: usize = 6;
/// 담당자 근거 글의 최소 길이(글자·숫자만 셈). "제가" 같은 말은 누구인지 못 보여 준다.
pub const MIN_ASSIGNEE_QUOTE_CHARS: usize = 4;

/// 한국 시간(UTC+9, 서머타임 없음).
pub fn kst() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).expect("UTC+9 is a valid offset")
}

/// 노션·요약이 회의 하나를 가리키는 값: `{channel_id}:{첫 세션 id}`.
/// 한 채널에 회의가 여럿일 수 있어서 첫 세션까지 붙인다.
pub fn huddle_id(transcript: &Transcript) -> String {
    let first = transcript
        .session_ids
        .first()
        .map(ToString::to_string)
        .unwrap_or_default();
    format!("{}:{first}", transcript.channel_id)
}

/// pubkey 로 사람 이름을 찾는 곳. 진짜 이름표는 나중에 붙인다.
pub trait DisplayNames {
    /// `pubkey`(hex) 의 표시 이름.
    fn display_name(&self, pubkey: &str) -> String;
}

/// 기본 이름표: pubkey 앞 8자.
#[derive(Debug, Clone, Copy, Default)]
pub struct PubkeyPrefixNames;

impl DisplayNames for PubkeyPrefixNames {
    fn display_name(&self, pubkey: &str) -> String {
        pubkey.chars().take(8).collect()
    }
}

/// 요약 결과(`huddle-summary/1`). 회의 내용이 들어 있으니 0600 으로 쓴다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    /// 늘 [`SUMMARY_FORMAT`].
    pub format: String,
    /// 이 요약이 어느 회의 것인지([`huddle_id`]).
    pub huddle_id: String,
    /// 요청한 모델 이름.
    pub model: String,
    /// 회의 제목 한 줄.
    pub title: String,
    /// 요약 문단.
    pub summary: String,
    /// 결정사항.
    pub decisions: Vec<Decision>,
    /// 할 일.
    pub action_items: Vec<ActionItem>,
    /// 주제별 정리.
    pub topics: Vec<Topic>,
    /// 토큰 사용량과 비용.
    pub usage: Usage,
    /// 코드가 모델 답을 고친 개수.
    pub corrections: Corrections,
}

/// 결정사항 하나.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    /// 결정 내용.
    pub text: String,
    /// 근거 줄의 `start_ms`. 맞는 줄이 없으면 `None`.
    pub evidence_start_ms: Option<u64>,
}

/// 할 일 하나. 노션 기획 "노션<>허들 기반 업무 자동화" 1단계가 그대로 받는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionItem {
    /// 할 일 내용.
    pub text: String,
    /// 담당자 pubkey(hex). 말로 정해졌고 검사를 통과했을 때만.
    pub assignee_pubkey: Option<String>,
    /// 담당자를 정한 스크립트 글(그대로 베낀 것).
    pub assignee_quote: Option<String>,
    /// 기한, KST. `YYYY-MM-DD` 또는 `YYYY-MM-DDTHH:MM:00+09:00`.
    pub due: Option<String>,
    /// 기한을 말한 스크립트 글(그대로 베낀 것).
    pub due_quote: Option<String>,
    /// 확정 또는 애매.
    pub status: ItemStatus,
    /// 근거 줄의 `start_ms`. 맞는 줄이 없으면 `None`.
    pub evidence_start_ms: Option<u64>,
}

/// 할 일이 분명한지.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ItemStatus {
    /// 담당자가 분명하고, 기한을 말했다면 그 기한도 분명하다.
    #[serde(rename = "확정")]
    Firm,
    /// 담당자나 기한이 분명하지 않다.
    #[serde(rename = "애매")]
    Unsure,
}

impl ItemStatus {
    /// "확정" 또는 "애매".
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Firm => "확정",
            Self::Unsure => "애매",
        }
    }
}

/// 주제 하나.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Topic {
    /// 주제 이름.
    pub title: String,
    /// 주제가 시작한 줄의 `start_ms`. 맞는 줄이 없으면 `None`.
    pub start_ms: Option<u64>,
    /// 오간 내용.
    pub points: Vec<String>,
}

/// 토큰 사용량. 비용 계산용.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    /// 응답에 찍힌 실제 모델 버전.
    pub model_version: Option<String>,
    /// 입력 토큰.
    pub input_tokens: u64,
    /// 출력 토큰(생각 토큰 뺌).
    pub output_tokens: u64,
    /// 생각 토큰. 출력 단가로 매긴다.
    pub thinking_tokens: u64,
    /// 달러. 단가를 모르는 모델이면 `None`.
    pub cost_usd: Option<f64>,
}

/// 코드가 모델 답을 고친 개수.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Corrections {
    /// 근거 시각이 실제 줄과 달라서 가장 가까운 줄로 붙인 수.
    pub evidence_snapped: u64,
    /// 근거 시각이 어느 줄과도 너무 멀어서 버린 수.
    pub evidence_dropped: u64,
    /// 담당자를 비운 수(참석자가 아니거나 근거 글이 스크립트에 없음).
    pub assignee_cleared: u64,
    /// 기한을 비운 수(근거 글이 없거나 날짜를 못 읽음).
    pub due_cleared: u64,
    /// 모델이 낸 날짜를 근거 글에서 읽은 날짜로 바꾼 수.
    pub due_fixed: u64,
    /// 근거 글에 시각이 없어서 기한에서 시각만 뺀 수.
    pub due_time_dropped: u64,
    /// "확정"을 "애매"로 내린 수.
    pub status_downgraded: u64,
}

impl Corrections {
    /// 고친 것 모두 합친 수.
    pub fn total(&self) -> u64 {
        self.evidence_snapped
            + self.evidence_dropped
            + self.assignee_cleared
            + self.due_cleared
            + self.due_fixed
            + self.due_time_dropped
            + self.status_downgraded
    }
}

/// 100만 토큰당 단가(달러).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    /// 입력.
    pub input_usd_per_mtok: f64,
    /// 출력(생각 토큰 포함).
    pub output_usd_per_mtok: f64,
}

/// 아는 모델의 단가. gemini-3.8-flash: 입력 1.5, 출력 7.5(구글 가격 목록 API,
/// 2026-10-12 확인). 모르는 모델은 `None`.
pub fn known_price(model: &str) -> Option<Price> {
    match model {
        "gemini-3.8-flash" => Some(Price {
            input_usd_per_mtok: 1.5,
            output_usd_per_mtok: 7.5,
        }),
        _ => None,
    }
}

/// 일시 오류·429 를 다시 하는 법. `pipeline::SttPolicy` 와 같은 모양.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// 첫 시도 뒤에 더 해 볼 횟수.
    pub retries: u32,
    /// 일시 오류 뒤 첫 기다림(ms). 다시 할 때마다 두 배.
    pub retry_delay_ms: u64,
    /// 429 뒤 첫 기다림(ms). 다시 할 때마다 두 배. `Retry-After` 가 있으면 그걸 따른다.
    pub rate_limit_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            retries: 3,
            retry_delay_ms: 500,
            rate_limit_delay_ms: 5_000,
        }
    }
}

impl RetryPolicy {
    /// `retry` 번째(0부터) 다시 하기 전 기다림. `retry_after` 는 서버가 준 초.
    pub fn wait(&self, rate_limited: bool, retry: u32, retry_after: Option<u64>) -> Duration {
        let base = if rate_limited {
            self.rate_limit_delay_ms
        } else {
            self.retry_delay_ms
        };
        let backoff = base.saturating_mul(1u64 << retry.min(16));
        let ms = match retry_after {
            // 서버가 준 값을 따른다(노션 워크스페이스 한도는 1분을 넘기도 한다).
            // 다만 5분은 넘기지 않는다.
            Some(seconds) => seconds.saturating_mul(1_000).min(300_000),
            None => backoff,
        };
        Duration::from_millis(ms)
    }
}

/// Gemini 부르는 설정.
#[derive(Debug, Clone)]
pub struct GeminiSettings {
    /// 시험에서 가짜 서버로 바꾼다.
    pub base_url: String,
    /// GCP 프로젝트.
    pub project: String,
    /// Vertex AI 위치.
    pub location: String,
    /// 모델 이름. 비교를 위해 늘 설정값으로 둔다.
    pub model: String,
    /// 다시 하는 법.
    pub retry: RetryPolicy,
    /// 단가. `None` 이면 비용을 못 매긴다.
    pub price: Option<Price>,
}

impl GeminiSettings {
    /// `model` 로 기본 설정.
    pub fn new(model: &str) -> Self {
        Self {
            base_url: VERTEX_BASE_URL.into(),
            project: DEFAULT_PROJECT.into(),
            location: DEFAULT_LOCATION.into(),
            model: model.into(),
            retry: RetryPolicy::default(),
            price: known_price(model),
        }
    }

    /// generateContent 주소.
    pub fn endpoint(&self) -> String {
        format!(
            "{}/v1/projects/{}/locations/{}/publishers/google/models/{}:generateContent",
            self.base_url.trim_end_matches('/'),
            self.project,
            self.location,
            self.model
        )
    }
}

/// 요약 실패 종류. 종류마다 다르게 다룬다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryErrorKind {
    /// 토큰이 틀렸거나 만료(401).
    Auth,
    /// 권한 없음(403).
    Permission,
    /// 한도·429. 다시 해 보고도 안 됐을 때.
    RateLimited,
    /// 5xx·연결 끊김. 다시 해 보고도 안 됐을 때.
    Transient,
    /// 요청이 잘못됨(400·404, 예: 없는 모델 이름). 다시 해도 안 된다.
    BadRequest,
    /// 답이 왔는데 형식이 깨짐(JSON 아님, 잘림, 후보 없음).
    BadResponse,
}

impl SummaryErrorKind {
    /// 로그용 짧은 이름.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Permission => "permission",
            Self::RateLimited => "rate-limited",
            Self::Transient => "transient",
            Self::BadRequest => "bad-request",
            Self::BadResponse => "bad-response",
        }
    }
}

impl std::fmt::Display for SummaryErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 요약 실패. 종류와 짧은 코드만 담는다(회의 내용·토큰은 안 담는다).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("summary failed ({kind}): {code}")]
pub struct SummaryError {
    /// 종류.
    pub kind: SummaryErrorKind,
    /// 예: `HTTP 403 PERMISSION_DENIED`.
    pub code: String,
}

impl SummaryError {
    fn new(kind: SummaryErrorKind, code: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
        }
    }
}

/// 모델에게 주는 일의 설명.
const SYSTEM_PROMPT: &str = "\
너는 한국어 회의록을 정리하는 사람이다. 주어진 스크립트에 있는 말만 근거로 쓴다.
- title: 회의 제목 한 줄.
- summary: 회의 전체 요약 한 문단.
- decisions: 회의에서 정해진 것. evidence_start_ms 는 그 결정이 나온 줄의 [ ] 안 숫자를 그대로 쓴다.
- action_items: 해야 할 일로 나온 것. 누가 할지 안 정해진 일(\"누가 좀 알아봐 줘\" 같은 것)도 빼지 말고 넣는다.
  - assignee_id: 맡은 사람의 참석자 id. 참석자 목록 각 줄 맨 앞의 P1, P2 같은 값만 쓴다(이름 말고). 말로 분명히 정해지지 않았으면 null.
  - assignee_quote: 담당자가 정해졌음을 보여 주는 문장을 스크립트에서 글자 그대로 통째로 베낀 것. 되도록 담당자 본인이 맡겠다고 한 말을 쓴다. 없으면 null.
  - due: 기한. 회의 날짜(KST) 기준으로 풀어서 YYYY-MM-DD 또는 YYYY-MM-DDTHH:MM 로 쓴다. 기한을 말하지 않았으면 null.
  - due_quote: 기한을 말한 부분(요일·날짜·시각이 들어간 말)을 스크립트에서 글자 그대로 베낀 것. 없으면 null.
  - status: 담당자가 분명하고 (기한을 말했다면) 기한도 분명하면 \"확정\", 아니면 \"애매\".
  - evidence_start_ms: 그 할 일이 나온 줄의 [ ] 안 숫자를 그대로 쓴다.
- topics: 주제별 정리. start_ms 는 그 주제가 시작한 줄의 [ ] 안 숫자, points 는 오간 내용.
절대 담당자나 기한을 지어내지 마라. 스크립트에 없는 것은 null 로 두고 \"애매\"로 한다.
사람을 가리킬 때는 참석자 목록의 이름을 쓴다. 모든 글은 한국어로 쓴다.";

/// 모델 답의 JSON 모양(JSON Schema). 모든 칸을 `required` 로 둬서 빠뜨리지
/// 못하게 하고, 모르면 `null` 을 쓰게 한다.
///
/// Vertex v1 REST 참고서는 `responseMimeType`·`responseSchema` 를 낡은 것으로
/// 적고 `generationConfig.responseFormat[].text.{mimeType, schema}` 를 쓰라고
/// 한다. 2026-10-12 에 gemini-3.8-flash 로 둘 다 200 인 것을 확인하고 새 쪽을 쓴다.
fn response_schema() -> serde_json::Value {
    let nullable_string = json!({ "type": ["string", "null"] });
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "summary": { "type": "string" },
            "decisions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string" },
                        "evidence_start_ms": { "type": "integer" }
                    },
                    "required": ["text", "evidence_start_ms"]
                }
            },
            "action_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string" },
                        "assignee_id": nullable_string,
                        "assignee_quote": nullable_string,
                        "due": nullable_string,
                        "due_quote": nullable_string,
                        "status": { "type": "string", "enum": ["확정", "애매"] },
                        "evidence_start_ms": { "type": "integer" }
                    },
                    "required": [
                        "text", "assignee_id", "assignee_quote", "due", "due_quote",
                        "status", "evidence_start_ms"
                    ]
                }
            },
            "topics": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "start_ms": { "type": "integer" },
                        "points": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["title", "start_ms", "points"]
                }
            }
        },
        "required": ["title", "summary", "decisions", "action_items", "topics"]
    })
}

/// 참석자 id(P1, P2, …) ↔ pubkey. 참석자 순서, 그다음 참석자 목록에 없는 화자.
fn participant_ids(transcript: &Transcript) -> Vec<(String, String)> {
    let mut pubkeys: Vec<&str> = transcript
        .participants
        .iter()
        .map(|p| p.pubkey.as_str())
        .collect();
    for segment in &transcript.segments {
        if !pubkeys.contains(&segment.speaker.as_str()) {
            pubkeys.push(&segment.speaker);
        }
    }
    pubkeys
        .into_iter()
        .enumerate()
        .map(|(i, pubkey)| (format!("P{}", i + 1), pubkey.to_string()))
        .collect()
}

/// 근거로 쓸 수 있는 줄: 받아쓰기에 성공한, 비지 않은 줄. 시작 순.
fn usable_lines(transcript: &Transcript) -> Vec<(u64, &str, &str)> {
    let mut lines: Vec<_> = transcript
        .segments
        .iter()
        .filter(|s| s.text != FAILED_TEXT && !s.text.trim().is_empty())
        .map(|s| (s.start_ms, s.speaker.as_str(), s.text.as_str()))
        .collect();
    lines.sort_by_key(|line| line.0);
    lines
}

/// 회의 시작 날짜(KST).
pub fn meeting_date_kst(transcript: &Transcript) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(&transcript.started_at)
        .ok()
        .map(|at| at.with_timezone(&kst()).date_naive())
}

fn weekday_ko(day: Weekday) -> &'static str {
    match day {
        Weekday::Mon => "월",
        Weekday::Tue => "화",
        Weekday::Wed => "수",
        Weekday::Thu => "목",
        Weekday::Fri => "금",
        Weekday::Sat => "토",
        Weekday::Sun => "일",
    }
}

/// 모델에게 보내는 글: 회의 날짜, 참석자 목록, 스크립트 줄.
pub fn build_prompt(transcript: &Transcript, names: &dyn DisplayNames) -> String {
    let ids = participant_ids(transcript);
    let id_of: HashMap<&str, &str> = ids
        .iter()
        .map(|(id, pubkey)| (pubkey.as_str(), id.as_str()))
        .collect();
    let mut prompt = String::new();
    if let Some(date) = meeting_date_kst(transcript) {
        prompt.push_str(&format!(
            "회의 날짜(KST): {} ({}요일)\n",
            date.format("%Y-%m-%d"),
            weekday_ko(date.weekday())
        ));
    }
    prompt.push_str(&format!(
        "회의 길이: {}분\n\n참석자 목록:\n",
        transcript.duration_ms / 60_000
    ));
    for (id, pubkey) in &ids {
        prompt.push_str(&format!("- {id} (이름: {})\n", names.display_name(pubkey)));
    }
    prompt.push_str("\n스크립트([시작 ms] 참석자 id: 말):\n");
    for (start_ms, speaker, text) in usable_lines(transcript) {
        let id = id_of.get(speaker).copied().unwrap_or("?");
        prompt.push_str(&format!("[{start_ms}] {id}: {}\n", text.trim()));
    }
    prompt
}

/// generateContent 요청 본문. temperature 같은 표본 값은 넣지 않는다(3.6 Flash
/// 부터 무시된다). 생각 수준은 모델 기본값(3.8 Flash 는 MEDIUM)을 쓴다.
pub fn build_request(transcript: &Transcript, names: &dyn DisplayNames) -> serde_json::Value {
    json!({
        "systemInstruction": { "parts": [{ "text": SYSTEM_PROMPT }] },
        "contents": [{ "role": "user", "parts": [{ "text": build_prompt(transcript, names) }] }],
        "generationConfig": {
            "responseFormat": [{
                "text": { "mimeType": "APPLICATION_JSON", "schema": response_schema() }
            }]
        }
    })
}

/// 모델이 낸 답(검사 전).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Draft {
    title: String,
    summary: String,
    decisions: Vec<DraftDecision>,
    action_items: Vec<DraftActionItem>,
    topics: Vec<DraftTopic>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct DraftDecision {
    text: String,
    evidence_start_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct DraftActionItem {
    text: String,
    assignee_id: Option<String>,
    assignee_quote: Option<String>,
    due: Option<String>,
    due_quote: Option<String>,
    status: Option<String>,
    evidence_start_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct DraftTopic {
    title: String,
    start_ms: Option<f64>,
    points: Vec<String>,
}

/// 글자·숫자만 남기고 소문자로(띄어쓰기·문장부호 차이를 무시하려고).
fn squash(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 모델 답을 스크립트에 대 보고 고치는 일.
struct Checker<'a> {
    lines: Vec<(u64, &'a str, &'a str)>,
    /// 모델이 담당자로 낼 수 있는 값 → pubkey.
    ids: HashMap<String, String>,
    /// pubkey → 이름(글자·숫자만).
    names: HashMap<String, String>,
    meeting_date: Option<NaiveDate>,
    corrections: Corrections,
}

impl<'a> Checker<'a> {
    fn new(transcript: &'a Transcript, display: &dyn DisplayNames) -> Self {
        let mut ids = HashMap::new();
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        for (id, pubkey) in participant_ids(transcript) {
            ids.insert(id, pubkey.clone());
            ids.insert(pubkey.clone(), pubkey.clone());
            let name = display.display_name(&pubkey).trim().to_string();
            by_name.entry(name).or_default().push(pubkey);
        }
        // 모델이 P 번호 대신 이름을 내기도 한다(2026-10-12 실제 시험에서 봄).
        // 이름이 한 사람만 가리킬 때만 받는다.
        for (name, pubkeys) in by_name {
            if let [pubkey] = &pubkeys[..] {
                if !name.is_empty() {
                    ids.entry(name).or_insert_with(|| pubkey.clone());
                }
            }
        }
        let names = ids
            .values()
            .map(|pubkey| (pubkey.clone(), squash(&display.display_name(pubkey))))
            .collect();
        Self {
            lines: usable_lines(transcript),
            ids,
            names,
            meeting_date: meeting_date_kst(transcript),
            corrections: Corrections::default(),
        }
    }

    /// 근거 줄 앞뒤 [`QUOTE_WINDOW_LINES`] 줄의 범위.
    fn window(&self, line: usize) -> std::ops::Range<usize> {
        line.saturating_sub(QUOTE_WINDOW_LINES)
            ..(line + QUOTE_WINDOW_LINES + 1).min(self.lines.len())
    }

    /// 근거 시각 → 실제 줄 번호. 같은 시각이 있으면 그대로, 가까우면 붙이고,
    /// 멀면 버린다.
    fn evidence_line(&mut self, claimed: Option<f64>) -> Option<usize> {
        let claimed = claimed.filter(|ms| ms.is_finite() && *ms >= 0.0)?;
        let claimed = claimed.round() as u64;
        let (index, distance) = self
            .lines
            .iter()
            .enumerate()
            .map(|(i, line)| (i, line.0.abs_diff(claimed)))
            .min_by_key(|(_, distance)| *distance)?;
        if distance == 0 {
            Some(index)
        } else if distance <= EVIDENCE_SNAP_MS {
            self.corrections.evidence_snapped += 1;
            Some(index)
        } else {
            self.corrections.evidence_dropped += 1;
            None
        }
    }

    fn evidence(&mut self, claimed: Option<f64>) -> Option<u64> {
        // 모델이 근거를 아예 안 냈으면 버린 것으로 센다.
        if claimed.is_none() {
            self.corrections.evidence_dropped += 1;
            return None;
        }
        self.evidence_line(claimed).map(|i| self.lines[i].0)
    }

    /// `quote` 가 `line` 줄 앞뒤 [`QUOTE_WINDOW_LINES`] 줄 안에 실제로 있나.
    fn quote_near(&self, line: usize, quote: &str) -> bool {
        let quote = squash(quote);
        if quote.is_empty() {
            return false;
        }
        let window: String = self.lines[self.window(line)]
            .iter()
            .map(|(_, _, text)| squash(text))
            .collect();
        window.contains(&quote)
    }

    /// 담당자 근거 글 검사. 근거 줄 근처에 그 글이 든 줄이 있고, 그 줄을 담당자
    /// 본인이 말했거나 글에 담당자 이름이 들어 있어야 한다. "제가"처럼 너무 짧은
    /// 글은 누구인지 못 보여 주니 받지 않는다.
    fn assignee_quoted(&self, line: usize, quote: &str, pubkey: &str) -> bool {
        let quote = squash(quote);
        if quote.chars().count() < MIN_ASSIGNEE_QUOTE_CHARS {
            return false;
        }
        let named = self
            .names
            .get(pubkey)
            .is_some_and(|name| name.chars().count() >= 2 && quote.contains(name.as_str()));
        self.lines[self.window(line)]
            .iter()
            .any(|(_, speaker, text)| {
                squash(text).contains(&quote) && (*speaker == pubkey || named)
            })
    }

    fn action_item(&mut self, draft: DraftActionItem) -> ActionItem {
        let line = if draft.evidence_start_ms.is_none() {
            self.corrections.evidence_dropped += 1;
            None
        } else {
            self.evidence_line(draft.evidence_start_ms)
        };
        let mut unsure = draft.status.as_deref() != Some(ItemStatus::Firm.as_str());

        // 담당자: 참석자 id 여야 하고, 근거 글이 근거 줄 근처에 있으면서 그
        // 사람과 이어져야 한다(본인이 한 말이거나 이름이 든 말).
        let mut assignee_pubkey = None;
        if let Some(id) = draft.assignee_id.as_deref().filter(|id| !id.is_empty()) {
            let pubkey = self.ids.get(id.trim()).cloned();
            let quoted = match (line, draft.assignee_quote.as_deref(), pubkey.as_deref()) {
                (Some(line), Some(quote), Some(pubkey)) => {
                    self.assignee_quoted(line, quote, pubkey)
                }
                _ => false,
            };
            if quoted {
                assignee_pubkey = pubkey;
            } else {
                self.corrections.assignee_cleared += 1;
            }
        }
        if assignee_pubkey.is_none() {
            unsure = true;
        }

        // 기한: 근거 글이 있어야 하고, 날짜는 그 글에서 코드가 읽는다.
        let said_due = draft.due.is_some() || draft.due_quote.is_some();
        let mut due = None;
        if said_due {
            let quote = draft.due_quote.as_deref().filter(|quote| match line {
                Some(line) => self.quote_near(line, quote),
                None => false,
            });
            due = match (quote, self.meeting_date) {
                (Some(quote), Some(meeting)) => {
                    self.resolve_due(quote, draft.due.as_deref(), meeting)
                }
                _ => None,
            };
            if due.is_none() {
                self.corrections.due_cleared += 1;
                unsure = true;
            }
        }

        let status = if unsure {
            if draft.status.as_deref() == Some(ItemStatus::Firm.as_str()) {
                self.corrections.status_downgraded += 1;
            }
            ItemStatus::Unsure
        } else {
            ItemStatus::Firm
        };
        ActionItem {
            text: draft.text,
            assignee_quote: draft.assignee_quote,
            assignee_pubkey,
            due,
            due_quote: draft.due_quote,
            status,
            evidence_start_ms: line.map(|i| self.lines[i].0),
        }
    }

    /// 근거 글에서 날짜를 읽고(못 읽으면 `None`), 시각은 글에 시각이 있을 때만
    /// 남긴다. 회의 날보다 앞선 날짜는 버린다.
    fn resolve_due(
        &mut self,
        quote: &str,
        claimed: Option<&str>,
        meeting: NaiveDate,
    ) -> Option<String> {
        let date = date_from_quote(quote, meeting)?;
        if date < meeting {
            return None;
        }
        let claimed = claimed.and_then(parse_claimed_due);
        if claimed.map(|(day, _)| day) != Some(date) {
            self.corrections.due_fixed += 1;
        }
        let hours = hours_from_quote(quote);
        let claimed_time = claimed.and_then(|(_, time)| time);
        let time = match (&hours, claimed_time) {
            (Some((candidates, minute)), Some(time))
                if candidates.contains(&chrono::Timelike::hour(&time)) =>
            {
                NaiveTime::from_hms_opt(chrono::Timelike::hour(&time), *minute, 0)
            }
            (Some((candidates, minute)), _) if candidates.len() == 1 => {
                NaiveTime::from_hms_opt(candidates[0], *minute, 0)
            }
            _ => None,
        };
        if time.is_none() && claimed_time.is_some() {
            self.corrections.due_time_dropped += 1;
        }
        Some(match time {
            Some(time) => format!(
                "{}T{}+09:00",
                date.format("%Y-%m-%d"),
                time.format("%H:%M:%S")
            ),
            None => date.format("%Y-%m-%d").to_string(),
        })
    }
}

/// 모델이 낸 기한 글(`2026-10-16`, `2026-10-16T18:00` 등)을 KST 날짜·시각으로.
fn parse_claimed_due(value: &str) -> Option<(NaiveDate, Option<NaiveTime>)> {
    let value = value.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(value) {
        let at = at.with_timezone(&kst());
        return Some((at.date_naive(), Some(at.time())));
    }
    for pattern in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
        if let Ok(at) = NaiveDateTime::parse_from_str(value, pattern) {
            return Some((at.date(), Some(at.time())));
        }
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .map(|day| (day, None))
}

const WEEKDAYS: [(&str, Weekday); 14] = [
    ("월요일", Weekday::Mon),
    ("화요일", Weekday::Tue),
    ("수요일", Weekday::Wed),
    ("목요일", Weekday::Thu),
    ("금요일", Weekday::Fri),
    ("토요일", Weekday::Sat),
    ("일요일", Weekday::Sun),
    ("월욜", Weekday::Mon),
    ("화욜", Weekday::Tue),
    ("수욜", Weekday::Wed),
    ("목욜", Weekday::Thu),
    ("금욜", Weekday::Fri),
    ("토욜", Weekday::Sat),
    ("일욜", Weekday::Sun),
];

/// 숫자 앞뒤로 붙는 글자에서 숫자 묶음을 읽는다: `chars[at..]` 의 숫자들.
fn digits_at(chars: &[char], at: usize) -> Option<(u32, usize)> {
    let len = chars[at..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count();
    if len == 0 || len > 4 {
        return None;
    }
    let number: String = chars[at..at + len].iter().collect();
    number.parse().ok().map(|n| (n, len))
}

/// 근거 글에서 날짜를 읽는다(회의 날 기준). 읽은 날짜가 하나뿐일 때만 돌려준다.
///
/// 읽는 것: `N월 N일`, `N일까지`, 오늘·내일·모레·글피, 요일(앞에 이번 주·다음 주·
/// 다다음 주가 붙을 수 있음). 요일만 있고 회의 날과 같은 요일이면 이번 주인지
/// 다음 주인지 몰라서 못 읽은 것으로 본다.
pub fn date_from_quote(quote: &str, meeting: NaiveDate) -> Option<NaiveDate> {
    let text: String = quote.chars().filter(|c| !c.is_whitespace()).collect();
    let chars: Vec<char> = text.chars().collect();
    let mut found: Vec<NaiveDate> = Vec::new();

    // N월 N일, N일(까지·에·전·날·이·은/는·로).
    let mut i = 0;
    while i < chars.len() {
        let Some((first, len)) = chars[i]
            .is_ascii_digit()
            .then(|| digits_at(&chars, i))
            .flatten()
        else {
            i += 1;
            continue;
        };
        // 앞이 숫자면 이미 읽은 묶음의 일부다.
        let after = i + len;
        if chars.get(after) == Some(&'월') {
            if let Some((day, day_len)) = digits_at(&chars, after + 1) {
                if chars.get(after + 1 + day_len) == Some(&'일') {
                    let mut year = meeting.year();
                    if let Some(date) = NaiveDate::from_ymd_opt(year, first, day) {
                        // 한 달 넘게 지난 날이면 내년 이야기다.
                        if date + chrono::Days::new(30) < meeting {
                            year += 1;
                        }
                    }
                    if let Some(date) = NaiveDate::from_ymd_opt(year, first, day) {
                        found.push(date);
                    }
                    i = after + 2 + day_len;
                    continue;
                }
            }
        } else if chars.get(after) == Some(&'일')
            && matches!(
                chars.get(after + 1),
                None | Some(
                    '까' | '에' | '전' | '날' | '이' | '은' | '는' | '로' | '자' | '.' | ','
                )
            )
        {
            // "3일 안에"·"3일 뒤"는 날짜가 아니라 기간이라 여기서 빠진다.
            // 이번 달 그날, 이미 지났으면 다음 달.
            let mut date = NaiveDate::from_ymd_opt(meeting.year(), meeting.month(), first);
            if date.is_some_and(|d| d < meeting) {
                date = meeting
                    .checked_add_months(chrono::Months::new(1))
                    .and_then(|next| NaiveDate::from_ymd_opt(next.year(), next.month(), first));
            }
            if let Some(date) = date {
                found.push(date);
            }
        }
        i = after;
    }

    // 오늘·내일·모레·글피. 긴 말부터 지워 가며 고른다.
    let mut rest = text.clone();
    for (word, days) in [
        ("내일모레", 2u64),
        ("글피", 3),
        ("모레", 2),
        ("내일", 1),
        ("오늘", 0),
    ] {
        if rest.contains(word) {
            found.push(meeting + chrono::Days::new(days));
            rest = rest.replace(word, " ");
        }
    }

    // 요일. 서로 다른 요일이 둘 이상이면 못 읽은 것으로 본다.
    let mut weekdays: Vec<u32> = WEEKDAYS
        .iter()
        .filter(|(word, _)| text.contains(word))
        .map(|(_, day)| day.num_days_from_monday())
        .collect();
    weekdays.sort_unstable();
    weekdays.dedup();
    if let [target] = weekdays[..] {
        let week = if text.contains("다다음주") {
            Some(2)
        } else if text.contains("다음주") || text.contains("담주") || text.contains("차주") {
            Some(1)
        } else if text.contains("이번주") {
            Some(0)
        } else {
            None
        };
        let today = meeting.weekday().num_days_from_monday();
        match week {
            Some(week) => {
                let monday = meeting - chrono::Days::new(u64::from(today));
                found.push(monday + chrono::Days::new(u64::from(7 * week + target)));
            }
            None if target != today => {
                found.push(meeting + chrono::Days::new(u64::from((target + 7 - today) % 7)));
            }
            None => return None,
        }
    } else if weekdays.len() > 1 {
        return None;
    }

    found.sort();
    found.dedup();
    match found[..] {
        [date] => Some(date),
        _ => None,
    }
}

/// 한국어 고유어 시 이름(`세 시`). 긴 말부터.
const NATIVE_HOURS: [(&str, u32); 12] = [
    ("열두", 12),
    ("열한", 11),
    ("다섯", 5),
    ("여섯", 6),
    ("일곱", 7),
    ("여덟", 8),
    ("아홉", 9),
    ("한", 1),
    ("두", 2),
    ("세", 3),
    ("네", 4),
    ("열", 10),
];

/// 근거 글에서 시각을 읽는다. `(가능한 시(0~23), 분)`. 시각이 없거나 둘 이상이면 `None`.
/// 오전·오후가 없으면 1~11시는 오전·오후 둘 다 가능한 것으로 본다.
pub fn hours_from_quote(quote: &str) -> Option<(Vec<u32>, u32)> {
    let text: String = quote.chars().filter(|c| !c.is_whitespace()).collect();
    let chars: Vec<char> = text.chars().collect();
    let mut found: Vec<(Vec<u32>, u32)> = Vec::new();
    for (at, c) in chars.iter().enumerate() {
        if *c != '시' {
            continue;
        }
        // 시작·시간·시험·시도 같은 말은 시각이 아니다: 시 뒤에 올 수 있는
        // 글자만 받는다.
        let next = chars.get(at + 1);
        if !matches!(
            next,
            None | Some(
                '까' | '에'
                    | '쯤'
                    | '경'
                    | '께'
                    | '전'
                    | '반'
                    | '부'
                    | '정'
                    | '이'
                    | '로'
                    | '랑'
                    | '나'
                    | '와'
                    | '.'
                    | ','
                    | '!'
                    | '?'
            )
        ) && !next.is_some_and(char::is_ascii_digit)
        {
            continue;
        }
        let before: String = chars[..at].iter().collect();
        let digit_len = chars[..at]
            .iter()
            .rev()
            .take_while(|c| c.is_ascii_digit())
            .count();
        let (hour, word_start) = if digit_len > 0 {
            let number: String = chars[at - digit_len..at].iter().collect();
            match number.parse::<u32>() {
                Ok(hour) => (hour, at - digit_len),
                Err(_) => continue,
            }
        } else {
            match NATIVE_HOURS.iter().find(|(word, _)| before.ends_with(word)) {
                Some((word, hour)) => (*hour, at - word.chars().count()),
                None => continue,
            }
        };
        if hour > 24 {
            continue;
        }
        let lead: String = chars[word_start.saturating_sub(2)..word_start]
            .iter()
            .collect();
        let pm = ["후", "녁", "밤"].iter().any(|w| lead.ends_with(w));
        let am = ["전", "침", "벽"].iter().any(|w| lead.ends_with(w));
        let hours = if pm && hour < 12 {
            vec![hour + 12]
        } else if am || hour >= 12 {
            vec![hour % 24]
        } else {
            vec![hour, hour + 12]
        };
        let tail: String = chars[at + 1..].iter().collect();
        let minute = if tail.starts_with('반') {
            30
        } else {
            let tail_chars: Vec<char> = tail.chars().collect();
            match digits_at(&tail_chars, 0) {
                Some((minute, len)) if tail_chars.get(len) == Some(&'분') && minute < 60 => minute,
                _ => 0,
            }
        };
        found.push((hours, minute));
    }
    match found.len() {
        1 => found.pop(),
        _ => None,
    }
}

/// 모델 답(JSON 글)을 스크립트에 대 보고 고친다. 네트워크 없이 돈다.
/// `names` 는 담당자 근거 글에 이름이 들어 있는지 볼 때 쓴다.
/// `model`·`usage` 는 비워 두고 부른 쪽이 채운다.
pub fn check_answer(
    answer: &str,
    transcript: &Transcript,
    names: &dyn DisplayNames,
) -> Result<Summary, SummaryError> {
    let draft: Draft = serde_json::from_str(answer).map_err(|e| {
        SummaryError::new(
            SummaryErrorKind::BadResponse,
            format!("answer is not the expected JSON ({:?})", e.classify()),
        )
    })?;
    let mut checker = Checker::new(transcript, names);
    let decisions = draft
        .decisions
        .into_iter()
        .map(|d| Decision {
            evidence_start_ms: checker.evidence(d.evidence_start_ms),
            text: d.text,
        })
        .collect();
    let action_items = draft
        .action_items
        .into_iter()
        .map(|item| checker.action_item(item))
        .collect();
    let topics = draft
        .topics
        .into_iter()
        .map(|t| Topic {
            start_ms: checker.evidence(t.start_ms),
            title: t.title,
            points: t.points,
        })
        .collect();
    Ok(Summary {
        format: SUMMARY_FORMAT.into(),
        huddle_id: huddle_id(transcript),
        model: String::new(),
        title: draft.title,
        summary: draft.summary,
        decisions,
        action_items,
        topics,
        usage: Usage::default(),
        corrections: checker.corrections,
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct GenerateResponse {
    candidates: Vec<Candidate>,
    usage_metadata: UsageMetadata,
    model_version: Option<String>,
    prompt_feedback: PromptFeedback,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PromptFeedback {
    block_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Candidate {
    content: Option<Content>,
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Content {
    parts: Vec<Part>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Part {
    text: Option<String>,
    thought: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct UsageMetadata {
    prompt_token_count: u64,
    candidates_token_count: u64,
    thoughts_token_count: u64,
}

/// 오류 응답에서 `error.status`(예: `PERMISSION_DENIED`)만 꺼낸다.
fn error_status(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["status"].as_str().map(str::to_string))
        .unwrap_or_default()
}

fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// generateContent 를 한 번(다시 하기 포함) 부르고 답 JSON 글과 사용량을 돌려준다.
async fn generate(
    client: &reqwest::Client,
    settings: &GeminiSettings,
    token: &str,
    body: &serde_json::Value,
) -> Result<(String, Usage), SummaryError> {
    let mut auth =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
            SummaryError::new(SummaryErrorKind::Auth, "token is not a valid header value")
        })?;
    auth.set_sensitive(true);
    let mut retry = 0u32;
    loop {
        let sent = client
            .post(settings.endpoint())
            .header(reqwest::header::AUTHORIZATION, auth.clone())
            .json(body)
            .send()
            .await;
        let (kind, code, retry_after) = match sent {
            Err(error) => (
                SummaryErrorKind::Transient,
                if error.is_timeout() {
                    "timeout".to_string()
                } else {
                    "connection failed".to_string()
                },
                None,
            ),
            Ok(response) => {
                let status = response.status();
                let retry_after = retry_after_seconds(response.headers());
                let text = response.text().await.unwrap_or_default();
                if status.is_success() {
                    return read_response(&text, settings);
                }
                let code = format!("HTTP {} {}", status.as_u16(), error_status(&text));
                let kind = match status.as_u16() {
                    401 => SummaryErrorKind::Auth,
                    403 => SummaryErrorKind::Permission,
                    429 => SummaryErrorKind::RateLimited,
                    400 | 404 => SummaryErrorKind::BadRequest,
                    _ => SummaryErrorKind::Transient,
                };
                (kind, code.trim_end().to_string(), retry_after)
            }
        };
        let again = matches!(
            kind,
            SummaryErrorKind::Transient | SummaryErrorKind::RateLimited
        );
        if !again || retry >= settings.retry.retries {
            return Err(SummaryError::new(kind, code));
        }
        let wait = settings
            .retry
            .wait(kind == SummaryErrorKind::RateLimited, retry, retry_after);
        tokio::time::sleep(wait).await;
        retry += 1;
    }
}

fn read_response(text: &str, settings: &GeminiSettings) -> Result<(String, Usage), SummaryError> {
    let bad = |code: &str| SummaryError::new(SummaryErrorKind::BadResponse, code);
    let response: GenerateResponse =
        serde_json::from_str(text).map_err(|_| bad("response is not JSON"))?;
    let meta = &response.usage_metadata;
    let mut usage = Usage {
        model_version: response.model_version.clone(),
        input_tokens: meta.prompt_token_count,
        output_tokens: meta.candidates_token_count,
        thinking_tokens: meta.thoughts_token_count,
        cost_usd: None,
    };
    usage.cost_usd = settings.price.map(|price| {
        (usage.input_tokens as f64 * price.input_usd_per_mtok
            + (usage.output_tokens + usage.thinking_tokens) as f64 * price.output_usd_per_mtok)
            / 1_000_000.0
    });
    let candidate = response.candidates.first().ok_or_else(|| {
        let reason = response.prompt_feedback.block_reason.as_deref();
        bad(&format!(
            "no candidates (block reason {})",
            reason.unwrap_or("none")
        ))
    })?;
    let finish = candidate.finish_reason.as_deref().unwrap_or("");
    if finish != "STOP" {
        return Err(bad(&format!("finish reason {finish}")));
    }
    let answer: String = candidate
        .content
        .iter()
        .flat_map(|content| &content.parts)
        .filter(|part| part.thought != Some(true))
        .filter_map(|part| part.text.as_deref())
        .collect();
    if answer.trim().is_empty() {
        return Err(bad("empty answer"));
    }
    Ok((answer, usage))
}

/// 스크립트를 요약한다. `token` 은 Google 접근 토큰(밖에서 받는다).
pub async fn summarize(
    client: &reqwest::Client,
    settings: &GeminiSettings,
    token: &str,
    transcript: &Transcript,
    names: &dyn DisplayNames,
) -> Result<Summary, SummaryError> {
    let body = build_request(transcript, names);
    let (answer, usage) = generate(client, settings, token, &body).await?;
    let mut summary = check_answer(&answer, transcript, names)?;
    summary.model = settings.model.clone();
    summary.usage = usage;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::test_http::{transcript_with, FakeServer, Reply};

    const A: &str = "aaaaaaaa00000000000000000000000000000000000000000000000000000001";
    const B: &str = "bbbbbbbb00000000000000000000000000000000000000000000000000000002";

    /// 회의 날(2026-10-12)은 월요일이다.
    fn monday() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 12).unwrap()
    }

    fn day(month: u32, day: u32) -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt(2026, month, day)
    }

    fn meeting() -> Transcript {
        transcript_with(&[
            (1_000, A, "오늘은 견적서랑 출시 일정 얘기해요."),
            (5_000, B, "네 좋아요."),
            (
                9_000,
                A,
                "민수 씨, 다음 주 금요일 오후 3시까지 견적서 보내 줄 수 있어요?",
            ),
            (14_000, B, "네, 제가 보낼게요."),
            (20_000, A, "출시는 11월 2일로 정하죠."),
            (25_000, B, "그럼 누가 서버 비용 좀 알아봐 줘요."),
            (30_000, A, FAILED_TEXT),
        ])
    }

    fn answer(action_items: serde_json::Value) -> String {
        json!({
            "title": "견적서와 출시 일정",
            "summary": "견적서와 출시 일정을 정했다.",
            "decisions": [],
            "action_items": action_items,
            "topics": []
        })
        .to_string()
    }

    fn item(
        assignee: Option<&str>,
        assignee_quote: Option<&str>,
        due: Option<&str>,
        due_quote: Option<&str>,
        evidence: u64,
    ) -> serde_json::Value {
        json!({
            "text": "견적서 보내기",
            "assignee_id": assignee,
            "assignee_quote": assignee_quote,
            "due": due,
            "due_quote": due_quote,
            "status": "확정",
            "evidence_start_ms": evidence
        })
    }

    #[test]
    fn evidence_snaps_to_a_real_line_or_is_dropped() {
        let answer = json!({
            "title": "t", "summary": "s", "action_items": [],
            "decisions": [
                { "text": "그대로", "evidence_start_ms": 9_000 },
                { "text": "가까움", "evidence_start_ms": 9_400 },
                { "text": "너무 멂", "evidence_start_ms": 500_000 },
                { "text": "없음", "evidence_start_ms": null },
                // 받아쓰기 실패 줄은 근거가 될 수 없다: 가장 가까운 진짜 줄로.
                { "text": "실패 줄", "evidence_start_ms": 30_000 }
            ],
            "topics": [{ "title": "주제", "start_ms": 19_000, "points": ["p"] }]
        })
        .to_string();
        let summary = check_answer(&answer, &meeting(), &PubkeyPrefixNames).unwrap();
        let evidence: Vec<_> = summary
            .decisions
            .iter()
            .map(|d| d.evidence_start_ms)
            .collect();
        assert_eq!(
            evidence,
            [Some(9_000), Some(9_000), None, None, Some(25_000)]
        );
        assert_eq!(summary.topics[0].start_ms, Some(20_000));
        assert_eq!(summary.corrections.evidence_snapped, 3);
        assert_eq!(summary.corrections.evidence_dropped, 2);
    }

    #[test]
    fn real_assignee_and_due_survive() {
        let answer = answer(json!([item(
            Some("P2"),
            Some("네, 제가 보낼게요"),
            Some("2026-10-23T15:00"),
            Some("다음 주 금요일 오후 3시까지"),
            14_000
        )]));
        let summary = check_answer(&answer, &meeting(), &PubkeyPrefixNames).unwrap();
        let item = &summary.action_items[0];
        assert_eq!(item.assignee_pubkey.as_deref(), Some(B));
        assert_eq!(item.due.as_deref(), Some("2026-10-23T15:00:00+09:00"));
        assert_eq!(item.status, ItemStatus::Firm);
        assert_eq!(item.evidence_start_ms, Some(14_000));
        assert_eq!(summary.corrections.total(), 0);
    }

    #[test]
    fn invented_assignee_is_cleared() {
        let answer = answer(json!([
            // 참석자 목록에 없는 id.
            item(Some("P9"), Some("제가 보낼게요"), None, None, 14_000),
            // 스크립트에 없는 말.
            item(Some("P1"), Some("제가 다 할게요"), None, None, 14_000),
            // 근거 글이 없음.
            item(Some("P2"), None, None, None, 14_000),
        ]));
        let summary = check_answer(&answer, &meeting(), &PubkeyPrefixNames).unwrap();
        for item in &summary.action_items {
            assert_eq!(item.assignee_pubkey, None);
            assert_eq!(item.status, ItemStatus::Unsure);
        }
        assert_eq!(summary.corrections.assignee_cleared, 3);
        assert_eq!(summary.corrections.status_downgraded, 3);
    }

    #[test]
    fn assignee_quote_must_be_near_the_evidence() {
        let mut lines = vec![(0, B, "제가 보낼게요.")];
        for i in 1..20u64 {
            lines.push((i * 10_000, A, "다른 얘기"));
        }
        lines.push((200_000, A, "견적서는 누가 보내죠?"));
        let transcript = transcript_with(&lines);
        let answer = answer(json!([item(
            Some("P1"),
            Some("제가 보낼게요"),
            None,
            None,
            200_000
        )]));
        let summary = check_answer(&answer, &transcript, &PubkeyPrefixNames).unwrap();
        assert_eq!(summary.action_items[0].assignee_pubkey, None);
        assert_eq!(summary.corrections.assignee_cleared, 1);
    }

    #[test]
    fn invented_due_is_cleared() {
        let answer = answer(json!([
            // 스크립트에 없는 기한 말.
            item(
                Some("P2"),
                Some("제가 보낼게요"),
                Some("2026-10-16"),
                Some("금요일 오전까지"),
                14_000
            ),
            // 기한만 있고 근거 글이 없음.
            item(
                Some("P2"),
                Some("제가 보낼게요"),
                Some("2026-10-16"),
                None,
                14_000
            ),
        ]));
        let summary = check_answer(&answer, &meeting(), &PubkeyPrefixNames).unwrap();
        for item in &summary.action_items {
            assert_eq!(item.due, None);
            assert_eq!(item.status, ItemStatus::Unsure);
            // 담당자는 진짜라 남는다.
            assert_eq!(item.assignee_pubkey.as_deref(), Some(B));
        }
        assert_eq!(summary.corrections.due_cleared, 2);
    }

    #[test]
    fn due_date_comes_from_the_quote() {
        let answer = answer(json!([
            // 모델이 이번 주 금요일로 잘못 풀었고 시각도 틀렸다.
            item(
                Some("P2"),
                Some("제가 보낼게요"),
                Some("2026-10-16T18:00"),
                Some("다음 주 금요일 오후 3시까지"),
                14_000
            ),
            // 말에 시각이 없는데 모델이 시각을 붙였다.
            item(
                Some("P1"),
                Some("출시는 11월 2일로 정하죠"),
                Some("2026-11-02T10:00"),
                Some("11월 2일"),
                20_000
            ),
            // 기한이 없는 할 일은 기한 없이도 확정일 수 있다.
            item(Some("P2"), Some("제가 보낼게요"), None, None, 14_000),
        ]));
        let summary = check_answer(&answer, &meeting(), &PubkeyPrefixNames).unwrap();
        let items = &summary.action_items;
        assert_eq!(items[0].due.as_deref(), Some("2026-10-23T15:00:00+09:00"));
        assert_eq!(items[1].due.as_deref(), Some("2026-11-02"));
        assert_eq!(items[2].due, None);
        assert!(items.iter().all(|item| item.status == ItemStatus::Firm));
        assert_eq!(summary.corrections.due_fixed, 1);
        assert_eq!(summary.corrections.due_time_dropped, 1);
    }

    #[test]
    fn unsure_stays_unsure() {
        let mut unsure = item(None, None, None, None, 25_000);
        unsure["status"] = json!("애매");
        let summary =
            check_answer(&answer(json!([unsure])), &meeting(), &PubkeyPrefixNames).unwrap();
        assert_eq!(summary.action_items[0].status, ItemStatus::Unsure);
        assert_eq!(summary.corrections.total(), 0);
    }

    /// 시험용 이름표: A 는 지영, B 는 민수.
    struct KoreanNames;

    impl DisplayNames for KoreanNames {
        fn display_name(&self, pubkey: &str) -> String {
            match pubkey {
                A => "지영".into(),
                B => "민수".into(),
                _ => "?".into(),
            }
        }
    }

    #[test]
    fn assignee_quote_must_point_at_the_assignee() {
        let answer = answer(json!([
            // B 가 한 말을 A 의 근거로 댔다.
            item(Some("P1"), Some("네, 제가 보낼게요"), None, None, 14_000),
            // "제가"만으로는 누구인지 모른다.
            item(Some("P2"), Some("제가"), None, None, 14_000),
            // A 가 한 말이지만 B 의 이름이 들어 있다.
            item(
                Some("P2"),
                Some("민수 씨, 다음 주 금요일 오후 3시까지 견적서 보내 줄 수 있어요?"),
                None,
                None,
                9_000
            ),
        ]));
        let summary = check_answer(&answer, &meeting(), &KoreanNames).unwrap();
        let assignees: Vec<_> = summary
            .action_items
            .iter()
            .map(|item| item.assignee_pubkey.as_deref())
            .collect();
        assert_eq!(assignees, [None, None, Some(B)]);
        assert_eq!(summary.corrections.assignee_cleared, 2);
        // 이름표가 pubkey 앞 8자뿐이면 이름으로는 못 잇는다.
        let summary = check_answer(&answer, &meeting(), &PubkeyPrefixNames).unwrap();
        assert_eq!(summary.action_items[2].assignee_pubkey, None);
    }

    #[test]
    fn assignee_may_be_given_by_name_or_pubkey_when_unique() {
        let answer = answer(json!([
            item(
                Some("bbbbbbbb"),
                Some("네, 제가 보낼게요"),
                None,
                None,
                14_000
            ),
            item(Some(B), Some("네, 제가 보낼게요"), None, None, 14_000),
        ]));
        let summary = check_answer(&answer, &meeting(), &PubkeyPrefixNames).unwrap();
        for item in &summary.action_items {
            assert_eq!(item.assignee_pubkey.as_deref(), Some(B));
        }
        // 두 사람이 같은 이름이면 이름으로는 못 고른다.
        struct SameName;
        impl DisplayNames for SameName {
            fn display_name(&self, _pubkey: &str) -> String {
                "같은이름".into()
            }
        }
        let answer = self::answer(json!([item(
            Some("같은이름"),
            Some("네, 제가 보낼게요"),
            None,
            None,
            14_000
        )]));
        let summary = check_answer(&answer, &meeting(), &SameName).unwrap();
        assert_eq!(summary.action_items[0].assignee_pubkey, None);
    }

    #[test]
    fn dates_are_read_from_korean_words() {
        let m = monday();
        let read = |quote: &str| date_from_quote(quote, m);
        assert_eq!(read("오늘까지"), day(10, 12));
        assert_eq!(read("내일 오전까지"), day(10, 13));
        assert_eq!(read("모레"), day(10, 14));
        assert_eq!(read("내일모레"), day(10, 14));
        assert_eq!(read("금요일까지"), day(10, 16));
        assert_eq!(read("다음 주 금요일"), day(10, 23));
        assert_eq!(read("담주 화요일"), day(10, 20));
        assert_eq!(read("다다음주 월요일"), day(10, 26));
        assert_eq!(read("이번 주 수요일"), day(10, 14));
        assert_eq!(read("11월 2일"), day(11, 2));
        assert_eq!(read("1월 5일까지"), NaiveDate::from_ymd_opt(2027, 1, 5));
        assert_eq!(read("15일까지"), day(10, 15));
        assert_eq!(read("5일까지"), day(11, 5));
        // 같은 요일이면 이번 주인지 다음 주인지 모른다.
        assert_eq!(read("월요일까지"), None);
        // 기간·여러 날·모르는 말은 못 읽은 것으로.
        assert_eq!(read("3일 안에"), None);
        assert_eq!(read("목요일이나 금요일"), None);
        assert_eq!(read("내일, 아니 금요일"), None);
        assert_eq!(read("그때까지"), None);
        assert_eq!(read("다음 주까지"), None);
    }

    #[test]
    fn hours_are_read_from_korean_words() {
        assert_eq!(hours_from_quote("3시까지"), Some((vec![3, 15], 0)));
        assert_eq!(hours_from_quote("오후 세 시까지"), Some((vec![15], 0)));
        assert_eq!(hours_from_quote("오전 10시 반"), Some((vec![10], 30)));
        assert_eq!(hours_from_quote("3시 20분"), Some((vec![3, 15], 20)));
        assert_eq!(hours_from_quote("저녁 7시"), Some((vec![19], 0)));
        assert_eq!(hours_from_quote("네, 시작할게요"), None);
        assert_eq!(hours_from_quote("2시간 안에"), None);
        assert_eq!(hours_from_quote("3시랑 5시"), None);
        assert_eq!(hours_from_quote("금요일까지"), None);
    }

    fn gemini_reply(answer: &str, finish: &str) -> Reply {
        Reply::json(
            200,
            &json!({
                "candidates": [{
                    "content": { "role": "model", "parts": [
                        { "text": "생각 요약", "thought": true },
                        { "text": answer }
                    ] },
                    "finishReason": finish
                }],
                "usageMetadata": {
                    "promptTokenCount": 1000,
                    "candidatesTokenCount": 200,
                    "thoughtsTokenCount": 300,
                    "totalTokenCount": 1500
                },
                "modelVersion": "gemini-3.8-flash"
            }),
        )
    }

    fn settings_for(server: &FakeServer) -> GeminiSettings {
        let mut settings = GeminiSettings::new(DEFAULT_MODEL);
        settings.base_url = server.base.clone();
        settings.retry = RetryPolicy {
            retries: 3,
            retry_delay_ms: 1,
            rate_limit_delay_ms: 1,
        };
        settings
    }

    #[tokio::test]
    async fn request_has_the_expected_shape() {
        let reply = gemini_reply(&answer(json!([])), "STOP");
        let server = FakeServer::start(move |_| reply.clone()).await;
        let http = reqwest::Client::new();
        summarize(
            &http,
            &settings_for(&server),
            "test-token",
            &meeting(),
            &PubkeyPrefixNames,
        )
        .await
        .unwrap();
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.path,
            "/v1/projects/a2d2-lab/locations/global/publishers/google/models/gemini-3.8-flash:generateContent"
        );
        assert_eq!(request.header("authorization"), Some("Bearer test-token"));
        let body = request.json();
        let format = &body["generationConfig"]["responseFormat"][0]["text"];
        assert_eq!(format["mimeType"], "APPLICATION_JSON");
        assert_eq!(
            format["schema"]["properties"]["action_items"]["items"]["properties"]["status"]["enum"],
            json!(["확정", "애매"])
        );
        assert!(body["generationConfig"].get("temperature").is_none());
        assert!(body["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("지어내지 마라"));
        let prompt = body["contents"][0]["parts"][0]["text"].as_str().unwrap();
        assert!(prompt.contains("회의 날짜(KST): 2026-10-12 (월요일)"));
        assert!(prompt.contains("- P1 (이름: aaaaaaaa)\n- P2 (이름: bbbbbbbb)\n"));
        assert!(prompt.contains("[9000] P1: 민수 씨"));
        // 받아쓰기 실패 줄은 보내지 않는다.
        assert!(!prompt.contains(FAILED_TEXT));
    }

    #[tokio::test]
    async fn response_is_read_with_usage_and_cost() {
        let reply = gemini_reply(&answer(json!([])), "STOP");
        let server = FakeServer::start(move |_| reply.clone()).await;
        let http = reqwest::Client::new();
        let summary = summarize(
            &http,
            &settings_for(&server),
            "t",
            &meeting(),
            &PubkeyPrefixNames,
        )
        .await
        .unwrap();
        assert_eq!(summary.format, SUMMARY_FORMAT);
        assert_eq!(summary.huddle_id, huddle_id(&meeting()));
        assert_eq!(summary.title, "견적서와 출시 일정");
        assert_eq!(summary.model, DEFAULT_MODEL);
        assert_eq!(summary.usage.input_tokens, 1000);
        assert_eq!(summary.usage.output_tokens, 200);
        assert_eq!(summary.usage.thinking_tokens, 300);
        assert_eq!(
            summary.usage.model_version.as_deref(),
            Some("gemini-3.8-flash")
        );
        // 1000 × 1.5 / 1e6 + (200 + 300) × 7.5 / 1e6
        let cost = summary.usage.cost_usd.unwrap();
        assert!((cost - 0.005_25).abs() < 1e-12, "{cost}");
    }

    #[tokio::test]
    async fn broken_answers_are_bad_responses() {
        for reply in [
            gemini_reply(&answer(json!([])), "MAX_TOKENS"),
            gemini_reply("{ not json", "STOP"),
            Reply::json(
                200,
                &json!({ "promptFeedback": { "blockReason": "SAFETY" } }),
            ),
        ] {
            let server = FakeServer::start(move |_| reply.clone()).await;
            let http = reqwest::Client::new();
            let error = summarize(
                &http,
                &settings_for(&server),
                "t",
                &meeting(),
                &PubkeyPrefixNames,
            )
            .await
            .unwrap_err();
            assert_eq!(error.kind, SummaryErrorKind::BadResponse, "{error}");
            assert_eq!(server.requests().len(), 1, "no retry for {error}");
        }
    }

    #[tokio::test]
    async fn rate_limits_and_server_errors_are_retried() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&calls);
        let ok = gemini_reply(&answer(json!([])), "STOP");
        let server = FakeServer::start(move |_| match seen.fetch_add(1, Ordering::SeqCst) {
            0 => Reply::json(
                429,
                &json!({ "error": { "code": 429, "status": "RESOURCE_EXHAUSTED" } }),
            )
            .with_header("retry-after", "0"),
            1 => Reply::json(
                503,
                &json!({ "error": { "code": 503, "status": "UNAVAILABLE" } }),
            ),
            _ => ok.clone(),
        })
        .await;
        let http = reqwest::Client::new();
        summarize(
            &http,
            &settings_for(&server),
            "t",
            &meeting(),
            &PubkeyPrefixNames,
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn error_kinds_follow_the_status() {
        for (status, kind, requests) in [
            (401, SummaryErrorKind::Auth, 1),
            (403, SummaryErrorKind::Permission, 1),
            (404, SummaryErrorKind::BadRequest, 1),
            (429, SummaryErrorKind::RateLimited, 4),
            (500, SummaryErrorKind::Transient, 4),
        ] {
            let server = FakeServer::start(move |_| {
                Reply::json(
                    status,
                    &json!({ "error": { "code": status, "status": "X" } }),
                )
            })
            .await;
            let http = reqwest::Client::new();
            let error = summarize(
                &http,
                &settings_for(&server),
                "secret-token-value",
                &meeting(),
                &PubkeyPrefixNames,
            )
            .await
            .unwrap_err();
            assert_eq!(error.kind, kind);
            assert_eq!(server.requests().len(), requests, "{status}");
            // 토큰과 회의 내용은 오류에 남지 않는다.
            let shown = format!("{error} {error:?}");
            assert!(!shown.contains("secret-token-value"));
            assert!(!shown.contains("견적서"));
        }
    }
}
