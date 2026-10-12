//! 노션 회의록 페이지 쓰기(설계 8번). 노션 API 를 직접 부른다(`Notion-Version`
//! 2026-03-11, 2026-10-12 공식 문서로 확인).
//!
//! - "허들 회의록" DB 에 회의마다 페이지 하나. "허들 ID"(`{channel_id}:{첫 세션 id}`)로
//!   찾아서 있으면 고치고 없으면 만든다. 같은 회의를 두 번 만들지 않는다.
//! - 본문은 요약 → 결정사항 → 할 일 → 주제별 정리 → 전체 스크립트. 다시 쓸 때는
//!   본문을 통째로 지우고(`erase_content`) 새로 넣는다.
//! - "허들 담당자 연결" DB 에 참석자를 pubkey 로 넣는다. 없으면 한 줄 더하고,
//!   있는 줄은 **절대 고치지 않는다**("노션 사용자"·"확인됨"은 사람이 채운다).
//! - 노션 한도: 요청당 블록 100개, 글 조각 하나에 2000자, 배열 100개,
//!   요청 500KB, 연결마다 평균 초당 3번. 429 는 `Retry-After` 를 지켜 다시 한다.
//! - 녹음 파일은 올리지 않는다. 링크만 건다.
//!
//! 토큰은 밖에서 받는다. 토큰 값과 회의 내용은 로그·오류에 남기지 않는다.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat};
use serde_json::{json, Map, Value};

use crate::summary::{huddle_id, kst, DisplayNames, ItemStatus, RetryPolicy, Summary};
use crate::transcript::Transcript;

/// 노션 API 주소.
pub const NOTION_BASE_URL: &str = "https://api.notion.com";
/// `Notion-Version` 헤더 값(2026-10-12 기준 최신).
pub const NOTION_VERSION: &str = "2026-03-11";
/// "허들 회의록" data source.
pub const MINUTES_DATA_SOURCE_ID: &str = "6a9b68db-a2d4-43e9-a9bf-dfdb0967d6a7";
/// "허들 담당자 연결" data source.
pub const PEOPLE_DATA_SOURCE_ID: &str = "f7ffbc2e-5f69-4dcd-928d-c16a50641b44";
/// 스크립트 시각에 거는 앱 재생 링크의 기본 모양.
/// `{channel_id}`·`{start_ms}` 를 바꿔 넣는다.
pub const DEFAULT_PLAYBACK_LINK: &str = "buzz://huddle/{channel_id}?t={start_ms}";
/// 요청 하나에 넣는 블록 수 한도.
pub const MAX_BLOCKS_PER_REQUEST: usize = 100;
/// 글 조각(`text.content`) 하나의 길이 한도(UTF-16 단위로 센다).
pub const MAX_TEXT_UNITS: usize = 2000;
/// 블록 하나의 `rich_text` 조각 수 한도.
pub const MAX_RICH_TEXT_ITEMS: usize = 100;
/// 요청 하나 크기. 노션 한도 500KB 보다 넉넉히 작게 자른다.
const MAX_REQUEST_BYTES: usize = 400_000;
/// 오류 메시지는 이만큼(글자)만 남긴다.
const MAX_ERROR_MESSAGE: usize = 300;

/// "허들 회의록" 칸 이름.
pub mod minutes_property {
    /// title
    pub const TITLE: &str = "제목";
    /// date(시작~끝)
    pub const WHEN: &str = "일시";
    /// text
    pub const CHANNEL: &str = "채널";
    /// select: 채널|DM
    pub const KIND: &str = "종류";
    /// multi_select(이름)
    pub const PARTICIPANTS: &str = "참석자";
    /// number
    pub const LENGTH_MINUTES: &str = "길이(분)";
    /// date
    pub const RECORDING_EXPIRES: &str = "녹음 만료일";
    /// url
    pub const APP_LINK: &str = "앱에서 열기";
    /// text
    pub const HUDDLE_ID: &str = "허들 ID";
    /// select: 처리 중|완료|실패
    pub const STATUS: &str = "처리 상태";
}

/// "허들 담당자 연결" 칸 이름.
pub mod people_property {
    /// title
    pub const NAME: &str = "Buzz 이름";
    /// text
    pub const PUBKEY: &str = "Buzz pubkey";
    /// people. 사람이 채운다. 이 코드는 읽기만 한다.
    pub const NOTION_USER: &str = "노션 사용자";
    /// checkbox. 사람이 채운다. 이 코드는 건드리지 않는다.
    pub const CONFIRMED: &str = "확인됨";
}

/// "처리 상태" 값.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingStatus {
    /// 처리 중
    InProgress,
    /// 완료
    Done,
    /// 실패
    Failed,
}

impl ProcessingStatus {
    /// 노션 select 이름.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InProgress => "처리 중",
            Self::Done => "완료",
            Self::Failed => "실패",
        }
    }
}

/// "종류" 값.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingKind {
    /// 채널
    Channel,
    /// DM
    Dm,
}

impl MeetingKind {
    /// 노션 select 이름.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Channel => "채널",
            Self::Dm => "DM",
        }
    }
}

/// 노션 쓰기 설정.
#[derive(Debug, Clone)]
pub struct NotionSettings {
    /// 시험에서 가짜 서버로 바꾼다.
    pub base_url: String,
    /// `Notion-Version`.
    pub version: String,
    /// "허들 회의록" data source.
    pub minutes_data_source_id: String,
    /// "허들 담당자 연결" data source.
    pub people_data_source_id: String,
    /// 재생 링크 모양([`DEFAULT_PLAYBACK_LINK`]).
    pub playback_link: String,
    /// 요청 사이 최소 간격(초당 3번 한도).
    pub min_interval: Duration,
    /// 요청 하나를 다시 하는 법.
    pub retry: RetryPolicy,
    /// 본문 쓰기(지우기 + 넣기)를 처음부터 다시 해 보는 최대 횟수(첫 번 포함).
    pub body_attempts: u32,
}

impl Default for NotionSettings {
    fn default() -> Self {
        Self {
            base_url: NOTION_BASE_URL.into(),
            version: NOTION_VERSION.into(),
            minutes_data_source_id: MINUTES_DATA_SOURCE_ID.into(),
            people_data_source_id: PEOPLE_DATA_SOURCE_ID.into(),
            playback_link: DEFAULT_PLAYBACK_LINK.into(),
            min_interval: Duration::from_millis(350),
            retry: RetryPolicy::default(),
            body_attempts: 3,
        }
    }
}

/// 노션 실패 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotionErrorKind {
    /// 토큰이 틀림(401).
    Auth,
    /// 그 DB·페이지에 권한 없음(403).
    Permission,
    /// 없는 DB·페이지, 또는 통합에 공유 안 됨(404).
    NotFound,
    /// 429·529. 다시 해 보고도 안 됐을 때.
    RateLimited,
    /// 409·5xx·연결 끊김. 다시 해 보고도 안 됐을 때.
    Transient,
    /// 요청이 잘못됨(400, 예: 칸 이름이 다름, 링크 주소를 안 받음).
    BadRequest,
    /// 답 형식이 예상과 다름.
    BadResponse,
}

impl NotionErrorKind {
    /// 로그용 짧은 이름.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Permission => "permission",
            Self::NotFound => "not-found",
            Self::RateLimited => "rate-limited",
            Self::Transient => "transient",
            Self::BadRequest => "bad-request",
            Self::BadResponse => "bad-response",
        }
    }
}

impl std::fmt::Display for NotionErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 노션 실패. 종류와 노션 오류 코드·메시지(짧게)만 담는다.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("notion failed ({kind}): {code}")]
pub struct NotionError {
    /// 종류.
    pub kind: NotionErrorKind,
    /// 예: `HTTP 400 validation_error: …`.
    pub code: String,
}

impl NotionError {
    fn new(kind: NotionErrorKind, code: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
        }
    }
}

/// 한 요청이 실패했을 때 다시 보내도 되는지.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Replay {
    /// 읽기, 또는 같은 걸 두 번 해도 결과가 같은 쓰기: 일시 오류면 다시 한다.
    Safe,
    /// 만들기·붙이기: 일시 오류(5xx)는 저장됐을 수도 있어서 다시 하지 않는다.
    /// 429·529 는 서버가 받지 않은 것이라 다시 한다.
    RejectedOnly,
}

/// 노션 요청을 보내는 곳. 요청 사이 간격을 지키고, 보낸 수를 센다.
pub struct NotionClient<'a> {
    http: &'a reqwest::Client,
    settings: &'a NotionSettings,
    auth: reqwest::header::HeaderValue,
    last_sent: Option<tokio::time::Instant>,
    /// 보낸 요청 수(다시 보낸 것 포함).
    pub requests: u64,
}

fn header_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// 노션 오류 본문(`{"code":…,"message":…}`)에서 코드와 짧은 메시지.
fn error_code(body: &str) -> String {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = value["code"].as_str().unwrap_or("");
    let message: String = value["message"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(MAX_ERROR_MESSAGE)
        .collect();
    format!("{code}: {message}")
}

impl<'a> NotionClient<'a> {
    /// `token` 은 노션 통합 토큰(밖에서 받는다).
    pub fn new(
        http: &'a reqwest::Client,
        settings: &'a NotionSettings,
        token: &str,
    ) -> Result<Self, NotionError> {
        let mut auth =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
                NotionError::new(NotionErrorKind::Auth, "token is not a valid header value")
            })?;
        auth.set_sensitive(true);
        Ok(Self {
            http,
            settings,
            auth,
            last_sent: None,
            requests: 0,
        })
    }

    async fn call(
        &mut self,
        method: reqwest::Method,
        path: &str,
        body: &Value,
        replay: Replay,
    ) -> Result<Value, NotionError> {
        let url = format!("{}{path}", self.settings.base_url.trim_end_matches('/'));
        let mut retry = 0u32;
        loop {
            if let Some(last) = self.last_sent {
                tokio::time::sleep_until(last + self.settings.min_interval).await;
            }
            self.last_sent = Some(tokio::time::Instant::now());
            self.requests += 1;
            let mut request = self
                .http
                .request(method.clone(), &url)
                .header(reqwest::header::AUTHORIZATION, self.auth.clone())
                .header("Notion-Version", &self.settings.version);
            if !body.is_null() {
                request = request.json(body);
            }
            let (kind, code, retry_after) = match request.send().await {
                Err(error) => (
                    NotionErrorKind::Transient,
                    if error.is_timeout() {
                        "timeout"
                    } else {
                        "connection failed"
                    }
                    .to_string(),
                    None,
                ),
                Ok(response) => {
                    let status = response.status().as_u16();
                    let retry_after = header_seconds(response.headers());
                    let text = response.text().await.unwrap_or_default();
                    if (200..300).contains(&status) {
                        return serde_json::from_str(&text).map_err(|_| {
                            NotionError::new(NotionErrorKind::BadResponse, "response is not JSON")
                        });
                    }
                    let kind = match status {
                        401 => NotionErrorKind::Auth,
                        403 => NotionErrorKind::Permission,
                        404 => NotionErrorKind::NotFound,
                        429 | 529 => NotionErrorKind::RateLimited,
                        409 | 500..=599 => NotionErrorKind::Transient,
                        _ => NotionErrorKind::BadRequest,
                    };
                    (
                        kind,
                        format!("HTTP {status} {}", error_code(&text)),
                        retry_after,
                    )
                }
            };
            let again = match kind {
                NotionErrorKind::RateLimited => true,
                NotionErrorKind::Transient => replay == Replay::Safe,
                _ => false,
            };
            if !again || retry >= self.settings.retry.retries {
                return Err(NotionError::new(kind, code));
            }
            let wait =
                self.settings
                    .retry
                    .wait(kind == NotionErrorKind::RateLimited, retry, retry_after);
            tokio::time::sleep(wait).await;
            retry += 1;
        }
    }

    /// `data_source` 에서 글 칸 `property` 가 `value` 와 같은 페이지들(휴지통 뺌),
    /// 만든 순서대로.
    async fn find_by_text(
        &mut self,
        data_source: &str,
        property: &str,
        value: &str,
    ) -> Result<Vec<Value>, NotionError> {
        let body = json!({
            "filter": { "property": property, "rich_text": { "equals": value } },
            "sorts": [{ "timestamp": "created_time", "direction": "ascending" }],
            "page_size": 10
        });
        let path = format!("/v1/data_sources/{data_source}/query");
        let result = self
            .call(reqwest::Method::POST, &path, &body, Replay::Safe)
            .await?;
        let results = result["results"].as_array().ok_or_else(|| {
            NotionError::new(NotionErrorKind::BadResponse, "query answer has no results")
        })?;
        Ok(results
            .iter()
            .filter(|page| page["in_trash"] != Value::Bool(true))
            .cloned()
            .collect())
    }

    /// 페이지를 만든다. 일시 오류로 답을 못 받으면 만들어졌는지 `key` 로 다시
    /// 찾아보고, 없을 때만 한 번 더 만든다(두 번 만들지 않으려고).
    async fn create_unless_exists(
        &mut self,
        data_source: &str,
        key_property: &str,
        key: &str,
        properties: Map<String, Value>,
    ) -> Result<String, NotionError> {
        let body = json!({
            "parent": { "type": "data_source_id", "data_source_id": data_source },
            "properties": properties
        });
        let mut checked = false;
        loop {
            match self
                .call(
                    reqwest::Method::POST,
                    "/v1/pages",
                    &body,
                    Replay::RejectedOnly,
                )
                .await
            {
                Ok(page) => return page_id(&page),
                Err(error) if error.kind == NotionErrorKind::Transient && !checked => {
                    checked = true;
                    if let Some(page) = self
                        .find_by_text(data_source, key_property, key)
                        .await?
                        .first()
                    {
                        return page_id(page);
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn update_properties(
        &mut self,
        page_id: &str,
        properties: Map<String, Value>,
    ) -> Result<(), NotionError> {
        let body = json!({ "properties": properties });
        self.call(
            reqwest::Method::PATCH,
            &format!("/v1/pages/{page_id}"),
            &body,
            Replay::Safe,
        )
        .await
        .map(drop)
    }

    /// 본문을 통째로 지우고 `chunks` 를 차례로 붙인다. 붙인 요청 수를 돌려준다.
    async fn replace_body(
        &mut self,
        page_id: &str,
        chunks: &[Vec<Value>],
    ) -> Result<usize, NotionError> {
        self.call(
            reqwest::Method::PATCH,
            &format!("/v1/pages/{page_id}"),
            &json!({ "erase_content": true }),
            Replay::Safe,
        )
        .await?;
        for chunk in chunks {
            self.call(
                reqwest::Method::PATCH,
                &format!("/v1/blocks/{page_id}/children"),
                &json!({ "children": chunk }),
                Replay::RejectedOnly,
            )
            .await?;
        }
        Ok(chunks.len())
    }
}

fn page_id(page: &Value) -> Result<String, NotionError> {
    page["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| NotionError::new(NotionErrorKind::BadResponse, "page has no id"))
}

/// 노션에 올릴 회의 하나.
pub struct MeetingPage<'a> {
    /// 스크립트.
    pub transcript: &'a Transcript,
    /// 요약. 없으면 본문에 스크립트만 넣는다.
    pub summary: Option<&'a Summary>,
    /// pubkey → 이름.
    pub names: &'a dyn DisplayNames,
    /// 제목 앞에 붙일 말(예: `[시험] `).
    pub title_prefix: &'a str,
    /// "채널" 칸에 쓸 이름. 없으면 channel id.
    pub channel_label: Option<&'a str>,
    /// "종류". 모르면 비워 둔다.
    pub kind: Option<MeetingKind>,
    /// 다 쓰고 나서 "처리 상태"에 넣을 값.
    pub status: ProcessingStatus,
}

/// 노션 쓰기 결과(개수와 page id 만).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PublishReport {
    /// 회의 페이지 id.
    pub page_id: String,
    /// 이번에 새로 만들었나(아니면 있던 것을 고침).
    pub created: bool,
    /// 같은 허들 ID 로 이미 여러 장 있던 경우, 가장 먼저 만든 것 말고 남은 수.
    pub duplicates: usize,
    /// 본문 블록 수.
    pub blocks: usize,
    /// 본문 붙이기 요청 수(마지막 시도).
    pub append_requests: usize,
    /// 본문 쓰기를 처음부터 한 횟수.
    pub body_attempts: u32,
    /// 담당자 연결 DB 에 새로 더한 줄 id.
    pub people_rows_added: Vec<String>,
    /// 노션 사용자가 연결돼 있어 멘션할 수 있는 참석자 수.
    pub people_linked: usize,
}

/// 참석자 pubkey: 참석자 목록 순서, 그다음 목록에 없는 화자.
fn attendee_pubkeys(transcript: &Transcript) -> Vec<&str> {
    let mut pubkeys: Vec<&str> = Vec::new();
    let all = transcript
        .participants
        .iter()
        .map(|p| p.pubkey.as_str())
        .chain(transcript.segments.iter().map(|s| s.speaker.as_str()));
    for pubkey in all {
        if !pubkeys.contains(&pubkey) {
            pubkeys.push(pubkey);
        }
    }
    pubkeys
}

/// 글 조각들. 2000 단위(UTF-16)를 넘으면 여러 조각으로 나눈다.
pub fn text_runs(content: &str, link: Option<&str>) -> Vec<Value> {
    let run = |piece: &str| match link {
        Some(url) => {
            json!({ "type": "text", "text": { "content": piece, "link": { "url": url } } })
        }
        None => json!({ "type": "text", "text": { "content": piece } }),
    };
    let mut runs = Vec::new();
    let mut piece = String::new();
    let mut units = 0;
    for c in content.chars() {
        if units + c.len_utf16() > MAX_TEXT_UNITS {
            runs.push(run(&piece));
            piece.clear();
            units = 0;
        }
        piece.push(c);
        units += c.len_utf16();
    }
    if !piece.is_empty() {
        runs.push(run(&piece));
    }
    runs
}

/// `kind` 블록. 조각이 100개를 넘으면 같은 종류 블록 여러 개로 나눈다.
fn blocks(kind: &str, runs: Vec<Value>) -> Vec<Value> {
    let make = |rich_text: &[Value]| {
        let mut inner = json!({ "rich_text": rich_text });
        if kind == "to_do" {
            inner["checked"] = Value::Bool(false);
        }
        json!({ "object": "block", "type": kind, kind: inner })
    };
    if runs.is_empty() {
        return vec![make(&[])];
    }
    runs.chunks(MAX_RICH_TEXT_ITEMS).map(make).collect()
}

fn heading(text: &str) -> Value {
    json!({
        "object": "block",
        "type": "heading_2",
        "heading_2": { "rich_text": text_runs(text, None) }
    })
}

/// `[mm:ss]`(분은 60을 넘을 수 있다).
pub fn clock(ms: u64) -> String {
    format!("[{:02}:{:02}]", ms / 60_000, ms / 1_000 % 60)
}

/// 앱 재생 링크.
pub fn playback_link(template: &str, transcript: &Transcript, start_ms: u64) -> String {
    template
        .replace("{channel_id}", &transcript.channel_id.to_string())
        .replace("{start_ms}", &start_ms.to_string())
}

/// UTC 시각 글을 KST 로(`2026-10-12T14:00:00.000+09:00`). 못 읽으면 그대로.
fn kst_text(utc: &str) -> String {
    DateTime::parse_from_rfc3339(utc)
        .map(|at| {
            at.with_timezone(&kst())
                .to_rfc3339_opts(SecondsFormat::Millis, false)
        })
        .unwrap_or_else(|_| utc.to_string())
}

/// 회의 페이지 칸들. "앱에서 열기"는 재생 링크 모양에 `start_ms` 0 을 넣은 것.
pub fn page_properties(
    page: &MeetingPage<'_>,
    status: ProcessingStatus,
    link_template: &str,
) -> Map<String, Value> {
    use minutes_property as p;
    let transcript = page.transcript;
    let title = match page.summary {
        Some(summary) if !summary.title.trim().is_empty() => summary.title.trim().to_string(),
        _ => format!(
            "허들 회의 {}",
            kst_text(&transcript.started_at).get(..16).unwrap_or("")
        ),
    };
    let mut names: Vec<String> = Vec::new();
    for pubkey in attendee_pubkeys(transcript) {
        // multi_select 이름에는 쉼표를 못 쓴다.
        let name = page.names.display_name(pubkey).replace(',', " ");
        if !name.trim().is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    let minutes = (transcript.duration_ms as f64 / 6_000.0).round() / 10.0;
    let channel = transcript.channel_id.to_string();
    let mut properties = Map::new();
    let mut put = |name: &str, value: Value| {
        properties.insert(name.to_string(), value);
    };
    put(
        p::TITLE,
        json!({ "title": text_runs(&format!("{}{title}", page.title_prefix), None) }),
    );
    put(
        p::WHEN,
        json!({ "date": {
            "start": kst_text(&transcript.started_at),
            "end": kst_text(&transcript.ended_at)
        } }),
    );
    put(
        p::CHANNEL,
        json!({ "rich_text": text_runs(page.channel_label.unwrap_or(&channel), None) }),
    );
    if let Some(kind) = page.kind {
        put(p::KIND, json!({ "select": { "name": kind.as_str() } }));
    }
    put(
        p::PARTICIPANTS,
        json!({ "multi_select": names.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>() }),
    );
    put(p::LENGTH_MINUTES, json!({ "number": minutes }));
    put(
        p::RECORDING_EXPIRES,
        json!({ "date": { "start": kst_text(&transcript.audio.expires_at) } }),
    );
    put(
        p::APP_LINK,
        json!({ "url": playback_link(link_template, transcript, 0) }),
    );
    put(
        p::HUDDLE_ID,
        json!({ "rich_text": text_runs(&huddle_id(transcript), None) }),
    );
    put(p::STATUS, json!({ "select": { "name": status.as_str() } }));
    properties
}

/// 노션 본문 글에 걸 수 있는 링크 모양인가. 2026-10-12 실제 시험에서 노션은
/// 본문 링크로 `buzz://`(어느 경로든)를 "Invalid URL for link" 로 거절했고
/// `https://` 는 받았다. ("앱에서 열기" url 칸은 `buzz://` 도 받는다.)
pub fn linkable_in_body(link_template: &str) -> bool {
    link_template.starts_with("https://") || link_template.starts_with("http://")
}

/// 회의 페이지 본문 블록, 순서대로.
/// `people` 은 pubkey → 노션 사용자 id(연결된 사람만).
/// 링크 모양이 본문에 걸 수 없는 것([`linkable_in_body`])이면 시각은 링크 없는 글로 넣는다.
pub fn body_blocks(
    page: &MeetingPage<'_>,
    people: &HashMap<String, String>,
    link_template: &str,
) -> Vec<Value> {
    let transcript = page.transcript;
    let linkable = linkable_in_body(link_template);
    let time_link = |ms: u64| {
        let link = linkable.then(|| playback_link(link_template, transcript, ms));
        text_runs(&clock(ms), link.as_deref())
    };
    let mut out = Vec::new();

    if let Some(summary) = page.summary {
        out.push(heading("요약"));
        let paragraphs: Vec<&str> = summary
            .summary
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        if paragraphs.is_empty() {
            out.extend(blocks("paragraph", text_runs("없음", None)));
        }
        for paragraph in paragraphs {
            out.extend(blocks("paragraph", text_runs(paragraph, None)));
        }

        out.push(heading("결정사항"));
        if summary.decisions.is_empty() {
            out.extend(blocks("paragraph", text_runs("없음", None)));
        }
        for decision in &summary.decisions {
            let mut runs = text_runs(&decision.text, None);
            if let Some(ms) = decision.evidence_start_ms {
                runs.extend(text_runs(" ", None));
                runs.extend(time_link(ms));
            }
            out.extend(blocks("bulleted_list_item", runs));
        }

        out.push(heading("할 일"));
        if summary.action_items.is_empty() {
            out.extend(blocks("paragraph", text_runs("없음", None)));
        }
        for item in &summary.action_items {
            let mut runs = text_runs(&item.text, None);
            runs.extend(text_runs(" · 담당: ", None));
            match item.assignee_pubkey.as_deref() {
                Some(pubkey) => match people.get(pubkey) {
                    Some(user) => runs.push(json!({
                        "type": "mention",
                        "mention": { "type": "user", "user": { "id": user } }
                    })),
                    None => runs.extend(text_runs(&page.names.display_name(pubkey), None)),
                },
                None => runs.extend(text_runs("미정", None)),
            }
            runs.extend(text_runs(" · 기한: ", None));
            match (&item.due, &item.due_quote) {
                (Some(due), _) => runs.push(json!({
                    "type": "mention",
                    "mention": { "type": "date", "date": { "start": due } }
                })),
                // 기한 말은 있었는데 날짜로 못 풀었으면 그 말을 그대로 보여 준다.
                (None, Some(quote)) => runs.extend(text_runs(&format!("“{quote}”"), None)),
                (None, None) => runs.extend(text_runs("없음", None)),
            }
            if item.status == ItemStatus::Unsure {
                runs.extend(text_runs(" · 애매", None));
            }
            if let Some(ms) = item.evidence_start_ms {
                runs.extend(text_runs(" ", None));
                runs.extend(time_link(ms));
            }
            out.extend(blocks("to_do", runs));
        }

        out.push(heading("주제별 정리"));
        if summary.topics.is_empty() {
            out.extend(blocks("paragraph", text_runs("없음", None)));
        }
        for topic in &summary.topics {
            let mut runs = text_runs(&topic.title, None);
            if let Some(ms) = topic.start_ms {
                runs.extend(text_runs(" ", None));
                runs.extend(time_link(ms));
            }
            out.extend(blocks("heading_3", runs));
            for point in &topic.points {
                out.extend(blocks("bulleted_list_item", text_runs(point, None)));
            }
        }
    }

    out.push(heading("전체 스크립트"));
    let mut segments: Vec<_> = transcript.segments.iter().collect();
    segments.sort_by_key(|segment| segment.start_ms);
    if segments.is_empty() {
        out.extend(blocks("paragraph", text_runs("없음", None)));
    }
    for segment in segments {
        let mut runs = time_link(segment.start_ms);
        let name = page.names.display_name(&segment.speaker);
        runs.extend(text_runs(
            &format!(" {name}: {}", segment.text.trim()),
            None,
        ));
        out.extend(blocks("paragraph", runs));
    }
    out
}

/// 블록을 요청 단위로 나눈다: 100개, 그리고 요청 크기 한도 안.
pub fn chunk_blocks(blocks: Vec<Value>) -> Vec<Vec<Value>> {
    let mut chunks = Vec::new();
    let mut current: Vec<Value> = Vec::new();
    let mut bytes = 0;
    for block in blocks {
        let size = block.to_string().len();
        if !current.is_empty()
            && (current.len() == MAX_BLOCKS_PER_REQUEST || bytes + size > MAX_REQUEST_BYTES)
        {
            chunks.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += size;
        current.push(block);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// 참석자마다 "허들 담당자 연결" 줄을 찾고, 없으면 이름과 pubkey 만 넣어 한 줄
/// 만든다. 있는 줄은 읽기만 한다. pubkey → 노션 사용자 id(연결된 사람만)를
/// 돌려주고, 새로 만든 줄 id 는 만들 때마다 `added` 에 더한다(중간에 실패해도 남게).
pub async fn link_people(
    client: &mut NotionClient<'_>,
    transcript: &Transcript,
    names: &dyn DisplayNames,
    added: &mut Vec<String>,
) -> Result<HashMap<String, String>, NotionError> {
    use people_property as p;
    let data_source = client.settings.people_data_source_id.clone();
    let mut linked = HashMap::new();
    for pubkey in attendee_pubkeys(transcript) {
        let rows = client.find_by_text(&data_source, p::PUBKEY, pubkey).await?;
        if let Some(row) = rows.first() {
            let user = row["properties"][p::NOTION_USER]["people"][0]["id"].as_str();
            if let Some(user) = user {
                linked.insert(pubkey.to_string(), user.to_string());
            }
            continue;
        }
        let mut properties = Map::new();
        properties.insert(
            p::NAME.into(),
            json!({ "title": text_runs(&names.display_name(pubkey), None) }),
        );
        properties.insert(
            p::PUBKEY.into(),
            json!({ "rich_text": text_runs(pubkey, None) }),
        );
        let id = client
            .create_unless_exists(&data_source, p::PUBKEY, pubkey, properties)
            .await?;
        added.push(id);
    }
    Ok(linked)
}

/// 회의 하나를 노션에 쓴다. 허들 ID 로 찾아 있으면 고치고, 없으면 만든다.
/// 쓰는 동안 "처리 상태"는 "처리 중", 다 쓰면 `page.status`, 본문 쓰기에
/// 실패하면 "실패"로 둔다. `report` 는 하는 대로 채워서, 중간에 실패해도
/// 만든 페이지·줄 id 가 남는다.
pub async fn publish(
    client: &mut NotionClient<'_>,
    page: &MeetingPage<'_>,
    report: &mut PublishReport,
) -> Result<(), NotionError> {
    let transcript = page.transcript;
    let key = huddle_id(transcript);
    if let Some(summary) = page.summary {
        if summary.huddle_id != key {
            return Err(NotionError::new(
                NotionErrorKind::BadRequest,
                "summary belongs to another huddle",
            ));
        }
    }
    let settings = client.settings;
    let people = link_people(
        client,
        transcript,
        page.names,
        &mut report.people_rows_added,
    )
    .await?;
    report.people_linked = people.len();

    let found = client
        .find_by_text(
            &settings.minutes_data_source_id,
            minutes_property::HUDDLE_ID,
            &key,
        )
        .await?;
    report.duplicates = found.len().saturating_sub(1);
    let working = page_properties(page, ProcessingStatus::InProgress, &settings.playback_link);
    let page_id = match found.first() {
        Some(existing) => {
            let id = page_id(existing)?;
            report.page_id = id.clone();
            client.update_properties(&id, working).await?;
            id
        }
        None => {
            let id = client
                .create_unless_exists(
                    &settings.minutes_data_source_id,
                    minutes_property::HUDDLE_ID,
                    &key,
                    working,
                )
                .await?;
            report.page_id = id.clone();
            report.created = true;
            id
        }
    };

    let body = body_blocks(page, &people, &settings.playback_link);
    report.blocks = body.len();
    let chunks = chunk_blocks(body);
    let mut attempts = 0;
    let append_requests = loop {
        attempts += 1;
        report.body_attempts = attempts;
        match client.replace_body(&page_id, &chunks).await {
            Ok(requests) => break requests,
            // 붙이다 끊기면 일부만 들어갔을 수 있으니, 처음부터(지우기부터) 다시 한다.
            Err(error)
                if error.kind == NotionErrorKind::Transient
                    && attempts < settings.body_attempts => {}
            Err(error) => {
                let mut failed = Map::new();
                failed.insert(
                    minutes_property::STATUS.into(),
                    json!({ "select": { "name": ProcessingStatus::Failed.as_str() } }),
                );
                // 실패 표시도 못 하면 처음 오류를 알리는 게 더 중요하다.
                let _ = client.update_properties(&page_id, failed).await;
                return Err(error);
            }
        }
    };
    report.append_requests = append_requests;

    let mut done = Map::new();
    done.insert(
        minutes_property::STATUS.into(),
        json!({ "select": { "name": page.status.as_str() } }),
    );
    client.update_properties(&page_id, done).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use super::*;
    use crate::summary::{
        check_answer, ActionItem, Corrections, Decision, PubkeyPrefixNames, Topic, Usage,
        SUMMARY_FORMAT,
    };
    use crate::test_http::{transcript_with, FakeServer, Recorded, Reply};

    const A: &str = "aaaaaaaa00000000000000000000000000000000000000000000000000000001";
    const B: &str = "bbbbbbbb00000000000000000000000000000000000000000000000000000002";

    /// 노션을 흉내 내는 상태: data source 별 페이지와 본문.
    #[derive(Default)]
    struct FakeNotion {
        pages: Vec<FakePage>,
        /// 401·429 같은 걸 앞에서부터 하나씩 꺼내 답한다.
        queued_errors: Vec<Reply>,
        /// 붙이기 요청을 이 상태로 거절한다.
        refuse_appends: Option<u16>,
    }

    struct FakePage {
        id: String,
        data_source: String,
        properties: Map<String, Value>,
        children: Vec<Value>,
        in_trash: bool,
    }

    /// 요청 모양의 칸 값을 응답 모양으로: 글 조각에 `plain_text` 를 붙인다.
    fn as_response(mut value: Value) -> Value {
        for key in ["title", "rich_text"] {
            if let Some(runs) = value.get_mut(key).and_then(Value::as_array_mut) {
                for run in runs {
                    run["plain_text"] = run["text"]["content"].clone();
                }
            }
        }
        value
    }

    fn plain_text(value: &Value) -> String {
        ["title", "rich_text"]
            .iter()
            .filter_map(|key| value[*key].as_array())
            .flatten()
            .filter_map(|run| run["plain_text"].as_str())
            .collect()
    }

    fn page_json(page: &FakePage) -> Value {
        json!({
            "object": "page",
            "id": page.id,
            "in_trash": page.in_trash,
            "properties": page.properties
        })
    }

    fn too_long(block: &Value) -> bool {
        let kind = block["type"].as_str().unwrap_or("");
        let runs = block[kind]["rich_text"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        runs.len() > MAX_RICH_TEXT_ITEMS
            || runs.iter().any(|run| {
                run["text"]["content"]
                    .as_str()
                    .is_some_and(|text| text.encode_utf16().count() > MAX_TEXT_UNITS)
            })
    }

    impl FakeNotion {
        fn answer(&mut self, request: &Recorded) -> Reply {
            if !self.queued_errors.is_empty() {
                return self.queued_errors.remove(0);
            }
            let body = request.json();
            let path: Vec<&str> = request.path.trim_start_matches('/').split('/').collect();
            match (request.method.as_str(), &path[..]) {
                ("POST", ["v1", "data_sources", source, "query"]) => {
                    let property = body["filter"]["property"].as_str().unwrap();
                    let wanted = body["filter"]["rich_text"]["equals"].as_str().unwrap();
                    let results: Vec<Value> = self
                        .pages
                        .iter()
                        .filter(|page| page.data_source == *source)
                        .filter(|page| {
                            page.properties
                                .get(property)
                                .is_some_and(|value| plain_text(value) == wanted)
                        })
                        .map(page_json)
                        .collect();
                    Reply::json(
                        200,
                        &json!({ "object": "list", "results": results, "has_more": false }),
                    )
                }
                ("POST", ["v1", "pages"]) => {
                    let id = format!("page-{}", self.pages.len() + 1);
                    let properties = body["properties"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(key, value)| (key.clone(), as_response(value.clone())))
                        .collect();
                    self.pages.push(FakePage {
                        id: id.clone(),
                        data_source: body["parent"]["data_source_id"].as_str().unwrap().into(),
                        properties,
                        children: Vec::new(),
                        in_trash: false,
                    });
                    Reply::json(200, &json!({ "object": "page", "id": id }))
                }
                ("PATCH", ["v1", "pages", id]) => {
                    let Some(page) = self.pages.iter_mut().find(|page| page.id == *id) else {
                        return Reply::json(404, &json!({ "code": "object_not_found" }));
                    };
                    if body["erase_content"] == Value::Bool(true) {
                        page.children.clear();
                    }
                    if let Some(properties) = body["properties"].as_object() {
                        for (key, value) in properties {
                            page.properties
                                .insert(key.clone(), as_response(value.clone()));
                        }
                    }
                    if let Some(trash) = body["in_trash"].as_bool() {
                        page.in_trash = trash;
                    }
                    Reply::json(200, &page_json(page))
                }
                ("PATCH", ["v1", "blocks", id, "children"]) => {
                    if let Some(status) = self.refuse_appends {
                        return Reply::json(
                            status,
                            &json!({ "code": "validation_error", "message": "refused" }),
                        );
                    }
                    let children = body["children"].as_array().unwrap();
                    if children.len() > MAX_BLOCKS_PER_REQUEST || children.iter().any(too_long) {
                        return Reply::json(
                            400,
                            &json!({ "code": "validation_error", "message": "too big" }),
                        );
                    }
                    let Some(page) = self.pages.iter_mut().find(|page| page.id == *id) else {
                        return Reply::json(404, &json!({ "code": "object_not_found" }));
                    };
                    page.children.extend(children.iter().cloned());
                    Reply::json(200, &json!({ "object": "list", "results": children }))
                }
                _ => Reply::json(404, &json!({ "code": "invalid_request_url" })),
            }
        }
    }

    async fn fake_notion(state: FakeNotion) -> (FakeServer, Arc<Mutex<FakeNotion>>) {
        let state = Arc::new(Mutex::new(state));
        let shared = Arc::clone(&state);
        let server = FakeServer::start(move |request| shared.lock().unwrap().answer(request)).await;
        (server, state)
    }

    fn settings_for(server: &FakeServer) -> NotionSettings {
        NotionSettings {
            base_url: server.base.clone(),
            min_interval: Duration::ZERO,
            retry: RetryPolicy {
                retries: 3,
                retry_delay_ms: 1,
                rate_limit_delay_ms: 1,
            },
            ..NotionSettings::default()
        }
    }

    /// A 는 노션 사용자 user-1 로 이미 연결돼 있고, B 는 줄이 없다.
    fn people_seed() -> FakePage {
        let mut properties = Map::new();
        properties.insert(
            people_property::NAME.into(),
            as_response(json!({ "title": text_runs("사람이 고친 이름", None) })),
        );
        properties.insert(
            people_property::PUBKEY.into(),
            as_response(json!({ "rich_text": text_runs(A, None) })),
        );
        properties.insert(
            people_property::NOTION_USER.into(),
            json!({ "people": [{ "object": "user", "id": "user-1" }] }),
        );
        properties.insert(
            people_property::CONFIRMED.into(),
            json!({ "checkbox": true }),
        );
        FakePage {
            id: "person-a".into(),
            data_source: PEOPLE_DATA_SOURCE_ID.into(),
            properties,
            children: Vec::new(),
            in_trash: false,
        }
    }

    fn meeting() -> Transcript {
        transcript_with(&[
            (1_000, A, "견적서 얘기해요."),
            (65_000, B, "네, 제가 금요일까지 보낼게요."),
        ])
    }

    fn summary_of(transcript: &Transcript) -> Summary {
        Summary {
            format: SUMMARY_FORMAT.into(),
            huddle_id: huddle_id(transcript),
            model: "m".into(),
            title: "견적서 회의".into(),
            summary: "견적서를 금요일까지 보내기로 했다.".into(),
            decisions: vec![Decision {
                text: "견적서는 B 가 보낸다".into(),
                evidence_start_ms: Some(65_000),
            }],
            action_items: vec![
                ActionItem {
                    text: "견적서 보내기".into(),
                    assignee_pubkey: Some(A.into()),
                    assignee_quote: Some("q".into()),
                    due: Some("2026-10-16".into()),
                    due_quote: Some("금요일까지".into()),
                    status: ItemStatus::Firm,
                    evidence_start_ms: Some(65_000),
                },
                ActionItem {
                    text: "서버 비용 알아보기".into(),
                    assignee_pubkey: Some(B.into()),
                    assignee_quote: Some("q".into()),
                    due: None,
                    due_quote: None,
                    status: ItemStatus::Unsure,
                    evidence_start_ms: None,
                },
            ],
            topics: vec![Topic {
                title: "견적서".into(),
                start_ms: Some(1_000),
                points: vec!["금요일까지".into()],
            }],
            usage: Usage::default(),
            corrections: Corrections::default(),
        }
    }

    fn page<'a>(transcript: &'a Transcript, summary: &'a Summary) -> MeetingPage<'a> {
        MeetingPage {
            transcript,
            summary: Some(summary),
            names: &PubkeyPrefixNames,
            title_prefix: "[시험] ",
            channel_label: None,
            kind: Some(MeetingKind::Channel),
            status: ProcessingStatus::Done,
        }
    }

    fn block_text(block: &Value) -> String {
        let kind = block["type"].as_str().unwrap();
        block[kind]["rich_text"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["text"]["content"].as_str().unwrap_or("@"))
            .collect()
    }

    #[test]
    fn long_text_is_split_into_runs_and_blocks() {
        let korean = "가".repeat(4_500);
        let runs = text_runs(&korean, None);
        let lengths: Vec<usize> = runs
            .iter()
            .map(|run| run["text"]["content"].as_str().unwrap().chars().count())
            .collect();
        assert_eq!(lengths, [2_000, 2_000, 500]);
        // 이모지는 UTF-16 두 단위라 1000개가 한 조각 끝이다.
        let emoji = "😀".repeat(1_001);
        assert_eq!(text_runs(&emoji, None).len(), 2);
        assert_eq!(
            blocks("paragraph", text_runs(&"나".repeat(2_000 * 250), None)).len(),
            3
        );
    }

    #[test]
    fn blocks_are_chunked_by_count_and_size() {
        let small: Vec<Value> = (0..250).map(|_| heading("x")).collect();
        let sizes: Vec<usize> = chunk_blocks(small).iter().map(Vec::len).collect();
        assert_eq!(sizes, [100, 100, 50]);
        // 블록 하나가 큰 경우(조각 100개 × 2000자)는 크기로도 자른다.
        let big = blocks("paragraph", text_runs(&"나".repeat(2_000 * 100), None));
        let many: Vec<Value> = std::iter::repeat_n(big[0].clone(), 5).collect();
        for chunk in chunk_blocks(many) {
            let bytes: usize = chunk.iter().map(|block| block.to_string().len()).sum();
            assert!(bytes <= MAX_REQUEST_BYTES || chunk.len() == 1);
        }
    }

    #[test]
    fn body_has_sections_in_order_with_links_and_mentions() {
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let people = HashMap::from([(A.to_string(), "user-1".to_string())]);
        let body = body_blocks(&page(&transcript, &summary), &people, DEFAULT_PLAYBACK_LINK);
        let headings: Vec<String> = body
            .iter()
            .filter(|block| block["type"] == "heading_2")
            .map(block_text)
            .collect();
        assert_eq!(
            headings,
            ["요약", "결정사항", "할 일", "주제별 정리", "전체 스크립트"]
        );
        let todos: Vec<&Value> = body
            .iter()
            .filter(|block| block["type"] == "to_do")
            .collect();
        assert_eq!(todos.len(), 2);
        let first = todos[0]["to_do"]["rich_text"].as_array().unwrap();
        assert_eq!(todos[0]["to_do"]["checked"], false);
        assert!(first.contains(&json!({
            "type": "mention", "mention": { "type": "user", "user": { "id": "user-1" } }
        })));
        assert!(first.contains(&json!({
            "type": "mention", "mention": { "type": "date", "date": { "start": "2026-10-16" } }
        })));
        // 연결 안 된 사람은 이름 글자로, 애매 표시.
        let second = block_text(todos[1]);
        assert!(second.contains("담당: bbbbbbbb"), "{second}");
        assert!(second.contains("애매"), "{second}");
        // 스크립트 줄: [mm:ss] 이름: 글. 기본 buzz:// 모양은 노션 본문이 안 받아서
        // 링크 없이 글로만 넣는다.
        let last = body.last().unwrap();
        assert_eq!(
            block_text(last),
            "[01:05] bbbbbbbb: 네, 제가 금요일까지 보낼게요."
        );
        assert!(!body
            .iter()
            .any(|block| block.to_string().contains("\"link\"")));
        // https 모양이면 시각마다 재생 링크를 건다.
        let https = "https://buzz.example.com/huddle/{channel_id}?t={start_ms}";
        let body = body_blocks(&page(&transcript, &summary), &people, https);
        assert_eq!(
            body.last().unwrap()["paragraph"]["rich_text"][0]["text"]["link"]["url"],
            "https://buzz.example.com/huddle/00000000-0000-0000-0000-000000000002?t=65000"
        );
    }

    #[test]
    fn app_link_property_keeps_the_buzz_link() {
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let properties = page_properties(
            &page(&transcript, &summary),
            ProcessingStatus::InProgress,
            DEFAULT_PLAYBACK_LINK,
        );
        assert_eq!(
            properties[minutes_property::APP_LINK]["url"],
            "buzz://huddle/00000000-0000-0000-0000-000000000002?t=0"
        );
        assert_eq!(
            properties[minutes_property::STATUS]["select"]["name"],
            "처리 중"
        );
    }

    async fn run(
        client: &mut NotionClient<'_>,
        page: &MeetingPage<'_>,
    ) -> Result<PublishReport, NotionError> {
        let mut report = PublishReport::default();
        publish(client, page, &mut report).await.map(|()| report)
    }

    #[tokio::test]
    async fn first_publish_creates_page_and_missing_people_rows() {
        let (server, state) = fake_notion(FakeNotion {
            pages: vec![people_seed()],
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "notion-test-token").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let report = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        assert!(report.created);
        assert_eq!(report.people_linked, 1);
        assert_eq!(report.people_rows_added.len(), 1);

        let state = state.lock().unwrap();
        let minutes: Vec<&FakePage> = state
            .pages
            .iter()
            .filter(|page| page.data_source == MINUTES_DATA_SOURCE_ID)
            .collect();
        assert_eq!(minutes.len(), 1);
        let props = &minutes[0].properties;
        assert_eq!(
            plain_text(&props[minutes_property::HUDDLE_ID]),
            "00000000-0000-0000-0000-000000000002:00000000-0000-0000-0000-000000000003"
        );
        assert_eq!(
            plain_text(&props[minutes_property::TITLE]),
            "[시험] 견적서 회의"
        );
        assert_eq!(props[minutes_property::STATUS]["select"]["name"], "완료");
        assert_eq!(props[minutes_property::KIND]["select"]["name"], "채널");
        assert_eq!(
            props[minutes_property::WHEN]["date"]["start"],
            "2026-10-12T14:00:00.000+09:00"
        );
        assert_eq!(props[minutes_property::LENGTH_MINUTES]["number"], 42.2);
        assert_eq!(
            props[minutes_property::PARTICIPANTS]["multi_select"],
            json!([{ "name": "aaaaaaaa" }, { "name": "bbbbbbbb" }])
        );
        assert_eq!(minutes[0].children.len(), report.blocks);

        // B 의 줄은 이름과 pubkey 만 넣어 새로 만든다.
        let added = state
            .pages
            .iter()
            .find(|page| page.id == report.people_rows_added[0])
            .unwrap();
        assert_eq!(added.data_source, PEOPLE_DATA_SOURCE_ID);
        let mut keys: Vec<&String> = added.properties.keys().collect();
        keys.sort();
        assert_eq!(keys, [people_property::PUBKEY, people_property::NAME]);
        assert_eq!(plain_text(&added.properties[people_property::PUBKEY]), B);

        // 요청 모양: 버전·토큰 헤더, data source 부모.
        let requests = server.requests();
        assert!(requests
            .iter()
            .all(|r| r.header("notion-version") == Some(NOTION_VERSION)));
        assert!(requests
            .iter()
            .all(|r| r.header("authorization") == Some("Bearer notion-test-token")));
        let create = requests
            .iter()
            .find(|r| r.method == "POST" && r.path == "/v1/pages")
            .unwrap();
        assert_eq!(create.json()["parent"]["type"], "data_source_id");
    }

    #[tokio::test]
    async fn existing_people_rows_are_never_touched() {
        let (server, state) = fake_notion(FakeNotion {
            pages: vec![people_seed()],
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();

        let requests = server.requests();
        assert!(!requests.iter().any(|r| r.path.contains("person-a")));
        let state = state.lock().unwrap();
        let rows: Vec<&FakePage> = state
            .pages
            .iter()
            .filter(|page| page.data_source == PEOPLE_DATA_SOURCE_ID)
            .collect();
        // A 하나(원래 있던 것), B 하나(첫 번에 만든 것). 두 번째는 아무것도 안 만든다.
        assert_eq!(rows.len(), 2);
        let seeded = rows.iter().find(|row| row.id == "person-a").unwrap();
        assert_eq!(seeded.properties, people_seed().properties);
    }

    #[tokio::test]
    async fn same_huddle_id_updates_the_same_page() {
        let (server, state) = fake_notion(FakeNotion::default()).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let mut summary = summary_of(&transcript);
        let first = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        summary.title = "고친 제목".into();
        summary.action_items.clear();
        let second = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        assert!(first.created);
        assert!(!second.created);
        assert_eq!(first.page_id, second.page_id);

        let state = state.lock().unwrap();
        let minutes: Vec<&FakePage> = state
            .pages
            .iter()
            .filter(|page| page.data_source == MINUTES_DATA_SOURCE_ID)
            .collect();
        assert_eq!(minutes.len(), 1);
        assert_eq!(
            plain_text(&minutes[0].properties[minutes_property::TITLE]),
            "[시험] 고친 제목"
        );
        // 본문은 통째로 갈아끼운다: 두 번 쌓이지 않는다.
        assert_eq!(minutes[0].children.len(), second.blocks);
        assert!(!minutes[0]
            .children
            .iter()
            .any(|block| block["type"] == "to_do"));
        let erases = server
            .requests()
            .iter()
            .filter(|r| r.json()["erase_content"] == Value::Bool(true))
            .count();
        assert_eq!(erases, 2);
    }

    #[tokio::test]
    async fn hour_long_meeting_fits_the_limits() {
        let long = "가".repeat(4_500);
        let mut lines: Vec<(u64, &str, &str)> = (0..450u64)
            .map(|i| (i * 8_000, if i % 2 == 0 { A } else { B }, "짧은 말"))
            .collect();
        lines.push((3_600_000, A, &long));
        let transcript = transcript_with(&lines);
        let answer = json!({
            "title": "긴 회의", "summary": "s", "decisions": [], "action_items": [], "topics": []
        })
        .to_string();
        let summary = check_answer(&answer, &transcript, &PubkeyPrefixNames).unwrap();
        let (server, state) = fake_notion(FakeNotion::default()).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let report = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        // 요약 2 + 결정 2 + 할 일 2 + 주제 2 + 스크립트 머리 1 + 줄 451
        assert_eq!(report.blocks, 460);
        assert_eq!(report.append_requests, 5);
        let state = state.lock().unwrap();
        let page = state
            .pages
            .iter()
            .find(|page| page.id == report.page_id)
            .unwrap();
        assert_eq!(page.children.len(), 460);
        let last = page.children.last().unwrap();
        assert_eq!(last["paragraph"]["rich_text"].as_array().unwrap().len(), 4);
        assert!(block_text(last).starts_with("[60:00] aaaaaaaa: 가"));
    }

    #[tokio::test]
    async fn rate_limit_waits_for_retry_after() {
        let (server, _state) = fake_notion(FakeNotion {
            queued_errors: vec![Reply::json(429, &json!({ "code": "rate_limited" }))
                .with_header("retry-after", "1")],
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let started = Instant::now();
        run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        assert!(started.elapsed() >= Duration::from_secs(1));
        let requests = server.requests();
        assert_eq!(requests[0].path, requests[1].path);
    }

    #[tokio::test]
    async fn errors_are_classified_and_hide_the_token() {
        for (status, kind) in [
            (401, NotionErrorKind::Auth),
            (403, NotionErrorKind::Permission),
            (404, NotionErrorKind::NotFound),
            (400, NotionErrorKind::BadRequest),
        ] {
            let (server, _state) = fake_notion(FakeNotion {
                queued_errors: vec![Reply::json(status, &json!({ "code": "x", "message": "m" }))],
                ..FakeNotion::default()
            })
            .await;
            let settings = settings_for(&server);
            let http = reqwest::Client::new();
            let mut client = NotionClient::new(&http, &settings, "secret-notion-token").unwrap();
            let transcript = meeting();
            let summary = summary_of(&transcript);
            let error = run(&mut client, &page(&transcript, &summary))
                .await
                .unwrap_err();
            assert_eq!(error.kind, kind);
            assert_eq!(server.requests().len(), 1);
            assert!(!format!("{error} {error:?}").contains("secret-notion-token"));
        }
    }

    #[tokio::test]
    async fn failed_body_marks_the_page_failed() {
        let (server, state) = fake_notion(FakeNotion {
            refuse_appends: Some(400),
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let mut report = PublishReport::default();
        let error = publish(&mut client, &page(&transcript, &summary), &mut report)
            .await
            .unwrap_err();
        assert_eq!(error.kind, NotionErrorKind::BadRequest);
        let state = state.lock().unwrap();
        let minutes = state
            .pages
            .iter()
            .find(|page| page.data_source == MINUTES_DATA_SOURCE_ID)
            .unwrap();
        assert_eq!(
            minutes.properties[minutes_property::STATUS]["select"]["name"],
            "실패"
        );
        // 실패해도 만든 페이지와 줄의 id 는 알려 준다.
        assert_eq!(report.page_id, minutes.id);
        assert!(report.created);
        assert_eq!(report.people_rows_added.len(), 2);
    }

    #[tokio::test]
    async fn summary_of_another_huddle_is_refused() {
        let (server, _state) = fake_notion(FakeNotion::default()).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let mut summary = summary_of(&transcript);
        summary.huddle_id = "other:huddle".into();
        let error = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap_err();
        assert_eq!(error.kind, NotionErrorKind::BadRequest);
        assert!(server.requests().is_empty());
    }
}
