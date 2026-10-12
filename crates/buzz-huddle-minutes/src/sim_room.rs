//! 회의실 마이크 가짜 회의: 정답(누가·언제·무슨 말)이 있는 녹음을 만든다.
//!
//! 화자 나누기(B)·누가 누군지(C)·새는 소리(A)를 재려고 쓴다. 화자는 진짜로 다른 사람이어야
//! 하므로 화자 id 가 붙은 한국어 소리(Zeroth-Korean)를 쓴다([`load_voice_clips`]).
//!
//! - 회의실 사람들: 기기 하나(회의실 마이크)에 같이 잡힌다. 사람마다 마이크와의 거리가 달라
//!   소리 크기가 다르고, 방 울림([`RoomAcoustics`])·방 잡음·노트북 마이크의 높은 소리 깎임이 있다.
//! - 원격 사람들: 자기 기기, 가까운 마이크(깨끗한 소리).
//! - 에코(선택): 원격 사람 소리가 회의실 스피커로 나와 회의실 마이크에 다시 잡힌다
//!   (앱 에코 제거가 놓친 것, 작게, 늦게, 울림과 함께).
//! - 말 순서: 한 문장씩 번갈아, 짧은 쉼, 가끔 겹쳐 말하기.
//!
//! 녹음은 [`crate::sim`] 과 같은 방식(Opus v2 프레임, `.bhr` 조각, manifest)으로 만든다.
//! 사람 pubkey 는 데이터의 화자 id 로만 정해서 회의가 달라도 같은 사람은 같은 pubkey 다
//! (회의 사이 프로필을 잴 수 있게).

use std::path::Path;

use anyhow::{bail, Context};
use buzz_huddle_recording::{
    chunk_key, format_utc_millis, manifest_key, EndReason, Manifest, ManifestParticipant, FORMAT,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audio::{read_wav_mono_i16, resample};
use crate::sim::{
    client_frames, digest, level_and_trim, ms_u32, occ, uuid_from, write_chunks, Clip, Event, Rng,
    Truth, TruthSpeaker, TruthUtterance, TRUTH_FORMAT,
};

/// [`RoomTruth::format`] 값.
pub const ROOM_TRUTH_FORMAT: &str = "huddle-room-meeting-truth/1";
const RATE: usize = 16_000;

/// 화자 id 가 붙은 문장 하나.
#[derive(Debug, Clone)]
pub struct VoiceClip {
    /// 데이터의 화자 id.
    pub speaker: String,
    /// 소리와 글.
    pub clip: Clip,
}

#[derive(Deserialize)]
struct ManifestLine {
    id: String,
    audio: String,
    text: String,
    speaker: String,
}

/// `{"id","audio","text","speaker"}` 줄 manifest(16kHz 16비트 모노 WAV)를 읽는다. 화자마다
/// 앞에서 `per_speaker` 개까지. 가장자리 조용한 곳을 자르고 소리 크기를 맞춘다
/// ([`crate::sim::load_bench_clips`] 와 같은 규칙).
pub fn load_voice_clips(manifest: &Path, per_speaker: usize) -> anyhow::Result<Vec<VoiceClip>> {
    let text = std::fs::read_to_string(manifest)
        .with_context(|| format!("read {}", manifest.display()))?;
    let dir = manifest.parent().unwrap_or(Path::new("."));
    let mut taken: std::collections::HashMap<String, usize> = Default::default();
    let mut out = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let entry: ManifestLine = serde_json::from_str(line).context("manifest line")?;
        let count = taken.entry(entry.speaker.clone()).or_default();
        if *count >= per_speaker {
            continue;
        }
        *count += 1;
        let path = dir.join(&entry.audio);
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let (rate, pcm) = read_wav_mono_i16(&bytes)?;
        if rate != 16_000 {
            bail!("{}: {rate} Hz, expected 16000", path.display());
        }
        let pcm_16k = level_and_trim(&pcm);
        out.push(VoiceClip {
            speaker: entry.speaker,
            clip: Clip {
                id: entry.id,
                text: entry.text,
                speech_start: 0,
                speech_end: pcm_16k.len(),
                speech_units: Vec::new(),
                pcm_16k,
            },
        });
    }
    Ok(out)
}

/// 방 소리.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RoomAcoustics {
    /// 울림 시간(RT60, 초) 범위. 회의마다 하나 고른다.
    pub rt60_s: (f32, f32),
    /// 1m 에서 직접 소리 대 울림 비(dB). 멀수록 울림이 상대적으로 커진다.
    pub drr_at_1m_db: f32,
    /// 방 잡음(dBFS RMS, 소리 크기 맞춘 뒤).
    pub noise_dbfs: f32,
    /// 노트북 마이크가 깎는 높은 소리(Hz, 1차 저역 통과).
    pub lowpass_hz: f32,
    /// 울림 꼬리의 탭 밀도(초당, 성긴 무작위 탭 = velvet noise).
    pub taps_per_s: f32,
}

impl Default for RoomAcoustics {
    fn default() -> Self {
        Self {
            rt60_s: (0.3, 0.6),
            drr_at_1m_db: 3.0,
            noise_dbfs: -55.0,
            lowpass_hz: 5_000.0,
            taps_per_s: 800.0,
        }
    }
}

/// 사람이 어디 있나.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Seat {
    /// 회의실, 마이크에서 이만큼(m).
    Room {
        /// 마이크까지 거리(m).
        distance_m: f32,
    },
    /// 원격, 자기 기기.
    Remote,
}

/// 회의에 나오는 사람 하나.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedPerson {
    /// 데이터의 화자 id.
    pub speaker: String,
    /// 어디 있나.
    pub seat: Seat,
    /// 이 회의에서 말할 문장들(`clips` 안 순번, 이 사람 것이어야 한다).
    pub clips: Vec<usize>,
}

/// 에코(원격 소리가 회의실 마이크로 다시 들어감).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EchoPlan {
    /// 원격 사람 소리보다 이만큼 작게(dB, 음수).
    pub gain_db: f32,
    /// 이만큼 늦게(ms).
    pub delay_ms: u64,
}

/// 회의 계획.
#[derive(Debug, Clone, PartialEq)]
pub struct RoomPlan {
    /// 사람들.
    pub people: Vec<PlannedPerson>,
    /// 회의실 기기 주인: `Some(i)` = `people[i]`(회의실 사람), `None` = 말하지 않는 다른 사람.
    pub room_owner: Option<usize>,
    /// 에코.
    pub echo: Option<EchoPlan>,
    /// 방 소리.
    pub acoustics: RoomAcoustics,
    /// 겹쳐 말하기 확률(0~1).
    pub overlap_chance: f32,
}

/// 정답의 사람.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoomPerson {
    /// 사람 pubkey(데이터 화자 id 로 정해짐).
    pub pubkey: String,
    /// 데이터의 화자 id.
    pub speaker: String,
    /// 어디 있었나.
    pub seat: Seat,
    /// 이 사람 소리가 실린 트랙(기기) pubkey.
    pub device: String,
}

/// 정답의 문장.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoomUtterance {
    /// 문장 id.
    pub id: String,
    /// 말한 사람 pubkey.
    pub person: String,
    /// 실린 트랙 pubkey.
    pub device: String,
    /// 말 시작(회의 ms).
    pub start_ms: u64,
    /// 말 끝(회의 ms).
    pub end_ms: u64,
    /// 글.
    pub text: String,
    /// 문장 안 말 단위(깨끗한 소리에서 찾은 것), `[start, end]` 회의 ms.
    pub speech_units_ms: Vec<[u64; 2]>,
}

/// 정답의 에코 하나(회의실 트랙에 다시 들어간 원격 문장).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoomEcho {
    /// 원래 문장 id.
    pub id: String,
    /// 회의실 트랙 pubkey.
    pub device: String,
    /// 회의실 트랙에서 시작(회의 ms).
    pub start_ms: u64,
    /// 끝.
    pub end_ms: u64,
}

/// 회의실 가짜 회의의 정답.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoomTruth {
    /// 늘 [`ROOM_TRUTH_FORMAT`].
    pub format: String,
    /// 커뮤니티 id.
    pub community_id: Uuid,
    /// 허들 채널 id.
    pub channel_id: Uuid,
    /// 저장 접두사.
    pub prefix: String,
    /// 회의 시작(UTC).
    pub started_at: String,
    /// 회의 길이(ms).
    pub duration_ms: u64,
    /// 사람들.
    pub people: Vec<RoomPerson>,
    /// 회의실 트랙 pubkey(회의실 사람이 없으면 `None`).
    pub room_device: Option<String>,
    /// 회의실 기기 주인 pubkey(말하지 않는 사람일 수도 있다).
    pub room_owner: Option<String>,
    /// 문장들, 시작 순.
    pub utterances: Vec<RoomUtterance>,
    /// 에코들.
    pub echoes: Vec<RoomEcho>,
}

/// 만든 회의: 정답, 받아쓰기 시험 대역용 정답(트랙마다 들리는 문장, 에코 포함), 파일들.
#[derive(Debug, Clone)]
pub struct RoomMeeting {
    /// 정답.
    pub truth: RoomTruth,
    /// [`crate::stt::TruthStt`] 에 줄 것: 문장의 `speaker` = 실린 트랙, 에코도 회의실 트랙
    /// 문장으로 들어 있다(그래서 에코가 남으면 같은 글이 두 번 나온다).
    pub stt_truth: Truth,
    /// `(상대 경로, 바이트)`.
    pub files: Vec<(String, Vec<u8>)>,
}

/// 사람 pubkey: 데이터 화자 id 로만 정한다(회의가 달라도 같다).
pub fn person_pubkey(speaker: &str) -> String {
    hex::encode(digest(&["huddle-room-sim", "person", speaker]))
}

/// 성긴 방 울림(velvet noise): 직접 소리(거리만큼 늦고 1/거리 크기) + 지수로 줄어드는 무작위 탭.
/// `(늦음 샘플, 크기)` 목록.
pub(crate) fn room_impulse(
    rng: &mut Rng,
    distance_m: f32,
    rt60_s: f32,
    acoustics: &RoomAcoustics,
) -> Vec<(usize, f32)> {
    let direct_at = (distance_m / 343.0 * RATE as f32).round() as usize;
    let mut taps = vec![(direct_at, 1.0 / distance_m.max(0.1))];
    let tail_energy = 10f32.powf(-acoustics.drr_at_1m_db / 10.0);
    let amp = (tail_energy * 13.816 / (acoustics.taps_per_s * rt60_s)).sqrt();
    let spacing = RATE as f32 / acoustics.taps_per_s;
    let start = direct_at + (0.0025 * RATE as f32) as usize;
    let count = (rt60_s * acoustics.taps_per_s) as usize;
    for k in 0..count {
        let jitter = (rng.below(1_000) as f32 / 1_000.0) * spacing;
        let at = start + (k as f32 * spacing + jitter) as usize;
        let t = (at - start) as f32 / RATE as f32;
        let sign = if rng.below(2) == 0 { 1.0 } else { -1.0 };
        taps.push((at, sign * amp * (-6.908 * t / rt60_s).exp()));
    }
    taps
}

/// `out[at + n] += Σ amp · x[n − delay]`.
fn add_convolved(out: &mut [f32], at: usize, x: &[f32], taps: &[(usize, f32)], gain: f32) {
    for &(delay, amp) in taps {
        let a = amp * gain;
        let from = at + delay;
        if from >= out.len() {
            continue;
        }
        for (o, s) in out[from..].iter_mut().zip(x) {
            *o += a * s;
        }
    }
}

fn peak_rms(pcm: &[f32]) -> f32 {
    pcm.chunks(RATE / 100)
        .map(|f| (f.iter().map(|x| x * x).sum::<f32>() / f.len() as f32).sqrt())
        .fold(0.0, f32::max)
}

/// 가짜 회의가 모두 쓰는 커뮤니티(회의 사이 목소리 프로필은 커뮤니티 안에서만 이어진다).
pub fn sim_community() -> Uuid {
    uuid_from(&["huddle-room-sim", "community"])
}

/// 회의실 가짜 회의를 [`sim_community`] 에 만든다. `clips` 는 [`load_voice_clips`] 결과(말 위치는
/// [`crate::sim::mark_speech`] 로 찍어 둔 것).
pub fn build_room_meeting(
    clips: &[VoiceClip],
    plan: &RoomPlan,
    seed: u64,
    prefix: &str,
    start_unix_ms: u64,
) -> anyhow::Result<RoomMeeting> {
    build_room_meeting_in(sim_community(), clips, plan, seed, prefix, start_unix_ms)
}

/// [`build_room_meeting`] 을 커뮤니티 `community_id` 에.
pub fn build_room_meeting_in(
    community_id: Uuid,
    clips: &[VoiceClip],
    plan: &RoomPlan,
    seed: u64,
    prefix: &str,
    start_unix_ms: u64,
) -> anyhow::Result<RoomMeeting> {
    let seed_text = seed.to_string();
    let mut rng = Rng(seed ^ 0x0700_5eed);
    let channel_id = uuid_from(&["huddle-room-sim", &seed_text, "channel"]);
    let session_id = uuid_from(&["huddle-room-sim", &seed_text, "session"]);
    for person in &plan.people {
        for &c in &person.clips {
            let clip = clips.get(c).context("clip index")?;
            if clip.speaker != person.speaker {
                bail!("clip {} is not speaker {}'s", clip.clip.id, person.speaker);
            }
        }
    }
    let in_room: Vec<usize> = (0..plan.people.len())
        .filter(|&i| matches!(plan.people[i].seat, Seat::Room { .. }))
        .collect();
    if let Some(owner) = plan.room_owner {
        if !in_room.contains(&owner) {
            bail!("the room device owner must be in the room");
        }
    }

    // Devices: the room mic (if anyone is in the room), then one per remote person.
    let pubkeys: Vec<String> = plan
        .people
        .iter()
        .map(|p| person_pubkey(&p.speaker))
        .collect();
    let room_device = (!in_room.is_empty()).then(|| match plan.room_owner {
        Some(owner) => pubkeys[owner].clone(),
        None => hex::encode(digest(&["huddle-room-sim", &seed_text, "room-device"])),
    });
    let mut devices: Vec<String> = room_device.iter().cloned().collect();
    let device_of: Vec<usize> = plan
        .people
        .iter()
        .enumerate()
        .map(|(i, person)| match person.seat {
            Seat::Room { .. } => 0,
            Seat::Remote => {
                devices.push(pubkeys[i].clone());
                devices.len() - 1
            }
        })
        .collect();

    // 1. Turns: one sentence each, the next person a different one when there
    //    is a choice, short pauses, now and then talking over the end.
    let mut queue: Vec<Vec<usize>> = plan.people.iter().map(|p| p.clips.clone()).collect();
    let mut placed: Vec<(usize, u64, usize)> = Vec::new(); // (person, speech start, clip)
    let mut t: i64 = 1_500;
    let mut last: Option<usize> = None;
    let mut previous_end: i64 = 0;
    while queue.iter().any(|q| !q.is_empty()) {
        let open: Vec<usize> = (0..queue.len()).filter(|&i| !queue[i].is_empty()).collect();
        let choices: Vec<usize> = open.iter().copied().filter(|&i| Some(i) != last).collect();
        let pool = if choices.is_empty() { &open } else { &choices };
        let who = pool[usize::try_from(rng.below(pool.len() as u64))?];
        let clip = queue[who].remove(0);
        let (from, to) = speech_ms(&clips[clip].clip);
        if last.is_some() {
            let overlap = (rng.below(1_000) as f32) < plan.overlap_chance * 1_000.0;
            t = if overlap {
                previous_end - 300 - i64::try_from(rng.below(600))?
            } else {
                previous_end + 250 + i64::try_from(rng.below(950))?
            };
        }
        let start = u64::try_from(t.max(i64::try_from(from)?))?;
        placed.push((who, start, clip));
        previous_end = previous_end.max(i64::try_from(start + (to - from))?);
        t = previous_end;
        last = Some(who);
    }
    let last_end = u64::try_from(previous_end)?;
    let duration_ms = last_end + 2_000;
    let total = usize::try_from(duration_ms)? * RATE / 1_000;

    // 2. Each device's sound at 16 kHz.
    let rt60 = plan.acoustics.rt60_s.0
        + (plan.acoustics.rt60_s.1 - plan.acoustics.rt60_s.0) * (rng.below(1_000) as f32 / 1_000.0);
    let impulses: Vec<Option<Vec<(usize, f32)>>> = plan
        .people
        .iter()
        .map(|p| match p.seat {
            Seat::Room { distance_m } => {
                Some(room_impulse(&mut rng, distance_m, rt60, &plan.acoustics))
            }
            Seat::Remote => None,
        })
        .collect();
    let speaker_impulse = room_impulse(&mut rng, 1.5, rt60, &plan.acoustics);
    let mut signals = vec![vec![0f32; total]; devices.len()];
    let mut utterances = Vec::with_capacity(placed.len());
    let mut echoes = Vec::new();
    for &(who, start, c) in &placed {
        let clip = &clips[c].clip;
        let (from, to) = speech_ms(clip);
        let at = usize::try_from(start - from)? * RATE / 1_000;
        let device = device_of[who];
        match &impulses[who] {
            Some(taps) => add_convolved(&mut signals[device], at, &clip.pcm_16k, taps, 1.0),
            None => {
                for (o, s) in signals[device][at.min(total)..]
                    .iter_mut()
                    .zip(&clip.pcm_16k)
                {
                    *o += s;
                }
                if let (Some(echo), Some(_)) = (plan.echo, &room_device) {
                    let delay = usize::try_from(echo.delay_ms)? * RATE / 1_000;
                    let gain = 10f32.powf(echo.gain_db / 20.0);
                    add_convolved(
                        &mut signals[0],
                        at + delay,
                        &clip.pcm_16k,
                        &speaker_impulse,
                        gain,
                    );
                    echoes.push(RoomEcho {
                        id: clip.id.clone(),
                        device: devices[0].clone(),
                        start_ms: start + echo.delay_ms,
                        end_ms: start + echo.delay_ms + (to - from),
                    });
                }
            }
        }
        utterances.push(RoomUtterance {
            id: clip.id.clone(),
            person: pubkeys[who].clone(),
            device: devices[device].clone(),
            start_ms: start,
            end_ms: start + (to - from),
            text: clip.text.clone(),
            speech_units_ms: clip
                .speech_units
                .iter()
                .map(|&(a, b)| {
                    let ms = |x: usize| x as u64 * 1_000 / RATE as u64;
                    [start + ms(a) - from, start + ms(b) - from]
                })
                .collect(),
        });
    }
    // The room mic: a laptop mic's top end, level brought to the clips'
    // (loudest 10 ms at -20 dBFS, as a gain control would), room noise.
    if room_device.is_some() {
        let room = &mut signals[0];
        let alpha = 1.0 - (-std::f32::consts::TAU * plan.acoustics.lowpass_hz / RATE as f32).exp();
        let mut y = 0.0;
        for x in room.iter_mut() {
            y += alpha * (*x - y);
            *x = y;
        }
        let peak = peak_rms(room);
        if peak > 0.0 {
            let gain = 0.1 / peak;
            room.iter_mut().for_each(|x| *x *= gain);
        }
        let noise_rms = 10f32.powf(plan.acoustics.noise_dbfs / 20.0);
        let beta = 1.0 - (-std::f32::consts::TAU * 400.0 / RATE as f32).exp();
        let mut low = 0.0f32;
        // Low rumble plus some hiss; white noise in [-1, 1) has RMS 1/sqrt(3).
        for x in room.iter_mut() {
            let white = rng.signed_unit() * 3f32.sqrt();
            low += beta * (white - low);
            *x += noise_rms * (0.8 * low * 4.0 + 0.6 * white);
        }
    }

    // 3. The recording: one session, everyone joins at the start.
    let tracks: Vec<(String, Vec<f32>)> = devices.iter().cloned().zip(signals).collect();
    let mut files = record_session(
        &tracks,
        (community_id, channel_id, session_id),
        prefix,
        start_unix_ms,
        duration_ms,
        &mut rng,
    )?;
    let session_end = duration_ms;

    utterances.sort_by_key(|u| u.start_ms);
    let people = plan
        .people
        .iter()
        .enumerate()
        .map(|(i, p)| RoomPerson {
            pubkey: pubkeys[i].clone(),
            speaker: p.speaker.clone(),
            seat: p.seat,
            device: devices[device_of[i]].clone(),
        })
        .collect();
    let truth = RoomTruth {
        format: ROOM_TRUTH_FORMAT.into(),
        community_id,
        channel_id,
        prefix: prefix.into(),
        started_at: format_utc_millis(start_unix_ms),
        duration_ms: session_end,
        people,
        room_device: room_device.clone(),
        room_owner: room_device.as_ref().map(|_| match plan.room_owner {
            Some(owner) => pubkeys[owner].clone(),
            None => devices[0].clone(),
        }),
        utterances,
        echoes,
    };
    let stt_truth = stt_truth_of(&truth);
    files.push(("room-truth.json".into(), serde_json::to_vec_pretty(&truth)?));
    Ok(RoomMeeting {
        truth,
        stt_truth,
        files,
    })
}

/// 기기마다 16kHz 소리(회의 시각 0 부터)를 릴레이 녹음기가 쓴 것처럼 만든다: 세션 하나, 모두 처음에
/// 들어옴, Opus v2 프레임, 30초 `.bhr` 조각, manifest. `(상대 경로, 바이트)` 를 돌려준다.
fn record_session(
    tracks: &[(String, Vec<f32>)],
    ids: (Uuid, Uuid, Uuid),
    prefix: &str,
    start_unix_ms: u64,
    duration_ms: u64,
    rng: &mut Rng,
) -> anyhow::Result<Vec<(String, Vec<u8>)>> {
    let pubkey_bytes: Vec<[u8; 32]> = tracks
        .iter()
        .map(|(d, _)| {
            let mut out = [0u8; 32];
            hex::decode_to_slice(d, &mut out).map(|_| out)
        })
        .collect::<Result<_, _>>()?;
    let mut events = Vec::new();
    let mut order = 0u64;
    let session_end = duration_ms;
    let (community_id, channel_id, session_id) = ids;
    for (index, (_, signal)) in tracks.iter().enumerate() {
        let occupancy = occ(
            0,
            index,
            u8::try_from(index)?,
            1,
            200 + 50 * index as u64,
            session_end,
        );
        events.push((occupancy.join_ms, 0u8, order, Event::Join(occupancy)));
        order += 1;
        let up = resample(signal, 16_000, 48_000)?;
        for (receive_ms, payload) in client_frames(&occupancy, &up, &[], rng)? {
            if receive_ms >= session_end {
                continue;
            }
            events.push((
                receive_ms,
                1,
                order,
                Event::Frame {
                    peer_index: occupancy.peer_index,
                    epoch: 1,
                    payload,
                },
            ));
            order += 1;
        }
    }
    events.sort_by_key(|(t, rank, order, _)| (*t, *rank, *order));
    let (chunks, manifest_chunks) = write_chunks(
        &events,
        &pubkey_bytes,
        prefix,
        community_id,
        channel_id,
        session_id,
        start_unix_ms,
        0,
    )?;
    let mut files = Vec::new();
    for (seq, bytes) in chunks.into_iter().enumerate() {
        let key = chunk_key(
            prefix,
            community_id,
            channel_id,
            session_id,
            u32::try_from(seq)?,
        );
        files.push((format!("recordings/{key}"), bytes));
    }
    let manifest = Manifest {
        format: FORMAT.into(),
        community_id,
        channel_id,
        parent_channel_id: None,
        session_id,
        started_at: format_utc_millis(start_unix_ms),
        ended_at: format_utc_millis(start_unix_ms + session_end),
        duration_ms: session_end,
        protocol_version: 2,
        end_reason: EndReason::RoomEmpty,
        chunks: manifest_chunks,
        participants: tracks
            .iter()
            .enumerate()
            .map(|(i, (d, _))| ManifestParticipant {
                pubkey: d.clone(),
                peer_index: u8::try_from(i).unwrap_or(0),
                epoch: 1,
                joined_t_ms: ms_u32(200 + 50 * i as u64),
                left_t_ms: ms_u32(session_end),
            })
            .collect(),
        dropped_frames: 0,
        lost_chunks: 0,
    };
    files.push((
        format!(
            "recordings/{}",
            manifest_key(prefix, community_id, channel_id, session_id)
        ),
        serde_json::to_vec_pretty(&manifest)?,
    ));

    Ok(files)
}

/// WAV 로 만든 기기 트랙들을 녹음 폴더 하나로 만든 것.
#[derive(Debug, Clone)]
pub struct TrackRecording {
    /// `(상대 경로, 바이트)`: `recordings/...` 아래 조각과 manifest.
    pub files: Vec<(String, Vec<u8>)>,
    /// 커뮤니티 id.
    pub community_id: Uuid,
    /// 허들 채널 id.
    pub channel_id: Uuid,
    /// 세션 길이(ms).
    pub duration_ms: u64,
}

/// 기기마다 16kHz 소리(`(hex pubkey, 소리)`)를 녹음 폴더(`buzz-huddle-recording/1`)로 바꾼다.
/// 실제 녹음 파일(예: 회의실 마이크 하나로 녹음한 WAV)을 작업기에 넣어 볼 때 쓴다.
pub fn recording_from_tracks(
    tracks: &[(String, Vec<f32>)],
    seed: u64,
    prefix: &str,
    start_unix_ms: u64,
) -> anyhow::Result<TrackRecording> {
    let seed_text = seed.to_string();
    let community_id = uuid_from(&["huddle-wav-recording", &seed_text, "community"]);
    let channel_id = uuid_from(&["huddle-wav-recording", &seed_text, "channel"]);
    let session_id = uuid_from(&["huddle-wav-recording", &seed_text, "session"]);
    let longest = tracks.iter().map(|(_, pcm)| pcm.len()).max().unwrap_or(0);
    let duration_ms = u64::try_from(longest)? * 1_000 / RATE as u64 + 1_000;
    let files = record_session(
        tracks,
        (community_id, channel_id, session_id),
        prefix,
        start_unix_ms,
        duration_ms,
        &mut Rng(seed ^ 0x0a1e_5eed),
    )?;
    Ok(TrackRecording {
        files,
        community_id,
        channel_id,
        duration_ms,
    })
}

fn speech_ms(clip: &Clip) -> (u64, u64) {
    (
        clip.speech_start as u64 * 1_000 / RATE as u64,
        clip.speech_end as u64 * 1_000 / RATE as u64,
    )
}

/// 받아쓰기 시험 대역용 정답: 트랙마다 들리는 문장(에코도 회의실 트랙 문장으로).
fn stt_truth_of(truth: &RoomTruth) -> Truth {
    let mut utterances: Vec<TruthUtterance> = truth
        .utterances
        .iter()
        .map(|u| TruthUtterance {
            id: u.id.clone(),
            speaker: u.device.clone(),
            label: u.device.chars().take(8).collect(),
            start_ms: u.start_ms,
            end_ms: u.end_ms,
            text: u.text.clone(),
            speaker_wav_start_ms: 0,
            speaker_wav_end_ms: 0,
            speech_units_ms: u.speech_units_ms.clone(),
        })
        .collect();
    for echo in &truth.echoes {
        let Some(text) = truth
            .utterances
            .iter()
            .find(|u| u.id == echo.id)
            .map(|u| u.text.clone())
        else {
            continue;
        };
        utterances.push(TruthUtterance {
            id: format!("{}#echo", echo.id),
            speaker: echo.device.clone(),
            label: echo.device.chars().take(8).collect(),
            start_ms: echo.start_ms,
            end_ms: echo.end_ms,
            text,
            speaker_wav_start_ms: 0,
            speaker_wav_end_ms: 0,
            speech_units_ms: vec![[echo.start_ms, echo.end_ms]],
        });
    }
    utterances.sort_by_key(|u| u.start_ms);
    let mut devices: Vec<String> = truth.people.iter().map(|p| p.device.clone()).collect();
    devices.sort();
    devices.dedup();
    Truth {
        format: TRUTH_FORMAT.into(),
        community_id: truth.community_id,
        channel_id: truth.channel_id,
        prefix: truth.prefix.clone(),
        started_at: truth.started_at.clone(),
        duration_ms: truth.duration_ms,
        speakers: devices
            .into_iter()
            .map(|d| TruthSpeaker {
                label: d.chars().take(8).collect(),
                pubkey: d,
                wav: String::new(),
            })
            .collect(),
        sessions: Vec::new(),
        utterances,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_far_speaker_has_more_room_sound_than_a_near_one() {
        let acoustics = RoomAcoustics::default();
        let energy = |taps: &[(usize, f32)]| -> (f32, f32) {
            let direct = taps[0].1 * taps[0].1;
            let tail: f32 = taps[1..].iter().map(|t| t.1 * t.1).sum();
            (direct, tail)
        };
        let near = room_impulse(&mut Rng(1), 0.7, 0.5, &acoustics);
        let far = room_impulse(&mut Rng(1), 3.0, 0.5, &acoustics);
        let (dn, tn) = energy(&near);
        let (df, tf) = energy(&far);
        // The tail is the same room; the direct sound falls with distance.
        assert!((tn / tf - 1.0).abs() < 0.2, "{tn} vs {tf}");
        let drr_near = 10.0 * (dn / tn).log10();
        let drr_far = 10.0 * (df / tf).log10();
        assert!(drr_near - drr_far > 10.0, "{drr_near} {drr_far}");
        // About the set ratio at 1 m.
        let at_1m = room_impulse(&mut Rng(1), 1.0, 0.5, &acoustics);
        let (d1, t1) = energy(&at_1m);
        assert!((10.0 * (d1 / t1).log10() - acoustics.drr_at_1m_db).abs() < 1.5);
        // Later for the far speaker.
        assert!(far[0].0 > near[0].0);
    }

    #[test]
    fn the_same_speaker_id_is_the_same_pubkey_in_every_meeting() {
        assert_eq!(person_pubkey("105"), person_pubkey("105"));
        assert_ne!(person_pubkey("105"), person_pubkey("118"));
        assert_eq!(person_pubkey("105").len(), 64);
    }
}
