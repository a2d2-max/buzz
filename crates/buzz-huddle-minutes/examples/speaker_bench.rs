//! 화자 나누기·누가 누군지·새는 소리를 정답 있는 가짜 회의로 잰다.
//!
//! ```text
//! cargo run -p buzz-huddle-minutes --example speaker_bench -- --set cal --out .cache/speaker-bench/x.json
//! ```
//!
//! 1. Zeroth-Korean 문장(화자 id 있음)을 읽고 Silero 로 말 위치를 찍는다.
//! 2. 프로필 있는 사람(화자 70%)마다 "원격 회의" 를 `--history` 번 돌려 목소리 프로필을 만든다
//!    (진짜 파이프라인, 로컬 저장소).
//! 3. 회의실 회의(회의실 2~5명 + 원격 0~2명, 에코 일부)를 돌리고 정답과 견준다. 저장소는 읽기만.
//! 4. 원격만 있는 회의(1인 트랙만)를 돌려 1인 트랙을 잘못 쪼개는지 본다.
//! 5. 회의실 화자 묶음의 유사도를 모아 맞추기 문턱별 표를 낸다.
//!
//! 결과(숫자, pubkey 앞 8자)는 `--out` JSON 과 표준 출력. 소리·글은 남기지 않는다.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Context;
use buzz_huddle_minutes::collect::collect_meetings;
use buzz_huddle_minutes::diarize::{
    cosine, DiarizerSettings, ModelId, SherpaDiarizer, SherpaEmbedder, SpeakerError, TrackDiarizer,
    Turn,
};
use buzz_huddle_minutes::ledger::SttLedger;
use buzz_huddle_minutes::models::{
    embedding_candidate, model_path, silero_vad_path, SPEAKER_EMBEDDING, SPEAKER_SEGMENTATION,
};
use buzz_huddle_minutes::pipeline::{build_minutes, MinutesSettings, SttPolicy};
use buzz_huddle_minutes::sim::{mark_speech, BASE_UNIX_MS};
use buzz_huddle_minutes::sim_room::{
    build_room_meeting, load_voice_clips, person_pubkey, sim_community, EchoPlan, PlannedPerson,
    RoomAcoustics, RoomMeeting, RoomPlan, Seat, VoiceClip,
};
use buzz_huddle_minutes::speaker_check::{score_room_meeting, NamingCounts, SpeakerScore};
use buzz_huddle_minutes::speakers::{
    NamingSettings, ProfileSettings, SpeakerSettings, SpeakersReport,
};
use buzz_huddle_minutes::store::LocalStore;
use buzz_huddle_minutes::stt::TruthStt;
use buzz_huddle_minutes::vad::{SegmentPlan, SileroSettings, SileroVad};
use buzz_huddle_minutes::voices::{
    assign, ForgetResult, Listing, LocalVoiceStore, StoreFuture, Version, VoiceProfile, VoiceStore,
    AGREE,
};
use clap::Parser;
use serde::Serialize;

#[derive(Parser, Debug, Clone)]
struct Args {
    /// cal (Zeroth train 일부, 문턱 정하기) 또는 eval (Zeroth test, 정한 뒤 한 번).
    #[arg(long, default_value = "cal")]
    set: String,
    /// 목소리 특징 모델(후보 파일 이름).
    #[arg(long)]
    embedding: Option<String>,
    /// 군집 문턱.
    #[arg(long, default_value_t = buzz_huddle_minutes::diarize::DEFAULT_CLUSTER_THRESHOLD)]
    cluster_threshold: f32,
    /// 작은 묶음 버리기(ms).
    #[arg(long, default_value_t = buzz_huddle_minutes::speakers::DEFAULT_MIN_CLUSTER_MS)]
    min_cluster_ms: u64,
    /// 작은 묶음 몫(트랙 말 가운데).
    #[arg(long, default_value_t = buzz_huddle_minutes::speakers::DEFAULT_MIN_CLUSTER_SHARE)]
    min_cluster_share: f32,
    /// 두 번째 합치기 문턱(없으면 기본값).
    #[arg(long)]
    merge_threshold: Option<f32>,
    /// 두 번째 합치기 끄기.
    #[arg(long)]
    no_merge: bool,
    /// 두 번째 합치기 문턱 여러 개를 한 번에 잰다(음수 = 합치기 안 함). 회의마다 화자 나누기는
    /// 한 번만 하고(같은 소리면 같은 결과를 기억), 뒤 단계만 문턱마다 다시 돈다.
    #[arg(long, value_delimiter = ',', allow_negative_numbers = true)]
    merge_values: Vec<f32>,
    /// 맞추기 문턱(파이프라인 안). 표는 따로 여러 문턱으로 낸다.
    #[arg(long, default_value_t = buzz_huddle_minutes::speakers::DEFAULT_NAMING_THRESHOLD)]
    naming_threshold: f32,
    /// 프로필 평균에 쓸 최근 재료 수.
    #[arg(long, default_value_t = ProfileSettings::default().max_samples)]
    max_samples: usize,
    /// 프로필 만드는 원격 회의 수(사람마다 재료 수).
    #[arg(long, default_value_t = 3)]
    history: usize,
    /// 회의실 회의 수.
    #[arg(long, default_value_t = 24)]
    room_meetings: usize,
    /// 원격만 있는 회의 수.
    #[arg(long, default_value_t = 4)]
    own_meetings: usize,
    /// 회의실 사람 수 목록(돌려 가며).
    #[arg(long, value_delimiter = ',', default_value = "2,3,4,5")]
    sizes: Vec<usize>,
    /// 사람마다 문장 수(회의실 회의).
    #[arg(long, default_value_t = 5)]
    sentences: usize,
    /// 동시에 돌릴 회의 수.
    #[arg(long, default_value_t = 6)]
    jobs: usize,
    /// 회의실 회의 첫 seed.
    #[arg(long, default_value_t = 1_000)]
    seed: u64,
    /// 특징 내기 전 소리 크기 맞추기(dBFS RMS).
    #[arg(long)]
    embed_level_dbfs: Option<f32>,
    /// 특징 낼 때 묶음마다 최대 길이(ms).
    #[arg(long, default_value_t = SpeakerSettings::default().embed_max_ms)]
    embed_max_ms: u64,
    /// 결과 JSON.
    #[arg(long)]
    out: PathBuf,
    /// 에코 크기 범위(dB, 음수) 낮은 쪽.
    #[arg(long, default_value_t = -25.0)]
    echo_min_db: f32,
    /// 에코 크기 범위 높은 쪽.
    #[arg(long, default_value_t = -12.0)]
    echo_max_db: f32,
    /// 새는 소리(A) 끄기.
    #[arg(long)]
    no_bleed: bool,
    /// 두 번 잡힘 판정(같은 시각 자기 트랙과 겹침) 끄기: 문턱을 1 위로.
    #[arg(long)]
    no_duplicate_check: bool,
    /// 화자 바뀜에서 자르지 않기(망가뜨려 보기용): 덩어리 안 최소 토막을 아주 길게.
    #[arg(long)]
    no_cut: bool,
    /// 첫 회의실 회의를 녹음 폴더(buzz-huddle-recording/1)로 이 폴더에 쓰고 끝낸다.
    /// `process` 명령줄 경로를 돌려 볼 때 쓴다.
    #[arg(long)]
    write_meeting: Option<PathBuf>,
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 같은 소리면 화자 나누기 결과를 기억한다(뒤 단계 설정만 바꿔 여러 번 잴 때).
struct CachedDiarizer {
    inner: SherpaDiarizer,
    cache: Mutex<HashMap<String, Vec<Turn>>>,
}

impl TrackDiarizer for CachedDiarizer {
    fn diarize(&self, pcm_16k: &[f32]) -> Result<Vec<Turn>, SpeakerError> {
        let bytes: Vec<u8> = pcm_16k.iter().flat_map(|x| x.to_le_bytes()).collect();
        let key = buzz_huddle_minutes::models::sha256_hex(&bytes);
        if let Some(turns) = self.cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
            return Ok(turns);
        }
        let turns = self.inner.diarize(pcm_16k)?;
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(key, turns.clone());
        }
        Ok(turns)
    }

    fn describe(&self) -> String {
        self.inner.describe()
    }
}

/// 읽기만 하는 저장소(회의실 회의끼리 서로 영향 주지 않게).
struct ReadOnly(Arc<dyn VoiceStore>);

impl VoiceStore for ReadOnly {
    fn list(&self, community: uuid::Uuid) -> StoreFuture<'_, Listing> {
        self.0.list(community)
    }
    fn list_all(&self) -> StoreFuture<'_, Listing> {
        self.0.list_all()
    }
    fn load<'a>(
        &'a self,
        community: uuid::Uuid,
        pubkey: &'a str,
    ) -> StoreFuture<'a, Option<(VoiceProfile, Version)>> {
        self.0.load(community, pubkey)
    }
    fn save<'a>(&'a self, _: &'a VoiceProfile, _: Version) -> StoreFuture<'a, bool> {
        Box::pin(async { Ok(true) })
    }
    fn is_forgotten<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool> {
        self.0.is_forgotten(pubkey)
    }
    fn forget<'a>(&'a self, _: &'a str) -> StoreFuture<'a, ForgetResult> {
        Box::pin(async { Ok(ForgetResult::default()) })
    }
    fn allow<'a>(&'a self, _: &'a str) -> StoreFuture<'a, bool> {
        Box::pin(async { Ok(false) })
    }
}

struct Models {
    segmentation: PathBuf,
    embedding: PathBuf,
    embedding_id: ModelId,
}

fn speaker_settings(
    args: &Args,
    models: &Models,
    store: Option<Arc<dyn VoiceStore>>,
) -> anyhow::Result<SpeakerSettings> {
    let mut settings = SpeakerSettings {
        diarizer: Some(Arc::new(SherpaDiarizer::new(
            &models.segmentation,
            &models.embedding,
            DiarizerSettings {
                threshold: args.cluster_threshold,
                ..DiarizerSettings::default()
            },
        )?)),
        embedder: Some(Arc::new(SherpaEmbedder::new(
            &models.embedding,
            models.embedding_id.clone(),
            1,
        )?)),
        store,
        min_cluster_ms: args.min_cluster_ms,
        min_cluster_share: args.min_cluster_share,
        merge_threshold: if args.no_merge {
            None
        } else {
            args.merge_threshold
                .or(buzz_huddle_minutes::speakers::DEFAULT_MERGE_THRESHOLD)
        },
        embed_max_ms: args.embed_max_ms,
        embed_level_dbfs: args.embed_level_dbfs,
        naming: NamingSettings {
            threshold: args.naming_threshold,
            ..NamingSettings::default()
        },
        profiles: ProfileSettings {
            max_samples: args.max_samples,
            ..ProfileSettings::default()
        },
        ..SpeakerSettings::default()
    };
    settings.bleed.enabled = !args.no_bleed;
    // The bench measures what learning from tracks gives (history meetings).
    settings.profiles.learn = true;
    if args.no_duplicate_check {
        settings.naming.duplicate_overlap = 2.0;
    }
    if args.no_cut {
        settings.cut.min_run_ms = 10_000_000;
    }
    Ok(settings)
}

/// 한 회의를 진짜 파이프라인으로 돌린다.
fn run_meeting(
    meeting: &RoomMeeting,
    settings: SpeakerSettings,
    work: &Path,
    silero: &Path,
) -> anyhow::Result<(
    buzz_huddle_minutes::transcript::Transcript,
    SpeakersReport,
    f64,
)> {
    let dir = tempfile::tempdir_in(work)?;
    for (relative, bytes) in &meeting.files {
        let path = dir.path().join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, bytes)?;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let truth = &meeting.truth;
    let store = LocalStore::new(dir.path().join("recordings"));
    let mut detector = SileroVad::new(silero, SileroSettings::default())?;
    let stt = TruthStt::new(&meeting.stt_truth);
    runtime.block_on(async {
        let mut meetings = collect_meetings(
            &store,
            &truth.prefix,
            truth.community_id,
            truth.channel_id,
            10 * 60_000,
        )
        .await?
        .meetings;
        anyhow::ensure!(meetings.len() == 1, "{} meetings", meetings.len());
        let gathered = meetings.remove(0);
        let minutes = MinutesSettings {
            segment_plan: SegmentPlan::default(),
            stt: SttPolicy {
                retry_delay_ms: 0,
                rate_limit_delay_ms: 0,
                ..SttPolicy::default()
            },
            ledger_version: "bench".into(),
            audio_key: String::new(),
            now_unix_ms: BASE_UNIX_MS,
            speakers: settings,
        };
        let started = Instant::now();
        let output = build_minutes(
            &gathered,
            &mut detector,
            &stt,
            &mut SttLedger::in_memory(),
            &minutes,
        )
        .await?;
        let seconds = started.elapsed().as_secs_f64();
        Ok((output.transcript, output.report.speakers_split, seconds))
    })
}

/// 사람마다 문장 순번: 앞 `history_clips` 개는 프로필용, 나머지는 회의용.
struct Pool {
    by_speaker: Vec<(String, Vec<usize>)>,
    history_clips: usize,
}

impl Pool {
    fn history(&self, speaker: usize, round: usize, per_round: usize) -> Vec<usize> {
        let clips = &self.by_speaker[speaker].1;
        let from = (round * per_round).min(self.history_clips);
        let to = ((round + 1) * per_round).min(self.history_clips);
        clips[from.min(clips.len())..to.min(clips.len())].to_vec()
    }

    fn meeting_clips(&self, speaker: usize, offset: usize, count: usize) -> Vec<usize> {
        let clips = &self.by_speaker[speaker].1;
        let rest: Vec<usize> = clips.iter().skip(self.history_clips).copied().collect();
        if rest.is_empty() {
            return Vec::new();
        }
        (0..count.min(rest.len()))
            .map(|i| rest[(offset + i) % rest.len()])
            .collect()
    }
}

struct SmallRng(u64);
impl SmallRng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// 같은 회의 안에서 같은 글이 두 번 나오지 않게 고른다.
fn unique_texts(clips: &[VoiceClip], people: &mut [PlannedPerson]) {
    let mut seen = HashSet::new();
    for person in people.iter_mut() {
        person
            .clips
            .retain(|&c| seen.insert(clips[c].clip.text.clone()));
    }
}

#[derive(Serialize, Clone)]
struct MeetingRow {
    kind: String,
    seed: u64,
    room_people: usize,
    remote_people: usize,
    echo: bool,
    owner_speaks: bool,
    duration_ms: u64,
    seconds: f64,
    diarize_ms: u64,
    diarized_audio_ms: u64,
    embed_ms: u64,
    room_tracks_speakers: Vec<usize>,
    score: SpeakerScore,
}

/// 한 회의 결과와 그 회의의 회의실 화자 묶음들.
type Done = (MeetingRow, Vec<ClusterRow>);

#[derive(Serialize, Clone)]
struct ClusterRow {
    seed: u64,
    /// 이 묶음이 가장 많이 덮은 정답 사람(pubkey 앞 8자), 없으면 빈 글.
    truth: String,
    truth_known: bool,
    speech_ms: u64,
    embedded_ms: u64,
    /// (사람 앞 8자, 유사도).
    scores: Vec<(String, f32)>,
    duplicate: bool,
    named: Option<String>,
}

#[derive(Serialize, Default, Clone)]
struct ThresholdRow {
    threshold: f32,
    known_right: f64,
    known_wrong: f64,
    known_unnamed: f64,
    unknown_wrong: f64,
    unknown_unnamed: f64,
    clusters_known: usize,
    clusters_unknown: usize,
}

#[derive(Serialize)]
struct Output {
    args: String,
    set: String,
    embedding: String,
    speakers_in_set: usize,
    known_speakers: usize,
    history_profiles: usize,
    clean_same_person: Vec<f32>,
    clean_other_person_max: f32,
    room: SpeakerScore,
    own: SpeakerScore,
    meetings: Vec<MeetingRow>,
    clusters: Vec<ClusterRow>,
    naming_by_threshold: Vec<ThresholdRow>,
}

fn short(p: &str) -> String {
    p.chars().take(8).collect()
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let root = crate_dir();
    let cache = root.join(".cache");
    let manifest = cache
        .join("zeroth-ko")
        .join(&args.set)
        .join("manifest.jsonl");
    let embedding = match &args.embedding {
        Some(name) => embedding_candidate(name).context("unknown embedding model")?,
        None => SPEAKER_EMBEDDING,
    };
    let models = Models {
        segmentation: model_path(&cache, &SPEAKER_SEGMENTATION),
        embedding: model_path(&cache, &embedding),
        embedding_id: ModelId::from(&embedding),
    };
    let silero = silero_vad_path(&cache);
    let work = cache.join("speaker-bench").join("work");
    std::fs::create_dir_all(&work)?;

    let started = Instant::now();
    let mut clips = load_voice_clips(&manifest, 60)?;
    {
        let mut silero_vad = SileroVad::new(&silero, SileroSettings::default())?;
        let mut plain: Vec<_> = clips.iter().map(|c| c.clip.clone()).collect();
        mark_speech(&mut plain, &mut silero_vad)?;
        for (c, p) in clips.iter_mut().zip(plain) {
            c.clip = p;
        }
    }
    let mut by_speaker: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, c) in clips.iter().enumerate() {
        match by_speaker.iter_mut().find(|(s, _)| *s == c.speaker) {
            Some((_, list)) => list.push(i),
            None => by_speaker.push((c.speaker.clone(), vec![i])),
        }
    }
    by_speaker.sort_by(|a, b| a.0.cmp(&b.0));
    let per_round = 4;
    let pool = Pool {
        by_speaker,
        history_clips: args.history * per_round,
    };
    let speakers = pool.by_speaker.len();
    // 70% of people have a profile (fixed by position in the sorted list).
    let known_index: Vec<bool> = (0..speakers).map(|i| i % 10 < 7).collect();
    let known: HashSet<String> = (0..speakers)
        .filter(|&i| known_index[i])
        .map(|i| person_pubkey(&pool.by_speaker[i].0))
        .collect();
    eprintln!(
        "set {} | {} clips, {} speakers ({} with profiles) | loaded in {:.1}s",
        args.set,
        clips.len(),
        speakers,
        known.len(),
        started.elapsed().as_secs_f64()
    );

    // 2. Profiles from remote-only meetings.
    let store_dir = tempfile::tempdir_in(&work)?;
    let store: Arc<dyn VoiceStore> = Arc::new(LocalVoiceStore::open(store_dir.path())?);
    for round in 0..args.history {
        let people: Vec<PlannedPerson> = (0..speakers)
            .filter(|&i| known_index[i])
            .map(|i| PlannedPerson {
                speaker: pool.by_speaker[i].0.clone(),
                seat: Seat::Remote,
                clips: pool.history(i, round, per_round),
            })
            .filter(|p| !p.clips.is_empty())
            .collect();
        let mut people = people;
        unique_texts(&clips, &mut people);
        let plan = RoomPlan {
            people,
            room_owner: None,
            echo: None,
            acoustics: RoomAcoustics::default(),
            overlap_chance: 0.0,
        };
        let meeting =
            build_room_meeting(&clips, &plan, 500 + round as u64, "huddles", BASE_UNIX_MS)?;
        let settings = speaker_settings(&args, &models, Some(store.clone()))?;
        let (_, report, seconds) = run_meeting(&meeting, settings, &work, &silero)?;
        let split = report.tracks.iter().filter(|t| t.speakers >= 2).count();
        eprintln!(
            "history {round}: {} tracks, {} split, profiles created/updated {}, {:.1}s",
            report.tracks.len(),
            split,
            report
                .tracks
                .iter()
                .filter(|t| matches!(
                    t.profile,
                    buzz_huddle_minutes::speakers::ProfileUpdate::Created
                        | buzz_huddle_minutes::speakers::ProfileUpdate::Updated
                ))
                .count(),
            seconds
        );
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let profiles: Vec<VoiceProfile> = runtime
        .block_on(store.list(sim_community()))?
        .profiles
        .into_iter()
        .map(|(profile, _)| profile)
        .collect();
    // Clean against clean: one sample of a person vs the mean of the others.
    let mut clean_same = Vec::new();
    let mut clean_other_max = f32::MIN;
    for p in &profiles {
        for (i, s) in p.samples.iter().enumerate() {
            let mut rest = p.clone();
            rest.samples.remove(i);
            if let Some(mean) = rest.mean(AGREE, args.max_samples) {
                clean_same.push(cosine(&mean, &s.embedding));
            }
            for q in profiles.iter().filter(|q| q.pubkey != p.pubkey) {
                if let Some(mean) = q.mean(AGREE, args.max_samples) {
                    clean_other_max = clean_other_max.max(cosine(&mean, &s.embedding));
                }
            }
        }
    }
    clean_same.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let read_only: Arc<dyn VoiceStore> = Arc::new(ReadOnly(store.clone()));

    // 3. and 4. Meetings to run.
    let mut plans: Vec<(String, u64, RoomPlan)> = Vec::new();
    for m in 0..args.room_meetings {
        let seed = args.seed + m as u64;
        let mut rng = SmallRng(seed.wrapping_mul(7_919));
        let k = args.sizes[m % args.sizes.len()];
        let remote = [0usize, 1, 2][(m / args.sizes.len()) % 3];
        let mut order: Vec<usize> = (0..speakers).collect();
        for i in (1..order.len()).rev() {
            order.swap(i, rng.below(i + 1));
        }
        let mut people = Vec::new();
        for (n, &s) in order.iter().take(k + remote).enumerate() {
            let seat = if n < k {
                Seat::Room {
                    distance_m: 0.7 + 2.3 * rng.unit(),
                }
            } else {
                Seat::Remote
            };
            let count = if n < k { args.sentences } else { 4 };
            people.push(PlannedPerson {
                speaker: pool.by_speaker[s].0.clone(),
                seat,
                clips: pool.meeting_clips(s, (seed as usize * 3) % 50, count),
            });
        }
        unique_texts(&clips, &mut people);
        let echo = (remote > 0 && m % 2 == 0).then(|| EchoPlan {
            gain_db: args.echo_min_db + (args.echo_max_db - args.echo_min_db) * rng.unit(),
            delay_ms: 150 + rng.below(200) as u64,
        });
        let room_owner = (m % 3 != 0).then(|| rng.below(k));
        plans.push((
            "room".into(),
            seed,
            RoomPlan {
                people,
                room_owner,
                echo,
                acoustics: RoomAcoustics::default(),
                overlap_chance: 0.2,
            },
        ));
    }
    for m in 0..args.own_meetings {
        let seed = args.seed + 10_000 + m as u64;
        let mut rng = SmallRng(seed);
        let n = 3 + m % 3;
        let mut order: Vec<usize> = (0..speakers).collect();
        for i in (1..order.len()).rev() {
            order.swap(i, rng.below(i + 1));
        }
        let mut people: Vec<PlannedPerson> = order
            .iter()
            .take(n)
            .map(|&s| PlannedPerson {
                speaker: pool.by_speaker[s].0.clone(),
                seat: Seat::Remote,
                clips: pool.meeting_clips(s, (seed as usize * 5) % 50, args.sentences),
            })
            .collect();
        unique_texts(&clips, &mut people);
        plans.push((
            "own".into(),
            seed,
            RoomPlan {
                people,
                room_owner: None,
                echo: None,
                acoustics: RoomAcoustics::default(),
                overlap_chance: 0.2,
            },
        ));
    }

    if let Some(dir) = &args.write_meeting {
        let (_, seed, plan) = plans.first().context("no room meeting planned")?;
        let meeting = build_room_meeting(&clips, plan, *seed, "huddles", BASE_UNIX_MS)?;
        for (relative, bytes) in &meeting.files {
            let path = dir.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, bytes)?;
        }
        let truth = &meeting.truth;
        println!(
            "--recordings {} --prefix {} --community {} --channel {} --now-ms {}",
            dir.join("recordings").display(),
            truth.prefix,
            truth.community_id,
            truth.channel_id,
            BASE_UNIX_MS + truth.duration_ms + 3_600_000
        );
        return Ok(());
    }
    let rows: Arc<Mutex<Vec<Done>>> = Arc::default();
    let next = Arc::new(Mutex::new(0usize));
    let plans = Arc::new(plans);
    let clips = Arc::new(clips);
    let known = Arc::new(known);
    std::thread::scope(|scope| -> anyhow::Result<()> {
        let mut handles = Vec::new();
        for _ in 0..args.jobs.max(1) {
            let (rows, next, plans, clips, known) = (
                rows.clone(),
                next.clone(),
                plans.clone(),
                clips.clone(),
                known.clone(),
            );
            let (args, models, silero, work, read_only) =
                (&args, &models, &silero, &work, read_only.clone());
            handles.push(scope.spawn(move || -> anyhow::Result<()> {
                loop {
                    let index = {
                        let mut n = next.lock().map_err(|_| anyhow::anyhow!("lock"))?;
                        let i = *n;
                        *n += 1;
                        i
                    };
                    let Some((kind, seed, plan)) = plans.get(index) else {
                        return Ok(());
                    };
                    let meeting = build_room_meeting(&clips, plan, *seed, "huddles", BASE_UNIX_MS)?;
                    let variants: Vec<Option<Option<f32>>> = if args.merge_values.is_empty() {
                        vec![None]
                    } else {
                        args.merge_values
                            .iter()
                            .map(|&v| Some((v >= 0.0).then_some(v)))
                            .collect()
                    };
                    let cached: Arc<dyn TrackDiarizer> = Arc::new(CachedDiarizer {
                        inner: SherpaDiarizer::new(
                            &models.segmentation,
                            &models.embedding,
                            DiarizerSettings {
                                threshold: args.cluster_threshold,
                                ..DiarizerSettings::default()
                            },
                        )?,
                        cache: Mutex::default(),
                    });
                    for variant in &variants {
                    let mut settings = speaker_settings(args, models, Some(read_only.clone()))?;
                    let kind = match variant {
                        None => kind.clone(),
                        Some(merge) => {
                            settings.diarizer = Some(cached.clone());
                            settings.merge_threshold = *merge;
                            format!("{kind}@merge{}", merge.map_or("none".to_string(), |v| v.to_string()))
                        }
                    };
                    let (transcript, report, seconds) =
                        run_meeting(&meeting, settings, work, silero)?;
                    let score = score_room_meeting(&transcript, &meeting.truth, &report, &known);
                    let truth = &meeting.truth;
                    let room_people = truth
                        .people
                        .iter()
                        .filter(|p| matches!(p.seat, Seat::Room { .. }))
                        .count();
                    let room_tracks_speakers = report
                        .tracks
                        .iter()
                        .filter(|t| Some(&t.device) == truth.room_device.as_ref())
                        .map(|t| t.speakers)
                        .collect();
                    // Each room cluster's true person: the one its lines cover most.
                    let mut cluster_rows = Vec::new();
                    for cluster in &report.clusters {
                        let mut by_person: HashMap<&str, u64> = HashMap::new();
                        for line in transcript.segments.iter().filter(|l| {
                            l.device == cluster.device
                                && l.speaker_label.as_deref() == Some(cluster.label.as_str())
                        }) {
                            for u in truth.utterances.iter().filter(|u| u.device == cluster.device) {
                                let o = line
                                    .end_ms
                                    .min(u.end_ms)
                                    .saturating_sub(line.start_ms.max(u.start_ms));
                                *by_person.entry(u.person.as_str()).or_default() += o;
                            }
                        }
                        let top = by_person
                            .iter()
                            .filter(|(_, ms)| **ms > 0)
                            .max_by_key(|(p, ms)| (**ms, **p))
                            .map(|(p, _)| p.to_string())
                            .unwrap_or_default();
                        cluster_rows.push(ClusterRow {
                            seed: *seed,
                            truth_known: known.contains(&top),
                            truth: short(&top),
                            speech_ms: cluster.speech_ms,
                            embedded_ms: cluster.embedded_ms,
                            scores: cluster
                                .scores
                                .iter()
                                .map(|(p, s)| (short(p), *s))
                                .collect(),
                            duplicate: cluster.duplicate_of_own_track,
                            named: cluster.named.as_ref().map(|(p, _)| short(p)),
                        });
                    }
                    let row = MeetingRow {
                        kind: kind.clone(),
                        seed: *seed,
                        room_people,
                        remote_people: truth.people.len() - room_people,
                        echo: !truth.echoes.is_empty(),
                        owner_speaks: plan.room_owner.is_some(),
                        duration_ms: truth.duration_ms,
                        seconds,
                        diarize_ms: report.diarize_ms,
                        diarized_audio_ms: report.diarized_audio_ms,
                        embed_ms: report.embed_ms,
                        room_tracks_speakers,
                        score,
                    };
                    eprintln!(
                        "{kind} seed {seed}: room {} remote {} | room speakers found {:?} | DER {:.3} (no overlap {:.3}) | grouped {}/{} | named known {:?} unknown {:?} | own split {}/{} | dup {} lost {} removed-real {} | {:.1}s",
                        row.room_people,
                        row.remote_people,
                        row.room_tracks_speakers,
                        row.score.room_der.der(),
                        row.score.room_der_no_overlap.der(),
                        row.score.room_sentences_grouped_right,
                        row.score.room_sentences,
                        row.score.naming_known,
                        row.score.naming_unknown,
                        row.score.own_tracks_split,
                        row.score.own_tracks,
                        row.score.duplicated_sentences,
                        row.score.sentences_lost,
                        row.score.removed_real_pieces,
                        seconds
                    );
                    rows.lock()
                        .map_err(|_| anyhow::anyhow!("lock"))?
                        .push((row, cluster_rows));
                    }
                }
            }));
        }
        for handle in handles {
            handle
                .join()
                .map_err(|_| anyhow::anyhow!("worker panicked"))??;
        }
        Ok(())
    })?;

    let mut rows = Arc::try_unwrap(rows)
        .map_err(|_| anyhow::anyhow!("rows still shared"))?
        .into_inner()
        .map_err(|_| anyhow::anyhow!("lock"))?;
    rows.sort_by_key(|(r, _)| (r.kind.clone(), r.seed));
    if !args.merge_values.is_empty() {
        let mut kinds: Vec<String> = rows.iter().map(|(r, _)| r.kind.clone()).collect();
        kinds.dedup();
        for kind in kinds {
            let mut sum = SpeakerScore::default();
            let (mut under, mut over, mut exact) = (0, 0, 0);
            for (row, _) in rows.iter().filter(|(r, _)| r.kind == kind) {
                sum.add(&row.score);
                let found = row.room_tracks_speakers.first().copied().unwrap_or(0);
                match found.cmp(&row.room_people) {
                    std::cmp::Ordering::Less => under += 1,
                    std::cmp::Ordering::Greater => over += 1,
                    std::cmp::Ordering::Equal => exact += 1,
                }
            }
            let reference = sum.room_der.reference_ms.max(1) as f64;
            println!(
                "{kind}: meetings {} | DER {:.3} conf {:.3} | grouped {:.3} ({}/{}) | speakers exact {exact} fewer {under} more {over} | own split {}/{}",
                sum.meetings,
                sum.room_der.der(),
                sum.room_der.confusion_ms as f64 / reference,
                sum.room_sentences_grouped_right as f64 / sum.room_sentences.max(1) as f64,
                sum.room_sentences_grouped_right,
                sum.room_sentences,
                sum.own_tracks_split,
                sum.own_tracks,
            );
        }
    }
    let mut room = SpeakerScore::default();
    let mut own = SpeakerScore::default();
    let mut clusters = Vec::new();
    let mut meetings = Vec::new();
    for (row, cluster_rows) in rows {
        if row.kind == "room" {
            room.add(&row.score);
        } else {
            own.add(&row.score);
        }
        clusters.extend(cluster_rows);
        meetings.push(row);
    }

    // 5. Naming by threshold, weighted by each cluster's speech.
    let mut naming_by_threshold = Vec::new();
    for step in 0..=14 {
        let threshold = 0.20 + 0.05 * step as f32;
        let mut row = ThresholdRow {
            threshold,
            ..ThresholdRow::default()
        };
        let mut known_total = 0f64;
        let mut unknown_total = 0f64;
        let mut by_seed: HashMap<u64, Vec<usize>> = HashMap::new();
        for (i, c) in clusters.iter().enumerate() {
            if !c.duplicate && !c.truth.is_empty() {
                by_seed.entry(c.seed).or_default().push(i);
            }
        }
        for indices in by_seed.values() {
            let mut names: Vec<String> = Vec::new();
            let scores: Vec<Vec<(usize, f32)>> = indices
                .iter()
                .map(|&i| {
                    clusters[i]
                        .scores
                        .iter()
                        .map(|(p, s)| {
                            let at = match names.iter().position(|n| n == p) {
                                Some(at) => at,
                                None => {
                                    names.push(p.clone());
                                    names.len() - 1
                                }
                            };
                            (at, *s)
                        })
                        .collect()
                })
                .collect();
            let named = assign(&scores, threshold);
            for (n, &i) in indices.iter().enumerate() {
                let c = &clusters[i];
                let w = c.speech_ms as f64;
                let got = named[n].map(|(p, _)| names[p].clone());
                if c.truth_known {
                    known_total += w;
                    row.clusters_known += 1;
                    match got {
                        Some(p) if p == c.truth => row.known_right += w,
                        Some(_) => row.known_wrong += w,
                        None => row.known_unnamed += w,
                    }
                } else {
                    unknown_total += w;
                    row.clusters_unknown += 1;
                    match got {
                        Some(_) => row.unknown_wrong += w,
                        None => row.unknown_unnamed += w,
                    }
                }
            }
        }
        if known_total > 0.0 {
            row.known_right /= known_total;
            row.known_wrong /= known_total;
            row.known_unnamed /= known_total;
        }
        if unknown_total > 0.0 {
            row.unknown_wrong /= unknown_total;
            row.unknown_unnamed /= unknown_total;
        }
        naming_by_threshold.push(row);
    }

    let rate = |n: usize, d: usize| if d == 0 { 0.0 } else { n as f64 / d as f64 };
    let naming = |c: &NamingCounts| {
        let t = c.total();
        format!(
            "right {:.3} wrong {:.3} unnamed {:.3} missed {:.3} (n={t})",
            rate(c.right, t),
            rate(c.wrong, t),
            rate(c.unnamed, t),
            rate(c.missed, t)
        )
    };
    let audio_ms: u64 = meetings.iter().map(|m| m.duration_ms).sum();
    let wall: f64 = meetings.iter().map(|m| m.seconds).sum();
    let diarize_ms: u64 = meetings.iter().map(|m| m.diarize_ms).sum();
    let diarized_ms: u64 = meetings.iter().map(|m| m.diarized_audio_ms).sum();
    let embed_ms: u64 = meetings.iter().map(|m| m.embed_ms).sum();
    println!("== {} | embedding {} | cluster threshold {} | min cluster {} ms share {} | merge {:?} | naming threshold {} | max samples {}",
        args.set, embedding.file, args.cluster_threshold, args.min_cluster_ms, args.min_cluster_share, if args.no_merge { None } else { args.merge_threshold.or(buzz_huddle_minutes::speakers::DEFAULT_MERGE_THRESHOLD) }, args.naming_threshold, args.max_samples);
    println!(
        "room: meetings {} | DER {:.3} (miss {:.3} fa {:.3} conf {:.3}) | DER no overlap {:.3} | sentences grouped right {:.3} ({}/{}) missed {}",
        room.meetings,
        room.room_der.der(),
        room.room_der.miss_ms as f64 / room.room_der.reference_ms.max(1) as f64,
        room.room_der.false_alarm_ms as f64 / room.room_der.reference_ms.max(1) as f64,
        room.room_der.confusion_ms as f64 / room.room_der.reference_ms.max(1) as f64,
        room.room_der_no_overlap.der(),
        rate(room.room_sentences_grouped_right, room.room_sentences),
        room.room_sentences_grouped_right,
        room.room_sentences,
        room.room_sentences_missed
    );
    println!(
        "room naming, people with a profile: {}",
        naming(&room.naming_known)
    );
    println!(
        "room naming, people without one:   {}",
        naming(&room.naming_unknown)
    );
    println!(
        "room owner pubkey given to someone else: {} | duplicated sentences {} (echoes {}) | lost {} | removed pieces {} real {} ({} ms)",
        room.room_owner_given_by_device,
        room.duplicated_sentences,
        room.echoes,
        room.sentences_lost,
        room.removed_pieces,
        room.removed_real_pieces,
        room.removed_real_ms
    );
    println!(
        "one-person tracks split: {} of {} (room meetings' remote tracks {} split {}) | own sentences right {}/{} | own meetings removed real {}",
        own.own_tracks_split,
        own.own_tracks,
        room.own_tracks,
        room.own_tracks_split,
        own.own_sentences_right + room.own_sentences_right,
        own.own_sentences + room.own_sentences,
        own.removed_real_pieces
    );
    println!(
        "time: {:.0} s audio, pipeline {:.1} s ({:.3}x real time) | diarize {:.1} s for {:.0} s squeezed audio ({:.3}x) | embed {:.1} s",
        audio_ms as f64 / 1_000.0,
        wall,
        wall / (audio_ms as f64 / 1_000.0),
        diarize_ms as f64 / 1_000.0,
        diarized_ms as f64 / 1_000.0,
        diarize_ms as f64 / diarized_ms.max(1) as f64,
        embed_ms as f64 / 1_000.0
    );
    println!(
        "clean vs clean, same person: min {:.3} median {:.3} | other person max {:.3}",
        clean_same.first().copied().unwrap_or(0.0),
        clean_same.get(clean_same.len() / 2).copied().unwrap_or(0.0),
        clean_other_max
    );
    println!("naming threshold | known right wrong unnamed | unknown wrong unnamed");
    for row in &naming_by_threshold {
        println!(
            "  {:.2} | {:.3} {:.3} {:.3} | {:.3} {:.3}",
            row.threshold,
            row.known_right,
            row.known_wrong,
            row.known_unnamed,
            row.unknown_wrong,
            row.unknown_unnamed
        );
    }
    let output = Output {
        args: format!("{args:?}"),
        set: args.set.clone(),
        embedding: embedding.file.into(),
        speakers_in_set: speakers,
        known_speakers: known.len(),
        history_profiles: profiles.len(),
        clean_same_person: clean_same,
        clean_other_person_max: clean_other_max,
        room,
        own,
        meetings,
        clusters,
        naming_by_threshold,
    };
    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&args.out, serde_json::to_vec_pretty(&output)?)?;
    eprintln!(
        "wrote {} in {:.0}s",
        args.out.display(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}
