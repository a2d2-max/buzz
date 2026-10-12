//! 끝에서 끝까지: 회의실 마이크 가짜 회의 → 작업기 → 화자 정답 대조.
//!
//! 모델·네트워크 없이 돈다. 사람마다 높이가 다른 소리(사인파 "말")를 쓰고, 화자 나누기와
//! 목소리 특징은 소리 높이로 하는 대역([`PitchDiarizer`], [`PitchEmbedder`])이다. 진짜 모델로
//! 재는 것은 `examples/speaker_bench.rs`.

use std::collections::HashSet;
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
    build_room_meeting, build_room_meeting_in, person_pubkey, sim_community, EchoPlan,
    PlannedPerson, RoomAcoustics, RoomMeeting, RoomPlan, Seat, VoiceClip,
};
use buzz_huddle_minutes::speaker_check::score_room_meeting;
use buzz_huddle_minutes::speakers::{ProfileUpdate, SpeakerSettings};
use buzz_huddle_minutes::store::LocalStore;
use buzz_huddle_minutes::stt::{SpeechToText, SttError, SttOutput, SttRequest, TruthStt};
use buzz_huddle_minutes::transcript::SttInfo;
use buzz_huddle_minutes::vad::{SegmentPlan, SpeechDetector, SpeechSpan, VadError};
use buzz_huddle_minutes::voices::{
    ForgetResult, Listing, LocalVoiceStore, StoreFuture, Version, VoiceProfile, VoiceStore, AGREE,
};
use uuid::Uuid;

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
    // The store tests here are about learning from tracks; the default (off)
    // has its own test.
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

/// 회의실 마이크 하나에 세 사람: "회의실 화자 1~3" 으로 나뉘고, 덩어리는 화자가 바뀌는
/// 자리에서 잘리고, 기기 주인 pubkey 는 아무에게도 저절로 가지 않는다(맞출 프로필이 없으니
/// 모두 null).
#[tokio::test]
async fn a_room_mic_with_three_people_gets_three_room_speakers() {
    let clips = voice_clips();
    let plan = room_plan(&[(0, 0.8), (1, 1.6), (2, 2.8)], &[], Some(1));
    let meeting = build_room_meeting(&clips, &plan, 21, "huddles", BASE_UNIX_MS).expect("meeting");
    let dir = tempfile::tempdir().expect("tempdir");
    let output = run(&meeting, dir.path(), speaker_settings(None)).await;
    let report = &output.report.speakers_split;
    assert_eq!(report.tracks.len(), 1);
    assert_eq!(report.tracks[0].speakers, 3, "{report:#?}");
    assert_eq!(report.mismatched_tracks, 0);

    let labels: HashSet<&str> = output
        .transcript
        .segments
        .iter()
        .filter_map(|s| s.speaker_label.as_deref())
        .collect();
    assert_eq!(
        labels,
        HashSet::from(["회의실 화자 1", "회의실 화자 2", "회의실 화자 3"])
    );
    for line in &output.transcript.segments {
        assert_eq!(
            line.device,
            meeting.truth.room_device.clone().expect("room")
        );
        assert_eq!(
            line.speaker, None,
            "nobody is named without a voice to match"
        );
        assert_eq!(line.speaker_confidence, None);
    }
    let score = score_room_meeting(&output.transcript, &meeting.truth, report, &HashSet::new());
    eprintln!(
        "DER {:.3} (no overlap {:.3}) {:?} grouped {}/{}",
        score.room_der.der(),
        score.room_der_no_overlap.der(),
        score.room_der,
        score.room_sentences_grouped_right,
        score.room_sentences
    );
    assert_eq!(score.room_sentences_grouped_right, score.room_sentences);
    assert_eq!(score.room_owner_given_by_device, 0);
    assert_eq!(score.sentences_lost, 0);
    // What this test controls is who-is-who, so the limit is on confusion.
    // Seed 21 measured: reference 22 760 ms, miss 1 420, false alarm 2 310
    // (reverb tails the test's energy detector keeps), confusion 390 (1.7 %).
    // Limit = measured + margin: confusion under 4 %. (A first limit of
    // 0.15 on the whole DER was written before measuring; it mostly judged
    // the test's energy detector, so it was replaced, not widened.)
    let der = score.room_der;
    assert!(der.confusion_ms * 25 <= der.reference_ms, "{der:?}");
}

/// 1인 트랙만 있는 회의: 화자 나누기를 켜도 덩어리·줄이 끈 것과 똑같고, 줄마다 트랙 주인,
/// 확실도 1, 이름표 없음.
#[tokio::test]
async fn one_person_tracks_stay_exactly_as_before() {
    let clips = voice_clips();
    let plan = room_plan(&[], &[0, 2, 3], None);
    let meeting = build_room_meeting(&clips, &plan, 22, "huddles", BASE_UNIX_MS).expect("meeting");
    let off_dir = tempfile::tempdir().expect("tempdir");
    let off = run(&meeting, off_dir.path(), SpeakerSettings::default()).await;
    let on_dir = tempfile::tempdir().expect("tempdir");
    let on = run(&meeting, on_dir.path(), speaker_settings(None)).await;
    assert_eq!(on.transcript.segments, off.transcript.segments);
    let report = &on.report.speakers_split;
    assert!(report.tracks.iter().all(|t| t.speakers == 1), "{report:#?}");
    for line in &on.transcript.segments {
        assert_eq!(line.speaker.as_ref(), Some(&line.device));
        assert_eq!(line.speaker_confidence, Some(1.0));
        assert_eq!(line.speaker_label, None);
    }
}

/// 사람들이 원격으로 혼자 말한 회의를 한 번 돌린다(커뮤니티 `community`).
async fn remote_round(
    clips: &[VoiceClip],
    store: &Arc<dyn VoiceStore>,
    community: Uuid,
    people: &[usize],
    from: usize,
    seed: u64,
) -> MinutesOutput {
    let mut plan = room_plan(&[], people, None);
    for person in &mut plan.people {
        let p: usize = person.speaker[1..].parse().expect("index");
        person.clips = clips_of(p, from, 3);
    }
    let meeting = build_room_meeting_in(
        community,
        clips,
        &plan,
        seed,
        "huddles",
        BASE_UNIX_MS + seed * 3_600_000,
    )
    .expect("meeting");
    let dir = tempfile::tempdir().expect("tempdir");
    run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await
}

/// 커뮤니티 프로필들, 사람 순서대로.
async fn profiles_in(store: &Arc<dyn VoiceStore>, community: Uuid) -> Vec<VoiceProfile> {
    let mut profiles: Vec<VoiceProfile> = store
        .list(community)
        .await
        .expect("list")
        .profiles
        .into_iter()
        .map(|(profile, _)| profile)
        .collect();
    profiles.sort_by(|a, b| a.pubkey.cmp(&b.pubkey));
    profiles
}

/// 회의 사이 프로필: 원격 회의 한 번이면 "대기", 두 번이면 "준비"되고, 그때부터 회의실 화자에
/// 이름이 붙는다. 프로필이 없는 사람은 "회의실 화자 N" 으로 남고, 회의실 기기 주인(프로필 없음)의
/// pubkey 는 그 사람에게도 저절로 가지 않는다. 회의실에서 맞힌 것은 프로필 재료가 되지 않는다.
#[tokio::test]
async fn stored_profiles_name_room_speakers_and_strangers_stay_unnamed() {
    let clips = voice_clips();
    let voices_dir = tempfile::tempdir().expect("tempdir");
    let store: Arc<dyn VoiceStore> =
        Arc::new(LocalVoiceStore::open(voices_dir.path()).expect("store"));
    let community = sim_community();

    // One remote meeting: profiles are made, but only pending.
    let out = remote_round(&clips, &store, community, &[0, 1], 0, 30).await;
    assert!(out
        .report
        .speakers_split
        .tracks
        .iter()
        .all(|t| t.profile == ProfileUpdate::Created));
    let profiles = profiles_in(&store, community).await;
    let mut expected = vec![person_pubkey("P0"), person_pubkey("P1")];
    expected.sort();
    let owners: Vec<&str> = profiles.iter().map(|p| p.pubkey.as_str()).collect();
    assert_eq!(owners, expected);
    assert!(profiles.iter().all(|p| !p.is_ready(AGREE)));
    // Rerunning the same meeting adds nothing (one meeting never makes a profile ready).
    let again = remote_round(&clips, &store, community, &[0, 1], 0, 30).await;
    assert!(again
        .report
        .speakers_split
        .tracks
        .iter()
        .all(|t| t.profile == ProfileUpdate::Unchanged));
    // A second, different meeting: ready.
    let out = remote_round(&clips, &store, community, &[0, 1], 3, 33).await;
    assert_eq!(out.report.speakers_split.profiles_pending, 2);
    let profiles = profiles_in(&store, community).await;
    assert!(profiles.iter().all(|p| p.is_ready(AGREE)), "{profiles:#?}");
    let before = profiles.clone();

    // Room: 0 and 1 (profiles) and 3 (none, owns the room device).
    let plan = room_plan(&[(0, 1.0), (1, 2.5), (3, 0.9)], &[], Some(2));
    let meeting = build_room_meeting(&clips, &plan, 31, "huddles", BASE_UNIX_MS).expect("meeting");
    let dir = tempfile::tempdir().expect("tempdir");
    let output = run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    assert_eq!(output.report.speakers_split.profiles_loaded, 2);
    let known: HashSet<String> = [person_pubkey("P0"), person_pubkey("P1")].into();
    let score = score_room_meeting(
        &output.transcript,
        &meeting.truth,
        &output.report.speakers_split,
        &known,
    );
    assert_eq!(
        score.naming_known.wrong + score.naming_unknown.wrong,
        0,
        "{score:#?}"
    );
    assert_eq!(
        score.naming_known.right,
        score.naming_known.total(),
        "{score:#?}"
    );
    assert_eq!(score.naming_unknown.unnamed, score.naming_unknown.total());
    assert_eq!(score.room_owner_given_by_device, 0);
    for line in output
        .transcript
        .segments
        .iter()
        .filter(|l| l.speaker.is_some())
    {
        let confidence = line
            .speaker_confidence
            .expect("named lines carry their similarity");
        assert!(confidence > 0.5 && confidence <= 1.0001, "{confidence}");
        assert!(line.speaker_label.is_some(), "room lines keep their label");
    }
    // Participants follow who spoke: the room device's owner (P3) is there
    // with only what was matched to P3 (nothing: no profile), P0 and P1 are added.
    let participants = &output.transcript.participants;
    let speech = |who: &str| {
        participants
            .iter()
            .find(|p| p.pubkey == person_pubkey(who))
            .map(|p| p.speech_ms)
    };
    assert_eq!(speech("P3"), Some(0), "{participants:?}");
    assert!(speech("P0").is_some_and(|ms| ms > 0), "{participants:?}");
    assert!(speech("P1").is_some_and(|ms| ms > 0), "{participants:?}");
    // Room matches never feed a profile.
    assert_eq!(profiles_in(&store, community).await, before);

    // A room device owned by person 1 (silent) where only person 0 talks: one
    // speaker, but not the owner's stored voice. It is named by voice (0),
    // never given the owner's pubkey, and adds nothing to person 1's profile
    // (only one more disagreement is counted).
    let mut plan = room_plan(&[(0, 1.2), (1, 2.0)], &[], Some(1));
    plan.people[1].clips.clear();
    let meeting = build_room_meeting(&clips, &plan, 32, "huddles", BASE_UNIX_MS).expect("meeting");
    let dir = tempfile::tempdir().expect("tempdir");
    let output = run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    let track = &output.report.speakers_split.tracks[0];
    assert_eq!(track.speakers, 1);
    assert!(track.owner_voice_mismatch, "{track:#?}");
    assert_eq!(track.profile, ProfileUpdate::Refused);
    assert!(!output.transcript.segments.is_empty());
    for line in &output.transcript.segments {
        assert_eq!(line.device, person_pubkey("P1"));
        assert_eq!(line.speaker.as_deref(), Some(person_pubkey("P0").as_str()));
        assert_eq!(line.speaker_label.as_deref(), Some("회의실 화자 1"));
    }
    let after = profiles_in(&store, community).await;
    for (old, new) in before.iter().zip(&after) {
        assert_eq!(old.samples, new.samples);
        let dissent = u32::from(new.pubkey == person_pubkey("P1"));
        assert_eq!(new.dissent, dissent, "{}", &new.pubkey[..8]);
    }
}

/// 목록 읽기가 실패하는 저장소(나머지는 그대로 넘긴다).
struct BrokenList(Arc<dyn VoiceStore>);

impl VoiceStore for BrokenList {
    fn list(&self, _: Uuid) -> StoreFuture<'_, Listing> {
        Box::pin(async { Err(std::io::Error::other("listing failed").into()) })
    }
    fn list_all(&self) -> StoreFuture<'_, Listing> {
        self.0.list_all()
    }
    fn load<'a>(
        &'a self,
        community: Uuid,
        pubkey: &'a str,
    ) -> StoreFuture<'a, Option<(VoiceProfile, Version)>> {
        self.0.load(community, pubkey)
    }
    fn save<'a>(&'a self, profile: &'a VoiceProfile, version: Version) -> StoreFuture<'a, bool> {
        self.0.save(profile, version)
    }
    fn is_forgotten<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool> {
        self.0.is_forgotten(pubkey)
    }
    fn forget<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, ForgetResult> {
        self.0.forget(pubkey)
    }
    fn allow<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool> {
        self.0.allow(pubkey)
    }
}

/// H2: 저장소 목록을 못 읽은 회의는 프로필을 읽지도(이름 맞추기·주인 검사) 쓰지도 않는다.
#[tokio::test]
async fn a_meeting_that_cannot_list_profiles_neither_uses_nor_writes_them() {
    let clips = voice_clips();
    let voices_dir = tempfile::tempdir().expect("tempdir");
    let store: Arc<dyn VoiceStore> =
        Arc::new(LocalVoiceStore::open(voices_dir.path()).expect("store"));
    let community = sim_community();
    remote_round(&clips, &store, community, &[0], 0, 60).await;
    remote_round(&clips, &store, community, &[0], 3, 61).await;
    let before = profiles_in(&store, community).await;
    assert!(before[0].is_ready(AGREE));
    let broken: Arc<dyn VoiceStore> = Arc::new(BrokenList(store.clone()));

    // P0 alone again: nothing is written.
    let out = remote_round(&clips, &broken, community, &[0], 6, 62).await;
    let report = &out.report.speakers_split;
    assert_eq!(report.store_errors, 1);
    assert_eq!(report.tracks[0].profile, ProfileUpdate::StoreError);
    assert_eq!(profiles_in(&store, community).await, before);

    // P0 in a room: not named, the stored voice is not used.
    let mut plan = room_plan(&[(0, 0.6), (3, 1.5)], &[], None);
    plan.people[0].clips = clips_of(0, 0, 10);
    plan.overlap_chance = 0.0;
    let meeting = build_room_meeting(&clips, &plan, 63, "huddles", BASE_UNIX_MS).expect("meeting");
    let dir = tempfile::tempdir().expect("tempdir");
    let out = run(&meeting, dir.path(), speaker_settings(Some(broken))).await;
    assert!(!out.transcript.segments.is_empty());
    for line in &out.transcript.segments {
        assert_eq!(line.speaker, None);
        assert!(line.speaker_label.is_some());
    }
    // With the store readable, the same meeting names P0.
    let dir = tempfile::tempdir().expect("tempdir");
    let out = run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    assert!(
        out.transcript
            .segments
            .iter()
            .any(|l| l.speaker.as_deref() == Some(person_pubkey("P0").as_str())),
        "{:#?}",
        out.report.speakers_split
    );
}

/// 저절로 배우기 끔(기본): 혼자 트랙 회의를 여러 번 돌려도, 회의실 기기에 남이 혼자 말해도 프로필이
/// 하나도 생기지 않고 파일도 하나도 없다.
#[tokio::test]
async fn with_learning_off_no_profile_and_no_file_is_ever_written() {
    let clips = voice_clips();
    let voices_dir = tempfile::tempdir().expect("tempdir");
    let store: Arc<dyn VoiceStore> =
        Arc::new(LocalVoiceStore::open(voices_dir.path()).expect("store"));
    let off = || {
        let mut settings = speaker_settings(Some(store.clone()));
        settings.profiles.learn = false;
        settings
    };
    let mut plans = Vec::new();
    for from in [0, 3, 6] {
        let mut plan = room_plan(&[], &[0, 1], None);
        for person in &mut plan.people {
            let p: usize = person.speaker[1..].parse().expect("index");
            person.clips = clips_of(p, from, 3);
        }
        plans.push(plan);
    }
    // The same stranger (P0) twice on P1's room device.
    for from in [0, 4] {
        let mut plan = room_plan(&[(0, 1.2), (1, 2.0)], &[], Some(1));
        plan.people[0].clips = clips_of(0, from, 4);
        plan.people[1].clips.clear();
        plans.push(plan);
    }
    for (n, plan) in plans.iter().enumerate() {
        let seed = 90 + n as u64;
        let meeting = build_room_meeting(&clips, plan, seed, "huddles", BASE_UNIX_MS + seed)
            .expect("meeting");
        let dir = tempfile::tempdir().expect("tempdir");
        let out = run(&meeting, dir.path(), off()).await;
        assert!(out
            .report
            .speakers_split
            .tracks
            .iter()
            .all(|t| t.profile == ProfileUpdate::NotUsed));
    }
    assert!(store.list_all().await.expect("list").profiles.is_empty());
    let mut files = Vec::new();
    let mut stack = vec![voices_dir.path().to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path);
            }
        }
    }
    assert!(files.is_empty(), "{files:?}");
}

/// H4: 다른 커뮤니티의 프로필은 후보가 아니고, 커뮤니티마다 따로 모인다.
#[tokio::test]
async fn profiles_stay_inside_their_community() {
    let clips = voice_clips();
    let voices_dir = tempfile::tempdir().expect("tempdir");
    let store: Arc<dyn VoiceStore> =
        Arc::new(LocalVoiceStore::open(voices_dir.path()).expect("store"));
    let home = sim_community();
    let other = Uuid::from_u128(0x0123_4567_89ab_cdef);
    remote_round(&clips, &store, home, &[0], 0, 70).await;
    remote_round(&clips, &store, home, &[0], 3, 71).await;
    let home_before = profiles_in(&store, home).await;
    assert!(home_before[0].is_ready(AGREE));

    // P0 in a room of the other community: not named (and is, at home).
    let mut plan = room_plan(&[(0, 1.0), (3, 1.5)], &[], None);
    plan.people[0].clips = clips_of(0, 0, 10);
    plan.overlap_chance = 0.0;
    let meeting =
        build_room_meeting_in(other, &clips, &plan, 72, "huddles", BASE_UNIX_MS).expect("meeting");
    let dir = tempfile::tempdir().expect("tempdir");
    let out = run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    assert_eq!(out.report.speakers_split.profiles_loaded, 0);
    assert!(out.transcript.segments.iter().all(|l| l.speaker.is_none()));
    let meeting =
        build_room_meeting_in(home, &clips, &plan, 72, "huddles", BASE_UNIX_MS).expect("meeting");
    let dir = tempfile::tempdir().expect("tempdir");
    let out = run(&meeting, dir.path(), speaker_settings(Some(store.clone()))).await;
    assert!(out
        .transcript
        .segments
        .iter()
        .any(|l| l.speaker.as_deref() == Some(person_pubkey("P0").as_str())));

    // P0 alone in the other community: a new pending profile there, home untouched.
    remote_round(&clips, &store, other, &[0], 6, 73).await;
    let there = profiles_in(&store, other).await;
    assert_eq!(there.len(), 1);
    assert_eq!(there[0].community, other);
    assert!(!there[0].is_ready(AGREE));
    assert_eq!(profiles_in(&store, home).await, home_before);
}

/// 원격 사람 소리가 회의실 스피커로 나와 회의실 마이크에 다시 잡혀도(에코) 같은 문장이
/// 두 번 나오지 않고, 진짜 말은 지워지지 않는다. A 와 "두 번 잡힘" 검사를 둘 다 끄면 두 번
/// 나온다(검사가 실제로 일한다는 증거).
#[tokio::test]
async fn an_echo_of_a_remote_person_is_not_written_twice() {
    let clips = voice_clips();
    let mut plan = room_plan(&[(0, 1.0), (1, 2.0)], &[2], Some(0));
    plan.echo = Some(EchoPlan {
        gain_db: -15.0,
        delay_ms: 200,
    });
    let meeting = build_room_meeting(&clips, &plan, 41, "huddles", BASE_UNIX_MS).expect("meeting");
    assert_eq!(meeting.truth.echoes.len(), 3);

    let dir = tempfile::tempdir().expect("tempdir");
    let output = run(&meeting, dir.path(), speaker_settings(None)).await;
    let report = &output.report.speakers_split;
    let score = score_room_meeting(&output.transcript, &meeting.truth, report, &HashSet::new());
    eprintln!(
        "bleed pieces {:?} duplicate lines {} | duplicated {} removed real {}",
        report
            .tracks
            .iter()
            .map(|t| t.bleed_pieces)
            .collect::<Vec<_>>(),
        report.duplicate_lines_removed,
        score.duplicated_sentences,
        score.removed_real_pieces
    );
    let on = score.clone();
    assert!(report.tracks.iter().map(|t| t.bleed_pieces).sum::<usize>() > 0);
    assert_eq!(on.echoes_left_dominant, 0, "{on:#?}");
    assert_eq!(score.removed_real_pieces, 0, "{score:#?}");
    assert_eq!(score.sentences_lost, 0, "{score:#?}");
    assert_eq!(score.own_tracks_split, 0);

    let mut off = speaker_settings(None);
    off.bleed.enabled = false;
    off.naming.duplicate_overlap = 2.0;
    let dir = tempfile::tempdir().expect("tempdir");
    let output = run(&meeting, dir.path(), off).await;
    let score = score_room_meeting(
        &output.transcript,
        &meeting.truth,
        &output.report.speakers_split,
        &HashSet::new(),
    );
    eprintln!(
        "echo checks on: text twice {} echo-led lines {} | off: text twice {} echo-led lines {}",
        on.duplicated_sentences,
        on.echoes_left_dominant,
        score.duplicated_sentences,
        score.echoes_left_dominant
    );
    assert!(score.echoes_left_dominant > 0, "{score:#?}");
    assert!(
        score.duplicated_sentences > on.duplicated_sentences,
        "{score:#?}"
    );
}

/// Answers like [`TruthStt`] and writes down the bounds of every piece sent.
struct Recording {
    truth: TruthStt,
    sent: std::sync::Mutex<Vec<(String, u64, u64)>>,
}

impl Recording {
    fn new(meeting: &RoomMeeting) -> Self {
        Self {
            truth: TruthStt::new(&meeting.stt_truth),
            sent: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn sent(&self) -> Vec<(String, u64, u64)> {
        self.sent.lock().expect("lock").clone()
    }
}

impl SpeechToText for Recording {
    fn info(&self) -> SttInfo {
        self.truth.info()
    }

    async fn transcribe(&self, request: SttRequest<'_>) -> Result<SttOutput, SttError> {
        self.sent.lock().expect("lock").push((
            request.speaker.to_string(),
            request.start_ms,
            request.end_ms,
        ));
        self.truth.transcribe(request).await
    }
}

/// The ledger key is a piece's bounds and frames, and telling speakers
/// apart only moves bounds — it never changes the sound sent. So with the
/// same ledger, a run with speakers off after one with them on (1) sends no
/// piece whose bounds stayed, and (2) sends only the pieces whose bounds
/// changed.
#[tokio::test]
async fn turning_speakers_off_resends_only_pieces_whose_bounds_changed() {
    let clips = voice_clips();
    let plan = room_plan(&[(0, 0.8), (1, 1.6), (2, 2.8)], &[], Some(1));
    let meeting = build_room_meeting(&clips, &plan, 21, "huddles", BASE_UNIX_MS).expect("meeting");
    let dir = tempfile::tempdir().expect("tempdir");
    for (relative, bytes) in &meeting.files {
        let path = dir.path().join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, bytes).expect("write");
    }
    let truth = &meeting.truth;
    let store = LocalStore::new(dir.path().join("recordings"));
    let planned = collect_meetings(
        &store,
        &truth.prefix,
        truth.community_id,
        truth.channel_id,
        10 * 60_000,
    )
    .await
    .expect("collect")
    .meetings
    .remove(0);
    let mut ledger = SttLedger::in_memory();

    let on = Recording::new(&meeting);
    let first = build_minutes(
        &planned,
        &mut EnergyDetector,
        &on,
        &mut ledger,
        &settings(speaker_settings(None)),
    )
    .await
    .expect("speakers on");
    let sent_on: HashSet<_> = on.sent().into_iter().collect();
    assert_eq!(first.report.stt_reused, 0);
    assert_eq!(first.report.stt_requests as usize, sent_on.len());

    let off = Recording::new(&meeting);
    let second = build_minutes(
        &planned,
        &mut EnergyDetector,
        &off,
        &mut ledger,
        &settings(SpeakerSettings::default()),
    )
    .await
    .expect("speakers off");
    let sent_off = off.sent();
    // (1) A piece with the same bounds is never sent again.
    assert!(
        sent_off.iter().all(|piece| !sent_on.contains(piece)),
        "{sent_off:?}"
    );
    assert!(
        second.report.stt_reused > 0,
        "some pieces kept their bounds"
    );
    // (2) Only the pieces whose bounds changed go out.
    assert!(
        !sent_off.is_empty(),
        "turning speakers off moved some bounds"
    );
    assert_eq!(second.report.stt_requests as usize, sent_off.len());
}
