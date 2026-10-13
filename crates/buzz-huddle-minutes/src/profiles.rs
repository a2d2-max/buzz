//! 참석자 프로필 이름. 회의마다 한 번, 운영 릴레이의 `POST /query` 에 참석자들의
//! kind 0(프로필)을 묻는다. 운영 릴레이는 멤버만 읽게 해 두어서
//! (`BUZZ_REQUIRE_AUTH_TOKEN`, `BUZZ_REQUIRE_RELAY_MEMBERSHIP`) 회의록 봇 키로
//! NIP-98 인증을 붙인다. 서명은 nostr 라이브러리의 NIP-98 빌더
//! (`EventBuilder::http_auth`)로 한다.
//!
//! - 고르는 순서: `display_name` → `name` → pubkey 앞 8자. 다듬어서 비면 없는 것으로 본다.
//! - 다듬기: 줄바꿈·제어 문자·안 보이는 서식 문자·빈칸처럼 보이는 채움 글자를 빼고,
//!   띄어쓰기는 하나로 줄이고, 쉼표는 띄어쓰기로 바꾸고(노션 multi_select 는 쉼표를 못
//!   받는다), NFC 로 맞추고, 길이는 UTF-16 100 단위까지 자른다(노션 선택지 이름 한도).
//!   보이는 글자가 하나도 안 남으면 이름이 없는 것으로 본다.
//! - 한 회의 안에서 다른 pubkey 가 같은 이름이면 둘 다 `이름 (앞 8자)` 로 가른다. 그래도
//!   겹치면(남의 가른 이름을 제 이름으로 쓴 경우) 겹친 사람은 앞 8자. 요약에서 담당자를
//!   이름으로 pubkey 에 되돌릴 때 두 사람이 섞이지 않는다.
//! - 회의 하나에 요청 하나: 참석자 pubkey 를 모두 `authors` 하나에 넣고, 시간 상한
//!   [`QUERY_TIMEOUT`] 을 둔다. 다시 하지 않는다. 한 실행에서 시간 상한에 한 번 걸리면 그
//!   실행 동안은 더 묻지 않는다.
//! - 묻기가 안 돼도(릴레이 안 닿음·401·403·시간 초과·이상한 답) 회의는 그대로 간다. 그
//!   사람들만 앞 8자로 두고, 몇 명인지와 까닭의 종류만 남긴다([`NamesReport`]). 돈 드는
//!   단계의 실패 기록(`StepFailures`)에는 넣지 않는다.
//! - 봇 비밀 키는 밖(환경 변수 [`SCRIBE_KEY_ENV`])에서 받는다. 로그·오류·Debug 어디에도
//!   찍지 않는다.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use nostr::hashes::{sha256, Hash};
use nostr::nips::nip98::{HttpData, HttpMethod};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag, Url};
use reqwest::header::HeaderValue;
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::correct::is_format;
use crate::summary::{known_pubkeys, DisplayNames, PubkeyPrefixNames};
use crate::transcript::Transcript;

/// 회의록 봇 비밀 키(nsec 또는 hex 64자)를 받는 환경 변수. 명령줄 플래그는 없다
/// (프로세스 목록에 보이지 않게).
pub const SCRIBE_KEY_ENV: &str = "BUZZ_MINUTES_SCRIBE_NSEC";
/// 묻기 하나의 시간 상한(연결부터 답 끝까지).
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
/// 이름 길이 상한(UTF-16 단위). 노션 multi_select 선택지 이름 한도다.
pub const MAX_NAME_UNITS: usize = 100;
/// 답 본문 상한. 운영 릴레이는 이벤트 내용을 512 KiB 까지 받으니, 그만큼 큰 프로필이
/// 서른 명쯤 와도 받는다(큰 프로필 몇 개 때문에 회의 전체가 앞 8자로 떨어지지 않게).
const MAX_ANSWER_BYTES: usize = 16 << 20;

/// 이름 묻기를 켜지 못한 까닭. 값(주소·키)은 담지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProfileSetupError {
    /// 릴레이 주소가 http(s)·ws(s) 의 맨 앞 주소(호스트만, 경로 없음)가 아니다.
    #[error("the relay address must be http(s):// or ws(s):// with a host and no path")]
    BadRelayUrl,
    /// 봇 키가 nostr 비밀 키가 아니다.
    #[error("BUZZ_MINUTES_SCRIBE_NSEC is not a nostr secret key (nsec or 64 hex); the value is never printed")]
    BadKey,
    /// HTTP 클라이언트를 못 만들었다.
    #[error("could not build the HTTP client")]
    Http,
}

/// 묻기가 통째로 안 된 까닭. 종류와 HTTP 상태만 담는다(릴레이가 보낸 글은 안 담는다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamesTrouble {
    /// 연결이 안 됐다.
    Unreachable,
    /// 시간 상한 안에 답이 다 오지 않았다.
    TimedOut,
    /// 401·403: 인증이 거절됐거나 봇이 릴레이 멤버가 아니다.
    Refused(u16),
    /// 그 밖의 HTTP 상태(429·5xx·넘겨주기 3xx 등).
    Status(u16),
    /// 답이 이벤트 JSON 배열이 아니다(중간에 끊김·너무 큼 포함).
    BadAnswer,
    /// 인증 이벤트에 서명하지 못했다.
    Unsigned,
    /// 묻지 않았다: 이 실행에서 릴레이가 앞서 시간 상한에 걸렸다.
    OffForRun,
}

impl fmt::Display for NamesTrouble {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable => f.write_str("relay unreachable"),
            Self::TimedOut => f.write_str("relay timed out"),
            Self::Refused(status) => write!(f, "relay refused: HTTP {status}"),
            Self::Status(status) => write!(f, "relay answered HTTP {status}"),
            Self::BadAnswer => f.write_str("relay answer unreadable"),
            Self::Unsigned => f.write_str("could not sign the request"),
            Self::OffForRun => f.write_str("not asked: the relay timed out earlier in this run"),
        }
    }
}

/// 회의 하나의 이름 묻기 결과. 수와 까닭의 종류뿐이라 로그에 그대로 찍는다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NamesReport {
    /// 이름을 찾으려던 사람 수.
    pub asked: usize,
    /// 프로필 이름을 찾은 사람 수. 나머지는 pubkey 앞 8자로 보인다.
    pub found: usize,
    /// 묻기가 통째로 안 됐으면 그 까닭. 프로필이 없는 사람은 까닭 없이 수에만 든다.
    pub trouble: Option<NamesTrouble>,
}

impl NamesReport {
    /// 모든 사람의 프로필 이름을 찾았다.
    pub fn all_found(&self) -> bool {
        self.trouble.is_none() && self.found >= self.asked
    }
}

impl fmt::Display for NamesReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "profile names: {} of {} found", self.found, self.asked)?;
        let kept = self.asked.saturating_sub(self.found);
        if kept > 0 {
            write!(f, ", {kept} shown as pubkey prefix")?;
        }
        if let Some(trouble) = &self.trouble {
            write!(f, " ({trouble})")?;
        }
        Ok(())
    }
}

/// 회의 하나의 이름표: 프로필 이름이 있으면 그것(다듬고, 같은 이름은 가른 것), 없으면
/// pubkey 앞 8자. 회의마다 한 번 만들어 그 회의의 후보정·요약·노션이 같이 쓴다. 그래서
/// 요약 프롬프트에 보인 이름과 담당자를 pubkey 로 되돌릴 때 보는 이름이 늘 같다.
#[derive(Debug, Clone, Default)]
pub struct ProfileNames {
    /// pubkey → 보일 이름.
    shown: HashMap<String, String>,
    /// pubkey → 그 사람 프로필 이름(가르기 전).
    own: HashMap<String, String>,
    report: NamesReport,
}

impl ProfileNames {
    /// `pubkeys`(이 회의 사람들)의 이름표. `found` 는 pubkey → 프로필 이름(다듬기 전이어도
    /// 된다). `trouble` 은 묻기가 통째로 안 된 까닭.
    pub fn new(
        pubkeys: &[&str],
        found: &HashMap<String, String>,
        trouble: Option<NamesTrouble>,
    ) -> Self {
        let mut people: Vec<&str> = Vec::new();
        for pubkey in pubkeys {
            if !people.contains(pubkey) {
                people.push(pubkey);
            }
        }
        let own: HashMap<String, String> = people
            .iter()
            .filter_map(|pubkey| Some((pubkey.to_string(), tidy_name(found.get(*pubkey)?)?)))
            .collect();
        // 같은 이름 세기. 프로필 이름이 없는 사람은 보일 이름(앞 8자)으로 센다.
        let mut counts: HashMap<String, usize> = HashMap::new();
        for pubkey in &people {
            let name = own.get(*pubkey).cloned().unwrap_or_else(|| prefix(pubkey));
            *counts.entry(same_name(&name)).or_default() += 1;
        }
        let mut shown: HashMap<String, String> = own
            .iter()
            .map(|(pubkey, name)| {
                let shared = counts.get(&same_name(name)).is_some_and(|n| *n > 1);
                let shown = if shared {
                    with_prefix(name, pubkey)
                } else {
                    name.clone()
                };
                (pubkey.clone(), shown)
            })
            .collect();
        // 다 만든 이름끼리 한 번 더 본다. 누가 남의 가른 이름("민수 (aaaaaaaa)")을 제
        // 이름으로 써 두면 여기서 또 겹친다: 겹친 사람은 앞 8자로 보인다(노션 "참석자" 칸에서
        // 한 사람이 빠지지 않게). 돌 때마다 한 사람 이상이 앞 8자가 되니 반드시 끝난다.
        loop {
            let mut counts: HashMap<String, usize> = HashMap::new();
            for pubkey in &people {
                let name = shown
                    .get(*pubkey)
                    .cloned()
                    .unwrap_or_else(|| prefix(pubkey));
                *counts.entry(same_name(&name)).or_default() += 1;
            }
            let clashing: Vec<String> = shown
                .iter()
                .filter(|(_, name)| counts.get(&same_name(name)).is_some_and(|n| *n > 1))
                .map(|(pubkey, _)| pubkey.clone())
                .collect();
            if clashing.is_empty() {
                break;
            }
            for pubkey in clashing {
                shown.remove(&pubkey);
            }
        }
        let report = NamesReport {
            asked: people.len(),
            found: own.len(),
            trouble,
        };
        Self { shown, own, report }
    }

    /// 묻기 결과(수와 까닭).
    pub fn report(&self) -> &NamesReport {
        &self.report
    }
}

impl DisplayNames for ProfileNames {
    fn display_name(&self, pubkey: &str) -> String {
        self.shown
            .get(pubkey)
            .cloned()
            .unwrap_or_else(|| prefix(pubkey))
    }

    fn profile_name(&self, pubkey: &str) -> Option<String> {
        self.own.get(pubkey).cloned()
    }
}

fn prefix(pubkey: &str) -> String {
    PubkeyPrefixNames.display_name(pubkey)
}

/// `text` 를 UTF-16 `max_units` 단위 안으로 자른다(글자 가운데는 안 자른다).
fn cut(text: &str, max_units: usize) -> String {
    let mut units = 0;
    let kept: String = text
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max_units
        })
        .collect();
    kept.trim_end().to_string()
}

/// 노션 multi_select 선택지가 될 수 있게 다듬은 이름. 보이는 글자가 하나도 없으면 `None`.
/// 조합이 다른 같은 글자(가 = ᄀ+ᅡ)는 NFC 로 맞춘다.
fn tidy_name(raw: &str) -> Option<String> {
    let kept: String = raw
        .chars()
        .filter(|c| (!c.is_control() || c.is_whitespace()) && !is_format(*c) && !is_filler(*c))
        .map(|c| if c == ',' { ' ' } else { c })
        .collect();
    let joined: String = kept
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .nfc()
        .collect();
    let name = cut(&joined, MAX_NAME_UNITS);
    name.chars().any(shows).then_some(name)
}

/// 빈칸처럼 보이는 채움 글자: 한글 채움(U+115F·U+1160·U+3164·U+FFA0)과 빈 점자(U+2800).
/// 서식 문자가 아니라 [`is_format`] 에 안 걸리지만, 이것만으로 이름을 비워 보이게 할 수 있다.
fn is_filler(c: char) -> bool {
    matches!(
        c,
        '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}' | '\u{2800}'
    )
}

/// 혼자서도 보이는 글자인가. 띄어쓰기, 결합 부호, 이체 선택자는 아니다(앞 글자에 붙어서만
/// 보인다). 이름에는 이런 글자가 하나는 있어야 한다.
fn shows(c: char) -> bool {
    !c.is_whitespace()
        && !matches!(
            c,
            '\u{0300}'..='\u{036F}'
                | '\u{1AB0}'..='\u{1AFF}'
                | '\u{1DC0}'..='\u{1DFF}'
                | '\u{20D0}'..='\u{20FF}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FE20}'..='\u{FE2F}'
                | '\u{E0100}'..='\u{E01EF}'
        )
}

/// 같은 이름인지 볼 때 쓰는 열쇠: 띄어쓰기를 빼고 소문자로.
fn same_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// `이름 (앞 8자)`, 길이 상한 안으로.
fn with_prefix(name: &str, pubkey: &str) -> String {
    let tail = format!(" ({})", prefix(pubkey));
    let room = MAX_NAME_UNITS.saturating_sub(tail.encode_utf16().count());
    format!("{}{tail}", cut(name, room))
}

/// kind 0 내용에서 이름: `display_name`, 없거나 비면 `name`. 둘 다 없으면 `None`.
fn profile_name(content: &str) -> Option<String> {
    let profile: Value = serde_json::from_str(content).ok()?;
    ["display_name", "name"].iter().find_map(|key| {
        profile
            .get(*key)
            .and_then(Value::as_str)
            .and_then(tidy_name)
    })
}

/// 답의 이벤트에서 pubkey → 프로필 이름. 물은 사람이 서명한 kind 0 만 본다. 한 사람에
/// 여럿이면 가장 새 것 하나로 정한다(그것에 이름이 없으면 이름 없음).
fn newest_names(events: Vec<Value>, authors: &[PublicKey]) -> HashMap<String, String> {
    let mut newest: HashMap<PublicKey, Event> = HashMap::new();
    for value in events {
        let Ok(event) = serde_json::from_value::<Event>(value) else {
            continue;
        };
        if event.kind != Kind::Metadata
            || !authors.contains(&event.pubkey)
            || event.verify().is_err()
        {
            continue;
        }
        if newest
            .get(&event.pubkey)
            .is_none_or(|seen| event.created_at > seen.created_at)
        {
            newest.insert(event.pubkey, event);
        }
    }
    newest
        .into_iter()
        .filter_map(|(pubkey, event)| Some((pubkey.to_hex(), profile_name(&event.content)?)))
        .collect()
}

/// 릴레이 주소 → `/query` 주소. `ws(s)://` 는 `http(s)://` 로 바꾼다. 경로가 붙은 주소는
/// 받지 않는다(릴레이가 NIP-98 `u` 로 기대하는 주소는 `{scheme}://{host}/query` 뿐이다).
fn query_url(relay_url: &str) -> Result<Url, ProfileSetupError> {
    let mut url = Url::parse(relay_url.trim()).map_err(|_| ProfileSetupError::BadRelayUrl)?;
    let scheme = match url.scheme() {
        "https" | "wss" => "https",
        "http" | "ws" => "http",
        _ => return Err(ProfileSetupError::BadRelayUrl),
    };
    let plain = url.host_str().is_some()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    if !plain {
        return Err(ProfileSetupError::BadRelayUrl);
    }
    url.set_scheme(scheme)
        .map_err(|()| ProfileSetupError::BadRelayUrl)?;
    url.set_path("/query");
    Ok(url)
}

/// 본문을 상한까지만 읽는다.
async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, NamesTrouble> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_ANSWER_BYTES {
                    return Err(NamesTrouble::BadAnswer);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(body),
            Err(error) if error.is_timeout() => return Err(NamesTrouble::TimedOut),
            Err(_) => return Err(NamesTrouble::BadAnswer),
        }
    }
}

/// 프로필 이름을 물을 곳: 릴레이 `/query` 주소, 회의록 봇 키, 시간 상한이 걸린 HTTP
/// 클라이언트. 한 실행에서 하나를 만들어 회의마다 쓴다. 그 실행에서 한 번이라도 시간
/// 상한에 걸리면 그 뒤로는 묻지 않는다(답 없이 매달리는 릴레이에 회의마다 상한만큼 쓰지
/// 않게). 바로 오는 거절(401 등)은 다음 회의에서 다시 묻는다.
pub struct ProfileSource {
    query_url: Url,
    keys: Keys,
    http: reqwest::Client,
    /// 이 실행에서 시간 상한에 걸린 적이 있다.
    hung: AtomicBool,
}

impl fmt::Debug for ProfileSource {
    // 봇 키는 보이지 않는다.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProfileSource")
            .field("query_url", &self.query_url.as_str())
            .finish_non_exhaustive()
    }
}

impl ProfileSource {
    /// `relay_url` 은 릴레이 주소(`https://…`, `wss://…`), `secret_key` 는 회의록 봇 키
    /// (nsec 또는 hex). `timeout` 은 묻기 하나의 시간 상한([`QUERY_TIMEOUT`]).
    pub fn new(
        relay_url: &str,
        secret_key: &str,
        timeout: Duration,
    ) -> Result<Self, ProfileSetupError> {
        let query_url = query_url(relay_url)?;
        let keys = Keys::parse(secret_key.trim()).map_err(|_| ProfileSetupError::BadKey)?;
        // 넘겨주기(3xx)는 따라가지 않는다: 서명한 인증을 다른 곳에 보내지 않게.
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ProfileSetupError::Http)?;
        Ok(Self {
            query_url,
            keys,
            http,
            hung: AtomicBool::new(false),
        })
    }

    /// 묻는 주소(`…/query`).
    pub fn query_url(&self) -> &str {
        self.query_url.as_str()
    }

    /// 이 회의에서 pubkey 로 아는 사람들(참석자와 화자)의 이름표. 요청은 하나다.
    pub async fn names_for(&self, transcript: &Transcript) -> ProfileNames {
        let mut pubkeys: Vec<&str> = known_pubkeys(transcript).into_iter().collect();
        pubkeys.sort_unstable();
        self.names(&pubkeys).await
    }

    /// `pubkeys` 의 이름표. 모두 한 요청으로 묻는다. 실패해도 이름표는 나온다: 못 찾은
    /// 사람은 pubkey 앞 8자. pubkey 모양이 아닌 것은 묻지 않고 앞 8자로 둔다.
    pub async fn names(&self, pubkeys: &[&str]) -> ProfileNames {
        let mut authors: Vec<PublicKey> = Vec::new();
        for pubkey in pubkeys {
            if let Ok(author) = PublicKey::from_hex(pubkey) {
                if !authors.contains(&author) {
                    authors.push(author);
                }
            }
        }
        if authors.is_empty() {
            return ProfileNames::new(pubkeys, &HashMap::new(), None);
        }
        if self.hung.load(Ordering::Relaxed) {
            return ProfileNames::new(pubkeys, &HashMap::new(), Some(NamesTrouble::OffForRun));
        }
        match self.ask(&authors).await {
            Ok(events) => ProfileNames::new(pubkeys, &newest_names(events, &authors), None),
            Err(trouble) => {
                if trouble == NamesTrouble::TimedOut {
                    self.hung.store(true, Ordering::Relaxed);
                }
                ProfileNames::new(pubkeys, &HashMap::new(), Some(trouble))
            }
        }
    }

    /// `POST /query` 의 `Authorization` 값: `Nostr <base64(kind 27235 이벤트)>`.
    /// `u`·`method`·`payload`(본문 sha256) 태그에 `nonce` 를 더한다. 릴레이는 본 이벤트
    /// id 를 다시 받지 않아서, 같은 본문을 같은 초에 다시 보내도 id 가 달라지게 한다.
    fn authorization(&self, body: &[u8]) -> Result<HeaderValue, NamesTrouble> {
        let data = HttpData::new(self.query_url.clone(), HttpMethod::POST)
            .payload(sha256::Hash::hash(body));
        let nonce = Uuid::new_v4().to_string();
        let nonce = Tag::parse(["nonce", nonce.as_str()]).map_err(|_| NamesTrouble::Unsigned)?;
        let event = EventBuilder::http_auth(data)
            .tag(nonce)
            .sign_with_keys(&self.keys)
            .map_err(|_| NamesTrouble::Unsigned)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(event.as_json());
        let mut value = HeaderValue::from_str(&format!("Nostr {encoded}"))
            .map_err(|_| NamesTrouble::Unsigned)?;
        value.set_sensitive(true);
        Ok(value)
    }

    /// `authors` 의 kind 0 을 한 요청으로 묻는다. 답은 이벤트 JSON 배열.
    async fn ask(&self, authors: &[PublicKey]) -> Result<Vec<Value>, NamesTrouble> {
        let authors: Vec<String> = authors.iter().map(PublicKey::to_hex).collect();
        let body = json!([{ "kinds": [0], "authors": authors }])
            .to_string()
            .into_bytes();
        let auth = self.authorization(&body)?;
        let response = self
            .http
            .post(self.query_url.as_str())
            .header(reqwest::header::AUTHORIZATION, auth)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    NamesTrouble::TimedOut
                } else {
                    NamesTrouble::Unreachable
                }
            })?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(match status {
                401 | 403 => NamesTrouble::Refused(status),
                _ => NamesTrouble::Status(status),
            });
        }
        let bytes = read_capped(response).await?;
        serde_json::from_slice(&bytes).map_err(|_| NamesTrouble::BadAnswer)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use std::time::Instant;

    use nostr::{TagKind, Timestamp, ToBech32};

    use super::*;
    use crate::test_http::{FakeServer, Recorded, Reply};

    const A: &str = "aaaaaaaa00000000000000000000000000000000000000000000000000000001";
    const B: &str = "bbbbbbbb00000000000000000000000000000000000000000000000000000002";
    const C: &str = "cccccccc00000000000000000000000000000000000000000000000000000003";

    /// `keys` 가 서명한 kind 0(`created_at` 은 `at`).
    pub(crate) fn profile_event(keys: &Keys, content: &Value, at: u64) -> Value {
        let event = EventBuilder::new(Kind::Metadata, content.to_string())
            .custom_created_at(Timestamp::from(at))
            .sign_with_keys(keys)
            .unwrap();
        serde_json::to_value(&event).unwrap()
    }

    /// 시험용 봇 키로 `relay` 에 묻는 곳.
    pub(crate) fn source_for(relay: &str, bot: &Keys) -> ProfileSource {
        ProfileSource::new(relay, &bot.secret_key().to_secret_hex(), QUERY_TIMEOUT).unwrap()
    }

    fn names_of(names: &[(&str, &str)]) -> HashMap<String, String> {
        names
            .iter()
            .map(|(pubkey, name)| (pubkey.to_string(), name.to_string()))
            .collect()
    }

    /// `Authorization` 헤더의 이벤트 JSON.
    fn auth_event_json(header: &str) -> String {
        let encoded = header.strip_prefix("Nostr ").expect("Nostr scheme");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        String::from_utf8(bytes).unwrap()
    }

    fn hex_of(people: &[Keys]) -> Vec<String> {
        people
            .iter()
            .map(|keys| keys.public_key().to_hex())
            .collect()
    }

    fn refs(pubkeys: &[String]) -> Vec<&str> {
        pubkeys.iter().map(String::as_str).collect()
    }

    #[test]
    fn display_name_then_name_then_pubkey_prefix() {
        assert_eq!(
            profile_name(&json!({ "display_name": " 지영 ", "name": "jy" }).to_string()),
            Some("지영".into())
        );
        // 비었거나, 띄어쓰기뿐이거나, 글이 아니면 다음 것.
        for display in [json!(""), json!("  \n "), json!(42), Value::Null] {
            let content = json!({ "display_name": display, "name": "민수" }).to_string();
            assert_eq!(profile_name(&content), Some("민수".into()), "{content}");
        }
        assert_eq!(profile_name(&json!({ "about": "x" }).to_string()), None);
        assert_eq!(profile_name("not json"), None);
        // 이름표에서는 못 찾은 사람이 pubkey 앞 8자.
        let names = ProfileNames::new(&[A, B], &names_of(&[(A, "지영")]), None);
        assert_eq!(names.display_name(A), "지영");
        assert_eq!(names.display_name(B), "bbbbbbbb");
        assert_eq!(names.profile_name(B), None);
        // 이 회의에 없던 pubkey 도 앞 8자.
        assert_eq!(names.display_name(C), "cccccccc");
        assert_eq!(
            names.report(),
            &NamesReport {
                asked: 2,
                found: 1,
                trouble: None
            }
        );
    }

    #[test]
    fn names_are_tidied_for_notion_multi_select() {
        // 쉼표는 띄어쓰기로, 줄바꿈·탭·제어·서식 문자는 빼고, 띄어쓰기는 하나로.
        assert_eq!(tidy_name("김,지영"), Some("김 지영".into()));
        assert_eq!(tidy_name(" 지영\n(팀장)\t "), Some("지영 (팀장)".into()));
        assert_eq!(tidy_name("\u{202E}지영\u{200B}\u{7}"), Some("지영".into()));
        assert_eq!(tidy_name(" , \u{200B} "), None);
        // 길이는 UTF-16 100 단위까지(이모지는 2 단위).
        assert_eq!(tidy_name(&"가".repeat(150)), Some("가".repeat(100)));
        assert_eq!(tidy_name(&"😀".repeat(60)), Some("😀".repeat(50)));
        let long = ProfileNames::new(&[A], &names_of(&[(A, &"a, b ".repeat(80))]), None);
        let shown = long.display_name(A);
        assert!(shown.encode_utf16().count() <= MAX_NAME_UNITS, "{shown}");
        assert!(!shown.contains(',') && !shown.ends_with(' '), "{shown}");
    }

    #[test]
    fn same_names_are_told_apart_by_pubkey_prefix() {
        let names = ProfileNames::new(
            &[A, B, C],
            &names_of(&[(A, "지영"), (B, " 지영 "), (C, "민수")]),
            None,
        );
        assert_eq!(names.display_name(A), "지영 (aaaaaaaa)");
        assert_eq!(names.display_name(B), "지영 (bbbbbbbb)");
        assert_eq!(names.display_name(C), "민수");
        // 담당자 연결 DB 에는 가르기 전 프로필 이름.
        assert_eq!(names.profile_name(B).as_deref(), Some("지영"));
        // 대소문자·띄어쓰기만 다른 것도 같은 이름으로 본다.
        let names = ProfileNames::new(&[A, B], &names_of(&[(A, "Ji Young"), (B, "jiyoung")]), None);
        assert_eq!(names.display_name(A), "Ji Young (aaaaaaaa)");
        assert_eq!(names.display_name(B), "jiyoung (bbbbbbbb)");
        // 다른 사람의 앞 8자(프로필 없는 사람)와 같은 이름도 가른다.
        let names = ProfileNames::new(&[A, B], &names_of(&[(A, "bbbbbbbb")]), None);
        assert_eq!(names.display_name(A), "bbbbbbbb (aaaaaaaa)");
        assert_eq!(names.display_name(B), "bbbbbbbb");
        // 긴 같은 이름도 상한 안에서 갈린다.
        let long = "가".repeat(120);
        let names = ProfileNames::new(&[A, B], &names_of(&[(A, &long), (B, &long)]), None);
        let (a, b) = (names.display_name(A), names.display_name(B));
        assert_ne!(a, b);
        for shown in [&a, &b] {
            assert_eq!(shown.encode_utf16().count(), MAX_NAME_UNITS, "{shown}");
        }
        assert!(a.ends_with(" (aaaaaaaa)"), "{a}");
    }

    /// 빈칸처럼 보이는 채움 글자·결합 부호만 있는 이름은 이름이 없는 것(앞 8자). 이름 안의
    /// 채움 글자는 빠진다. 조합이 다른 같은 글자는 NFC 로 같아진다.
    #[test]
    fn invisible_names_count_as_no_name() {
        for blank in [
            "\u{3164}",
            "\u{115F}\u{1160}",
            "\u{FFA0}\u{FFA0}",
            "\u{2800}",
            " \u{3164} \u{2800} ",
            "\u{0301}",
            "\u{FE0F}\u{200B}",
        ] {
            assert_eq!(tidy_name(blank), None, "{blank:?}");
        }
        assert_eq!(tidy_name("지\u{3164}영\u{2800}"), Some("지영".into()));
        // 결합 부호는 보이는 글자에 붙어 있으면 남는다(NFC 로 합쳐진다).
        assert_eq!(tidy_name("e\u{0301}"), Some("\u{E9}".into()));
        // 조합형(ᄀ+ᅡ)과 완성형(가)은 같은 이름.
        assert_eq!(tidy_name("\u{1100}\u{1161}"), Some("가".into()));
        let content = json!({ "display_name": "\u{3164}", "name": "민수" }).to_string();
        assert_eq!(profile_name(&content), Some("민수".into()));
        let names = ProfileNames::new(&[A], &names_of(&[(A, "\u{3164}\u{3164}")]), None);
        assert_eq!(names.display_name(A), "aaaaaaaa");
        assert_eq!(names.profile_name(A), None);
        assert_eq!(names.report().found, 0);
        let names = ProfileNames::new(
            &[A, B],
            &names_of(&[(A, "\u{1100}\u{1161}"), (B, "가")]),
            None,
        );
        assert_eq!(names.display_name(A), "가 (aaaaaaaa)");
        assert_eq!(names.display_name(B), "가 (bbbbbbbb)");
    }

    /// 남의 가른 이름을 제 이름으로 써도 보일 이름은 서로 다르다: 겹친 사람은 앞 8자.
    #[test]
    fn shown_names_never_collide() {
        let names = ProfileNames::new(
            &[A, B, C],
            &names_of(&[(A, "민수"), (B, "민수 (aaaaaaaa)"), (C, "민수")]),
            None,
        );
        assert_eq!(names.display_name(A), "aaaaaaaa");
        assert_eq!(names.display_name(B), "bbbbbbbb");
        assert_eq!(names.display_name(C), "민수 (cccccccc)");
        // 담당자 연결 DB 에 쓰는 프로필 이름은 그대로.
        assert_eq!(names.profile_name(B).as_deref(), Some("민수 (aaaaaaaa)"));
        let mut keys: Vec<String> = [A, B, C]
            .iter()
            .map(|pubkey| same_name(&names.display_name(pubkey)))
            .collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), 3);
    }

    /// 시간 상한에 한 번 걸리면 그 실행(같은 ProfileSource)에서는 더 묻지 않는다. 바로 오는
    /// 거절(401)은 다음 회의에서 다시 묻는다.
    #[tokio::test]
    async fn a_timeout_turns_asking_off_for_the_run() {
        let pubkeys = hex_of(&[Keys::generate()]);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&accepted);
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                held.push(socket);
            }
        });
        let bot = Keys::generate();
        let source = ProfileSource::new(
            &base,
            &bot.secret_key().to_secret_hex(),
            Duration::from_millis(300),
        )
        .unwrap();
        let first = source.names(&refs(&pubkeys)).await;
        assert_eq!(first.report().trouble, Some(NamesTrouble::TimedOut));
        let started = Instant::now();
        let second = source.names(&refs(&pubkeys)).await;
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(second.report().trouble, Some(NamesTrouble::OffForRun));
        assert_eq!(accepted.load(Ordering::SeqCst), 1, "asked only once");
        assert_eq!(second.display_name(&pubkeys[0]), &pubkeys[0][..8]);
        let line = second.report().to_string();
        assert!(line.contains("not asked"), "{line}");

        let relay = FakeServer::start(|_| Reply::json(401, &json!({}))).await;
        let source = source_for(&relay.base, &Keys::generate());
        for _ in 0..2 {
            source.names(&refs(&pubkeys)).await;
        }
        assert_eq!(relay.requests().len(), 2);
    }

    #[tokio::test]
    async fn one_signed_query_for_everyone_passes_the_relay_check() {
        let people: Vec<Keys> = (0..3).map(|_| Keys::generate()).collect();
        let events = json!([
            profile_event(
                &people[0],
                &json!({ "display_name": "지영", "name": "jy" }),
                10
            ),
            profile_event(&people[1], &json!({ "name": "민수" }), 10),
            // 세 번째 사람은 프로필이 없다.
        ]);
        let relay = FakeServer::start(move |_| Reply::json(200, &events)).await;
        let bot = Keys::generate();
        let source = source_for(&relay.base, &bot);
        let pubkeys = hex_of(&people);
        let names = source.names(&refs(&pubkeys)).await;
        assert_eq!(names.display_name(&pubkeys[0]), "지영");
        assert_eq!(names.display_name(&pubkeys[1]), "민수");
        assert_eq!(names.display_name(&pubkeys[2]), &pubkeys[2][..8]);
        assert_eq!(
            names.report(),
            &NamesReport {
                asked: 3,
                found: 2,
                trouble: None
            }
        );

        // 회의 하나에 요청 하나: kind 0, 참석자 모두를 authors 하나에.
        let requests = relay.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/query")
        );
        assert_eq!(
            request.json(),
            json!([{ "kinds": [0], "authors": pubkeys }])
        );

        // 릴레이가 /query 에서 부르는 검사(verify_bridge_auth → buzz_auth::verify_nip98_event)를
        // 그대로 통과한다. 개발 릴레이(ws://)의 기대 주소는 http://{host}/query 다.
        let header = request.header("authorization").unwrap();
        let event_json = auth_event_json(header);
        let expected_url = format!("{}/query", relay.base);
        let signer =
            buzz_auth::verify_nip98_event(&event_json, &expected_url, "POST", Some(&request.body))
                .unwrap();
        assert_eq!(signer, bot.public_key());
        let event: Event = serde_json::from_str(&event_json).unwrap();
        assert_eq!(event.kind, Kind::HttpAuth);
        assert_eq!(
            event
                .tags
                .iter()
                .filter(|tag| tag.kind() == TagKind::Payload)
                .count(),
            1,
            "the body is bound by its sha256"
        );
        // 본문을 바꾸면 같은 검사에서 떨어진다.
        assert!(
            buzz_auth::verify_nip98_event(&event_json, &expected_url, "POST", Some(b"[]")).is_err()
        );
    }

    #[test]
    fn the_production_address_signs_for_its_query_url() {
        let bot = Keys::generate();
        let nsec = bot.secret_key().to_bech32().unwrap();
        for given in [
            "https://buzz.a2d2lab.com",
            "https://buzz.a2d2lab.com/",
            " wss://buzz.a2d2lab.com ",
            "HTTPS://Buzz.A2D2Lab.com",
        ] {
            let source = ProfileSource::new(given, &nsec, QUERY_TIMEOUT).unwrap();
            assert_eq!(
                source.query_url(),
                "https://buzz.a2d2lab.com/query",
                "{given}"
            );
        }
        for bad in [
            "",
            "buzz.a2d2lab.com",
            "ftp://buzz.a2d2lab.com",
            "https://buzz.a2d2lab.com/relay",
            "https://buzz.a2d2lab.com/?x=1",
            "https://user:pw@buzz.a2d2lab.com",
        ] {
            assert_eq!(
                ProfileSource::new(bad, &nsec, QUERY_TIMEOUT).unwrap_err(),
                ProfileSetupError::BadRelayUrl,
                "{bad}"
            );
        }
        // 운영 릴레이(wss://)는 https://{host}/query 를 기대한다(nip98_expected_url).
        let source = ProfileSource::new("https://buzz.a2d2lab.com", &nsec, QUERY_TIMEOUT).unwrap();
        let body = br#"[{"kinds":[0],"authors":[]}]"#;
        let first = source.authorization(body).unwrap();
        assert!(first.is_sensitive());
        let first_json = auth_event_json(first.to_str().unwrap());
        let signer = buzz_auth::verify_nip98_event(
            &first_json,
            "https://buzz.a2d2lab.com/query",
            "POST",
            Some(body),
        )
        .unwrap();
        assert_eq!(signer, bot.public_key());
        // 같은 본문을 바로 다시 보내도 이벤트 id 가 다르다(릴레이의 다시 보내기 막기).
        let second = source.authorization(body).unwrap();
        let id = |json: &str| serde_json::from_str::<Event>(json).unwrap().id;
        assert_ne!(
            id(&first_json),
            id(&auth_event_json(second.to_str().unwrap()))
        );
    }

    #[tokio::test]
    async fn the_newest_signed_profile_of_someone_asked_is_used() {
        let (jiyoung, stranger) = (Keys::generate(), Keys::generate());
        let mut forged = profile_event(&jiyoung, &json!({ "display_name": "위조" }), 30);
        forged["content"] = json!(json!({ "display_name": "바꿈" }).to_string());
        let mut not_profile = profile_event(&jiyoung, &json!({ "display_name": "글" }), 40);
        not_profile["kind"] = json!(1);
        let events = json!([
            profile_event(&jiyoung, &json!({ "display_name": "옛 이름" }), 10),
            profile_event(&jiyoung, &json!({ "display_name": "새 이름" }), 20),
            forged,
            not_profile,
            profile_event(&stranger, &json!({ "display_name": "남" }), 50),
            json!({ "not": "an event" }),
        ]);
        let relay = FakeServer::start(move |_| Reply::json(200, &events)).await;
        let source = source_for(&relay.base, &Keys::generate());
        let pubkey = jiyoung.public_key().to_hex();
        let names = source.names(&[&pubkey]).await;
        assert_eq!(names.display_name(&pubkey), "새 이름");
        assert_eq!(names.report().found, 1);
        // 물은 사람이 아닌 이의 프로필은 아무 데도 안 붙는다.
        assert_eq!(
            names.display_name(&stranger.public_key().to_hex()),
            &stranger.public_key().to_hex()[..8]
        );
    }

    /// 401·403·5xx·이상한 답·끊긴 답이면 모두 앞 8자, 까닭은 종류와 상태만.
    #[tokio::test]
    async fn failures_fall_back_to_pubkey_prefixes() {
        let html = Reply {
            status: 200,
            headers: vec![("content-type".into(), "text/html".into())],
            body: "<html>relay</html>".into(),
            cut_off: false,
        };
        let cases = [
            (
                Reply::json(401, &json!({ "error": "NIP-98: replay detected" })),
                NamesTrouble::Refused(401),
            ),
            (
                Reply::json(403, &json!({ "error": "not a relay member" })),
                NamesTrouble::Refused(403),
            ),
            (Reply::json(503, &json!({})), NamesTrouble::Status(503)),
            (
                Reply::json(200, &json!({ "events": [] })),
                NamesTrouble::BadAnswer,
            ),
            (html, NamesTrouble::BadAnswer),
            (
                Reply::json(200, &json!([])).cut_off(),
                NamesTrouble::BadAnswer,
            ),
        ];
        let people = [Keys::generate(), Keys::generate()];
        let pubkeys = hex_of(&people);
        for (reply, trouble) in cases {
            let relay = FakeServer::start(move |_: &Recorded| reply.clone()).await;
            let names = source_for(&relay.base, &Keys::generate())
                .names(&refs(&pubkeys))
                .await;
            for pubkey in &pubkeys {
                assert_eq!(names.display_name(pubkey), &pubkey[..8]);
            }
            let report = names.report();
            assert_eq!(report.trouble, Some(trouble));
            assert!(!report.all_found());
            // 로그 한 줄에는 수와 까닭의 종류만: 이름·pubkey·릴레이 글이 없다.
            let line = report.to_string();
            assert!(
                line.starts_with("profile names: 0 of 2 found, 2 shown as pubkey prefix ("),
                "{line}"
            );
            assert!(
                !line.contains(&pubkeys[0][..8]) && !line.contains("member"),
                "{line}"
            );
        }
    }

    #[tokio::test]
    async fn an_unreachable_or_silent_relay_falls_back_within_the_time_limit() {
        let people = [Keys::generate()];
        let pubkeys = hex_of(&people);
        // 닫힌 포트.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let names = source_for(&base, &Keys::generate())
            .names(&refs(&pubkeys))
            .await;
        assert_eq!(names.report().trouble, Some(NamesTrouble::Unreachable));
        assert_eq!(names.display_name(&pubkeys[0]), &pubkeys[0][..8]);

        // 받기만 하고 답하지 않는 릴레이.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let bot = Keys::generate();
        let source = ProfileSource::new(
            &base,
            &bot.secret_key().to_secret_hex(),
            Duration::from_millis(300),
        )
        .unwrap();
        let started = Instant::now();
        let names = source.names(&refs(&pubkeys)).await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(names.report().trouble, Some(NamesTrouble::TimedOut));
        assert_eq!(names.display_name(&pubkeys[0]), &pubkeys[0][..8]);
    }

    /// 답이 상한보다 크면 거기서 읽기를 멈추고 앞 8자로 떨어진다(올바른 JSON 이어도).
    #[tokio::test]
    async fn an_oversized_answer_is_not_read_to_the_end() {
        let big = Reply {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: format!("[\"{}\"]", "x".repeat(MAX_ANSWER_BYTES)),
            cut_off: false,
        };
        let relay = FakeServer::start(move |_: &Recorded| big.clone()).await;
        let pubkeys = hex_of(&[Keys::generate()]);
        let names = source_for(&relay.base, &Keys::generate())
            .names(&refs(&pubkeys))
            .await;
        assert_eq!(names.report().trouble, Some(NamesTrouble::BadAnswer));
        assert_eq!(names.display_name(&pubkeys[0]), &pubkeys[0][..8]);
    }

    #[tokio::test]
    async fn nothing_is_asked_when_no_one_has_a_real_pubkey() {
        let relay = FakeServer::start(|_| Reply::json(200, &json!([]))).await;
        let names = source_for(&relay.base, &Keys::generate())
            .names(&["not-a-pubkey"])
            .await;
        assert!(relay.requests().is_empty());
        assert_eq!(names.display_name("not-a-pubkey"), "not-a-pu");
        assert_eq!(names.report().trouble, None);
    }

    #[test]
    fn the_scribe_key_never_shows() {
        let bot = Keys::generate();
        let hex = bot.secret_key().to_secret_hex();
        let nsec = bot.secret_key().to_bech32().unwrap();
        for key in [&hex, &nsec] {
            let source =
                ProfileSource::new("https://buzz.a2d2lab.com", key, QUERY_TIMEOUT).unwrap();
            let debug = format!("{source:?}");
            assert!(debug.contains("https://buzz.a2d2lab.com/query"), "{debug}");
            for secret in [&hex, &nsec] {
                assert!(!debug.contains(secret.as_str()), "{debug}");
            }
            assert!(!debug.to_lowercase().contains("secret"), "{debug}");
        }
        // 틀린 키는 거절하되 그 값을 오류 글에 안 싣는다.
        let wrong = format!("{}x", &hex[..63]);
        let mut cut_nsec = nsec.clone();
        cut_nsec.pop();
        for key in [
            wrong.as_str(),
            cut_nsec.as_str(),
            "0".repeat(64).as_str(),
            "",
        ] {
            let error =
                ProfileSource::new("https://buzz.a2d2lab.com", key, QUERY_TIMEOUT).unwrap_err();
            assert_eq!(error, ProfileSetupError::BadKey);
            let text = format!("{error} {error:?}");
            assert!(key.is_empty() || !text.contains(key), "{text}");
            assert!(
                !text.contains(&hex[..16]) && !text.contains(&nsec[..16]),
                "{text}"
            );
        }
    }
}
