//! 검토자 확인 시험(리뷰 H1~H3)을 옮겨 온 것: 기대하는 동작을 단언으로 적었다.

use std::path::Path;
use std::sync::Arc;

use buzz_huddle_minutes::collect::collect_meetings;
use buzz_huddle_minutes::diarize::{
    normalized, ModelId, SpeakerError, TrackDiarizer, Turn, VoiceEmbedder,
};
use buzz_huddle_minutes::ledger::SttLedger;
use buzz_huddle_minutes::pipeline::{build_minutes, MinutesOutput, MinutesSettings, SttPolicy};
use buzz_huddle_minutes::sim::{mark_speech, Clip, BASE_UNIX_MS};
use buzz_huddle_minutes::sim_room::{
    build_room_meeting, person_pubkey, sim_community, PlannedPerson, RoomAcoustics, RoomMeeting,
    RoomPlan, Seat, VoiceClip,
};
use buzz_huddle_minutes::speakers::SpeakerSettings;
use buzz_huddle_minutes::store::LocalStore;
use buzz_huddle_minutes::stt::TruthStt;
use buzz_huddle_minutes::vad::{SegmentPlan, SpeechDetector, SpeechSpan, VadError};
use buzz_huddle_minutes::voices::{LocalVoiceStore, VoiceStore, AGREE};

/// 사람마다 목소리 높이(Hz). 서로 멀리 떨어져 있다.
const PITCHES: [f32; 5] = [140.0, 230.0, 370.0, 560.0, 820.0];
const RATE: usize = 16_000;

/// Test double: 10 ms frames louder than -45 dBFS are speech; pauses up to
/// 200 ms are bridged; spans shorter than 100 ms are dropped.
struct EnergyDetector;

impl SpeechDetector for EnergyDetector {
    fn detect(&mut self, pcm_16k: &[f32]) -> Result<Vec<SpeechSpan>, VadError> {
        const FRAME: usize = 160;
        let threshold = 10f32.powf(-45.0 / 20.0);
        let mut spans: Vec<SpeechSpan> = Vec::new();
        for (i, frame) in pcm_16k.chunks(FRAME).enumerate() {
            let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
            if rms < threshold {
                continue;
            }
            let (start, end) = (i * FRAME, i * FRAME + frame.len());
            match spans.last_mut() {
                Some(last) if start <= last.end + 20 * FRAME => last.end = end,
                _ => spans.push(SpeechSpan { start, end }),
            }
        }
        spans.retain(|span| span.len() >= 10 * FRAME);
        Ok(spans)
    }
}

/// 50ms 칸의 소리 높이(영점 교차로), 조용하면 `None`.
fn pitches(pcm: &[f32]) -> Vec<Option<f32>> {
    const WINDOW: usize = 800;
    pcm.chunks(WINDOW)
        .map(|w| {
            let rms = (w.iter().map(|x| x * x).sum::<f32>() / w.len() as f32).sqrt();
            if rms < 0.005 || w.len() < WINDOW / 2 {
                return None;
            }
            let crossings = w
                .windows(2)
                .filter(|p| (p[0] < 0.0) != (p[1] < 0.0))
                .count();
            Some(crossings as f32 * RATE as f32 / (2.0 * w.len() as f32))
        })
        .collect()
}

fn nearest_person(pitch: f32) -> Option<usize> {
    PITCHES.iter().position(|&p| (pitch / p - 1.0).abs() < 0.12)
}

/// 대역 화자 나누기: 50ms 칸마다 소리 높이로 사람을 고른다.
struct PitchDiarizer;

impl TrackDiarizer for PitchDiarizer {
    fn diarize(&self, pcm_16k: &[f32]) -> Result<Vec<Turn>, SpeakerError> {
        let mut turns: Vec<Turn> = Vec::new();
        for (i, pitch) in pitches(pcm_16k).into_iter().enumerate() {
            let Some(speaker) = pitch.and_then(nearest_person) else {
                continue;
            };
            let (start, end) = (i * 800, ((i + 1) * 800).min(pcm_16k.len()));
            match turns.last_mut() {
                Some(t) if t.speaker == speaker && t.end + 4_000 >= start => t.end = end,
                _ => turns.push(Turn {
                    start,
                    end,
                    speaker,
                }),
            }
        }
        Ok(turns)
    }

    fn describe(&self) -> String {
        "pitch".into()
    }
}

/// 대역 목소리 특징: 소리 높이 분포.
struct PitchEmbedder;

impl VoiceEmbedder for PitchEmbedder {
    fn model(&self) -> ModelId {
        ModelId {
            name: "pitch".into(),
            sha256: "00".repeat(32),
        }
    }

    fn embed(&self, pcm_16k: &[f32]) -> Result<Option<Vec<f32>>, SpeakerError> {
        let mut v = vec![0f32; PITCHES.len()];
        for pitch in pitches(pcm_16k).into_iter().flatten() {
            if let Some(p) = nearest_person(pitch) {
                v[p] += 1.0;
            }
        }
        Ok(normalized(v))
    }
}

/// 사람 `person` 의 문장 `n`: 높이가 그 사람 것인 "말" 3~5개.
fn tone_clip(person: usize, n: usize) -> Clip {
    let words = 3 + n % 3;
    let pitch = PITCHES[person];
    let mut pcm = vec![0.0f32; 4_800];
    for w in 0..words {
        let word = 16 * (300 + (n * 37 + w * 53 + person * 11) % 200);
        let gap = 16 * (90 + (n * 29 + w * 41) % 111);
        pcm.extend((0..word).map(|i| {
            let t = i as f32 / RATE as f32;
            let envelope = (std::f32::consts::PI * i as f32 / word as f32).sin().sqrt();
            0.2 * envelope * (std::f32::consts::TAU * pitch * t).sin()
        }));
        if w + 1 < words {
            pcm.extend(std::iter::repeat_n(0.0, gap));
        }
    }
    pcm.extend(std::iter::repeat_n(0.0, 4_800));
    let len = pcm.len();
    Clip {
        id: format!("p{person}-s{n:02}"),
        text: format!("사람 {person} 문장 {n:02}"),
        pcm_16k: pcm,
        speech_start: 0,
        speech_end: len,
        speech_units: Vec::new(),
    }
}

/// 사람 5명, 사람마다 문장 12개.
fn voice_clips() -> Vec<VoiceClip> {
    let mut out = Vec::new();
    for person in 0..PITCHES.len() {
        for n in 0..12 {
            out.push(VoiceClip {
                speaker: format!("P{person}"),
                clip: tone_clip(person, n),
            });
        }
    }
    let mut plain: Vec<Clip> = out.iter().map(|c| c.clip.clone()).collect();
    mark_speech(&mut plain, &mut EnergyDetector).expect("mark speech");
    for (c, p) in out.iter_mut().zip(plain) {
        c.clip = p;
    }
    out
}

fn clips_of(person: usize, from: usize, count: usize) -> Vec<usize> {
    (from..from + count).map(|n| person * 12 + n).collect()
}

fn settings(speakers: SpeakerSettings) -> MinutesSettings {
    MinutesSettings {
        segment_plan: SegmentPlan::default(),
        stt: SttPolicy {
            retry_delay_ms: 0,
            rate_limit_delay_ms: 0,
            ..SttPolicy::default()
        },
        ledger_version: "test".into(),
        audio_key: "mixed.wav".into(),
        now_unix_ms: BASE_UNIX_MS,
        speakers,
    }
}

fn speaker_settings(store: Option<Arc<dyn VoiceStore>>) -> SpeakerSettings {
    let mut settings = SpeakerSettings {
        diarizer: Some(Arc::new(PitchDiarizer)),
        embedder: Some(Arc::new(PitchEmbedder)),
        store,
        min_cluster_ms: 2_000,
        ..SpeakerSettings::default()
    };
    settings.profiles.min_material_ms = 3_000;
    // These are about what happens when learning from tracks is on (off by default).
    settings.profiles.learn = true;
    settings.bleed.enabled = true;
    settings
}

async fn run(meeting: &RoomMeeting, dir: &Path, speakers: SpeakerSettings) -> MinutesOutput {
    for (relative, bytes) in &meeting.files {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, bytes).expect("write");
    }
    let truth = &meeting.truth;
    let store = LocalStore::new(dir.join("recordings"));
    let mut meetings = collect_meetings(
        &store,
        &truth.prefix,
        truth.community_id,
        truth.channel_id,
        10 * 60_000,
    )
    .await
    .expect("collect")
    .meetings;
    assert_eq!(meetings.len(), 1);
    build_minutes(
        &meetings.remove(0),
        &mut EnergyDetector,
        &TruthStt::new(&meeting.stt_truth),
        &mut SttLedger::in_memory(),
        &settings(speakers),
    )
    .await
    .expect("build minutes")
}

fn room_plan(room: &[(usize, f32)], remote: &[usize], owner: Option<usize>) -> RoomPlan {
    let mut people: Vec<PlannedPerson> = room
        .iter()
        .map(|&(p, distance_m)| PlannedPerson {
            speaker: format!("P{p}"),
            seat: Seat::Room { distance_m },
            clips: clips_of(p, 6, 4),
        })
        .collect();
    people.extend(remote.iter().map(|&p| PlannedPerson {
        speaker: format!("P{p}"),
        seat: Seat::Remote,
        clips: clips_of(p, 6, 3),
    }));
    RoomPlan {
        people,
        room_owner: owner,
        echo: None,
        acoustics: RoomAcoustics::default(),
        overlap_chance: 0.2,
    }
}

fn history_plan(people: &[usize], from: usize) -> RoomPlan {
    let mut plan = room_plan(&[], people, None);
    for person in &mut plan.people {
        let p: usize = person.speaker[1..].parse().expect("index");
        person.clips = clips_of(p, from, 4);
    }
    plan
}

async fn profile_of(
    store: &Arc<dyn VoiceStore>,
    who: &str,
) -> Option<buzz_huddle_minutes::voices::VoiceProfile> {
    store
        .load(sim_community(), &person_pubkey(who))
        .await
        .expect("load")
        .map(|(profile, _)| profile)
}

/// H1: 회의실 기기(주인 P1, 말 안 함, 프로필 없음)에 P0 혼자 말한 회의가 P1 의 첫 프로필이 되면 안 된다.
/// 뒤에 P1 이 자기 기기로 말해도 밀려나지 않고, P0 이 회의실에서 말해도 P1 로 불리지 않아야 한다.
#[tokio::test]
async fn h1_a_first_recording_alone_never_becomes_someones_voice() {
    let clips = voice_clips();
    let voices_dir = tempfile::tempdir().unwrap();
    let store: Arc<dyn VoiceStore> = Arc::new(LocalVoiceStore::open(voices_dir.path()).unwrap());

    let mut plan = room_plan(&[(0, 1.2), (1, 2.0)], &[], Some(1));
    plan.people[1].clips.clear();
    let meeting = build_room_meeting(&clips, &plan, 32, "huddles", BASE_UNIX_MS).unwrap();
    let dir = tempfile::tempdir().unwrap();
    run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;

    // P1 really talks alone on P1's own device: P1, not pushed out.
    let meeting = build_room_meeting(
        &clips,
        &history_plan(&[1], 0),
        33,
        "huddles",
        BASE_UNIX_MS + 3_600_000,
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out = run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    let t = &out.report.speakers_split.tracks[0];
    assert!(
        !t.owner_voice_mismatch,
        "P1's own track was pushed out by P0's voice"
    );
    assert!(out
        .transcript
        .segments
        .iter()
        .all(|l| l.speaker.as_deref() == Some(person_pubkey("P1").as_str())));

    // P0 (and P3) in a room: nobody is called P1.
    let mut plan = room_plan(&[(0, 1.0), (3, 1.5)], &[], None);
    plan.people[0].clips = clips_of(0, 0, 10);
    plan.overlap_chance = 0.0;
    let meeting =
        build_room_meeting(&clips, &plan, 34, "huddles", BASE_UNIX_MS + 7_200_000).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out = run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    let named_p1 = out
        .transcript
        .segments
        .iter()
        .filter(|l| l.speaker.as_deref() == Some(person_pubkey("P1").as_str()))
        .count();
    assert_eq!(named_p1, 0, "P0 was named P1");
}

/// H2: 저장소(그 커뮤니티 폴더 안)에 못 읽는 파일이 있어도 준비된 프로필을 덮어쓰지 않는다.
/// 재검토 요청으로 바꿈: 못 읽는 파일을 커뮤니티 폴더 안에 두고, P0 이 준비된 상태에서 잰다.
#[tokio::test]
async fn h2_an_unreadable_file_never_makes_a_profile_get_overwritten() {
    let clips = voice_clips();
    let voices_dir = tempfile::tempdir().unwrap();
    let store: Arc<dyn VoiceStore> = Arc::new(LocalVoiceStore::open(voices_dir.path()).unwrap());
    for (from, seed, start) in [(0, 40, BASE_UNIX_MS), (4, 41, BASE_UNIX_MS + 3_600_000)] {
        let meeting =
            build_room_meeting(&clips, &history_plan(&[0], from), seed, "huddles", start).unwrap();
        let dir = tempfile::tempdir().unwrap();
        run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    }
    let before = profile_of(&store, "P0").await.unwrap();
    assert!(
        before.is_ready(AGREE),
        "P0 should be ready before the broken file"
    );

    let community = voices_dir
        .path()
        .join("voices")
        .join(sim_community().to_string());
    std::fs::write(community.join("zz.json"), b"not json").unwrap();
    let meeting = build_room_meeting(
        &clips,
        &history_plan(&[0], 8),
        42,
        "huddles",
        BASE_UNIX_MS + 7_200_000,
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out = run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    assert_eq!(out.report.speakers_split.profiles_unreadable, 1);
    let after = profile_of(&store, "P0").await.unwrap();
    for old in &before.samples {
        assert!(
            after.samples.iter().any(|s| s.embedding == old.embedding),
            "an earlier sample was lost"
        );
    }
    assert!(after.is_ready(AGREE));
}

/// H3: 지운 사람의 프로필은 다음 회의에서 다시 생기지 않는다.
#[tokio::test]
async fn h3_a_forgotten_person_is_not_recreated() {
    let clips = voice_clips();
    let voices_dir = tempfile::tempdir().unwrap();
    let store: Arc<dyn VoiceStore> = Arc::new(LocalVoiceStore::open(voices_dir.path()).unwrap());
    let meeting =
        build_room_meeting(&clips, &history_plan(&[0], 0), 50, "huddles", BASE_UNIX_MS).unwrap();
    let dir = tempfile::tempdir().unwrap();
    run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    assert!(store.forget(&person_pubkey("P0")).await.unwrap().deleted > 0);
    let meeting = build_room_meeting(
        &clips,
        &history_plan(&[0], 4),
        51,
        "huddles",
        BASE_UNIX_MS + 3_600_000,
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    assert!(
        profile_of(&store, "P0").await.is_none(),
        "forget did not last"
    );
}
