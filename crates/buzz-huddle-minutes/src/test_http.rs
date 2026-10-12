//! 시험에서만 쓰는 아주 작은 가짜 HTTP 서버. 네트워크 없이 127.0.0.1 에서
//! 요청을 받아 적어 두고, 시험이 준 함수로 답한다. 연결 하나에 요청 하나만
//! 받고 닫는다(`Connection: close`).

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::transcript::{AudioRef, Participant, Segment, Transcript};

/// 시험용 스크립트. 회의는 2026-10-12(월) 14:00 KST 에 시작한다.
/// `lines` 는 (start_ms, 화자 pubkey, 글). 요약·노션이 쓰는 칸만 채운다.
pub(crate) fn transcript_with(lines: &[(u64, &str, &str)]) -> Transcript {
    let mut participants: Vec<Participant> = Vec::new();
    for (_, speaker, _) in lines {
        if !participants.iter().any(|p| p.pubkey == *speaker) {
            participants.push(Participant {
                pubkey: (*speaker).to_string(),
                speech_ms: 1_000,
            });
        }
    }
    Transcript {
        channel_id: Uuid::from_u128(2),
        session_ids: vec![Uuid::from_u128(3), Uuid::from_u128(4)],
        started_at: "2026-10-12T05:00:00.000Z".into(),
        ended_at: "2026-10-12T05:42:10.120Z".into(),
        duration_ms: 2_530_120,
        participants,
        segments: lines
            .iter()
            .map(|(start_ms, speaker, text)| Segment {
                start_ms: *start_ms,
                end_ms: start_ms + 2_000,
                speaker: (*speaker).to_string(),
                text: (*text).to_string(),
            })
            .collect(),
        audio: AudioRef {
            expires_at: "2026-10-27T05:42:10.120Z".into(),
            ..AudioRef::default()
        },
        ..Transcript::default()
    }
}

/// 서버가 받은 요청 하나.
#[derive(Debug, Clone)]
pub(crate) struct Recorded {
    pub method: String,
    /// 경로와 쿼리(`/v1/pages?x=1`).
    pub path: String,
    /// 헤더 이름은 소문자.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    /// 이름이 `name`(소문자)인 첫 헤더 값.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// 본문을 JSON 으로 읽는다(본문이 없으면 `Null`).
    pub fn json(&self) -> serde_json::Value {
        if self.body.is_empty() {
            return serde_json::Value::Null;
        }
        serde_json::from_slice(&self.body).expect("request body is JSON")
    }
}

/// 가짜 서버의 답.
#[derive(Debug, Clone)]
pub(crate) struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// 본문 길이를 실제보다 길게 알려 주고 끊는다(본문 읽기 실패 흉내).
    pub cut_off: bool,
}

impl Reply {
    /// `status` 와 JSON 본문.
    pub fn json(status: u16, body: &serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.to_string(),
            cut_off: false,
        }
    }

    /// 헤더 하나를 더 붙인다.
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// 본문 중간에 연결을 끊는다.
    pub fn cut_off(mut self) -> Self {
        self.cut_off = true;
        self
    }
}

type Handler = dyn Fn(&Recorded) -> Reply + Send + Sync;

/// 돌고 있는 가짜 서버.
pub(crate) struct FakeServer {
    /// `http://127.0.0.1:<port>`
    pub base: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl FakeServer {
    /// 빈 포트에 서버를 띄운다. 요청마다 `handler` 로 답한다.
    pub async fn start(handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let seen = Arc::clone(&requests);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let handler = Arc::clone(&handler);
                let seen = Arc::clone(&seen);
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut socket).await else {
                        return;
                    };
                    let reply = handler(&request);
                    seen.lock().expect("lock").push(request);
                    let declared = reply.body.len() + if reply.cut_off { 1_000 } else { 0 };
                    let mut head = format!(
                        "HTTP/1.1 {} X\r\ncontent-length: {declared}\r\nconnection: close\r\n",
                        reply.status
                    );
                    for (name, value) in &reply.headers {
                        head.push_str(&format!("{name}: {value}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(reply.body.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self { base, requests }
    }

    /// 지금까지 받은 요청, 받은 순서대로.
    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().expect("lock").clone()
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<Recorded> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some(Recorded {
        method,
        path,
        headers,
        body,
    })
}
