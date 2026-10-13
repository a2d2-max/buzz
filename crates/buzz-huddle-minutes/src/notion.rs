//! 노션 회의록 페이지 쓰기(설계 8번). 노션 API 를 직접 부른다(`Notion-Version`
//! 2026-03-11, 2026-10-12 공식 문서로 확인).
//!
//! - "허들 회의록" DB 에 회의마다 페이지 하나. "허들 ID" 칸에
//!   `{channel_id}:{세션 id,세션 id,…}`([`huddle_key`])를 남기고, 세션이 하나라도
//!   겹치면 같은 회의로 본다. 늦게 올라온 앞 세션 때문에 첫 세션이 바뀌어도 같은
//!   페이지를 찾는다.
//! - 만든 page id 는 작업기 저장소의 스크립트 옆(`{첫 세션}.notion.json`)에 남기고
//!   다음엔 그 id 부터 쓴다. 회의 단위 잠금(작업기의 hold) 안에서 부른다
//!   ([`publish_held`], [`publish_meeting`]).
//! - 같은 회의 페이지가 두 장 생기지 않게: 만들다 503 이 나면 노션이 알려 주는
//!   `committed_resource_id` 를 쓰고, 만든 뒤 다시 찾아 두 장 이상이면 늦게 만든
//!   쪽을 휴지통으로 보낸다. 요청 시간 제한은 노션의 60초보다 길게 둔다.
//! - 본문 순서: 요약 → 결정사항 → 할 일 → 주제별 정리 → 전체 스크립트. 다시 쓸 때는
//!   새 본문을 먼저 다 붙인 뒤 옛 블록을 지운다(중간에 끊겨도 빈 페이지가 안 된다).
//!   같은 글의 할 일은 체크 상태를 이어받는다.
//! - 처음 만들 때만 기본 알림, 다시 게시·다시 쓰기는 조용히(`notifications.mode = silent`).
//! - "허들 담당자 연결" DB 에 참석자를 pubkey 로 넣는다. 없으면 한 줄 더한다(이름은
//!   프로필 이름, 모르면 pubkey 앞 8자). 있는 줄은 이름 칸이 pubkey 앞 8자 그대로일
//!   때(작업기가 넣은 그대로)만 프로필 이름으로 고치고, 사람이 고친 이름과 다른 칸은
//!   **절대 고치지 않는다**. 고치기가 안 돼도 멘션은 그대로 한다(이름 칸이 그대로라 다음
//!   회의에서 다시 해 본다). 사람 멘션은 "확인됨"이 체크된 줄의 "노션 사용자"만 쓰고,
//!   나머지는 이름 글자로. 이 DB 를 못 읽어도(403 등) 회의록은 쓴다(멘션만 빠진다).
//! - 노션 한도: 요청당 블록 100개, 글 조각 하나에 2000자, 배열 100개,
//!   요청 500KB, 연결마다 평균 초당 3번. 429·529 는 `Retry-After` 를 지켜 다시 한다.
//! - 녹음 파일은 올리지 않는다. 링크만 건다.
//!
//! 토큰은 밖에서 받는다(Cloud Run 은 Secret Manager 를 환경 변수로 붙인다).
//! 토큰 값과 회의 내용은 로그·오류에 남기지 않는다.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::collect::MeetingPlan;
use crate::correct::{self, Corrected, Piece};
use crate::runner::{MeetingError, MinutesHome};
use crate::summary::{
    huddle_id, kst, line_name, DisplayNames, ItemStatus, PubkeyPrefixNames, RetryPolicy, Summary,
};
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
/// 노션은 60초 넘는 요청을 503 으로 끊는다. 그 답을 받을 수 있게 더 길게 기다린다.
pub const NOTION_TIMEOUT: Duration = Duration::from_secs(120);
/// 요청 하나에 넣는 블록 수 한도.
pub const MAX_BLOCKS_PER_REQUEST: usize = 100;
/// 글 조각(`text.content`)·링크 주소 하나의 길이 한도(UTF-16 단위로 센다).
pub const MAX_TEXT_UNITS: usize = 2000;
/// 블록 하나의 `rich_text` 조각 수 한도.
pub const MAX_RICH_TEXT_ITEMS: usize = 100;
/// [`NotionRecord::format`] 값.
pub const RECORD_FORMAT: &str = "huddle-notion/1";
/// 요청 하나 크기. 노션 한도 500KB 보다 넉넉히 작게 자른다.
const MAX_REQUEST_BYTES: usize = 400_000;
/// 오류 메시지는 이만큼(글자)만 남긴다.
const MAX_ERROR_MESSAGE: usize = 300;
/// "실패" 표시를 해 보는 횟수.
const FAILED_MARK_ATTEMPTS: u32 = 4;
/// 할 일 블록에서 할 일 글과 덧붙인 글을 가르는 말.
const TASK_SEPARATOR: &str = " · 담당:";

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
    /// text: [`super::huddle_key`]
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
    /// checkbox. 사람이 채운다. 이 코드는 읽기만 한다(체크된 줄만 멘션).
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
    /// 본문 쓰기를 처음부터 다시 해 보는 최대 횟수(첫 번 포함).
    pub body_attempts: u32,
    /// "실패" 표시가 안 될 때 첫 기다림. 다시 할 때마다 두 배.
    pub failed_mark_wait: Duration,
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
            failed_mark_wait: Duration::from_secs(2),
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
    /// 409·5xx·연결 끊김·본문 읽다 끊김. 다시 해 보고도 안 됐을 때.
    Transient,
    /// 요청이 잘못됨(400, 예: 칸 이름이 다름, 링크 주소를 안 받음, 한도 넘는 블록).
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

    /// 처음부터 다시 해 볼 만한 실패인가.
    fn passes(self) -> bool {
        matches!(self, Self::Transient | Self::RateLimited)
    }
}

impl std::fmt::Display for NotionErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 노션 실패. 종류와 노션 오류 코드·메시지(짧게)만 담는다. 메시지는 페이지 글을
/// 옮겨 올 수 있으니 작업기 로그에는 [`NotionError::short`] 를 쓴다.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("notion failed ({kind}): {code}")]
pub struct NotionError {
    /// 종류.
    pub kind: NotionErrorKind,
    /// 예: `HTTP 400 validation_error: …`.
    pub code: String,
}

impl NotionError {
    /// 종류, HTTP 상태, 노션 오류 코드만(메시지 없이): 작업기 로그에 쓴다.
    pub fn short(&self) -> String {
        format!("{} {}", self.kind.as_str(), self.short_code())
    }

    /// HTTP 상태와 노션 오류 코드만(메시지 없이), 예: `HTTP 400 validation_error`.
    pub fn short_code(&self) -> &str {
        self.code.split(": ").next().unwrap_or("")
    }
}

impl NotionError {
    pub(crate) fn new(kind: NotionErrorKind, code: impl Into<String>) -> Self {
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

/// 쓰기 요청이 사람들에게 알림을 보내는지.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notify {
    /// 노션 기본 알림(처음 만들 때).
    Default,
    /// 알림 없이(다시 게시·다시 쓰기).
    Silent,
}

fn with_notify(mut body: Value, notify: Notify) -> Value {
    if notify == Notify::Silent {
        body["notifications"] = json!({ "mode": "silent" });
    }
    body
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

/// 노션 오류 본문에서 코드와 짧은 메시지.
fn error_code(body: &Value) -> String {
    let code = body["code"].as_str().unwrap_or("");
    let message: String = body["message"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(MAX_ERROR_MESSAGE)
        .collect();
    format!("{code}: {message}")
}

/// `Retry-After` 헤더, 없으면 본문의 `additional_data.retry_after`(초).
fn retry_after(headers: &reqwest::header::HeaderMap, body: &Value) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
        .or_else(|| {
            body["additional_data"]["retry_after"]
                .as_str()
                .and_then(|value| value.trim().parse().ok())
        })
}

/// 실패 한 번: 종류, 코드, 서버가 준 기다림(초).
type Failure = (NotionErrorKind, String, Option<u64>);

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

    async fn send_once(
        &mut self,
        method: &reqwest::Method,
        url: &str,
        body: &Value,
    ) -> Result<Value, Failure> {
        if let Some(last) = self.last_sent {
            tokio::time::sleep_until(last + self.settings.min_interval).await;
        }
        self.last_sent = Some(tokio::time::Instant::now());
        self.requests += 1;
        let mut request = self
            .http
            .request(method.clone(), url)
            .header(reqwest::header::AUTHORIZATION, self.auth.clone())
            .header("Notion-Version", &self.settings.version);
        if !body.is_null() {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| {
            let code = if error.is_timeout() {
                "timeout"
            } else {
                "connection failed"
            };
            (NotionErrorKind::Transient, code.to_string(), None)
        })?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        // 2xx 라도 본문을 다 못 읽으면 결과를 모른다: 일시 오류로 친다.
        let text = response.text().await.map_err(|_| {
            (
                NotionErrorKind::Transient,
                format!("HTTP {status} body cut off"),
                None,
            )
        })?;
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            if value.is_null() {
                return Err((
                    NotionErrorKind::BadResponse,
                    "response is not JSON".into(),
                    None,
                ));
            }
            return Ok(value);
        }
        // 만들기·붙이기가 저장은 됐는데 답을 제때 못 만든 503: 노션이 만든 것의
        // id 를 알려 준다. 다시 보내면 두 장이 되니 그 id 를 쓴다.
        if status == 503 {
            if let Some(id) = value["additional_data"]["committed_resource_id"].as_str() {
                return Ok(json!({
                    "object": "committed",
                    "id": id,
                    "committed_child_ids": value["additional_data"]["committed_child_ids"]
                }));
            }
        }
        let kind = match status {
            401 => NotionErrorKind::Auth,
            403 => NotionErrorKind::Permission,
            404 => NotionErrorKind::NotFound,
            429 | 529 => NotionErrorKind::RateLimited,
            409 | 500..=599 => NotionErrorKind::Transient,
            _ => NotionErrorKind::BadRequest,
        };
        Err((
            kind,
            format!("HTTP {status} {}", error_code(&value)),
            retry_after(&headers, &value),
        ))
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
            let (kind, code, retry_after) = match self.send_once(&method, &url, body).await {
                Ok(value) => return Ok(value),
                Err(failure) => failure,
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

    pub(crate) async fn query(
        &mut self,
        data_source: &str,
        body: Value,
    ) -> Result<Value, NotionError> {
        let path = format!("/v1/data_sources/{data_source}/query");
        self.call(reqwest::Method::POST, &path, &body, Replay::Safe)
            .await
    }

    /// `data_source` 에서 글 칸 `property` 가 `value` 와 같은 페이지들(휴지통 뺌).
    pub(crate) async fn find_by_text(
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
        let result = self.query(data_source, body).await?;
        live_results(&result)
    }

    /// 이 채널에서 `sessions` 와 세션이 하나라도 겹치는 회의 페이지들(휴지통 뺌).
    async fn find_meeting_pages(
        &mut self,
        channel: Uuid,
        sessions: &[Uuid],
    ) -> Result<Vec<Value>, NotionError> {
        use minutes_property::HUDDLE_ID;
        let any_session: Vec<Value> = sessions
            .iter()
            .map(|session| {
                json!({ "property": HUDDLE_ID, "rich_text": { "contains": session.to_string() } })
            })
            .collect();
        let body = json!({
            "filter": { "and": [
                { "property": HUDDLE_ID, "rich_text": { "starts_with": format!("{channel}:") } },
                { "or": any_session }
            ] },
            "sorts": [{ "timestamp": "created_time", "direction": "ascending" }],
            "page_size": 100
        });
        let data_source = self.settings.minutes_data_source_id.clone();
        let result = self.query(&data_source, body).await?;
        Ok(live_results(&result)?
            .into_iter()
            .filter(|page| same_meeting(page, channel, sessions))
            .collect())
    }

    /// 페이지 하나. 없으면 `None`.
    async fn get_page(&mut self, page_id: &str) -> Result<Option<Value>, NotionError> {
        match self
            .call(
                reqwest::Method::GET,
                &format!("/v1/pages/{page_id}"),
                &Value::Null,
                Replay::Safe,
            )
            .await
        {
            Ok(page) => Ok(Some(page)),
            Err(error) if error.kind == NotionErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// 페이지를 만든다(다시 보내지 않음). 503 이면서 노션이 만든 id 를 알려 주면 그 id.
    async fn create_page(
        &mut self,
        data_source: &str,
        properties: &Map<String, Value>,
    ) -> Result<String, NotionError> {
        let body = json!({
            "parent": { "type": "data_source_id", "data_source_id": data_source },
            "properties": properties
        });
        let page = self
            .call(
                reqwest::Method::POST,
                "/v1/pages",
                &body,
                Replay::RejectedOnly,
            )
            .await?;
        page_id(&page)
    }

    pub(crate) async fn update_page(
        &mut self,
        page_id: &str,
        body: Value,
        notify: Notify,
    ) -> Result<(), NotionError> {
        self.call(
            reqwest::Method::PATCH,
            &format!("/v1/pages/{page_id}"),
            &with_notify(body, notify),
            Replay::Safe,
        )
        .await
        .map(drop)
    }

    async fn set_status(
        &mut self,
        page_id: &str,
        status: ProcessingStatus,
        notify: Notify,
    ) -> Result<(), NotionError> {
        let body = json!({ "properties": {
            minutes_property::STATUS: { "select": { "name": status.as_str() } }
        } });
        self.update_page(page_id, body, notify).await
    }

    async fn trash_page(&mut self, page_id: &str) -> Result<(), NotionError> {
        self.update_page(page_id, json!({ "in_trash": true }), Notify::Silent)
            .await
    }

    /// 페이지 바로 아래 블록 전부(차례대로).
    pub(crate) async fn list_children(
        &mut self,
        block_id: &str,
    ) -> Result<Vec<Value>, NotionError> {
        let mut blocks = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!("/v1/blocks/{block_id}/children?page_size=100");
            if let Some(cursor) = &cursor {
                path.push_str(&format!("&start_cursor={cursor}"));
            }
            let page = self
                .call(reqwest::Method::GET, &path, &Value::Null, Replay::Safe)
                .await?;
            let results = page["results"].as_array().ok_or_else(|| {
                NotionError::new(NotionErrorKind::BadResponse, "children have no results")
            })?;
            blocks.extend(results.iter().cloned());
            match (page["has_more"].as_bool(), page["next_cursor"].as_str()) {
                (Some(true), Some(next)) => cursor = Some(next.to_string()),
                _ => return Ok(blocks),
            }
        }
    }

    pub(crate) async fn append_children(
        &mut self,
        block_id: &str,
        children: &[Value],
        notify: Notify,
    ) -> Result<(), NotionError> {
        self.call(
            reqwest::Method::PATCH,
            &format!("/v1/blocks/{block_id}/children"),
            &with_notify(json!({ "children": children }), notify),
            Replay::RejectedOnly,
        )
        .await
        .map(drop)
    }

    /// 블록 하나를 지운다. 이미 없으면 된 것으로 본다.
    async fn delete_block(&mut self, block_id: &str) -> Result<(), NotionError> {
        match self
            .call(
                reqwest::Method::DELETE,
                &format!("/v1/blocks/{block_id}"),
                &Value::Null,
                Replay::Safe,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.kind == NotionErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// 읽기 하나(`GET {path}`, 예: `/v1/databases/{id}`). 일시 오류는 다시 한다.
    pub(crate) async fn get(&mut self, path: &str) -> Result<Value, NotionError> {
        self.call(reqwest::Method::GET, path, &Value::Null, Replay::Safe)
            .await
    }

    /// 본문(`children`)까지 한 요청으로 페이지를 만든다(다시 보내지 않음). 503 이면서 노션이
    /// 만든 id 를 알려 주면 그 id. 알림은 노션 기본값이다(새 task 의 담당자가 알게).
    pub(crate) async fn create_page_with_children(
        &mut self,
        data_source: &str,
        properties: &Map<String, Value>,
        children: &[Value],
    ) -> Result<String, NotionError> {
        let body = json!({
            "parent": { "type": "data_source_id", "data_source_id": data_source },
            "properties": properties,
            "children": children
        });
        let page = self
            .call(
                reqwest::Method::POST,
                "/v1/pages",
                &body,
                Replay::RejectedOnly,
            )
            .await?;
        page_id(&page)
    }

    /// 이 클라이언트의 설정.
    pub(crate) fn settings(&self) -> &NotionSettings {
        self.settings
    }
}

pub(crate) fn page_id(page: &Value) -> Result<String, NotionError> {
    page["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| NotionError::new(NotionErrorKind::BadResponse, "page has no id"))
}

/// query 결과에서 휴지통에 없는 페이지들.
pub(crate) fn live_results(result: &Value) -> Result<Vec<Value>, NotionError> {
    let results = result["results"].as_array().ok_or_else(|| {
        NotionError::new(NotionErrorKind::BadResponse, "query answer has no results")
    })?;
    Ok(results
        .iter()
        .filter(|page| page["in_trash"] != Value::Bool(true))
        .cloned()
        .collect())
}

/// 칸 값의 글(`title`·`rich_text` 조각의 `plain_text` 를 이은 것).
pub(crate) fn property_text(value: &Value) -> String {
    ["title", "rich_text"]
        .iter()
        .filter_map(|key| value[*key].as_array())
        .flatten()
        .filter_map(|run| run["plain_text"].as_str())
        .collect()
}

/// "허들 ID" 칸 값: `{channel_id}:{세션 id,세션 id,…}`(세션은 시작 순).
pub fn huddle_key(transcript: &Transcript) -> String {
    let sessions: Vec<String> = transcript
        .session_ids
        .iter()
        .map(ToString::to_string)
        .collect();
    format!("{}:{}", transcript.channel_id, sessions.join(","))
}

/// "허들 ID" 칸 값을 채널과 세션들로.
pub fn parse_huddle_key(key: &str) -> Option<(Uuid, Vec<Uuid>)> {
    let (channel, sessions) = key.split_once(':')?;
    let channel = channel.trim().parse().ok()?;
    let sessions = sessions
        .split(',')
        .filter_map(|session| session.trim().parse().ok())
        .collect();
    Some((channel, sessions))
}

/// 같은 채널이고 세션이 하나라도 겹치는 회의 페이지인가.
fn same_meeting(page: &Value, channel: Uuid, sessions: &[Uuid]) -> bool {
    let key = property_text(&page["properties"][minutes_property::HUDDLE_ID]);
    parse_huddle_key(&key).is_some_and(|(page_channel, page_sessions)| {
        page_channel == channel && page_sessions.iter().any(|s| sessions.contains(s))
    })
}

/// 노션에 올릴 회의 하나.
pub struct MeetingPage<'a> {
    /// 스크립트(원본).
    pub transcript: &'a Transcript,
    /// 이 스크립트의 후보정. 있으면 전체 스크립트에 고친 글을 줄 안 표시와 함께
    /// 보인다: 고친 낱말은 "노션에(원래: 오션에)", 애매 제안은 "오션에(혹시 노션에?)".
    /// 원본은 스크립트 파일에 그대로 있다.
    pub corrected: Option<&'a Corrected>,
    /// 요약. 없으면 본문에 스크립트만 넣는다.
    pub summary: Option<&'a Summary>,
    /// 요약이 없을 때 "요약" 제목 아래 넣을 한 문단(예: 요약을 못 만든 까닭).
    pub summary_note: Option<&'a str>,
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
    /// 본문 맨 끝(전체 스크립트 뒤)에 붙일 블록. task 연결이 이미 붙인 「관련 있을 수 있는
    /// task」 절을 페이지를 다시 쓸 때도 남기려고 쓴다([`crate::tasks::maybe_blocks`]).
    pub tail: &'a [Value],
}

/// 노션 쓰기 결과(개수와 page id 만). 하는 대로 채워서, 중간에 실패해도 그때까지
/// 만든 것이 남는다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PublishReport {
    /// 회의 페이지 id.
    pub page_id: String,
    /// 이번에 새로 만들었나(아니면 있던 것을 고침).
    pub created: bool,
    /// 같은 회의 페이지가 여러 장이라 휴지통으로 보낸 페이지 id.
    pub trashed_duplicates: Vec<String>,
    /// 본문 블록 수.
    pub blocks: usize,
    /// 본문 붙이기 요청 수(마지막 시도).
    pub append_requests: usize,
    /// 새 본문을 붙인 뒤 지운 옛 블록 수(마지막 시도).
    pub deleted_old_blocks: usize,
    /// 체크 상태를 이어받은 할 일 수.
    pub kept_checked: usize,
    /// 본문 쓰기를 처음부터 한 횟수.
    pub body_attempts: u32,
    /// 담당자 연결 DB 에 새로 더한 줄 id.
    pub people_rows_added: Vec<String>,
    /// 담당자 연결 DB 에서 이름 칸이 pubkey 앞 8자 그대로라 프로필 이름으로 고친 줄 id.
    pub people_rows_renamed: Vec<String>,
    /// 이름을 고치려다 못 한 줄 수(권한·일시 오류). 다음 회의에서 다시 해 본다.
    pub people_rename_failed: usize,
    /// "확인됨" 줄에 노션 사용자가 있어 멘션할 수 있는 참석자 수.
    pub people_linked: usize,
    /// 담당자 연결 DB 를 못 다뤘을 때 그 까닭(회의록은 그래도 쓴다). 종류·HTTP 상태·노션
    /// 오류 코드만([`NotionError::short`]): 작업기 로그에 찍힌다.
    pub people_error: Option<String>,
    /// 본문 쓰기에 실패했는데 "실패" 표시까지 못 해서 "처리 중"으로 남았을 수 있다.
    pub stuck_in_progress: bool,
}

/// 참석자 pubkey: 참석자 목록 순서, 그다음 목록에 없는 화자.
fn attendee_pubkeys(transcript: &Transcript) -> Vec<&str> {
    let mut pubkeys: Vec<&str> = Vec::new();
    let all = crate::summary::attending(transcript)
        // Only people known by pubkey: a room speaker's label is no one to
        // mention.
        .chain(
            transcript
                .segments
                .iter()
                .filter_map(|s| s.speaker.as_deref()),
        );
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
/// 할 일(`to_do`)이면 `checked` 를 넣는다.
pub(crate) fn blocks(kind: &str, runs: Vec<Value>, checked: bool) -> Vec<Value> {
    let make = |rich_text: &[Value]| {
        let mut inner = json!({ "rich_text": rich_text });
        if kind == "to_do" {
            inner["checked"] = Value::Bool(checked);
        }
        json!({ "object": "block", "type": kind, kind: inner })
    };
    if runs.is_empty() {
        return vec![make(&[])];
    }
    runs.chunks(MAX_RICH_TEXT_ITEMS).map(make).collect()
}

fn paragraph(text: &str) -> Vec<Value> {
    blocks("paragraph", text_runs(text, None), false)
}

/// 스크립트 한 줄의 글: 후보정이 있으면 고친 글에 줄 안 표시를 붙인 것.
fn line_text(
    segment: &crate::transcript::Segment,
    line: Option<&correct::CorrectedLine>,
) -> String {
    let Some(line) = line else {
        return segment.text.trim().to_string();
    };
    let mut text = String::new();
    for piece in correct::pieces(&segment.text, line) {
        match piece {
            Piece::Same(same) => text.push_str(same),
            Piece::Fixed { from, to } => text.push_str(&format!("{to}(원래: {from})")),
            Piece::Maybe { from, to } => text.push_str(&format!("{from}(혹시 {to}?)")),
        }
    }
    text.trim().to_string()
}

pub(crate) fn heading(text: &str) -> Value {
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
    playback_link_at(template, transcript.channel_id, start_ms)
}

/// `channel` 채널의 앱 재생 링크(스크립트 없이 채널 id 만 알 때).
pub fn playback_link_at(template: &str, channel: Uuid, start_ms: u64) -> String {
    template
        .replace("{channel_id}", &channel.to_string())
        .replace("{start_ms}", &start_ms.to_string())
}

/// 노션 본문 글에 걸 수 있는 링크 모양인가. 2026-10-12 실제 시험에서 노션은
/// 본문 링크로 `buzz://`(어느 경로든)를 "Invalid URL for link" 로 거절했고
/// `https://` 는 받았다. ("앱에서 열기" url 칸은 `buzz://` 도 받는다.)
pub fn linkable_in_body(link_template: &str) -> bool {
    link_template.starts_with("https://") || link_template.starts_with("http://")
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
        json!({ "rich_text": text_runs(&huddle_key(transcript), None) }),
    );
    put(p::STATUS, json!({ "select": { "name": status.as_str() } }));
    properties
}

/// 할 일 글을 비교용으로(글자·숫자만, 소문자).
fn todo_key(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 옛 본문에서 체크된 할 일의 글(비교용).
fn checked_todos(old: &[Value]) -> HashSet<String> {
    old.iter()
        .filter(|block| block["type"] == "to_do" && block["to_do"]["checked"] == true)
        .map(|block| {
            let text: String = block["to_do"]["rich_text"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|run| {
                    run["plain_text"]
                        .as_str()
                        .or_else(|| run["text"]["content"].as_str())
                        .unwrap_or("")
                })
                .collect();
            let task = text.split(TASK_SEPARATOR).next().unwrap_or("");
            todo_key(task)
        })
        .collect()
}

/// 회의 페이지 본문 블록, 순서대로.
/// `people` 은 pubkey → 노션 사용자 id("확인됨" 줄만). `checked` 는 옛 본문에서
/// 체크돼 있던 할 일 글([`todo_key`]). 링크 모양이 본문에 걸 수 없는 것
/// ([`linkable_in_body`])이면 시각은 링크 없는 글로 넣는다.
pub fn body_blocks(
    page: &MeetingPage<'_>,
    people: &HashMap<String, String>,
    link_template: &str,
    checked: &HashSet<String>,
) -> Vec<Value> {
    let transcript = page.transcript;
    let linkable = linkable_in_body(link_template);
    let time_link = |ms: u64| {
        let link = linkable.then(|| playback_link(link_template, transcript, ms));
        text_runs(&clock(ms), link.as_deref())
    };
    let mut out = Vec::new();

    if let (None, Some(note)) = (page.summary, page.summary_note) {
        out.push(heading("요약"));
        out.extend(paragraph(note));
    }
    if let Some(summary) = page.summary {
        out.push(heading("요약"));
        let paragraphs: Vec<&str> = summary
            .summary
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        if paragraphs.is_empty() {
            out.extend(paragraph("없음"));
        }
        for text in paragraphs {
            out.extend(paragraph(text));
        }

        out.push(heading("결정사항"));
        if summary.decisions.is_empty() {
            out.extend(paragraph("없음"));
        }
        for decision in &summary.decisions {
            let mut runs = text_runs(&decision.text, None);
            if let Some(ms) = decision.evidence_start_ms {
                runs.extend(text_runs(" ", None));
                runs.extend(time_link(ms));
            }
            out.extend(blocks("bulleted_list_item", runs, false));
        }

        out.push(heading("할 일"));
        if summary.action_items.is_empty() {
            out.extend(paragraph("없음"));
        }
        for item in &summary.action_items {
            let mut runs = text_runs(&item.text, None);
            runs.extend(text_runs(TASK_SEPARATOR, None));
            runs.extend(text_runs(" ", None));
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
            // 검사를 통과한 근거 글만 따옴표로 보여 준다.
            if let Some(quote) = item.assignee_quote.as_deref() {
                runs.extend(text_runs(&format!(" (“{quote}”)"), None));
            }
            runs.extend(text_runs(" · 기한: ", None));
            match &item.due {
                Some(due) => runs.push(json!({
                    "type": "mention",
                    "mention": { "type": "date", "date": { "start": due } }
                })),
                None if item.due_quote.is_some() => {}
                None => runs.extend(text_runs("없음", None)),
            }
            if let Some(quote) = item.due_quote.as_deref() {
                let space = if item.due.is_some() { " " } else { "" };
                runs.extend(text_runs(&format!("{space}(“{quote}”)"), None));
            }
            if item.status == ItemStatus::Unsure {
                runs.extend(text_runs(" · 애매", None));
            }
            if let Some(ms) = item.evidence_start_ms {
                runs.extend(text_runs(" ", None));
                runs.extend(time_link(ms));
            }
            let done = checked.contains(&todo_key(&item.text));
            out.extend(blocks("to_do", runs, done));
        }

        out.push(heading("주제별 정리"));
        if summary.topics.is_empty() {
            out.extend(paragraph("없음"));
        }
        for topic in &summary.topics {
            let mut runs = text_runs(&topic.title, None);
            if let Some(ms) = topic.start_ms {
                runs.extend(text_runs(" ", None));
                runs.extend(time_link(ms));
            }
            out.extend(blocks("heading_3", runs, false));
            for point in &topic.points {
                out.extend(blocks("bulleted_list_item", text_runs(point, None), false));
            }
        }
    }

    out.push(heading("전체 스크립트"));
    let mut segments: Vec<_> = transcript.segments.iter().enumerate().collect();
    segments.sort_by_key(|(_, segment)| segment.start_ms);
    if segments.is_empty() {
        out.extend(paragraph("없음"));
    }
    for (index, segment) in segments {
        let mut runs = time_link(segment.start_ms);
        let name = line_name(segment, page.names);
        let line = page
            .corrected
            .and_then(|corrected| corrected.lines.get(&index));
        let text = line_text(segment, line);
        runs.extend(text_runs(&format!(" {name}: {text}"), None));
        out.extend(blocks("paragraph", runs, false));
    }
    out.extend(page.tail.iter().cloned());
    out
}

/// 새 본문을 붙이기 전에 노션 한도를 넘는 블록이 없는지 본다(조각 100개,
/// 글 2000자, 링크 2000자·http(s) 만).
pub fn validate_blocks(blocks: &[Value]) -> Result<(), NotionError> {
    let bad = |index: usize, what: &str| {
        Err(NotionError::new(
            NotionErrorKind::BadRequest,
            format!("block {index}: {what}"),
        ))
    };
    for (index, block) in blocks.iter().enumerate() {
        let kind = block["type"].as_str().unwrap_or("");
        let runs = block[kind]["rich_text"].as_array();
        let Some(runs) = runs else {
            return bad(index, "no rich_text");
        };
        if runs.len() > MAX_RICH_TEXT_ITEMS {
            return bad(index, "more than 100 text pieces");
        }
        for run in runs {
            let text = run["text"]["content"].as_str().unwrap_or("");
            if text.encode_utf16().count() > MAX_TEXT_UNITS {
                return bad(index, "text piece over 2000");
            }
            if let Some(url) = run["text"]["link"]["url"].as_str() {
                if url.encode_utf16().count() > MAX_TEXT_UNITS || !linkable_in_body(url) {
                    return bad(index, "link Notion will not take");
                }
            }
        }
    }
    Ok(())
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

/// 참석자마다 "허들 담당자 연결" 줄을 찾고, 없으면 이름(프로필 이름, 모르면 pubkey
/// 앞 8자)과 pubkey 만 넣어 한 줄 만든다. 있는 줄은 읽기만 하되, 이름 칸이 pubkey 앞
/// 8자 그대로면 프로필 이름으로 고친다([`rename_prefix_row`]). "확인됨"이 체크되고
/// "노션 사용자"가 있는 줄만 pubkey → 노션 사용자 id 로 돌려준다. 새로 만든 줄·고친 줄
/// id 는 할 때마다 `report` 에 더한다(중간에 실패해도 남게).
pub async fn link_people(
    client: &mut NotionClient<'_>,
    transcript: &Transcript,
    names: &dyn DisplayNames,
    report: &mut PublishReport,
) -> Result<HashMap<String, String>, NotionError> {
    use people_property as p;
    let data_source = client.settings.people_data_source_id.clone();
    let mut linked = HashMap::new();
    for pubkey in attendee_pubkeys(transcript) {
        let rows = client.find_by_text(&data_source, p::PUBKEY, pubkey).await?;
        if let Some(row) = rows.first() {
            if let Some(user) = confirmed_user(row) {
                linked.insert(pubkey.to_string(), user.to_string());
            }
            rename_prefix_row(client, row, pubkey, names, report).await;
            continue;
        }
        let name = names
            .profile_name(pubkey)
            .unwrap_or_else(|| names.display_name(pubkey));
        let mut properties = Map::new();
        properties.insert(p::NAME.into(), json!({ "title": text_runs(&name, None) }));
        properties.insert(
            p::PUBKEY.into(),
            json!({ "rich_text": text_runs(pubkey, None) }),
        );
        let id = match client.create_page(&data_source, &properties).await {
            Ok(id) => id,
            // 만들어졌는데 답만 못 받았을 수 있으니 다시 찾아보고, 없을 때만 한 번 더.
            Err(error) if error.kind == NotionErrorKind::Transient => {
                match client
                    .find_by_text(&data_source, p::PUBKEY, pubkey)
                    .await?
                    .first()
                {
                    Some(row) => page_id(row)?,
                    None => client.create_page(&data_source, &properties).await?,
                }
            }
            Err(error) => return Err(error),
        };
        report.people_rows_added.push(id);
    }
    Ok(linked)
}

/// 담당자 줄이 "확인됨"이고 "노션 사용자"가 있으면 그 노션 사용자 id. 멘션·담당자 칸에는
/// 이 사람만 쓴다.
fn confirmed_user(row: &Value) -> Option<&str> {
    use people_property as p;
    let confirmed = row["properties"][p::CONFIRMED]["checkbox"] == Value::Bool(true);
    let user = row["properties"][p::NOTION_USER]["people"][0]["id"].as_str();
    user.filter(|_| confirmed)
}

/// `pubkey` 의 "허들 담당자 연결" 줄이 "확인됨"이면 그 노션 사용자 id(읽기만 한다: 줄을
/// 만들거나 고치지 않는다). task 연결이 새 task 의 담당자를 넣을 때 쓴다.
pub(crate) async fn confirmed_user_of(
    client: &mut NotionClient<'_>,
    pubkey: &str,
) -> Result<Option<String>, NotionError> {
    let data_source = client.settings.people_data_source_id.clone();
    let rows = client
        .find_by_text(&data_source, people_property::PUBKEY, pubkey)
        .await?;
    Ok(rows.first().and_then(confirmed_user).map(str::to_string))
}

/// 있는 담당자 줄의 이름 칸이 `pubkey` 앞 8자 그대로(작업기가 넣은 그대로)이고 프로필
/// 이름을 알면 그 이름으로 고친다(조용히). 사람이 고친 이름과 다른 칸은 건드리지 않는다.
/// 못 고쳐도(고치기 권한이 없거나 일시 오류) 실패로 넘기지 않고 수만 센다: 이름 칸이 그대로
/// 남아서 그 사람이 나오는 다음 회의가 다시 해 본다.
async fn rename_prefix_row(
    client: &mut NotionClient<'_>,
    row: &Value,
    pubkey: &str,
    names: &dyn DisplayNames,
    report: &mut PublishReport,
) {
    use people_property as p;
    let Some(name) = names.profile_name(pubkey) else {
        return;
    };
    let current = property_text(&row["properties"][p::NAME]);
    if current.trim() != PubkeyPrefixNames.display_name(pubkey) || current.trim() == name {
        return;
    }
    let Ok(id) = page_id(row) else {
        return;
    };
    let body = json!({ "properties": { p::NAME: { "title": text_runs(&name, None) } } });
    match client.update_page(&id, body, Notify::Silent).await {
        Ok(()) => report.people_rows_renamed.push(id),
        Err(_) => report.people_rename_failed += 1,
    }
}

/// 같은 회의 페이지들 가운데 가장 먼저 만든 것(만든 시각, 그다음 id 순)만 남기고
/// 나머지는 휴지통으로. 남긴 id 를 돌려준다. 두 작업기가 같은 목록을 보면 같은
/// 것을 남긴다.
async fn keep_earliest(
    client: &mut NotionClient<'_>,
    mut pages: Vec<(String, String)>,
    report: &mut PublishReport,
) -> Result<Option<String>, NotionError> {
    pages.sort();
    pages.dedup_by(|a, b| a.1 == b.1);
    let mut pages = pages.into_iter();
    let Some((_, keep)) = pages.next() else {
        return Ok(None);
    };
    for (_, extra) in pages {
        client.trash_page(&extra).await?;
        report.trashed_duplicates.push(extra);
    }
    Ok(Some(keep))
}

/// (만든 시각, id) 목록.
fn created_and_ids(pages: &[Value]) -> Vec<(String, String)> {
    pages
        .iter()
        .filter_map(|page| {
            let id = page["id"].as_str()?.to_string();
            let created = page["created_time"].as_str().unwrap_or("").to_string();
            Some((created, id))
        })
        .collect()
}

/// 회의 페이지를 만든다. 일시 오류로 답을 못 받으면 만들어졌는지 다시 찾아보고,
/// 없을 때만 한 번 더 만든다.
async fn create_meeting_page(
    client: &mut NotionClient<'_>,
    transcript: &Transcript,
    properties: &Map<String, Value>,
) -> Result<String, NotionError> {
    let data_source = client.settings.minutes_data_source_id.clone();
    match client.create_page(&data_source, properties).await {
        Ok(id) => Ok(id),
        Err(error) if error.kind == NotionErrorKind::Transient => {
            let found = client
                .find_meeting_pages(transcript.channel_id, &transcript.session_ids)
                .await?;
            match found.first() {
                Some(page) => page_id(page),
                None => client.create_page(&data_source, properties).await,
            }
        }
        Err(error) => Err(error),
    }
}

/// 본문 한 번 쓰기: 옛 블록을 읽고(체크 상태도), 새 본문을 만들어 한도를 확인한
/// 뒤 다 붙이고, 그다음에 옛 블록을 지운다.
async fn write_body(
    client: &mut NotionClient<'_>,
    page_id: &str,
    page: &MeetingPage<'_>,
    people: &HashMap<String, String>,
    notify: Notify,
    report: &mut PublishReport,
) -> Result<(), NotionError> {
    let old = client.list_children(page_id).await?;
    let checked = checked_todos(&old);
    let link = client.settings.playback_link.clone();
    let body = body_blocks(page, people, &link, &checked);
    validate_blocks(&body)?;
    report.blocks = body.len();
    report.kept_checked = body
        .iter()
        .filter(|block| block["to_do"]["checked"] == true)
        .count();
    let chunks = chunk_blocks(body);
    report.append_requests = 0;
    for chunk in &chunks {
        client.append_children(page_id, chunk, notify).await?;
        report.append_requests += 1;
    }
    report.deleted_old_blocks = 0;
    for block in &old {
        if let Some(id) = block["id"].as_str() {
            client.delete_block(id).await?;
            report.deleted_old_blocks += 1;
        }
    }
    Ok(())
}

/// "실패" 표시를 기다렸다가 여러 번 해 본다. 끝내 못 하면 `false`.
async fn mark_failed(client: &mut NotionClient<'_>, page_id: &str) -> bool {
    let mut wait = client.settings.failed_mark_wait;
    for attempt in 0..FAILED_MARK_ATTEMPTS {
        if client
            .set_status(page_id, ProcessingStatus::Failed, Notify::Silent)
            .await
            .is_ok()
        {
            return true;
        }
        if attempt + 1 < FAILED_MARK_ATTEMPTS {
            tokio::time::sleep(wait).await;
            wait *= 2;
        }
    }
    false
}

/// 회의 하나를 노션에 쓴다. `known_page_id` 는 지난번에 남긴 page id(있으면 그것부터).
/// 없거나 맞지 않으면 세션이 겹치는 페이지를 찾고, 그래도 없으면 만든다.
/// 쓰는 동안 "처리 상태"는 "처리 중", 다 쓰면 `page.status`, 본문 쓰기에 실패하면
/// "실패"로 둔다. `report` 는 하는 대로 채운다.
///
/// 같은 회의를 동시에 두 번 쓰지 않도록 작업기의 회의 잠금 안에서 부른다
/// ([`publish_held`]).
pub async fn publish(
    client: &mut NotionClient<'_>,
    page: &MeetingPage<'_>,
    known_page_id: Option<&str>,
    report: &mut PublishReport,
) -> Result<(), NotionError> {
    let transcript = page.transcript;
    if let Some(summary) = page.summary {
        if summary.huddle_id != huddle_id(transcript) {
            return Err(NotionError::new(
                NotionErrorKind::BadRequest,
                "summary belongs to another huddle",
            ));
        }
    }
    let settings = client.settings;
    let (channel, sessions) = (transcript.channel_id, &transcript.session_ids);

    // 담당자 연결 DB 를 못 다뤄도 회의록은 쓴다(멘션만 빠진다).
    let people = match link_people(client, transcript, page.names, report).await {
        Ok(people) => people,
        Err(error) => {
            // 노션 메시지는 페이지 글을 옮겨 올 수 있어서 종류와 코드만 남긴다.
            report.people_error = Some(error.short());
            HashMap::new()
        }
    };
    report.people_linked = people.len();

    // 1) 지난번에 남긴 page id. 2) 세션이 겹치는 페이지. 3) 새로 만든다.
    let mut found_id = None;
    if let Some(id) = known_page_id {
        if let Some(existing) = client.get_page(id).await? {
            if existing["in_trash"] != Value::Bool(true)
                && same_meeting(&existing, channel, sessions)
            {
                found_id = Some(id.to_string());
            }
        }
    }
    if found_id.is_none() {
        let found = client.find_meeting_pages(channel, sessions).await?;
        found_id = keep_earliest(client, created_and_ids(&found), report).await?;
    }
    let working = page_properties(page, ProcessingStatus::InProgress, &settings.playback_link);
    let page_id = match found_id {
        Some(id) => {
            report.page_id = id.clone();
            client
                .update_page(&id, json!({ "properties": working }), Notify::Silent)
                .await?;
            id
        }
        None => {
            let id = create_meeting_page(client, transcript, &working).await?;
            report.page_id = id.clone();
            report.created = true;
            // 만든 뒤 다시 찾아 두 장 이상이면 늦게 만든 쪽을 휴지통으로. 방금 만든
            // 것이 아직 안 보이면 가장 늦게 만든 것으로 끼워 넣는다.
            let found = client.find_meeting_pages(channel, sessions).await?;
            let mut pages = created_and_ids(&found);
            if !pages.iter().any(|(_, page)| *page == id) {
                pages.push(("~".to_string(), id.clone()));
            }
            let keep = keep_earliest(client, pages, report)
                .await?
                .unwrap_or_else(|| id.clone());
            if keep != id {
                report.page_id = keep.clone();
                report.created = false;
            }
            keep
        }
    };
    let notify = if report.created {
        Notify::Default
    } else {
        Notify::Silent
    };

    let mut attempts = 0;
    loop {
        attempts += 1;
        report.body_attempts = attempts;
        match write_body(client, &page_id, page, &people, notify, report).await {
            Ok(()) => break,
            // 붙이다 끊기면(429 포함) 처음부터: 지금 있는 블록을 다 옛 것으로 보고
            // 새 본문을 다시 붙인 뒤 지운다.
            Err(error) if error.kind.passes() && attempts < settings.body_attempts => {}
            Err(error) => {
                if !mark_failed(client, &page_id).await {
                    report.stuck_in_progress = true;
                }
                return Err(error);
            }
        }
    }
    client.set_status(&page_id, page.status, notify).await
}

/// 작업기 저장소에 남기는 노션 기록(`huddle-notion/1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotionRecord {
    /// 늘 [`RECORD_FORMAT`].
    pub format: String,
    /// 회의 페이지 id.
    pub page_id: String,
    /// "허들 ID" 칸에 쓴 값.
    pub huddle_key: String,
    /// 페이지를 끝까지 썼나(작업기가 [`publish_held`] 로 성공했을 때만 true).
    /// 이 칸이 없던 기록은 false 로 읽어서, 다음 실행이 같은 페이지를 다시 고친다.
    #[serde(default)]
    pub done: bool,
    /// 페이지에 쓴 스크립트의 sha256([`RecordStamp`]).
    #[serde(default)]
    pub script_sha256: String,
    /// 페이지에 쓴 요약: 요약 파일의 sha256, 요약을 포기했으면 `failed`, 없으면 비움.
    #[serde(default)]
    pub summary_sha256: String,
    /// 페이지에 쓴 후보정: 후보정 파일의 sha256, 원본 글로 썼으면 비움.
    #[serde(default)]
    pub corrected_sha256: String,
}

/// 노션 기록에 같이 적는, 페이지에 무엇을 썼는지.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordStamp {
    /// 스크립트 바이트의 sha256.
    pub script_sha256: String,
    /// 요약 파일의 sha256, `failed`, 또는 비움.
    pub summary_sha256: String,
    /// 후보정 파일의 sha256, 또는 비움(원본 글).
    pub corrected_sha256: String,
}

impl NotionRecord {
    /// `transcript` 회의의 `page_id` 기록.
    pub fn new(transcript: &Transcript, page_id: &str) -> Self {
        Self {
            format: RECORD_FORMAT.into(),
            page_id: page_id.into(),
            huddle_key: huddle_key(transcript),
            done: false,
            script_sha256: String::new(),
            summary_sha256: String::new(),
            corrected_sha256: String::new(),
        }
    }
}

/// [`publish_held`]·[`publish_meeting`] 실패.
#[derive(Debug, thiserror::Error)]
pub enum PublishMeetingError {
    /// 작업기 저장소(잠금·기록)가 실패.
    #[error(transparent)]
    Home(#[from] MeetingError),
    /// 노션이 실패.
    #[error(transparent)]
    Notion(#[from] NotionError),
}

/// 회의를 잡은(hold) 채로 부른다: 기록에서 page id 를 읽어 [`publish`] 하고,
/// 페이지가 생겼으면(실패했어도) 기록을 남긴다. 기록을 못 읽으면 없는 것으로 친다.
/// 기록에는 `stamp`(무엇을 썼는지)를 같이 적는다. 실패하면 page id 를 못 받았어도
/// 아는 page id 로 `done=false` 를 적어서, 옛 "끝남"이 남지 않게 한다.
/// 기록을 쓰기 전에 아직 `hold` 를 쥐고 있는지 본다(놓쳤으면 안 쓰고
/// [`MeetingError::HoldLost`]).
pub async fn publish_held<H: MinutesHome>(
    home: &H,
    hold: &H::Hold,
    meeting: &MeetingPlan,
    client: &mut NotionClient<'_>,
    page: &MeetingPage<'_>,
    stamp: &RecordStamp,
    report: &mut PublishReport,
) -> Result<(), PublishMeetingError> {
    let known = home
        .read_notion_record(meeting)
        .await?
        .and_then(|bytes| serde_json::from_slice::<NotionRecord>(&bytes).ok())
        .map(|record| record.page_id);
    let result = publish(client, page, known.as_deref(), report).await;
    let page_id = if report.page_id.is_empty() {
        known.filter(|_| result.is_err())
    } else {
        Some(report.page_id.clone())
    };
    if let Some(page_id) = page_id {
        if !home.still_held(hold).await? {
            return Err(MeetingError::HoldLost.into());
        }
        let record = NotionRecord {
            done: result.is_ok(),
            script_sha256: stamp.script_sha256.clone(),
            summary_sha256: stamp.summary_sha256.clone(),
            corrected_sha256: stamp.corrected_sha256.clone(),
            ..NotionRecord::new(page.transcript, &page_id)
        };
        let json = serde_json::to_vec_pretty(&record)
            .map_err(|error| MeetingError::Io(std::io::Error::other(error)))?;
        home.write_notion_record(meeting, json)
            .await
            .map_err(PublishMeetingError::Home)?;
    }
    result.map_err(PublishMeetingError::Notion)
}

/// 회의를 잡고 [`publish_held`] 를 한 뒤 놓는다. 다른 작업기가 잡고 있으면
/// `Ok(false)`(다음 실행에 다시).
pub async fn publish_meeting<H: MinutesHome>(
    home: &H,
    meeting: &MeetingPlan,
    client: &mut NotionClient<'_>,
    page: &MeetingPage<'_>,
    report: &mut PublishReport,
) -> Result<bool, PublishMeetingError> {
    let Some(hold) = home.hold(meeting).await? else {
        return Ok(false);
    };
    let done = publish_held(
        home,
        &hold,
        meeting,
        client,
        page,
        &RecordStamp::default(),
        report,
    )
    .await;
    let released = home.release(hold).await;
    done?;
    released?;
    Ok(true)
}

/// 오래 "처리 중"으로 남은 페이지.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StalePage {
    /// 페이지 id.
    pub page_id: String,
    /// "허들 ID" 칸 값.
    pub huddle_key: String,
    /// 마지막으로 고친 때(UTC).
    pub last_edited_time: String,
}

/// "처리 상태"가 "처리 중"이면서 `now` 보다 `older_than` 넘게 안 고친 페이지들
/// (작업기가 쓰다 죽었을 수 있는 것).
pub async fn find_stale(
    client: &mut NotionClient<'_>,
    older_than: Duration,
    now: DateTime<Utc>,
) -> Result<Vec<StalePage>, NotionError> {
    let older = chrono::Duration::from_std(older_than).unwrap_or(chrono::Duration::zero());
    let cutoff = (now - older).to_rfc3339_opts(SecondsFormat::Secs, true);
    let data_source = client.settings.minutes_data_source_id.clone();
    let mut stale = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut body = json!({
            "filter": { "and": [
                { "property": minutes_property::STATUS,
                  "select": { "equals": ProcessingStatus::InProgress.as_str() } },
                { "timestamp": "last_edited_time", "last_edited_time": { "before": cutoff } }
            ] },
            "sorts": [{ "timestamp": "last_edited_time", "direction": "ascending" }],
            "page_size": 100
        });
        if let Some(cursor) = &cursor {
            body["start_cursor"] = json!(cursor);
        }
        let result = client.query(&data_source, body).await?;
        for page in live_results(&result)? {
            stale.push(StalePage {
                page_id: page_id(&page)?,
                huddle_key: property_text(&page["properties"][minutes_property::HUDDLE_ID]),
                last_edited_time: page["last_edited_time"].as_str().unwrap_or("").into(),
            });
        }
        match (result["has_more"].as_bool(), result["next_cursor"].as_str()) {
            (Some(true), Some(next)) => cursor = Some(next.to_string()),
            _ => return Ok(stale),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use super::*;
    use crate::runner::LocalMinutes;
    use crate::summary::{
        check_answer, ActionItem, Corrections, Decision, PubkeyPrefixNames, Topic, Usage,
        SUMMARY_FORMAT,
    };
    use crate::test_http::{transcript_with, FakeServer, Recorded, Reply};

    const A: &str = "aaaaaaaa00000000000000000000000000000000000000000000000000000001";
    const B: &str = "bbbbbbbb00000000000000000000000000000000000000000000000000000002";

    /// 노션을 흉내 내는 상태.
    #[derive(Default)]
    pub(crate) struct FakeNotion {
        pub(crate) pages: Vec<FakePage>,
        /// 어느 요청이든 앞에서부터 하나씩 꺼내 답한다.
        pub(crate) queued: Vec<Reply>,
        /// 붙이기 요청에만 앞에서부터 꺼내 답한다.
        pub(crate) append_failures: Vec<Reply>,
        /// 페이지 고치기(PATCH /v1/pages)에만 앞에서부터 꺼내 답한다.
        page_patch_failures: Vec<Reply>,
        /// 회의 페이지를 만들기 바로 전에 다른 작업기가 먼저 한 장 만든다(한 번).
        race_create: bool,
        /// 회의 페이지를 만들고 503 + committed_resource_id 로 답한다(한 번).
        commit_then_503: bool,
        /// 회의 페이지를 만들고 답 본문을 중간에 끊는다(한 번).
        cut_off_create: bool,
        /// 담당자 연결 DB 를 403 으로 막는다.
        people_forbidden: bool,
        /// `GET /v1/databases/{id}` 의 답(task DB).
        pub(crate) databases: HashMap<String, Value>,
        /// `GET /v1/data_sources/{id}` 의 답(task DB 스키마).
        pub(crate) data_sources: HashMap<String, Value>,
        /// 경로에 이 글이 든 요청(새 페이지는 부모 data source)은 403 으로 막는다(통합이 그
        /// DB 에 연결 안 됨). 노션 메시지에 회의 글을 넣어 로그로 새는지 본다.
        pub(crate) forbidden_paths: Vec<String>,
        /// 경로에 이 글이 든 쓰기(PATCH·POST)는 503 으로 답한다.
        pub(crate) failing_paths: Vec<String>,
        next_id: usize,
    }

    pub(crate) struct FakePage {
        pub(crate) id: String,
        pub(crate) data_source: String,
        created_time: String,
        last_edited_time: String,
        pub(crate) properties: Map<String, Value>,
        pub(crate) children: Vec<Value>,
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

    fn page_json(page: &FakePage) -> Value {
        json!({
            "object": "page",
            "id": page.id,
            "created_time": page.created_time,
            "last_edited_time": page.last_edited_time,
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

    /// 노션 query filter 를 흉내 낸다(이 모듈이 쓰는 모양만).
    fn matches(filter: &Value, page: &FakePage) -> bool {
        if let Some(all) = filter["and"].as_array() {
            return all.iter().all(|f| matches(f, page));
        }
        if let Some(any) = filter["or"].as_array() {
            return any.iter().any(|f| matches(f, page));
        }
        if filter["timestamp"] == "last_edited_time" {
            let before = filter["last_edited_time"]["before"].as_str().unwrap();
            return page.last_edited_time.as_str() < before;
        }
        let property = filter["property"].as_str().unwrap();
        let value = page
            .properties
            .get(property)
            .cloned()
            .unwrap_or(Value::Null);
        for kind in ["select", "status"] {
            if let Some(condition) = filter.get(kind) {
                let name = &value[kind]["name"];
                if let Some(other) = condition.get("does_not_equal") {
                    return name != other;
                }
                return *name == condition["equals"];
            }
        }
        let text = property_text(&value);
        let condition = filter.get("title").unwrap_or(&filter["rich_text"]);
        if let Some(wanted) = condition["equals"].as_str() {
            text == wanted
        } else if let Some(part) = condition["contains"].as_str() {
            text.contains(part)
        } else if let Some(start) = condition["starts_with"].as_str() {
            text.starts_with(start)
        } else {
            panic!("filter not faked: {filter}")
        }
    }

    impl FakeNotion {
        fn stamp(&mut self) -> String {
            self.next_id += 1;
            format!(
                "2026-10-12T07:{:02}:{:02}.000Z",
                self.next_id / 60,
                self.next_id % 60
            )
        }

        fn new_page(&mut self, data_source: &str, properties: &Value) -> String {
            let stamp = self.stamp();
            let id = format!("page-{}", self.next_id);
            let properties = properties
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), as_response(value.clone())))
                .collect();
            self.pages.push(FakePage {
                id: id.clone(),
                data_source: data_source.into(),
                created_time: stamp.clone(),
                last_edited_time: stamp,
                properties,
                children: Vec::new(),
                in_trash: false,
            });
            id
        }

        fn page_mut(&mut self, id: &str) -> Option<&mut FakePage> {
            self.pages.iter_mut().find(|page| page.id == id)
        }

        /// 붙인 블록처럼: id 를 주고 글 조각에 `plain_text` 를 붙인다(응답 모양).
        fn with_ids(&mut self, children: Vec<Value>) -> Vec<Value> {
            let mut added = Vec::new();
            for mut child in children {
                self.next_id += 1;
                child["id"] = json!(format!("block-{}", self.next_id));
                let kind = child["type"].as_str().unwrap_or("").to_string();
                if let Some(runs) = child[&kind]["rich_text"].as_array_mut() {
                    for run in runs {
                        run["plain_text"] = run["text"]["content"].clone();
                    }
                }
                added.push(child);
            }
            added
        }

        fn answer(&mut self, request: &Recorded) -> Reply {
            if !self.queued.is_empty() {
                return self.queued.remove(0);
            }
            let body = request.json();
            let path = request.path.split('?').next().unwrap_or("");
            let parent = body["parent"]["data_source_id"].as_str().unwrap_or("");
            let hits = |list: &[String]| {
                list.iter()
                    .any(|part| path.contains(part.as_str()) || parent.contains(part.as_str()))
            };
            if hits(&self.forbidden_paths) {
                return Reply::json(
                    403,
                    &json!({ "code": "restricted_resource", "message": "회의 글 조각 견적서" }),
                );
            }
            if request.method != "GET" && hits(&self.failing_paths) {
                return Reply::json(
                    503,
                    &json!({ "code": "service_unavailable", "message": "later" }),
                );
            }
            let query = request.path.split_once('?').map_or("", |(_, q)| q);
            let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
            let not_found = || Reply::json(404, &json!({ "code": "object_not_found" }));
            match (request.method.as_str(), &parts[..]) {
                ("POST", ["v1", "data_sources", source, "query"]) => {
                    if self.people_forbidden && *source == PEOPLE_DATA_SOURCE_ID {
                        // 노션 메시지는 글 조각을 옮겨 올 수 있다(로그에 가면 안 된다).
                        return Reply::json(
                            403,
                            &json!({ "code": "restricted_resource", "message": "회의 글 조각" }),
                        );
                    }
                    let mut found: Vec<&FakePage> = self
                        .pages
                        .iter()
                        .filter(|page| page.data_source == *source)
                        .filter(|page| body["filter"].is_null() || matches(&body["filter"], page))
                        .collect();
                    // 최근 고친 순(task 읽기). 다른 정렬은 만든 순 그대로.
                    if body["sorts"][0]["timestamp"] == "last_edited_time"
                        && body["sorts"][0]["direction"] == "descending"
                    {
                        found.sort_by(|a, b| b.last_edited_time.cmp(&a.last_edited_time));
                    }
                    let start: usize = body["start_cursor"]
                        .as_str()
                        .and_then(|cursor| cursor.parse().ok())
                        .unwrap_or(0);
                    let size = body["page_size"].as_u64().unwrap_or(100) as usize;
                    let end = (start + size).min(found.len());
                    let more = end < found.len();
                    let results: Vec<Value> = found[start.min(end)..end]
                        .iter()
                        .map(|page| page_json(page))
                        .collect();
                    Reply::json(
                        200,
                        &json!({
                            "object": "list",
                            "results": results,
                            "has_more": more,
                            "next_cursor": if more { json!(end.to_string()) } else { Value::Null }
                        }),
                    )
                }
                ("GET", ["v1", "databases", id]) => match self.databases.get(*id) {
                    Some(database) => Reply::json(200, database),
                    None => not_found(),
                },
                ("GET", ["v1", "data_sources", id]) => match self.data_sources.get(*id) {
                    Some(source) => Reply::json(200, source),
                    None => not_found(),
                },
                ("POST", ["v1", "pages"]) => {
                    let source = body["parent"]["data_source_id"]
                        .as_str()
                        .unwrap()
                        .to_string();
                    if self.people_forbidden && source == PEOPLE_DATA_SOURCE_ID {
                        return Reply::json(403, &json!({ "code": "restricted_resource" }));
                    }
                    let minutes = source == MINUTES_DATA_SOURCE_ID;
                    if minutes && std::mem::take(&mut self.race_create) {
                        self.new_page(&source, &body["properties"]);
                    }
                    let id = self.new_page(&source, &body["properties"]);
                    if let Some(children) = body["children"].as_array() {
                        let children = self.with_ids(children.clone());
                        if let Some(page) = self.page_mut(&id) {
                            page.children = children;
                        }
                    }
                    if minutes && std::mem::take(&mut self.commit_then_503) {
                        return Reply::json(
                            503,
                            &json!({
                                "object": "error", "status": 503, "code": "service_unavailable",
                                "additional_data": {
                                    "committed_resource_id": id,
                                    "retry_guidance": "Read the object again to confirm the saved change."
                                }
                            }),
                        );
                    }
                    let reply = Reply::json(200, &json!({ "object": "page", "id": id }));
                    if minutes && std::mem::take(&mut self.cut_off_create) {
                        return reply.cut_off();
                    }
                    reply
                }
                ("GET", ["v1", "pages", id]) => match self.page_mut(id) {
                    Some(page) => Reply::json(200, &page_json(page)),
                    None => not_found(),
                },
                ("PATCH", ["v1", "pages", id]) => {
                    if !self.page_patch_failures.is_empty() {
                        return self.page_patch_failures.remove(0);
                    }
                    let stamp = self.stamp();
                    let Some(page) = self.page_mut(id) else {
                        return not_found();
                    };
                    page.last_edited_time = stamp;
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
                ("GET", ["v1", "blocks", id, "children"]) => {
                    let Some(page) = self.page_mut(id) else {
                        return not_found();
                    };
                    let start: usize = query
                        .split('&')
                        .find_map(|pair| pair.strip_prefix("start_cursor="))
                        .and_then(|cursor| cursor.parse().ok())
                        .unwrap_or(0);
                    let end = (start + 100).min(page.children.len());
                    let more = end < page.children.len();
                    Reply::json(
                        200,
                        &json!({
                            "object": "list",
                            "results": page.children[start..end],
                            "has_more": more,
                            "next_cursor": if more { json!(end.to_string()) } else { Value::Null }
                        }),
                    )
                }
                ("PATCH", ["v1", "blocks", id, "children"]) => {
                    if !self.append_failures.is_empty() {
                        return self.append_failures.remove(0);
                    }
                    let children = body["children"].as_array().unwrap().clone();
                    if children.len() > MAX_BLOCKS_PER_REQUEST || children.iter().any(too_long) {
                        return Reply::json(
                            400,
                            &json!({ "code": "validation_error", "message": "too big" }),
                        );
                    }
                    let added = self.with_ids(children);
                    let Some(page) = self.page_mut(id) else {
                        return not_found();
                    };
                    page.children.extend(added.iter().cloned());
                    Reply::json(200, &json!({ "object": "list", "results": added }))
                }
                ("DELETE", ["v1", "blocks", id]) => {
                    for page in &mut self.pages {
                        if let Some(at) = page.children.iter().position(|b| b["id"] == *id) {
                            let block = page.children.remove(at);
                            return Reply::json(200, &block);
                        }
                    }
                    not_found()
                }
                _ => Reply::json(404, &json!({ "code": "invalid_request_url" })),
            }
        }
    }

    /// `data_source` 의 페이지 하나(요청 모양의 칸 값을 받는다). `edited` 는 마지막으로 고친 때.
    pub(crate) fn fake_page(
        id: &str,
        data_source: &str,
        edited: &str,
        properties: &Value,
    ) -> FakePage {
        FakePage {
            id: id.into(),
            data_source: data_source.into(),
            created_time: edited.into(),
            last_edited_time: edited.into(),
            properties: properties
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), as_response(value.clone())))
                .collect(),
            children: Vec::new(),
            in_trash: false,
        }
    }

    pub(crate) async fn fake_notion(state: FakeNotion) -> (FakeServer, Arc<Mutex<FakeNotion>>) {
        let state = Arc::new(Mutex::new(state));
        let shared = Arc::clone(&state);
        let server = FakeServer::start(move |request| shared.lock().unwrap().answer(request)).await;
        (server, state)
    }

    pub(crate) fn settings_for(server: &FakeServer) -> NotionSettings {
        NotionSettings {
            base_url: server.base.clone(),
            min_interval: Duration::ZERO,
            retry: RetryPolicy {
                retries: 3,
                retry_delay_ms: 1,
                rate_limit_delay_ms: 1,
                ..RetryPolicy::default()
            },
            failed_mark_wait: Duration::from_millis(1),
            ..NotionSettings::default()
        }
    }

    /// A 의 담당자 줄: 노션 사용자 user-1, "확인됨"은 `confirmed`.
    fn person_a(confirmed: bool) -> FakePage {
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
            json!({ "checkbox": confirmed }),
        );
        FakePage {
            id: "person-a".into(),
            data_source: PEOPLE_DATA_SOURCE_ID.into(),
            created_time: "2026-10-01T00:00:00.000Z".into(),
            last_edited_time: "2026-10-01T00:00:00.000Z".into(),
            properties,
            children: Vec::new(),
            in_trash: false,
        }
    }

    /// `pubkey` 의 담당자 줄(이름 칸 `name`, 확인됨, 노션 사용자 user-1).
    fn person_row(id: &str, pubkey: &str, name: &str) -> FakePage {
        let mut row = person_a(true);
        row.id = id.into();
        row.properties.insert(
            people_property::NAME.into(),
            as_response(json!({ "title": text_runs(name, None) })),
        );
        row.properties.insert(
            people_property::PUBKEY.into(),
            as_response(json!({ "rich_text": text_runs(pubkey, None) })),
        );
        row
    }

    /// A 는 "김,지영"(쉼표는 다듬어진다), B 는 "민수" 인 프로필 이름표.
    fn profile_names() -> crate::profiles::ProfileNames {
        let found = HashMap::from([
            (A.to_string(), "김,지영".to_string()),
            (B.to_string(), "민수".to_string()),
        ]);
        crate::profiles::ProfileNames::new(&[A, B], &found, None)
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
                    text: "고객사에 견적서 보내기".into(),
                    assignee_pubkey: Some(A.into()),
                    assignee_quote: Some("제가 보낼게요".into()),
                    due: Some("2026-10-16".into()),
                    due_quote: Some("금요일까지".into()),
                    status: ItemStatus::Firm,
                    evidence_start_ms: Some(65_000),
                },
                ActionItem {
                    text: "서버 비용 알아보기".into(),
                    assignee_pubkey: Some(B.into()),
                    assignee_quote: None,
                    due: None,
                    due_quote: Some("다음 주까지".into()),
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
            script_sha256: String::new(),
            corrected_sha256: String::new(),
        }
    }

    fn page<'a>(transcript: &'a Transcript, summary: &'a Summary) -> MeetingPage<'a> {
        MeetingPage {
            transcript,
            corrected: None,
            summary: Some(summary),
            summary_note: None,
            names: &PubkeyPrefixNames,
            title_prefix: "[시험] ",
            channel_label: None,
            kind: Some(MeetingKind::Channel),
            status: ProcessingStatus::Done,
            tail: &[],
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

    pub(crate) fn minutes_pages(state: &FakeNotion) -> Vec<&FakePage> {
        state
            .pages
            .iter()
            .filter(|page| page.data_source == MINUTES_DATA_SOURCE_ID && !page.in_trash)
            .collect()
    }

    async fn run(
        client: &mut NotionClient<'_>,
        page: &MeetingPage<'_>,
    ) -> Result<PublishReport, NotionError> {
        let mut report = PublishReport::default();
        publish(client, page, None, &mut report)
            .await
            .map(|()| report)
    }

    /// 한 번 게시해 두고 그 서버·상태를 돌려준다.
    async fn published(state: FakeNotion) -> (FakeServer, Arc<Mutex<FakeNotion>>, PublishReport) {
        let (server, state) = fake_notion(state).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let report = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        (server, state, report)
    }

    fn silent(request: &Recorded) -> bool {
        request.json()["notifications"]["mode"] == "silent"
    }

    fn is_write(request: &Recorded) -> bool {
        (request.method == "PATCH" || request.method == "POST") && !request.path.ends_with("/query")
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
            blocks(
                "paragraph",
                text_runs(&"나".repeat(2_000 * 250), None),
                false
            )
            .len(),
            3
        );
    }

    #[test]
    fn blocks_are_chunked_by_count_and_size() {
        let small: Vec<Value> = (0..250).map(|_| heading("x")).collect();
        let sizes: Vec<usize> = chunk_blocks(small).iter().map(Vec::len).collect();
        assert_eq!(sizes, [100, 100, 50]);
        // 블록 하나가 큰 경우(조각 100개 × 2000자)는 크기로도 자른다.
        let big = blocks(
            "paragraph",
            text_runs(&"나".repeat(2_000 * 100), None),
            false,
        );
        let many: Vec<Value> = std::iter::repeat_n(big[0].clone(), 5).collect();
        for chunk in chunk_blocks(many) {
            let bytes: usize = chunk.iter().map(|block| block.to_string().len()).sum();
            assert!(bytes <= MAX_REQUEST_BYTES || chunk.len() == 1);
        }
    }

    #[test]
    fn body_has_sections_in_order_with_checked_quotes_and_mentions() {
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let people = HashMap::from([(A.to_string(), "user-1".to_string())]);
        let body = body_blocks(
            &page(&transcript, &summary),
            &people,
            DEFAULT_PLAYBACK_LINK,
            &HashSet::new(),
        );
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
        // 검사를 통과한 근거 글은 따옴표로.
        let first_text = block_text(todos[0]);
        assert!(first_text.contains("(“제가 보낼게요”)"), "{first_text}");
        assert!(first_text.contains("@ (“금요일까지”)"), "{first_text}");
        // 연결 안 된 사람은 이름 글자로, 날짜를 못 읽은 기한 말은 그 말만, 애매 표시.
        let second = block_text(todos[1]);
        assert!(
            second.contains("담당: bbbbbbbb · 기한: (“다음 주까지”)"),
            "{second}"
        );
        assert!(second.ends_with(" · 애매"), "{second}");
        // 기본 buzz:// 모양은 노션 본문이 안 받아서 링크 없이 글로만.
        let last = body.last().unwrap();
        assert_eq!(
            block_text(last),
            "[01:05] bbbbbbbb: 네, 제가 금요일까지 보낼게요."
        );
        assert!(!body
            .iter()
            .any(|block| block.to_string().contains("\"link\"")));
        // https 모양이면 시각마다 재생 링크를 걸고, 체크돼 있던 할 일은 체크한 채로.
        let https = "https://buzz.example.com/huddle/{channel_id}?t={start_ms}";
        let checked = HashSet::from([todo_key("고객사에 견적서 보내기")]);
        let body = body_blocks(&page(&transcript, &summary), &people, https, &checked);
        assert_eq!(
            body.last().unwrap()["paragraph"]["rich_text"][0]["text"]["link"]["url"],
            "https://buzz.example.com/huddle/00000000-0000-0000-0000-000000000002?t=65000"
        );
        let checks: Vec<bool> = body
            .iter()
            .filter(|block| block["type"] == "to_do")
            .map(|block| block["to_do"]["checked"] == true)
            .collect();
        assert_eq!(checks, [true, false]);
        assert!(validate_blocks(&body).is_ok());
    }

    #[test]
    fn blocks_notion_would_refuse_are_caught_before_writing() {
        let too_many = json!({ "type": "paragraph", "paragraph": {
            "rich_text": vec![json!({ "type": "text", "text": { "content": "x" } }); 101]
        } });
        let too_long = json!({ "type": "paragraph", "paragraph": {
            "rich_text": [{ "type": "text", "text": { "content": "가".repeat(2_001) } }]
        } });
        let buzz_link = json!({ "type": "paragraph", "paragraph": {
            "rich_text": [{ "type": "text", "text": { "content": "[00:01]",
                "link": { "url": "buzz://huddle/x?t=1" } } }]
        } });
        for block in [too_many, too_long, buzz_link] {
            let error = validate_blocks(&[heading("ok"), block]).unwrap_err();
            assert_eq!(error.kind, NotionErrorKind::BadRequest);
            assert!(error.code.starts_with("block 1:"), "{}", error.code);
        }
    }

    #[test]
    fn huddle_key_lists_every_session_and_app_link_keeps_buzz() {
        let mut transcript = meeting();
        assert_eq!(
            huddle_key(&transcript),
            "00000000-0000-0000-0000-000000000002:00000000-0000-0000-0000-000000000003,00000000-0000-0000-0000-000000000004"
        );
        let (channel, sessions) = parse_huddle_key(&huddle_key(&transcript)).unwrap();
        assert_eq!(channel, transcript.channel_id);
        assert_eq!(sessions, transcript.session_ids);
        transcript.session_ids.clear();
        let summary = summary_of(&meeting());
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

    #[tokio::test]
    async fn first_publish_creates_page_and_missing_people_rows() {
        let (server, state, report) = published(FakeNotion {
            pages: vec![person_a(true)],
            ..FakeNotion::default()
        })
        .await;
        assert!(report.created);
        assert_eq!(report.people_linked, 1);
        assert_eq!(report.people_rows_added.len(), 1);
        assert_eq!(report.deleted_old_blocks, 0);

        let state = state.lock().unwrap();
        let minutes = minutes_pages(&state);
        assert_eq!(minutes.len(), 1);
        let props = &minutes[0].properties;
        assert_eq!(
            property_text(&props[minutes_property::HUDDLE_ID]),
            huddle_key(&meeting())
        );
        assert_eq!(
            property_text(&props[minutes_property::TITLE]),
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
        assert_eq!(property_text(&added.properties[people_property::PUBKEY]), B);

        // 요청 모양: 버전·토큰 헤더, data source 부모, 처음 만들 때는 기본 알림.
        let requests = server.requests();
        assert!(requests
            .iter()
            .all(|r| r.header("notion-version") == Some(NOTION_VERSION)));
        assert!(requests
            .iter()
            .all(|r| r.header("authorization") == Some("Bearer t")));
        let create = requests
            .iter()
            .find(|r| r.method == "POST" && r.path == "/v1/pages")
            .unwrap();
        assert_eq!(create.json()["parent"]["type"], "data_source_id");
        assert!(!requests.iter().filter(|r| is_write(r)).any(silent));
    }

    #[tokio::test]
    async fn only_confirmed_people_are_mentioned() {
        for confirmed in [false, true] {
            let (_server, state, report) = published(FakeNotion {
                pages: vec![person_a(confirmed)],
                ..FakeNotion::default()
            })
            .await;
            assert_eq!(report.people_linked, usize::from(confirmed));
            let state = state.lock().unwrap();
            let body = &minutes_pages(&state)[0].children;
            let mentioned = body
                .iter()
                .any(|block| block.to_string().contains("\"user\":{\"id\":\"user-1\"}"));
            assert_eq!(mentioned, confirmed);
        }
    }

    #[tokio::test]
    async fn existing_people_rows_are_never_touched() {
        let (server, state, _) = published(FakeNotion {
            pages: vec![person_a(true)],
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
        assert_eq!(seeded.properties, person_a(true).properties);
    }

    #[tokio::test]
    async fn republish_is_silent_keeps_the_page_and_swaps_the_body_safely() {
        let (server, state, first) = published(FakeNotion::default()).await;
        let before = server.requests().len();
        let old_blocks = state
            .lock()
            .unwrap()
            .pages
            .iter()
            .find(|p| p.id == first.page_id)
            .unwrap()
            .children
            .len();
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let mut summary = summary_of(&transcript);
        summary.title = "고친 제목".into();
        summary.action_items.truncate(1);
        let second = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        assert!(!second.created);
        assert_eq!(second.page_id, first.page_id);
        assert_eq!(second.deleted_old_blocks, old_blocks);

        let requests = server.requests()[before..].to_vec();
        // 다시 게시할 때는 쓰기마다 조용히.
        let writes: Vec<&Recorded> = requests.iter().filter(|r| is_write(r)).collect();
        assert!(!writes.is_empty());
        assert!(writes.iter().all(|r| silent(r)), "every rewrite is silent");
        // 새 본문을 다 붙인 뒤에야 옛 블록을 지운다.
        let last_append = requests
            .iter()
            .rposition(|r| r.method == "PATCH" && r.path.ends_with("/children"))
            .unwrap();
        let first_delete = requests.iter().position(|r| r.method == "DELETE").unwrap();
        assert!(last_append < first_delete);

        let state = state.lock().unwrap();
        let minutes = minutes_pages(&state);
        assert_eq!(minutes.len(), 1);
        assert_eq!(
            property_text(&minutes[0].properties[minutes_property::TITLE]),
            "[시험] 고친 제목"
        );
        // 본문은 새 것만 남는다.
        assert_eq!(minutes[0].children.len(), second.blocks);
        let todos = minutes[0]
            .children
            .iter()
            .filter(|block| block["type"] == "to_do")
            .count();
        assert_eq!(todos, 1);
    }

    #[tokio::test]
    async fn checked_todos_stay_checked_on_republish() {
        let (server, state, first) = published(FakeNotion::default()).await;
        {
            let mut state = state.lock().unwrap();
            let page = state.page_mut(&first.page_id).unwrap();
            let todo = page
                .children
                .iter_mut()
                .find(|block| block["type"] == "to_do")
                .unwrap();
            todo["to_do"]["checked"] = Value::Bool(true);
        }
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let second = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        assert_eq!(second.kept_checked, 1);
        let state = state.lock().unwrap();
        let checks: Vec<bool> = minutes_pages(&state)[0]
            .children
            .iter()
            .filter(|block| block["type"] == "to_do")
            .map(|block| block["to_do"]["checked"] == true)
            .collect();
        assert_eq!(checks, [true, false]);
    }

    #[tokio::test]
    async fn an_earlier_session_arriving_late_finds_the_same_page() {
        let (server, state, first) = published(FakeNotion::default()).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        // 늦게 올라온 앞 세션 때문에 첫 세션이 바뀌었다.
        let mut transcript = meeting();
        transcript.session_ids.insert(0, Uuid::from_u128(1));
        let summary = summary_of(&transcript);
        let second = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        assert!(!second.created);
        assert_eq!(second.page_id, first.page_id);
        let state = state.lock().unwrap();
        let minutes = minutes_pages(&state);
        assert_eq!(minutes.len(), 1);
        assert_eq!(
            property_text(&minutes[0].properties[minutes_property::HUDDLE_ID]),
            huddle_key(&transcript)
        );
    }

    #[tokio::test]
    async fn a_503_that_saved_the_page_does_not_make_a_second_one() {
        let (server, state, report) = published(FakeNotion {
            commit_then_503: true,
            ..FakeNotion::default()
        })
        .await;
        let state = state.lock().unwrap();
        let minutes = minutes_pages(&state);
        assert_eq!(minutes.len(), 1);
        assert_eq!(minutes[0].id, report.page_id);
        assert_eq!(minutes[0].children.len(), report.blocks);
        // 노션이 알려 준 id 를 바로 썼다: 만들기 전·후 한 번씩만 찾았다
        // (다시 찾아 확인하는 길로 가면 한 번 더 찾는다).
        let minutes_queries = server
            .requests()
            .iter()
            .filter(|r| r.path == format!("/v1/data_sources/{MINUTES_DATA_SOURCE_ID}/query"))
            .count();
        assert_eq!(minutes_queries, 2);
    }

    #[tokio::test]
    async fn a_cut_off_create_answer_is_checked_before_creating_again() {
        let (_server, state, report) = published(FakeNotion {
            cut_off_create: true,
            ..FakeNotion::default()
        })
        .await;
        let state = state.lock().unwrap();
        let minutes = minutes_pages(&state);
        assert_eq!(minutes.len(), 1);
        assert_eq!(minutes[0].id, report.page_id);
    }

    #[tokio::test]
    async fn a_racing_duplicate_is_trashed_and_the_earlier_page_kept() {
        let (_server, state, report) = published(FakeNotion {
            race_create: true,
            ..FakeNotion::default()
        })
        .await;
        let state = state.lock().unwrap();
        let minutes = minutes_pages(&state);
        assert_eq!(minutes.len(), 1, "one live meeting page");
        // 먼저 만들어진(다른 작업기의) 페이지를 남기고 내 것을 버렸다.
        assert_eq!(report.page_id, minutes[0].id);
        assert_eq!(report.trashed_duplicates.len(), 1);
        assert_ne!(report.trashed_duplicates[0], report.page_id);
        assert!(!report.created);
        assert_eq!(minutes[0].children.len(), report.blocks);
    }

    #[tokio::test]
    async fn rate_limited_appends_restart_the_body_without_doubling_it() {
        let limited =
            || Reply::json(429, &json!({ "code": "rate_limited" })).with_header("retry-after", "0");
        let (_server, state, report) = published(FakeNotion {
            // 한 요청의 다시 하기(3번)를 다 쓰도록 4번 연달아.
            append_failures: (0..4).map(|_| limited()).collect(),
            ..FakeNotion::default()
        })
        .await;
        assert_eq!(report.body_attempts, 2);
        let state = state.lock().unwrap();
        assert_eq!(minutes_pages(&state)[0].children.len(), report.blocks);
    }

    #[tokio::test]
    async fn failed_body_marks_the_page_failed_after_retrying_the_mark() {
        let refused = || {
            Reply::json(
                400,
                &json!({ "code": "validation_error", "message": "refused" }),
            )
        };
        // "실패" 표시가 두 번 막혔다가 세 번째에 된다.
        let (server, state) = fake_notion(FakeNotion {
            append_failures: vec![refused()],
            page_patch_failures: vec![refused(), refused()],
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let mut report = PublishReport::default();
        let error = publish(&mut client, &page(&transcript, &summary), None, &mut report)
            .await
            .unwrap_err();
        assert_eq!(error.kind, NotionErrorKind::BadRequest);
        assert!(!report.stuck_in_progress);
        {
            let state = state.lock().unwrap();
            let minutes = minutes_pages(&state);
            assert_eq!(
                minutes[0].properties[minutes_property::STATUS]["select"]["name"],
                "실패"
            );
            // 실패해도 만든 페이지와 줄의 id 는 알려 준다.
            assert_eq!(report.page_id, minutes[0].id);
            assert_eq!(report.people_rows_added.len(), 2);
        }

        // 끝내 "실패" 표시를 못 하면 처리 중으로 남았다고 알린다.
        let (server, _state) = fake_notion(FakeNotion {
            append_failures: vec![refused()],
            page_patch_failures: (0..FAILED_MARK_ATTEMPTS).map(|_| refused()).collect(),
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let mut report = PublishReport::default();
        publish(&mut client, &page(&transcript, &summary), None, &mut report)
            .await
            .unwrap_err();
        assert!(report.stuck_in_progress);
    }

    #[tokio::test]
    async fn refused_people_db_does_not_block_the_minutes() {
        let (_server, state, report) = published(FakeNotion {
            people_forbidden: true,
            ..FakeNotion::default()
        })
        .await;
        // 작업기 로그에 찍히니 종류·상태·코드만(노션 메시지는 없다).
        assert_eq!(
            report.people_error.as_deref(),
            Some("permission HTTP 403 restricted_resource")
        );
        assert_eq!(report.people_linked, 0);
        let state = state.lock().unwrap();
        assert_eq!(
            minutes_pages(&state)[0].properties[minutes_property::STATUS]["select"]["name"],
            "완료"
        );
    }

    /// 프로필 이름표로 쓰면 "참석자" 칸, 스크립트 줄, 연결 안 된 담당자 글, 새 담당자 줄
    /// 이름 칸에 프로필 이름이 들어간다(쉼표는 다듬어서).
    #[tokio::test]
    async fn profile_names_fill_attendees_lines_and_new_people_rows() {
        let names = profile_names();
        let (server, state) = fake_notion(FakeNotion::default()).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let mut shown = page(&transcript, &summary);
        shown.names = &names;
        let report = run(&mut client, &shown).await.unwrap();
        assert_eq!(report.people_rows_added.len(), 2);
        assert!(report.people_rows_renamed.is_empty());

        let state = state.lock().unwrap();
        let minutes = minutes_pages(&state);
        assert_eq!(
            minutes[0].properties[minutes_property::PARTICIPANTS]["multi_select"],
            json!([{ "name": "김 지영" }, { "name": "민수" }])
        );
        let body = &minutes[0].children;
        assert_eq!(
            block_text(body.last().unwrap()),
            "[01:05] 민수: 네, 제가 금요일까지 보낼게요."
        );
        let todos: Vec<String> = body
            .iter()
            .filter(|block| block["type"] == "to_do")
            .map(block_text)
            .collect();
        assert!(todos[0].contains("담당: 김 지영 ("), "{}", todos[0]);
        assert!(todos[1].contains("담당: 민수 · 기한"), "{}", todos[1]);
        let rows: Vec<String> = state
            .pages
            .iter()
            .filter(|page| page.data_source == PEOPLE_DATA_SOURCE_ID)
            .map(|page| property_text(&page.properties[people_property::NAME]))
            .collect();
        assert_eq!(rows, ["김 지영", "민수"]);
    }

    /// 있는 담당자 줄: 이름 칸이 pubkey 앞 8자 그대로(작업기가 넣은 그대로)면 프로필
    /// 이름으로 조용히 고치고, 사람이 고친 이름과 다른 칸은 그대로 둔다. 앞 8자 이름표로
    /// 쓸 때는 아무것도 안 고친다.
    #[tokio::test]
    async fn only_prefix_named_people_rows_get_the_profile_name() {
        let rows = || {
            vec![
                person_row("person-a", A, "aaaaaaaa"),
                person_row("person-b", B, "사람이 고친 이름"),
            ]
        };
        let names = profile_names();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let http = reqwest::Client::new();

        // 앞 8자 이름표: 프로필 이름을 모르니 고칠 것이 없다.
        let (server, _state) = fake_notion(FakeNotion {
            pages: rows(),
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let report = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        assert!(report.people_rows_renamed.is_empty());
        assert!(!server.requests().iter().any(|r| r.path.contains("person-")));

        // 프로필 이름표: A 의 줄만 고친다.
        let (server, state) = fake_notion(FakeNotion {
            pages: rows(),
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let mut shown = page(&transcript, &summary);
        shown.names = &names;
        let report = run(&mut client, &shown).await.unwrap();
        assert_eq!(report.people_rows_renamed, ["person-a"]);
        assert_eq!(report.people_rename_failed, 0);
        assert!(report.people_rows_added.is_empty());
        assert_eq!(report.people_linked, 2);
        let touched: Vec<Recorded> = server
            .requests()
            .into_iter()
            .filter(|r| r.path.contains("person-"))
            .collect();
        assert_eq!(touched.len(), 1);
        assert_eq!(
            (touched[0].method.as_str(), touched[0].path.as_str()),
            ("PATCH", "/v1/pages/person-a")
        );
        assert!(silent(&touched[0]));
        let changed: Vec<String> = touched[0].json()["properties"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(changed, [people_property::NAME]);
        {
            let state = state.lock().unwrap();
            let row = |id: &str| state.pages.iter().find(|page| page.id == id).unwrap();
            assert_eq!(
                property_text(&row("person-a").properties[people_property::NAME]),
                "김 지영"
            );
            let mut kept = person_row("person-a", A, "aaaaaaaa").properties;
            kept.remove(people_property::NAME);
            for (key, value) in kept {
                assert_eq!(row("person-a").properties[&key], value, "{key}");
            }
            assert_eq!(
                row("person-b").properties,
                person_row("person-b", B, "사람이 고친 이름").properties
            );
        }

        // 고친 뒤에는 앞 8자가 아니니 다시 고치지 않는다.
        let before = server.requests().len();
        run(&mut client, &shown).await.unwrap();
        assert!(!server.requests()[before..]
            .iter()
            .any(|r| r.path.contains("person-")));
    }

    /// 남의 가른 이름을 제 이름으로 쓴 사람이 있어도 "참석자" 칸에서 아무도 빠지지 않는다
    /// (multi_select 는 같은 이름을 하나로 친다).
    #[test]
    fn attendees_keep_everyone_when_a_name_copies_a_split_name() {
        const C: &str = "cccccccc00000000000000000000000000000000000000000000000000000003";
        let transcript = transcript_with(&[
            (1_000, A, "견적서 얘기해요."),
            (2_000, B, "네."),
            (3_000, C, "좋아요."),
        ]);
        let found = HashMap::from([
            (A.to_string(), "민수".to_string()),
            (B.to_string(), "민수 (aaaaaaaa)".to_string()),
            (C.to_string(), "민수".to_string()),
        ]);
        let names = crate::profiles::ProfileNames::new(&[A, B, C], &found, None);
        let summary = summary_of(&transcript);
        let mut shown = page(&transcript, &summary);
        shown.names = &names;
        let properties = page_properties(&shown, ProcessingStatus::Done, DEFAULT_PLAYBACK_LINK);
        assert_eq!(
            properties[minutes_property::PARTICIPANTS]["multi_select"],
            json!([
                { "name": "aaaaaaaa" },
                { "name": "bbbbbbbb" },
                { "name": "민수 (cccccccc)" }
            ])
        );
    }

    /// 이름 고치기가 막혀도(고치기 권한 없음) 멘션과 회의록은 그대로고, 수만 센다.
    #[tokio::test]
    async fn a_refused_rename_keeps_the_mention_and_the_minutes() {
        let (server, state) = fake_notion(FakeNotion {
            pages: vec![person_row("person-a", A, "aaaaaaaa")],
            page_patch_failures: vec![Reply::json(403, &json!({ "code": "restricted_resource" }))],
            ..FakeNotion::default()
        })
        .await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let names = profile_names();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let mut shown = page(&transcript, &summary);
        shown.names = &names;
        let report = run(&mut client, &shown).await.unwrap();
        assert_eq!(report.people_rename_failed, 1);
        assert!(report.people_rows_renamed.is_empty());
        assert!(report.people_error.is_none());
        assert_eq!(report.people_linked, 1);
        let state = state.lock().unwrap();
        let minutes = minutes_pages(&state);
        assert_eq!(
            minutes[0].properties[minutes_property::STATUS]["select"]["name"],
            "완료"
        );
        assert!(minutes[0]
            .children
            .iter()
            .any(|block| block.to_string().contains("\"user\":{\"id\":\"user-1\"}")));
        let row = state
            .pages
            .iter()
            .find(|page| page.id == "person-a")
            .unwrap();
        assert_eq!(
            property_text(&row.properties[people_property::NAME]),
            "aaaaaaaa"
        );
    }

    /// `channel` 의 회의 하나(첫 세션 3)를 시험용 녹음 폴더에 두고 계획을 세운다.
    /// Notion attendees are people known by pubkey: a room speaker's label
    /// and a line nobody can place are no one to mention; a line is shown
    /// under its label, never under the room device's owner.
    #[test]
    fn room_speakers_are_named_by_label_and_never_mentioned() {
        const A: &str = "aaaaaaaa00000000000000000000000000000000000000000000000000000001";
        const D: &str = "dddddddd00000000000000000000000000000000000000000000000000000004";
        let mut transcript = crate::test_http::transcript_with(&[(1_000, A, "안녕하세요.")]);
        let mut room = crate::transcript::Segment::own(D.into(), 2_000, 3_000, "네.".into());
        room.speaker = None;
        room.speaker_confidence = None;
        room.speaker_label = Some("회의실 화자 1".into());
        let mut unplaced = room.clone();
        unplaced.speaker_label = Some(crate::transcript::UNPLACED_ROOM_SPEAKER.into());
        transcript.segments.extend([room.clone(), unplaced.clone()]);
        // The room device's owner, none of whose speech was heard, is left
        // out; someone who joined and said nothing on their own device stays.
        const E: &str = "eeeeeeee00000000000000000000000000000000000000000000000000000005";
        for pubkey in [D, E] {
            transcript
                .participants
                .push(crate::transcript::Participant {
                    pubkey: pubkey.into(),
                    speech_ms: 0,
                });
        }
        assert_eq!(attendee_pubkeys(&transcript), vec![A, E]);
        let names = crate::summary::PubkeyPrefixNames;
        assert_eq!(line_name(&room, &names), "회의실 화자 1");
        assert_eq!(line_name(&unplaced, &names), "회의실 화자 ?");
        assert_ne!(line_name(&room, &names), names.display_name(D));
    }

    pub(crate) async fn plan_for(dir: &std::path::Path) -> MeetingPlan {
        plan_in(dir, Uuid::from_u128(2), Uuid::from_u128(3)).await
    }

    /// 커뮤니티 1 의 `channel` 에 `session` 하나뿐인 회의를 두고 계획을 세운다.
    pub(crate) async fn plan_in(
        dir: &std::path::Path,
        channel: Uuid,
        session: Uuid,
    ) -> MeetingPlan {
        use crate::store::{LocalStore, RecordingStore};
        use buzz_huddle_recording::{chunk_key, ChunkHeader, Record};
        let store = LocalStore::new(dir);
        let community = Uuid::from_u128(1);
        let mut bytes = ChunkHeader {
            protocol_version: 2,
            session_id: session,
            chunk_seq: 0,
            session_start_unix_ms: 1_791_781_200_000,
        }
        .encode()
        .to_vec();
        Record::Join {
            t_ms: 0,
            peer_index: 0,
            epoch: 1,
            pubkey: [7; 32],
        }
        .encode_into(&mut bytes)
        .unwrap();
        store
            .put(&chunk_key("h", community, channel, session, 0), bytes)
            .await
            .unwrap();
        crate::collect::plan_meetings(&store, "h", community, channel, 10 * 60_000)
            .await
            .unwrap()
            .meetings
            .remove(0)
    }

    #[tokio::test]
    async fn the_record_keeps_the_page_id_for_next_time() {
        let recordings = tempfile::tempdir().unwrap();
        let minutes_dir = tempfile::tempdir().unwrap();
        let meeting_plan = plan_for(recordings.path()).await;
        let home = LocalMinutes::open(minutes_dir.path()).unwrap();
        let (server, state) = fake_notion(FakeNotion::default()).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        let mut first = PublishReport::default();
        assert!(publish_meeting(
            &home,
            &meeting_plan,
            &mut client,
            &page(&transcript, &summary),
            &mut first
        )
        .await
        .unwrap());
        let record: NotionRecord = serde_json::from_slice(
            &std::fs::read(home.notion_record_path(Uuid::from_u128(3))).unwrap(),
        )
        .unwrap();
        assert_eq!(record.page_id, first.page_id);

        // 다음엔 기록된 id 부터: 회의 페이지를 찾는 query 없이 그 페이지를 읽는다.
        let before = server.requests().len();
        let mut second = PublishReport::default();
        publish_meeting(
            &home,
            &meeting_plan,
            &mut client,
            &page(&transcript, &summary),
            &mut second,
        )
        .await
        .unwrap();
        let requests = server.requests()[before..].to_vec();
        assert!(requests
            .iter()
            .any(|r| r.method == "GET" && r.path == format!("/v1/pages/{}", first.page_id)));
        let minutes_queries = requests
            .iter()
            .filter(|r| r.path == format!("/v1/data_sources/{MINUTES_DATA_SOURCE_ID}/query"))
            .count();
        assert_eq!(minutes_queries, 0);
        assert_eq!(second.page_id, first.page_id);

        // 기록된 페이지가 휴지통에 있으면 세션으로 다시 찾는다(없으니 새로 만든다).
        state
            .lock()
            .unwrap()
            .page_mut(&first.page_id)
            .unwrap()
            .in_trash = true;
        let mut third = PublishReport::default();
        publish_meeting(
            &home,
            &meeting_plan,
            &mut client,
            &page(&transcript, &summary),
            &mut third,
        )
        .await
        .unwrap();
        assert!(third.created);
        assert_ne!(third.page_id, first.page_id);
    }

    #[tokio::test]
    async fn the_record_sits_beside_the_script_in_the_minutes_bucket() {
        use buzz_gcp::fake::FakeGcs;
        use buzz_gcp::gcs::Gcs;
        use buzz_gcp::token::{AccessToken, TokenSource, Tokens};

        use crate::gcs_minutes::GcsMinutes;

        let recordings = tempfile::tempdir().unwrap();
        let meeting_plan = plan_for(recordings.path()).await;
        let fake = FakeGcs::start(3_600).await;
        fake.accept_token("t");
        let tokens = Tokens::new(TokenSource::Static(AccessToken::new("t"))).unwrap();
        let gcs = Arc::new(Gcs::with_base_url(tokens, fake.url()).unwrap());
        let home = GcsMinutes::new(gcs, "minutes");
        assert_eq!(home.read_notion_record(&meeting_plan).await.unwrap(), None);

        let script = serde_json::to_vec(&meeting()).unwrap();
        home.write_script(&meeting_plan, script, false)
            .await
            .unwrap();
        let record = br#"{"page_id":"p"}"#.to_vec();
        home.write_notion_record(&meeting_plan, record.clone())
            .await
            .unwrap();
        assert_eq!(
            home.read_notion_record(&meeting_plan).await.unwrap(),
            Some(record)
        );
        let names: Vec<String> = fake.objects("minutes").into_keys().collect();
        assert!(names.contains(&GcsMinutes::notion_record_key(&meeting_plan)));
        assert!(GcsMinutes::notion_record_key(&meeting_plan)
            .ends_with("/00000000-0000-0000-0000-000000000003.notion.json"));
        // 기록은 스크립트가 아니다: `{uuid}.json` 꼴만 스크립트로 읽는다.
        let scripts = home.scripts(&meeting_plan).await.unwrap();
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].session_ids, meeting().session_ids);
    }

    #[tokio::test]
    async fn a_held_meeting_is_left_for_the_next_run() {
        let recordings = tempfile::tempdir().unwrap();
        let minutes_dir = tempfile::tempdir().unwrap();
        let meeting_plan = plan_for(recordings.path()).await;
        let home = LocalMinutes::open(minutes_dir.path()).unwrap();
        let (server, _state) = fake_notion(FakeNotion::default()).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let transcript = meeting();
        let summary = summary_of(&transcript);
        // 다른 작업기(여기서는 같은 시험)가 이 회의를 잡고 있다.
        let other = LocalMinutes::open(minutes_dir.path()).unwrap();
        let hold = other.hold(&meeting_plan).await.unwrap().expect("hold");
        let mut report = PublishReport::default();
        let done = publish_meeting(
            &home,
            &meeting_plan,
            &mut client,
            &page(&transcript, &summary),
            &mut report,
        )
        .await
        .unwrap();
        assert!(!done);
        assert!(server.requests().is_empty());
        other.release(hold).await.unwrap();
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
        let (server, shared) = fake_notion(FakeNotion::default()).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let report = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        // 요약 2 + 결정 2 + 할 일 2 + 주제 2 + 스크립트 머리 1 + 줄 451
        assert_eq!(report.blocks, 460);
        assert_eq!(report.append_requests, 5);
        {
            let state = shared.lock().unwrap();
            let written = minutes_pages(&state)[0];
            assert_eq!(written.children.len(), 460);
            let last = written.children.last().unwrap();
            assert_eq!(last["paragraph"]["rich_text"].as_array().unwrap().len(), 4);
            assert!(block_text(last).starts_with("[60:00] aaaaaaaa: 가"));
        }

        // 다시 쓰면 옛 블록 460개를 다 지우고(목록은 100개씩 넘겨 읽는다) 새 것만 남는다.
        let report = run(&mut client, &page(&transcript, &summary))
            .await
            .unwrap();
        assert_eq!(report.deleted_old_blocks, 460);
        let state = shared.lock().unwrap();
        assert_eq!(minutes_pages(&state)[0].children.len(), 460);
    }

    #[tokio::test]
    async fn rate_limit_waits_for_retry_after() {
        let (server, _state) = fake_notion(FakeNotion {
            queued: vec![Reply::json(429, &json!({ "code": "rate_limited" }))
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
    async fn stale_pages_are_found_and_errors_are_classified() {
        let mut state = FakeNotion::default();
        for (status, edited) in [
            ("처리 중", "2026-10-12T05:00:00.000Z"),
            ("처리 중", "2026-10-12T09:30:00.000Z"),
            ("완료", "2026-10-12T05:00:00.000Z"),
        ] {
            let id = state.new_page(
                MINUTES_DATA_SOURCE_ID,
                &json!({
                    minutes_property::STATUS: { "select": { "name": status } },
                    minutes_property::HUDDLE_ID: { "rich_text": text_runs("c:s", None) }
                }),
            );
            state.page_mut(&id).unwrap().last_edited_time = edited.into();
        }
        let (server, _state) = fake_notion(state).await;
        let settings = settings_for(&server);
        let http = reqwest::Client::new();
        let mut client = NotionClient::new(&http, &settings, "t").unwrap();
        let now = DateTime::parse_from_rfc3339("2026-10-12T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let stale = find_stale(&mut client, Duration::from_secs(3_600), now)
            .await
            .unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].page_id, "page-1");
        assert_eq!(stale[0].huddle_key, "c:s");

        for (status, kind) in [
            (401, NotionErrorKind::Auth),
            (403, NotionErrorKind::Permission),
            (404, NotionErrorKind::NotFound),
            (400, NotionErrorKind::BadRequest),
        ] {
            let (server, _state) = fake_notion(FakeNotion {
                queued: vec![Reply::json(status, &json!({ "code": "x", "message": "m" }))],
                ..FakeNotion::default()
            })
            .await;
            let settings = settings_for(&server);
            let mut client = NotionClient::new(&http, &settings, "secret-notion-token").unwrap();
            let error = find_stale(&mut client, Duration::from_secs(60), now)
                .await
                .unwrap_err();
            assert_eq!(error.kind, kind);
            assert_eq!(server.requests().len(), 1);
            assert!(!format!("{error} {error:?}").contains("secret-notion-token"));
        }
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

    #[test]
    fn corrected_lines_show_the_fix_and_the_original_word_in_place() {
        let transcript = transcript_with(&[
            (0, A, "허드 회의록은 오션에 올려 주세요"),
            (5_000, B, "네 지금 올릴게요"),
            (9_000, A, "그대로인 줄"),
        ]);
        let edit = |from: &str, to: &str, level: &str| json!({ "from": from, "to": to, "level": level, "why": "" });
        let answer = json!({ "lines": [
            { "id": "L000", "edits": [edit("오션에", "노션에", "확정"), edit("허드", "허들", "애매")] },
            { "id": "L001", "edits": [edit("올릴게요", "올릴께요", "애매")] }
        ] });
        let corrected = correct::check_answer(&answer.to_string(), &transcript).unwrap();
        let summary = summary_of(&transcript);
        let mut page = page(&transcript, &summary);
        page.corrected = Some(&corrected);
        let body = body_blocks(
            &page,
            &HashMap::new(),
            DEFAULT_PLAYBACK_LINK,
            &HashSet::new(),
        );
        validate_blocks(&body).unwrap();
        let at = body
            .iter()
            .position(|block| block["type"] == "heading_2" && block_text(block) == "전체 스크립트")
            .unwrap();
        let script = &body[at + 1..];
        // One paragraph per line, as without the correction.
        assert_eq!(script.len(), 3);
        assert!(script.iter().all(|block| block["type"] == "paragraph"));
        assert_eq!(
            block_text(&script[0]),
            "[00:00] aaaaaaaa: 허드(혹시 허들?) 회의록은 노션에(원래: 오션에) 올려 주세요"
        );
        assert_eq!(
            block_text(&script[1]),
            "[00:05] bbbbbbbb: 네 지금 올릴게요(혹시 올릴께요?)"
        );
        assert_eq!(block_text(&script[2]), "[00:09] aaaaaaaa: 그대로인 줄");

        // Without the correction the page is as before.
        page.corrected = None;
        let plain = body_blocks(
            &page,
            &HashMap::new(),
            DEFAULT_PLAYBACK_LINK,
            &HashSet::new(),
        );
        assert_eq!(plain.len(), body.len());
        assert_eq!(
            block_text(&plain[at + 1]),
            "[00:00] aaaaaaaa: 허드 회의록은 오션에 올려 주세요"
        );
    }
}
