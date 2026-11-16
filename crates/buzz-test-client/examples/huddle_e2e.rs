//! Huddle end-to-end client for the relay's huddle recorder.
//!
//! Usage, against a running relay (keep `--keys` and `--out` outside the repo):
//!
//! ```text
//! cargo run -p buzz-test-client --example huddle_e2e -- \
//!   --relay ws://localhost:3300 --keys <dir> \
//!   --speakers <dir with A.wav B.wav> --truth <fake meeting truth.json> \
//!   --out <dir> [--silence-secs 40] [--join <parent-uuid>:<huddle-uuid>]
//! ```
//!
//! Without `--join` it starts a new huddle and runs the script below. With
//! `--join` the same two people rejoin an existing huddle, say one sentence
//! each and end it (to check what a relay restart leaves behind). Keys come
//! from `<keys>/a.nsec` and `<keys>/b.nsec`, created (mode 0600) if missing.
//! The result goes to `<out>/sent.json`: ids, pubkeys, every sentence with the
//! wall-clock time its speech went out, per-pair delivery (frames each
//! listener should have heard vs. got, latency), and whether the run was cut
//! short (for example by a relay shutdown).
//!
//! Two people hold a huddle the way the desktop app does
//! (desktop/src-tauri/src/huddle), in this order:
//! 1. A creates an open parent channel (kind 9007); B joins it (kind 9021).
//! 2. A starts a huddle: private ttl-3600 backing channel (kind 9007), then
//!    kind 48100 in the parent. Every event goes over `POST /events` with
//!    NIP-98 auth, like the app.
//! 3. Both open `/huddle/{id}/audio`, answer the NIP-42 challenge with a kind
//!    22242 event and `protocol_version: 2`.
//! 4. They take turns reading FLEURS sentences: 16 kHz WAV, upsampled to
//!    48 kHz, Opus (VoIP, 32 kbit/s, DTX) in 20 ms frames behind the v2
//!    8-byte header, sent in real time. A muted person sends nothing, as the
//!    app's worklet drops audio while muted. B leaves (kind 9022) and comes
//!    back midway; everyone is silent for a while to exercise keep-alive
//!    chunks.
//! 5. End: B leaves (9022), A — the last one — sends 48103 and archives the
//!    backing channel (9002) before closing, which is the app's end path.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use buzz_sdk::{ChannelKind, Visibility};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use nostr::{EventBuilder, Keys, Kind, Tag, ToBech32};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = SplitSink<Ws, Message>;
type WsStream = SplitStream<Ws>;

const FRAME_SAMPLES_48K: usize = 960;
const TURN_GAP: Duration = Duration::from_millis(700);
/// Audio sent around each sentence's speech, ms.
const SLICE_MARGIN_MS: u64 = 300;

struct Args {
    relay: String,
    keys: PathBuf,
    speakers: PathBuf,
    truth: PathBuf,
    out: PathBuf,
    silence_secs: u64,
    /// Rejoin this existing huddle (parent, backing channel) instead of
    /// starting a new one.
    join: Option<(Uuid, Uuid)>,
}

fn parse_args() -> Result<Args> {
    let mut map = HashMap::new();
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let value = it.next().with_context(|| format!("{flag} needs a value"))?;
        map.insert(flag, value);
    }
    let take = |name: &str| {
        map.get(name)
            .cloned()
            .with_context(|| format!("missing {name}"))
    };
    Ok(Args {
        relay: take("--relay")?.trim_end_matches('/').to_string(),
        keys: take("--keys")?.into(),
        speakers: take("--speakers")?.into(),
        truth: take("--truth")?.into(),
        out: take("--out")?.into(),
        silence_secs: map
            .get("--silence-secs")
            .map(|v| v.parse())
            .transpose()?
            .unwrap_or(40),
        join: map
            .get("--join")
            .map(|v| -> Result<(Uuid, Uuid)> {
                let (parent, channel) = v
                    .split_once(':')
                    .context("--join is <parent-uuid>:<huddle-uuid>")?;
                Ok((parent.parse()?, channel.parse()?))
            })
            .transpose()?,
    })
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_or_create_keys(dir: &Path, name: &str) -> Result<Keys> {
    let path = dir.join(format!("{name}.nsec"));
    if path.exists() {
        let nsec = std::fs::read_to_string(&path)?;
        return Ok(Keys::parse(nsec.trim())?);
    }
    std::fs::create_dir_all(dir)?;
    let keys = Keys::generate();
    std::fs::write(&path, keys.secret_key().to_bech32()?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(keys)
}

/// 16-bit PCM mono 16 kHz WAV → f32 samples.
fn read_wav_16k(path: &Path) -> Result<Vec<f32>> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        bail!("{} is not a WAV file", path.display());
    }
    let mut pos = 12;
    let mut format_ok = false;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into()?) as usize;
        let body = bytes
            .get(pos + 8..pos + 8 + size)
            .context("truncated WAV chunk")?;
        if id == b"fmt " {
            let fmt = u16::from_le_bytes([body[0], body[1]]);
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let rate = u32::from_le_bytes(body[4..8].try_into()?);
            let bits = u16::from_le_bytes([body[14], body[15]]);
            if (fmt, channels, rate, bits) != (1, 1, 16_000, 16) {
                bail!("{}: need PCM16 mono 16 kHz", path.display());
            }
            format_ok = true;
        } else if id == b"data" {
            if !format_ok {
                bail!("{}: data before fmt", path.display());
            }
            return Ok(body
                .chunks_exact(2)
                .map(|s| f32::from(i16::from_le_bytes([s[0], s[1]])) / 32_768.0)
                .collect());
        }
        pos += 8 + size + (size & 1);
    }
    bail!("{}: no data chunk", path.display())
}

/// 16 kHz → 48 kHz by linear interpolation (the app captures at 48 kHz).
fn upsample_3x(pcm: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(pcm.len() * 3);
    for (i, &s) in pcm.iter().enumerate() {
        let next = pcm.get(i + 1).copied().unwrap_or(s);
        for k in 0..3 {
            out.push(s + (next - s) * k as f32 / 3.0);
        }
    }
    out
}

/// RMS level in dBov, clamped to the v2 header's `-127..=0`.
fn level_dbov(frame: &[f32]) -> i8 {
    let mean = frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32;
    if mean <= 0.0 {
        return -127;
    }
    (10.0 * mean.log10()).round().clamp(-127.0, 0.0) as i8
}

#[derive(Default)]
struct Stats {
    /// Listeners currently in the room.
    present: HashSet<&'static str>,
    /// (sender, seq) → send instant.
    sent: HashMap<(&'static str, u16), Instant>,
    /// Frames sent per sender.
    sent_total: HashMap<&'static str, u64>,
    /// (listener, sender) → frames sent while the listener was in the room.
    expected: HashMap<(&'static str, &'static str), u64>,
    /// (listener, sender) → latency of each received frame.
    received: HashMap<(&'static str, &'static str), Vec<Duration>>,
    /// Frames from a routing index no roster entry explained.
    unknown_sender: u64,
}

type Shared = Arc<Mutex<Stats>>;

struct Person {
    label: &'static str,
    keys: Keys,
    encoder: opus::Encoder,
    seq: u16,
    ts_48k: u32,
    sink: Option<WsSink>,
    reader: Option<tokio::task::JoinHandle<()>>,
    presence: Vec<(u64, Option<u64>)>,
}

impl Person {
    fn new(label: &'static str, keys: Keys) -> Result<Self> {
        let mut encoder =
            opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip)?;
        encoder.set_bitrate(opus::Bitrate::Bits(32_000))?;
        encoder.set_dtx(true)?;
        Ok(Self {
            label,
            keys,
            encoder,
            seq: 0,
            ts_48k: 0,
            sink: None,
            reader: None,
            presence: Vec::new(),
        })
    }

    fn pubkey(&self) -> String {
        self.keys.public_key().to_hex()
    }
}

struct Http {
    client: reqwest::Client,
    base: String,
}

impl Http {
    /// `POST /events` with NIP-98 auth, like the desktop's `submit_event`.
    async fn publish(&self, keys: &Keys, builder: EventBuilder, what: &str) -> Result<()> {
        let event = builder.sign_with_keys(keys)?;
        let url = format!("{}/events", self.base);
        let body = serde_json::to_string(&event)?;
        let auth = EventBuilder::new(Kind::Custom(27_235), "")
            .tags([
                Tag::parse(["u", url.as_str()])?,
                Tag::parse(["method", "POST"])?,
                Tag::parse(["payload", &hex::encode(Sha256::digest(body.as_bytes()))])?,
                Tag::parse(["nonce", &Uuid::new_v4().to_string()])?,
            ])
            .sign_with_keys(keys)?;
        let header = format!(
            "Nostr {}",
            base64::engine::general_purpose::STANDARD.encode(serde_json::to_string(&auth)?)
        );
        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", header)
            .body(body)
            .send()
            .await?;
        let status = response.status();
        let text = response.text().await?;
        let accepted = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("accepted").and_then(Value::as_bool))
            .unwrap_or(false);
        if !status.is_success() || !accepted {
            bail!(
                "{what} (kind {}) refused: {status} {text}",
                event.kind.as_u16()
            );
        }
        println!("  published {what} (kind {})", event.kind.as_u16());
        Ok(())
    }
}

async fn next_text(stream: &mut WsStream) -> Result<Value> {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .context("audio socket silent for 5 s")?;
        match message {
            Some(Ok(Message::Text(text))) => return Ok(serde_json::from_str(&text)?),
            Some(Ok(_)) => continue,
            Some(Err(e)) => bail!("audio socket error: {e}"),
            None => bail!("audio socket closed"),
        }
    }
}

fn roster_from(peers: &Value) -> HashMap<u8, String> {
    peers
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some((
                u8::try_from(p.get("peer_index")?.as_u64()?).ok()?,
                p.get("pubkey")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

/// Open `/huddle/{id}/audio`, pass NIP-42, wait for our own `joined`, and
/// start counting what we hear.
async fn join_audio(
    person: &mut Person,
    relay: &str,
    channel: Uuid,
    parent: Uuid,
    stats: &Shared,
    labels: &Arc<HashMap<String, &'static str>>,
) -> Result<()> {
    let url = format!("{relay}/huddle/{channel}/audio");
    let (ws, _) = tokio_tungstenite::connect_async(url.as_str()).await?;
    let (mut sink, mut stream) = ws.split();
    let challenge = loop {
        let v = next_text(&mut stream).await?;
        if v["type"] == "challenge" {
            break v["challenge"]
                .as_str()
                .context("challenge without value")?
                .to_string();
        }
    };
    let auth = buzz_ws_client::build_auth_event(&challenge, relay, &person.keys, None)?;
    let hello = json!({
        "type": "auth",
        "event": auth,
        "parent_channel_id": parent,
        "protocol_version": 2,
    });
    sink.send(Message::Text(hello.to_string().into())).await?;
    let me = person.pubkey();
    let joined = loop {
        let v = next_text(&mut stream).await?;
        match v["type"].as_str() {
            Some("joined") if v["pubkey"] == me.as_str() => break v,
            Some("error") => bail!("{} refused: {v}", person.label),
            _ => {}
        }
    };
    let roster = roster_from(&joined["peers"]);
    println!(
        "  {} joined audio as peer_index {} epoch {} ({} in room)",
        person.label,
        joined["peer_index"],
        joined["epoch"],
        roster.len()
    );
    stats.lock().expect("stats").present.insert(person.label);
    person.presence.push((unix_ms(), None));
    person.reader = Some(tokio::spawn(read_loop(
        person.label,
        stream,
        roster,
        Arc::clone(stats),
        Arc::clone(labels),
    )));
    person.sink = Some(sink);
    Ok(())
}

async fn read_loop(
    me: &'static str,
    mut stream: WsStream,
    mut roster: HashMap<u8, String>,
    stats: Shared,
    labels: Arc<HashMap<String, &'static str>>,
) {
    while let Some(message) = stream.next().await {
        match message {
            Ok(Message::Binary(frame)) => {
                // v1/v2 relay prefix: [peer_index][8-byte header][opus].
                if frame.len() < 10 {
                    continue;
                }
                let now = Instant::now();
                let seq = u16::from_be_bytes([frame[1], frame[2]]);
                let mut stats = stats.lock().expect("stats");
                let Some(sender) = roster.get(&frame[0]).and_then(|pk| labels.get(pk).copied())
                else {
                    stats.unknown_sender += 1;
                    continue;
                };
                let latency = stats
                    .sent
                    .get(&(sender, seq))
                    .map(|sent| now.saturating_duration_since(*sent));
                if let Some(latency) = latency {
                    stats
                        .received
                        .entry((me, sender))
                        .or_default()
                        .push(latency);
                }
            }
            Ok(Message::Text(text)) => {
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                match v["type"].as_str() {
                    Some("joined") => roster = roster_from(&v["peers"]),
                    Some("left") => {
                        if let Some(index) = v["peer_index"].as_u64() {
                            roster.remove(&(index as u8));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

/// Close the audio socket like the app (`Close(None)`), after optional events.
async fn leave_audio(person: &mut Person, stats: &Shared) {
    stats.lock().expect("stats").present.remove(person.label);
    if let Some(mut sink) = person.sink.take() {
        let _ = sink.send(Message::Close(None)).await;
        let _ = sink.close().await;
    }
    if let Some(reader) = person.reader.take() {
        let _ = tokio::time::timeout(Duration::from_secs(5), reader).await;
    }
    if let Some(last) = person.presence.last_mut() {
        last.1 = Some(unix_ms());
    }
    println!("  {} left audio", person.label);
}

/// Send `pcm48` in real time as v2 frames. Returns (start, end) wall ms.
async fn speak(person: &mut Person, pcm48: &[f32], stats: &Shared) -> Result<(u64, u64)> {
    let label = person.label;
    let sink = person.sink.as_mut().context("speaker not in the room")?;
    let start = unix_ms();
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    let mut packet = vec![0u8; 1500];
    for chunk in pcm48.chunks(FRAME_SAMPLES_48K) {
        tick.tick().await;
        let mut frame = [0f32; FRAME_SAMPLES_48K];
        frame[..chunk.len()].copy_from_slice(chunk);
        let n = person.encoder.encode_float(&frame, &mut packet)?;
        if n == 0 {
            continue;
        }
        let mut message = Vec::with_capacity(8 + n);
        message.extend_from_slice(&person.seq.to_be_bytes());
        message.extend_from_slice(&person.ts_48k.to_be_bytes());
        message.push(level_dbov(&frame) as u8);
        message.push(if n <= 2 { 0x01 } else { 0x00 });
        message.extend_from_slice(&packet[..n]);
        {
            let mut stats = stats.lock().expect("stats");
            stats.sent.insert((label, person.seq), Instant::now());
            *stats.sent_total.entry(label).or_default() += 1;
            let listeners: Vec<_> = stats
                .present
                .iter()
                .copied()
                .filter(|l| *l != label)
                .collect();
            for listener in listeners {
                *stats.expected.entry((listener, label)).or_default() += 1;
            }
        }
        sink.send(Message::Binary(message.into())).await?;
        person.seq = person.seq.wrapping_add(1);
        person.ts_48k = person.ts_48k.wrapping_add(FRAME_SAMPLES_48K as u32);
    }
    Ok((start, unix_ms()))
}

struct Sentence {
    /// Where the speech starts in the speaker WAV, ms (sort key).
    wav_start_ms: u64,
    id: String,
    text: String,
    pcm48: Vec<f32>,
    /// Speech start/end inside `pcm48`, ms.
    speech_ms: (u64, u64),
}

/// The fake meeting's sentences for `label`, cut from its speaker WAV.
fn sentences(truth: &Value, speakers: &Path, label: &str) -> Result<Vec<Sentence>> {
    let wav = read_wav_16k(&speakers.join(format!("{label}.wav")))?;
    let wav_ms = wav.len() as u64 * 1000 / 16_000;
    let mut out = Vec::new();
    for u in truth["utterances"].as_array().context("truth utterances")? {
        if u["label"] != label {
            continue;
        }
        let start = u["speaker_wav_start_ms"].as_u64().context("start")?;
        let end = u["speaker_wav_end_ms"].as_u64().context("end")?;
        let from = start.saturating_sub(SLICE_MARGIN_MS);
        let to = (end + SLICE_MARGIN_MS).min(wav_ms);
        let slice = &wav[(from * 16) as usize..(to * 16) as usize];
        out.push(Sentence {
            wav_start_ms: start,
            id: u["id"].as_str().unwrap_or_default().to_string(),
            text: u["text"].as_str().unwrap_or_default().to_string(),
            pcm48: upsample_3x(slice),
            speech_ms: (start - from, end - from),
        });
    }
    out.sort_by_key(|s| s.wav_start_ms);
    Ok(out)
}

/// The app's `start_huddle`: open parent channel (A creates, B joins), the
/// private ttl backing channel, then 48100 in the parent.
async fn start_huddle(
    http: &Http,
    people: &[Person; 2],
    parent: Uuid,
    channel: Uuid,
) -> Result<()> {
    // Parent channel: A creates it open, B joins (kind 9021).
    http.publish(
        &people[0].keys,
        buzz_sdk::build_create_channel(
            parent,
            "e2e recorder test",
            Some(Visibility::Open),
            Some(ChannelKind::Stream),
            None,
            None,
        )?,
        "parent channel",
    )
    .await?;
    http.publish(
        &people[1].keys,
        buzz_sdk::build_join(parent)?,
        "B joins parent",
    )
    .await?;
    // start_huddle: backing channel, then 48100 in the parent.
    http.publish(
        &people[0].keys,
        buzz_sdk::build_create_channel(
            channel,
            "e2e recorder test huddle",
            Some(Visibility::Private),
            Some(ChannelKind::Stream),
            None,
            Some(3600),
        )?,
        "huddle backing channel",
    )
    .await?;
    http.publish(
        &people[0].keys,
        EventBuilder::new(
            Kind::Custom(48_100),
            json!({ "ephemeral_channel_id": channel }).to_string(),
        )
        .tags([Tag::parse(["h", &parent.to_string()])?]),
        "huddle started",
    )
    .await?;

    Ok(())
}

#[derive(Clone, Copy)]
enum Who {
    A,
    B,
}

enum Step {
    Say(Who, usize),
    Silence(Duration),
    LeaveMidway(Who),
    Rejoin(Who),
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args = parse_args()?;
    std::fs::create_dir_all(&args.out)?;
    let truth: Value = serde_json::from_slice(&std::fs::read(&args.truth)?)?;
    let lines = [
        sentences(&truth, &args.speakers, "A")?,
        sentences(&truth, &args.speakers, "B")?,
    ];
    let http = Http {
        client: reqwest::Client::new(),
        base: args
            .relay
            .replacen("wss://", "https://", 1)
            .replacen("ws://", "http://", 1),
    };
    let mut people = [
        Person::new("A", load_or_create_keys(&args.keys, "a")?)?,
        Person::new("B", load_or_create_keys(&args.keys, "b")?)?,
    ];
    let labels: Arc<HashMap<String, &'static str>> =
        Arc::new(people.iter().map(|p| (p.pubkey(), p.label)).collect());
    let stats: Shared = Arc::default();

    let (parent, channel) = args
        .join
        .unwrap_or_else(|| (Uuid::new_v4(), Uuid::new_v4()));
    println!("parent channel {parent}\nhuddle channel {channel}");
    println!("A {}\nB {}", people[0].pubkey(), people[1].pubkey());
    if args.join.is_none() {
        start_huddle(&http, &people, parent, channel).await?;
    }

    let started = unix_ms();
    // A failure from here on (a refused join, a socket the relay closed) cuts
    // the run short but still writes the report.
    let mut interrupted: Option<String> = None;
    for person in people.iter_mut() {
        if let Err(e) = join_audio(person, &args.relay, channel, parent, &stats, &labels).await {
            interrupted = Some(format!("{} could not join: {e:#}", person.label));
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    use Step::*;
    use Who::{A, B};
    let full = vec![
        Say(A, 0),
        Say(B, 0),
        Say(A, 1),
        Say(B, 1),
        LeaveMidway(B),
        Say(A, 2),
        Rejoin(B),
        Say(B, 2),
        Say(A, 3),
        Silence(Duration::from_secs(args.silence_secs)),
        Say(B, 4),
        Say(A, 4),
        Say(B, 5),
    ];
    let plan = match (&interrupted, args.join) {
        (Some(_), _) => Vec::new(),
        (None, Some(_)) => vec![Say(A, 0), Say(B, 0)],
        (None, None) => full,
    };
    let mut said = Vec::new();
    for step in plan {
        let result: Result<()> = async {
            match step {
                Say(who, n) => {
                    let i = who as usize;
                    let sentence = lines[i].get(n).context("not enough sentences")?;
                    println!(
                        "  {} says {} ({} ms)",
                        people[i].label,
                        sentence.id,
                        sentence.pcm48.len() / 48
                    );
                    let (start, end) = speak(&mut people[i], &sentence.pcm48, &stats).await?;
                    said.push(json!({
                        "id": sentence.id,
                        "label": people[i].label,
                        "speaker": people[i].pubkey(),
                        "text": sentence.text,
                        "send_start_unix_ms": start,
                        "send_end_unix_ms": end,
                        "speech_start_unix_ms": start + sentence.speech_ms.0,
                        "speech_end_unix_ms": start + sentence.speech_ms.1,
                    }));
                    tokio::time::sleep(TURN_GAP).await;
                }
                Silence(d) => {
                    println!("  everyone muted for {} s", d.as_secs());
                    tokio::time::sleep(d).await;
                }
                LeaveMidway(who) => {
                    let i = who as usize;
                    // Others remain, so the app sends 9022 (leave) before closing.
                    if let Err(e) = http
                        .publish(&people[i].keys, buzz_sdk::build_leave(channel)?, "leave")
                        .await
                    {
                        println!("  warning: {e}");
                    }
                    leave_audio(&mut people[i], &stats).await;
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                Rejoin(who) => {
                    let i = who as usize;
                    join_audio(
                        &mut people[i],
                        &args.relay,
                        channel,
                        parent,
                        &stats,
                        &labels,
                    )
                    .await?;
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            println!("  run cut short: {e:#}");
            interrupted = Some(format!("{e:#}"));
            break;
        }
    }

    // End: B leaves (others remain), then A — the last one — ends the huddle
    // (48103 + archive) before closing, like `emit_end_and_archive`. A run
    // cut short only closes whatever sockets are still open.
    let mut end_notes = Vec::new();
    if interrupted.is_some() {
        for person in people.iter_mut() {
            if person.sink.is_some() {
                leave_audio(person, &stats).await;
            }
        }
    } else {
        if let Err(e) = http
            .publish(&people[1].keys, buzz_sdk::build_leave(channel)?, "leave")
            .await
        {
            println!("  warning: {e}");
        }
        leave_audio(&mut people[1], &stats).await;
        for (builder, what) in [
            (
                EventBuilder::new(
                    Kind::Custom(48_103),
                    json!({ "ephemeral_channel_id": channel }).to_string(),
                )
                .tags([Tag::parse(["h", &parent.to_string()])?]),
                "huddle ended",
            ),
            (buzz_sdk::build_archive(channel)?, "archive backing channel"),
        ] {
            if let Err(e) = http.publish(&people[0].keys, builder, what).await {
                println!("  warning: {e}");
                end_notes.push(e.to_string());
            }
        }
        leave_audio(&mut people[0], &stats).await;
    }
    let ended = unix_ms();

    let stats = stats.lock().expect("stats");
    let mut delivery = Vec::new();
    for listener in ["A", "B"] {
        for sender in ["A", "B"] {
            if listener == sender {
                continue;
            }
            let expected = stats
                .expected
                .get(&(listener, sender))
                .copied()
                .unwrap_or(0);
            let mut latencies = stats
                .received
                .get(&(listener, sender))
                .cloned()
                .unwrap_or_default();
            latencies.sort();
            let pick = |q: f64| {
                latencies
                    .get(((latencies.len() as f64 - 1.0) * q).round() as usize)
                    .map(|d| d.as_secs_f64() * 1000.0)
            };
            delivery.push(json!({
                "listener": listener,
                "sender": sender,
                "expected": expected,
                "received": latencies.len(),
                "missing": expected.saturating_sub(latencies.len() as u64),
                "p50_ms": pick(0.5),
                "p95_ms": pick(0.95),
                "max_ms": pick(1.0),
            }));
        }
    }
    let report = json!({
        "relay": args.relay,
        "parent_channel_id": parent,
        "channel_id": channel,
        "started_unix_ms": started,
        "ended_unix_ms": ended,
        "speakers": people.iter().map(|p| json!({
            "label": p.label,
            "pubkey": p.pubkey(),
            "presence_unix_ms": p.presence,
        })).collect::<Vec<_>>(),
        "utterances": said,
        "frames_sent": stats.sent_total,
        "delivery": delivery,
        "unknown_sender_frames": stats.unknown_sender,
        "end_event_errors": end_notes,
        "interrupted": interrupted,
        "mode": if args.join.is_some() { "join" } else { "new" },
    });
    let path = args.out.join("sent.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&report)?)?;
    println!("wrote {}", path.display());
    println!("{}", serde_json::to_string_pretty(&report["delivery"])?);
    Ok(())
}
