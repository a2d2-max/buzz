//! 화자 단계: 파이프라인에 끼우는 자리 하나에서 B → A → C 를 돈다.
//!
//! 1. [`MeetingSpeakers::start`]: (A 가 켜져 있고 트랙이 둘 이상이면) 트랙마다 10ms 소리 크기
//!    흐름을 미리 만든다.
//! 2. [`MeetingSpeakers::split`] (트랙마다, 받아쓰기 전에):
//!    - B: 말 덩어리만 이어 붙여 화자를 나눈다. 말이 [`SpeakerSettings::min_cluster_ms`] 보다
//!      적은 화자 묶음은 버린다(헛기침·웃음이 "새 사람"이 되지 않게). 남은 화자가 둘 이상이면
//!      "여럿이 쓰는 트랙"이고, 덩어리를 화자가 바뀌는 자리에서 자른다([`RoomPieces::Cut`], 기본).
//!      [`RoomPieces::Whole`] 이면 받아쓰기에는 자르지 않은 덩어리를 보내고(단어 시각을 묻는다), 자른
//!      토막은 줄을 나눌 때만 쓴다.
//!    - A: 다른 트랙에서 새어 든 소리인 덩어리는 받아쓰기에 보내지 않는다.
//!    - C 재료: 한 사람 트랙이면 그 사람 목소리 특징, 여럿 트랙이면 화자 묶음마다 특징을 낸다.
//! 3. [`MeetingSpeakers::lines`] (덩어리마다, 받아쓴 뒤): 스크립트 줄을 만든다(whole 의 여럿 트랙이면
//!    단어를 시각으로 화자에 나눈다).
//! 4. [`MeetingSpeakers::finish`] (모든 트랙 뒤, 스크립트 줄이 다 나온 뒤):
//!    - 회의실 화자 묶음을 같은 회의의 깨끗한 트랙 특징·저장된 프로필과 코사인으로 맞춘다.
//!    - 맞은 사람이 같은 회의에 자기 기기로도 있고, 묶음의 말이 그 사람 트랙 말과 같은 시각이면
//!      같은 말이 두 번 잡힌 것(스피커 에코·같은 방 노트북)이라 회의실 쪽 줄을 뺀다.
//!    - "회의실 화자 N" 번호를 붙이고, 줄마다 `speaker`·`speaker_label`·`speaker_confidence` 를 쓴다.
//!    - 깨끗한 한 사람 트랙으로만 프로필을 고친다(회의실에서 기계가 맞힌 것은 재료로 안 쓴다).
//!
//! 모델이 없으면(기본 설정) 트랙 하나 = 사람 한 명, 예전과 똑같다.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use uuid::Uuid;

use crate::bleed::{find_bleed, BleedSettings, Envelope};
use crate::diarize::{
    cosine, cut_pieces, merge_similar, speech_per_speaker, squeeze, weighted_mean, CutSettings,
    ModelId, SpeakerError, SpeakerPiece, TrackDiarizer, Turn, VoiceEmbedder,
};
use crate::tracks::{Demuxed, SAMPLE_RATE};
use crate::transcript::{Participant, Segment};
use crate::vad::{Piece, VAD_SAMPLE_RATE};
use crate::voices::{
    assign, day_of, SampleSource, VoiceProfile, VoiceSample, VoiceStore, VoiceStoreError,
};

/// 회의실 화자 이름표 앞부분.
pub const ROOM_SPEAKER_LABEL: &str = "회의실 화자";
/// 회의실 줄에서 그 화자 몫이 이보다 적으면(다른 사람이 끼어들어 겹친 줄) 이름표만 두고 이름·확실도는
/// 비운다.
const MIN_NAMED_SHARE: f32 = 0.5;

/// 누가 누군지(C) 맞추는 기준.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NamingSettings {
    /// 같은 회의의 깨끗한 트랙으로 맞추기(기본 켜짐).
    pub same_meeting: bool,
    /// 저장된 프로필로 맞추기(저장소가 있을 때).
    pub profiles: bool,
    /// 코사인 유사도가 이 이상이어야 그 사람으로 본다. 잰 값은 문서 "누가 누군지" 표.
    pub threshold: f32,
    /// 맞은 묶음의 말이 그 사람 자기 트랙 말과 이만큼 이상 같은 시각이면 같은 말이 두 번 잡힌 것.
    pub duplicate_overlap: f32,
}

impl Default for NamingSettings {
    fn default() -> Self {
        Self {
            same_meeting: true,
            profiles: true,
            threshold: DEFAULT_NAMING_THRESHOLD,
            duplicate_overlap: 0.5,
        }
    }
}

/// 맞추기 문턱 기본값. cal 에서 회의실 묶음이 다른 사람 프로필과 낸 유사도의 최고가 0.609,
/// 깨끗한 소리끼리 다른 사람 최고가 0.636 이라 그 위로 잡았다(문서 "누가 누군지" 표).
pub const DEFAULT_NAMING_THRESHOLD: f32 = 0.65;

/// 프로필 재료·고치기 기준.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProfileSettings {
    /// 한 사람 트랙이 이만큼 이상 말해야 재료로 쓴다(ms).
    pub min_material_ms: u64,
    /// 자기 트랙 재료는 최근 이만큼만 모은다(평균도 이만큼으로).
    pub max_samples: usize,
    /// 재료끼리 같은 사람으로 보는 코사인. 서로 이만큼 닮은 재료가 둘 이상이어야 프로필이 "준비"되고,
    /// 준비된 프로필에는 새 재료가 이만큼 이상 닮아야 들어간다(다른 사람 목소리가 주인 이름으로
    /// 들어가는 것을 막는다). 주인 목소리 검사도 이 값.
    pub update_min_similarity: f32,
    /// 자기 기기 혼자 트랙에서 저절로 배우기(프로필 만들기·고치기). 기본 끔: "그 기기 혼자 트랙 = 기기
    /// 주인" 이 회의실 기기에서 깨져서(같은 남이 두 번 말하면 주인 키에 남의 목소리가 준비된다) 그 문제가
    /// 풀리기 전엔 켜지 않는다. 끄면 트랙으로는 아무것도 쓰지 않고, 프로필은 사람이 확인한 재료로만 생긴다.
    pub learn: bool,
}

impl Default for ProfileSettings {
    fn default() -> Self {
        Self {
            min_material_ms: 20_000,
            max_samples: 5,
            // cal: same person clean vs clean min 0.873, other person max 0.636.
            update_min_similarity: crate::voices::AGREE,
            learn: false,
        }
    }
}

/// 화자 단계 설정. 기본값은 모델 없음 = 트랙 하나 = 사람 한 명(예전과 같음).
#[derive(Clone)]
pub struct SpeakerSettings {
    /// 트랙 안 화자 나누기(B). `None` 이면 하지 않는다.
    pub diarizer: Option<Arc<dyn TrackDiarizer>>,
    /// 목소리 특징(C). `None` 이면 누가 누군지 맞추지 않는다.
    pub embedder: Option<Arc<dyn VoiceEmbedder>>,
    /// 회의 사이 프로필 저장소. `None` 이면 회의 사이 저장 꺼짐.
    pub store: Option<Arc<dyn VoiceStore>>,
    /// 말이 이보다 적은 화자 묶음은 버린다(ms).
    pub min_cluster_ms: u64,
    /// 말이 트랙 전체 말의 이 몫보다 적은 묶음도 버린다(긴 회의용, 0 이면 안 씀).
    pub min_cluster_share: f32,
    /// 두 번째 합치기: 묶음 평균 특징끼리 코사인이 이 이상이면 한 사람(`None` 이면 안 함).
    pub merge_threshold: Option<f32>,
    /// 화자 나누기에 넣을 때 말 덩어리 사이에 둘 무음(ms).
    pub squeeze_gap_ms: u64,
    /// 덩어리 자르기.
    pub cut: CutSettings,
    /// 새는 소리(A).
    pub bleed: BleedSettings,
    /// 누가 누군지(C).
    pub naming: NamingSettings,
    /// 프로필.
    pub profiles: ProfileSettings,
    /// 특징을 낼 때 쓰는 덩어리: 이보다 짧은 것은 빼고(ms),
    pub embed_min_piece_ms: u64,
    /// 묶음(또는 트랙)마다 이만큼까지만 쓴다(ms, 긴 덩어리부터).
    pub embed_max_ms: u64,
    /// 특징을 내기 전에 덩어리 소리 크기를 이 RMS(dBFS)로 맞춘다(`None` 이면 그대로).
    pub embed_level_dbfs: Option<f32>,
    /// 여럿이 쓰는 트랙의 받아쓰기 조각(기본 [`RoomPieces::Cut`]).
    pub room_pieces: RoomPieces,
}

/// 여럿이 쓰는 트랙을 받아쓰기에 어떻게 보내나. 한 사람 트랙은 어느 쪽이든 같다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum RoomPieces {
    /// A: 화자가 바뀌는 자리에서 자른 토막마다 보낸다(단어 시각 없음). KconfSpeech 실제 회의 발췌에서 C 보다
    /// CER 이 낮았다(6.47% 대 7.42%). 장부 열쇠에 토막 경계가 들어가서, 화자 설정을 바꾸면 경계가 바뀐 조각은
    /// 다시 보낸다.
    #[default]
    Cut,
    /// C: VAD 덩어리 그대로 보내고 단어 시각을 받아 단어를 화자에 나눈다. 장부 열쇠가 화자 설정과 상관없다.
    /// 단어 시각을 켜면 받아쓰기가 조금 나빠진다. 겹쳐 말하기가 있는 가짜 회의실에서는 A 보다 나았다(표본 작음).
    Whole,
}

impl Default for SpeakerSettings {
    fn default() -> Self {
        Self {
            diarizer: None,
            embedder: None,
            store: None,
            min_cluster_ms: DEFAULT_MIN_CLUSTER_MS,
            min_cluster_share: DEFAULT_MIN_CLUSTER_SHARE,
            merge_threshold: DEFAULT_MERGE_THRESHOLD,
            squeeze_gap_ms: 500,
            cut: CutSettings::default(),
            // Off here so the plain default is exactly one person per track;
            // `process --speakers on` turns it on.
            bleed: BleedSettings {
                enabled: false,
                ..BleedSettings::default()
            },
            naming: NamingSettings::default(),
            profiles: ProfileSettings::default(),
            embed_min_piece_ms: 1_000,
            embed_max_ms: 60_000,
            embed_level_dbfs: None,
            room_pieces: RoomPieces::Cut,
        }
    }
}

/// 작은 묶음 버리기 기본값(잰 값 + 여유, 문서 "화자 나누기" 표).
pub const DEFAULT_MIN_CLUSTER_MS: u64 = 5_000;
/// 긴 회의 작은 묶음 몫 기본값(문서 "화자 나누기" 표).
pub const DEFAULT_MIN_CLUSTER_SHARE: f32 = 0.0;
/// 두 번째 합치기 기본값. cal 긴 회의(3~6명 x 20문장)에서 합치기가 없으면 8회의 모두 사람보다 많이
/// 나뉘었고(혼동 0.146), 0.65~0.75 에서 혼동 0.033~0.034 로 가장 적었다. 0.6 아래는 다른 사람을
/// 합쳐 혼동이 0.145 로 뛴다. 그 낭떠러지에서 0.1 떨어진 0.7(문서 "화자 나누기" 표).
pub const DEFAULT_MERGE_THRESHOLD: Option<f32> = Some(0.7);

impl std::fmt::Debug for SpeakerSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpeakerSettings")
            .field("diarizer", &self.diarizer.as_ref().map(|d| d.describe()))
            .field("embedder", &self.embedder.as_ref().map(|e| e.model().name))
            .field("store", &self.store.is_some())
            .field("min_cluster_ms", &self.min_cluster_ms)
            .field("min_cluster_share", &self.min_cluster_share)
            .field("merge_threshold", &self.merge_threshold)
            .field("cut", &self.cut)
            .field("bleed", &self.bleed)
            .field("naming", &self.naming)
            .field("profiles", &self.profiles)
            .finish()
    }
}

/// 화자 단계가 실패한 까닭.
#[derive(Debug, thiserror::Error)]
pub enum SpeakersError {
    /// 화자 나누기·특징.
    #[error(transparent)]
    Speaker(#[from] SpeakerError),
    /// 소리 크기 흐름을 만들려고 Opus 를 풀다 실패.
    #[error("opus: {0}")]
    Opus(#[from] opus::Error),
}

/// 회의실 화자 묶음 하나(숫자와 pubkey 만, 소리·글·특징 값은 없다).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ClusterReport {
    /// 트랙(기기) pubkey.
    pub device: String,
    /// 트랙 안 번호.
    pub local: usize,
    /// "회의실 화자 N"(같은 말이 두 번 잡힌 것으로 뺀 묶음은 빈 글).
    pub label: String,
    /// 이 묶음에 간 말(ms, 받아쓰기 덩어리 기준).
    pub speech_ms: u64,
    /// 특징을 낸 말(ms).
    pub embedded_ms: u64,
    /// 후보마다 유사도(같은 회의 트랙·프로필 가운데 높은 것). 후보에는 이 회의에 없는 사람(저장된
    /// 프로필)도 있어서 **pubkey 앞 8자만** 둔다.
    pub scores: Vec<(String, f32)>,
    /// 맞춘 사람(pubkey 앞 8자)과 유사도. 전체 pubkey 는 스크립트 줄의 `speaker` 에 있다.
    pub named: Option<(String, f32)>,
    /// 맞은 사람이 같은 시각 자기 트랙에서 말한 것(줄을 뺐다).
    pub duplicate_of_own_track: bool,
}

/// 트랙 하나.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct TrackSpeakersReport {
    /// 트랙(기기) pubkey.
    pub device: String,
    /// 화자 나누기가 찾은 화자 수(작은 묶음 버린 뒤). 나누지 않았으면 1.
    pub speakers: usize,
    /// 버린 작은 묶음 수.
    pub folded_clusters: usize,
    /// 두 번째 합치기로 합친 횟수.
    pub merged_clusters: usize,
    /// 화자 나누기가 낸 묶음마다 말(ms, 화자 나누기 구간 기준, 버리기·합치기 전).
    pub raw_cluster_ms: Vec<u64>,
    /// 두 번째 합치기 전 남은 묶음끼리 평균 목소리 코사인 `(a, b, 유사도)`(남은 묶음 번호).
    pub cluster_similarity: Vec<(usize, usize, f32)>,
    /// 자른 뒤 덩어리 수 − 자르기 전 덩어리 수.
    pub extra_pieces: usize,
    /// 한 사람 트랙의 특징을 낸 말(ms). 0 이면 특징 없음.
    pub own_embedded_ms: u64,
    /// 한 사람 트랙의 말(ms, 새어 든 소리 뺀 덩어리 기준).
    pub own_speech_ms: u64,
    /// 새어 든 소리로 뺀 덩어리 수와 길이(ms).
    pub bleed_pieces: usize,
    /// 새어 든 소리로 뺀 길이(ms).
    pub bleed_ms: u64,
    /// 새어 든 소리로 뺀 덩어리 시각들(회의 ms).
    pub bleed_spans_ms: Vec<(u64, u64)>,
    /// 프로필을 어떻게 했나.
    pub profile: ProfileUpdate,
    /// 화자가 하나인데 저장된 주인 목소리와 달라서 회의실 화자로 돌린 트랙.
    pub owner_voice_mismatch: bool,
}

/// 한 사람 트랙으로 프로필을 어떻게 했나.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
pub enum ProfileUpdate {
    /// 저장소 없음, 여럿 트랙, 또는 특징 없음.
    #[default]
    NotUsed,
    /// 말이 짧아 재료로 안 씀.
    TooShort,
    /// 새로 만듦(아직 대기: 닮은 재료가 하나 더 와야 쓴다).
    Created,
    /// 재료를 넣음.
    Updated,
    /// 같은 재료가 이미 있음(같은 회의를 다시 돌림).
    Unchanged,
    /// 준비된 프로필과 너무 달라 넣지 않음(반대 수만 올림).
    Refused,
    /// 지운 사람이라 만들지 않음.
    Forgotten,
    /// 다른 워커와 두 번 겹쳐 이번엔 못 넣음(다음 회의에 다시).
    Raced,
    /// 저장소 오류, 또는 이번 회의에 저장소 목록을 못 읽어 쓰지 않음.
    StoreError,
}

/// 화자 단계 보고(숫자와 pubkey 만).
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct SpeakersReport {
    /// 화자 나누기 설정(모델·문턱), 꺼져 있으면 `None`.
    pub diarizer: Option<String>,
    /// 특징 모델 이름.
    pub embedder: Option<String>,
    /// 트랙마다.
    pub tracks: Vec<TrackSpeakersReport>,
    /// 회의실 화자 묶음마다.
    pub clusters: Vec<ClusterReport>,
    /// 같은 말이 두 번 잡혀 뺀 줄 수.
    pub duplicate_lines_removed: usize,
    /// 그 길이(ms).
    pub duplicate_ms_removed: u64,
    /// 뺀 줄의 `(트랙 pubkey, 시작, 끝)`(회의 ms).
    pub duplicate_spans_ms: Vec<(String, u64, u64)>,
    /// 저장소에서 읽은 준비된(모델이 같은) 프로필 수.
    pub profiles_loaded: usize,
    /// 아직 대기인 프로필 수(맞추기에 안 씀).
    pub profiles_pending: usize,
    /// 저장소에서 못 읽어 건너뛴 파일 수.
    pub profiles_unreadable: usize,
    /// 모델이 달라 못 쓴 프로필 수.
    pub profiles_other_model: usize,
    /// 저장소 오류 수(회의는 계속한다). 목록을 못 읽은 회의는 프로필을 읽지도 쓰지도 않는다.
    pub store_errors: usize,
    /// 화자 나누기에 걸린 시간(ms).
    pub diarize_ms: u64,
    /// 화자 나누기에 넣은 소리 길이(ms).
    pub diarized_audio_ms: u64,
    /// 특징 내기에 걸린 시간(ms).
    pub embed_ms: u64,
    /// 소리 크기 흐름(A)에 걸린 시간(ms).
    pub bleed_prepass_ms: u64,
    /// 스크립트 줄과 덩어리 기록이 어긋난 트랙 수(0 이어야 한다).
    pub mismatched_tracks: usize,
}

#[derive(Debug, Clone)]
struct RecordedPiece {
    start_ms: u64,
    end_ms: u64,
    local: Option<usize>,
    /// 화자 나누기가 이 덩어리에서 그 화자에게 준 몫.
    share: f32,
}

#[derive(Debug, Clone)]
struct Cluster {
    local: usize,
    embedding: Option<Vec<f32>>,
    embedded_ms: u64,
    speech_ms: u64,
    first_ms: u64,
    spans_ms: Vec<(u64, u64)>,
}

/// 화자 나누기가 자른 토막 하나(받아쓰기에는 안 보내고, 단어를 나눠 줄 때 쓴다).
#[derive(Debug, Clone, Copy)]
struct Sub {
    start_ms: u64,
    end_ms: u64,
    local: Option<usize>,
    share: f32,
    /// 다른 트랙에서 새어 든 소리(이 토막에 든 단어는 버린다).
    bleed: bool,
}

/// 받아쓰기에 보낸 덩어리 하나: 말 구간(회의 ms)과, 화자 토막 그대로 보낸 것이면 그 화자.
#[derive(Debug, Clone, Copy)]
struct Sent {
    start_ms: u64,
    end_ms: u64,
    local: Option<usize>,
    share: f32,
}

/// 받아쓴 단어 하나와 매긴 화자 토막: (시작, 끝, 글, 그 토막의 몫).
type HeardWord<'w> = (u64, u64, &'w str, f32);

/// 스크립트 줄 하나(회의 ms). [`MeetingSpeakers::lines`] 가 낸다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    /// 시작(회의 ms).
    pub start_ms: u64,
    /// 끝(회의 ms).
    pub end_ms: u64,
    /// 글.
    pub text: String,
}

#[derive(Debug, Clone)]
struct TrackState {
    device: String,
    multi: bool,
    /// 받아쓰기에 보낸 덩어리마다, [`MeetingSpeakers::split`] 이 돌려준 순서.
    sent: Vec<Sent>,
    /// 화자 나누기가 자른 토막들(여럿 트랙을 [`RoomPieces::Whole`] 로 보낼 때만).
    subs: Vec<Sub>,
    /// 스크립트 줄마다(넣은 순서) 어느 화자인지. [`MeetingSpeakers::lines`] 가 채운다.
    pieces: Vec<RecordedPiece>,
    own: Option<Vec<f32>>,
    clusters: Vec<Cluster>,
    report: TrackSpeakersReport,
}

/// 한 회의의 화자 단계.
pub struct MeetingSpeakers<'a> {
    settings: &'a SpeakerSettings,
    community: Uuid,
    now_unix_ms: u64,
    envelopes: Vec<(String, Envelope)>,
    tracks: Vec<TrackState>,
    report: SpeakersReport,
}

fn samples_to_ms(samples: usize) -> u64 {
    samples as u64 * 1_000 / u64::from(VAD_SAMPLE_RATE)
}

fn ms_to_samples(ms: u64) -> usize {
    usize::try_from(ms * u64::from(VAD_SAMPLE_RATE) / 1_000).unwrap_or(usize::MAX)
}

impl<'a> MeetingSpeakers<'a> {
    /// 회의 하나를 시작한다. `community` 는 프로필을 찾을 커뮤니티, `now_unix_ms` 는 프로필 날짜.
    pub fn start(
        settings: &'a SpeakerSettings,
        community: Uuid,
        routed: &Demuxed<'_>,
        now_unix_ms: u64,
    ) -> Result<Self, SpeakersError> {
        let mut envelopes = Vec::new();
        let started = Instant::now();
        let sounding = routed
            .speakers
            .iter()
            .filter(|p| p.frame_count() > 0)
            .count();
        if settings.bleed.enabled && sounding >= 2 {
            for person in routed.speakers.iter().filter(|p| p.frame_count() > 0) {
                let track = person.decode()?;
                envelopes.push((
                    person.pubkey.clone(),
                    Envelope::of(&track.pcm, SAMPLE_RATE, track.start_ms),
                ));
            }
        }
        Ok(Self {
            settings,
            community,
            now_unix_ms,
            envelopes,
            tracks: Vec::new(),
            report: SpeakersReport {
                diarizer: settings.diarizer.as_ref().map(|d| d.describe()),
                embedder: settings.embedder.as_ref().map(|e| e.model().name),
                bleed_prepass_ms: elapsed_ms(started),
                ..SpeakersReport::default()
            },
        })
    }

    /// 한 트랙의 화자를 나누고 새어 든 소리를 찾는다. 돌려준 덩어리가 받아쓰기에 간다.
    /// - 한 사람 트랙: 새어 든 소리를 뺀 VAD 덩어리(예전 그대로).
    /// - 여럿 트랙, [`RoomPieces::Cut`](기본): 화자가 바뀌는 자리에서 자른 토막(새어 든 것은 뺀다).
    /// - 여럿 트랙, [`RoomPieces::Whole`]: 자르지 않은 VAD 덩어리(새어 든 소리뿐인 덩어리만 뺀다). 받아쓴 뒤
    ///   단어 시각으로 화자에 나눈다.
    ///
    /// 받아쓴 뒤 덩어리마다 이 순서대로 [`lines`](Self::lines) 를 불러 스크립트 줄을 만든다.
    pub fn split(
        &mut self,
        device: &str,
        track_start_ms: u64,
        pcm: &[f32],
        pieces: Vec<Piece>,
    ) -> Result<Vec<Piece>, SpeakersError> {
        let settings = self.settings;
        let mut report = TrackSpeakersReport {
            device: device.to_string(),
            speakers: 1,
            ..TrackSpeakersReport::default()
        };
        // B: who spoke when inside this track.
        let mut turns: Vec<Turn> = Vec::new();
        // Less speech than two kept clusters need cannot split: skip the work.
        let speech_ms: u64 = pieces.iter().map(|p| samples_to_ms(p.speech.len())).sum();
        let could_split = speech_ms >= 2 * settings.min_cluster_ms;
        if let Some(diarizer) = settings.diarizer.as_ref().filter(|_| could_split) {
            let spans: Vec<_> = pieces.iter().map(|p| p.audio).collect();
            let squeezed = squeeze(pcm, &spans, ms_to_samples(settings.squeeze_gap_ms));
            let started = Instant::now();
            let found = diarizer.diarize(&squeezed.pcm)?;
            self.report.diarize_ms += elapsed_ms(started);
            self.report.diarized_audio_ms += samples_to_ms(squeezed.pcm.len());
            let found = squeezed.turns_to_track(&found);
            let per = speech_per_speaker(&found);
            report.raw_cluster_ms = per.iter().map(|&s| samples_to_ms(s)).collect();
            let total: usize = per.iter().sum();
            let floor = ms_to_samples(settings.min_cluster_ms)
                .max((total as f32 * settings.min_cluster_share) as usize);
            let mut keep: Vec<usize> = Vec::new();
            for (speaker, &samples) in per.iter().enumerate() {
                if samples == 0 {
                    continue;
                }
                if samples >= floor {
                    keep.push(speaker);
                } else {
                    report.folded_clusters += 1;
                }
            }
            if keep.len() >= 2 {
                turns = found
                    .into_iter()
                    .filter_map(|t| {
                        let local = keep.iter().position(|&k| k == t.speaker)?;
                        Some(Turn {
                            speaker: local,
                            ..t
                        })
                    })
                    .collect();
                report.speakers = keep.len();
                // Second pass: clusters whose average voices are alike are one person.
                if let (Some(threshold), Some(embedder)) =
                    (settings.merge_threshold, settings.embedder.as_ref())
                {
                    let started = Instant::now();
                    let (merged_turns, merged, similar) = merge_similar(
                        &turns,
                        pcm,
                        embedder.as_ref(),
                        threshold,
                        ms_to_samples(settings.embed_min_piece_ms),
                        ms_to_samples(settings.embed_max_ms),
                    )?;
                    self.report.embed_ms += elapsed_ms(started);
                    turns = merged_turns;
                    report.merged_clusters = merged;
                    report.cluster_similarity = similar;
                    report.speakers = keep.len() - merged;
                }
            }
        }
        let multi = report.speakers >= 2;
        let before = pieces.len();
        let cut: Vec<SpeakerPiece> = if multi {
            cut_pieces(&pieces, &turns, pcm, &settings.cut)
        } else {
            pieces
                .iter()
                .map(|piece| SpeakerPiece {
                    piece: *piece,
                    speaker: None,
                    share: 1.0,
                })
                .collect()
        };
        report.extra_pieces = cut.len().saturating_sub(before);

        // A: pieces another track carries louder and a little earlier.
        let others: Vec<&Envelope> = self
            .envelopes
            .iter()
            .filter(|(d, _)| d != device)
            .map(|(_, e)| e)
            .collect();
        let own_envelope = (!others.is_empty()).then(|| {
            let started = Instant::now();
            let envelope = Envelope::of(pcm, VAD_SAMPLE_RATE, track_start_ms);
            self.report.bleed_prepass_ms += elapsed_ms(started);
            envelope
        });
        let mut kept: Vec<SpeakerPiece> = Vec::with_capacity(cut.len());
        let mut subs: Vec<Sub> = Vec::with_capacity(cut.len());
        for piece in cut {
            let from = track_start_ms + samples_to_ms(piece.piece.speech.start);
            let to = track_start_ms + samples_to_ms(piece.piece.speech.end);
            let bleed = own_envelope.as_ref().is_some_and(|envelope| {
                find_bleed(envelope, from, to, &others, &settings.bleed).is_some()
            });
            subs.push(Sub {
                start_ms: from,
                end_ms: to,
                local: piece.speaker,
                share: piece.share,
                bleed,
            });
            if bleed {
                report.bleed_pieces += 1;
                report.bleed_ms += to - from;
                report.bleed_spans_ms.push((from, to));
                continue;
            }
            kept.push(piece);
        }
        // What goes to transcription: the kept pieces (cut at changes of
        // speaker on a shared track), or, for whole pieces on a shared track,
        // the VAD pieces that still hold something not leaked in.
        let whole = multi && settings.room_pieces == RoomPieces::Whole;
        let send: Vec<(Piece, Option<usize>, f32)> = if whole {
            pieces
                .iter()
                .filter(|p| {
                    kept.iter().any(|k| {
                        k.piece.speech.start < p.speech.end && p.speech.start < k.piece.speech.end
                    })
                })
                .map(|p| (*p, None, 1.0))
                .collect()
        } else {
            kept.iter().map(|p| (p.piece, p.speaker, p.share)).collect()
        };

        // C material: one embedding for a one-speaker track, one per cluster otherwise.
        let mut state = TrackState {
            device: device.to_string(),
            multi,
            sent: send
                .iter()
                .map(|(p, local, share)| Sent {
                    start_ms: track_start_ms + samples_to_ms(p.speech.start),
                    end_ms: track_start_ms + samples_to_ms(p.speech.end),
                    local: *local,
                    share: *share,
                })
                .collect(),
            subs: if whole { subs } else { Vec::new() },
            pieces: Vec::new(),
            own: None,
            clusters: Vec::new(),
            report,
        };
        if multi {
            for local in 0..state.report.speakers {
                let mine: Vec<&SpeakerPiece> =
                    kept.iter().filter(|p| p.speaker == Some(local)).collect();
                if mine.is_empty() {
                    // All of it leaked in from another track: no lines, no label.
                    continue;
                }
                let speech_ms = mine
                    .iter()
                    .map(|p| samples_to_ms(p.piece.speech.len()))
                    .sum();
                let first_ms = mine
                    .iter()
                    .map(|p| track_start_ms + samples_to_ms(p.piece.speech.start))
                    .min()
                    .unwrap_or(u64::MAX);
                let clean: Vec<&SpeakerPiece> =
                    mine.iter().copied().filter(|p| p.share >= 0.8).collect();
                let (embedding, embedded_ms) = self.embed(pcm, &clean)?;
                state.clusters.push(Cluster {
                    local,
                    embedding,
                    embedded_ms,
                    speech_ms,
                    first_ms,
                    spans_ms: mine
                        .iter()
                        .map(|p| {
                            (
                                track_start_ms + samples_to_ms(p.piece.speech.start),
                                track_start_ms + samples_to_ms(p.piece.speech.end),
                            )
                        })
                        .collect(),
                });
            }
        } else {
            let all: Vec<&SpeakerPiece> = kept.iter().collect();
            state.report.own_speech_ms = all
                .iter()
                .map(|p| samples_to_ms(p.piece.speech.len()))
                .sum();
            let (embedding, embedded_ms) = self.embed(pcm, &all)?;
            state.own = embedding;
            state.report.own_embedded_ms = embedded_ms;
        }
        self.tracks.push(state);
        Ok(send.into_iter().map(|(p, _, _)| p).collect())
    }

    /// `device` 트랙의 덩어리가 화자 여럿을 담을 수 있나([`RoomPieces::Whole`] 의 여럿 트랙). 그러면
    /// 받아쓰기에 단어 시각을 묻는다.
    pub fn needs_words(&self, device: &str) -> bool {
        self.tracks
            .iter()
            .rev()
            .find(|t| t.device == device)
            .is_some_and(|t| !t.subs.is_empty())
    }

    /// 받아쓴 덩어리 하나를 스크립트 줄로 만든다. `index` 는 [`split`](Self::split) 이 돌려준 순서,
    /// `audio_start_ms` 는 보낸 소리의 시작(회의 ms, `words` 시각의 0), `text` 는 받아쓴 글.
    /// 덩어리마다 순서대로 한 번씩 불러야 하고, 돌려준 줄을 그 순서대로 스크립트에 넣는다.
    ///
    /// - 한 사람 트랙, 또는 여럿 트랙을 [`RoomPieces::Cut`] 으로 보냈을 때: 덩어리 하나 = 줄 하나(말 구간
    ///   그대로, 예전과 같다). 줄의 화자는 그 토막의 화자.
    /// - 여럿 트랙을 [`RoomPieces::Whole`] 로 보냈을 때: 단어마다 시각이 가장 많이 겹치는(없으면 가장 가까운) 화자 토막을 찾아, 같은 화자가
    ///   이어지는 단어끼리 줄로 묶는다. 줄 시각은 그 단어들의 시각(말 구간 안으로 자름). 새어 든
    ///   소리 토막의 단어는 버린다. 묶음이 하나뿐이고 버린 단어가 없으면 글은 받아쓴 글 그대로.
    ///   단어가 없으면(시각을 안 물은 옛 결과, 빈 결과, 받아쓰기 실패) 덩어리에서 말이 가장 많은
    ///   화자에게 말 구간 그대로 한 줄로 준다.
    pub fn lines(
        &mut self,
        device: &str,
        index: usize,
        audio_start_ms: u64,
        text: &str,
        words: Option<&[crate::stt::Word]>,
    ) -> Vec<Line> {
        let Some(track) = self.tracks.iter_mut().rev().find(|t| t.device == device) else {
            return Vec::new();
        };
        let Some(&sent) = track.sent.get(index) else {
            return Vec::new();
        };
        let (from, to) = (sent.start_ms, sent.end_ms);
        let whole = |track: &mut TrackState, local: Option<usize>, share: f32| {
            track.pieces.push(RecordedPiece {
                start_ms: from,
                end_ms: to,
                local,
                share,
            });
            vec![Line {
                start_ms: from,
                end_ms: to,
                text: text.to_string(),
            }]
        };
        if track.subs.is_empty() {
            return whole(track, sent.local, sent.share);
        }
        let overlap =
            |sub: &Sub, a: u64, b: u64| b.min(sub.end_ms).saturating_sub(a.max(sub.start_ms));
        let subs: Vec<Sub> = track
            .subs
            .iter()
            .filter(|sub| overlap(sub, from, to) > 0)
            .copied()
            .collect();
        let mut words: Vec<&crate::stt::Word> = words.unwrap_or_default().iter().collect();
        words.sort_by_key(|w| w.start_ms);
        if words.is_empty() || subs.is_empty() {
            // The speaker with the most (not leaked) speech in the piece.
            let mut per: Vec<(Option<usize>, u64, f32)> = Vec::new();
            for sub in subs.iter().filter(|s| !s.bleed) {
                let ms = overlap(sub, from, to);
                match per.iter_mut().find(|(l, _, _)| *l == sub.local) {
                    Some(entry) => {
                        entry.1 += ms;
                        entry.2 += sub.share * ms as f32;
                    }
                    None => per.push((sub.local, ms, sub.share * ms as f32)),
                }
            }
            if per.is_empty() && !subs.is_empty() {
                // All of it leaked in from another track.
                return Vec::new();
            }
            // Its share: how much of the piece's speech it holds (weighted by
            // how sure each speaker piece was).
            let total: u64 = per.iter().map(|p| p.1).sum();
            let (local, share) = per
                .iter()
                .max_by_key(|p| p.1)
                .map_or((None, 1.0), |&(local, _, weighted)| {
                    (local, weighted / total.max(1) as f32)
                });
            return whole(track, local, share);
        }
        // Each word to the speaker piece it overlaps most, else the nearest.
        let mut groups: Vec<(Option<usize>, Vec<HeardWord<'_>>)> = Vec::new();
        let mut dropped = false;
        for word in words {
            let a = audio_start_ms + word.start_ms;
            let b = (audio_start_ms + word.end_ms).max(a);
            let middle = (a + b) / 2;
            let distance = |sub: &Sub| {
                if middle < sub.start_ms {
                    sub.start_ms - middle
                } else {
                    middle.saturating_sub(sub.end_ms)
                }
            };
            let Some(best) = subs
                .iter()
                .max_by(|x, y| {
                    overlap(x, a, b)
                        .cmp(&overlap(y, a, b))
                        .then(distance(y).cmp(&distance(x)))
                })
                .copied()
            else {
                continue;
            };
            if best.bleed {
                dropped = true;
                continue;
            }
            let item = (a, b, word.text.as_str(), best.share);
            match groups.last_mut() {
                Some((local, items)) if *local == best.local => items.push(item),
                _ => groups.push((best.local, vec![item])),
            }
        }
        let single = groups.len() == 1 && !dropped;
        let mut out = Vec::with_capacity(groups.len());
        for (local, items) in &groups {
            let first = items.iter().map(|item| item.0).min().unwrap_or(from);
            let last = items.iter().map(|item| item.1).max().unwrap_or(to);
            // Never an empty line: at least 1 ms, inside the piece.
            let start_ms = first.clamp(from, to.saturating_sub(1).max(from));
            let end_ms = last.clamp(start_ms + 1, to.max(start_ms + 1));
            track.pieces.push(RecordedPiece {
                start_ms,
                end_ms,
                local: *local,
                share: weighted_share(items),
            });
            out.push(Line {
                start_ms,
                end_ms,
                // One speaker for every word: the text as the engine wrote it.
                text: if single {
                    text.to_string()
                } else {
                    items
                        .iter()
                        .map(|item| item.2)
                        .collect::<Vec<_>>()
                        .join(" ")
                },
            });
        }
        out
    }

    /// 덩어리들의 특징 평균(긴 덩어리부터 [`SpeakerSettings::embed_max_ms`] 까지).
    fn embed(
        &mut self,
        pcm: &[f32],
        pieces: &[&SpeakerPiece],
    ) -> Result<(Option<Vec<f32>>, u64), SpeakersError> {
        let Some(embedder) = &self.settings.embedder else {
            return Ok((None, 0));
        };
        let mut order: Vec<&SpeakerPiece> = pieces
            .iter()
            .copied()
            .filter(|p| samples_to_ms(p.piece.speech.len()) >= self.settings.embed_min_piece_ms)
            .collect();
        order.sort_by_key(|p| std::cmp::Reverse(p.piece.speech.len()));
        let started = Instant::now();
        let mut items = Vec::new();
        let mut used = 0u64;
        for piece in order {
            if used >= self.settings.embed_max_ms {
                break;
            }
            let span = piece.piece.speech;
            let end = span.end.min(pcm.len());
            if span.start >= end {
                continue;
            }
            let audio = &pcm[span.start..end];
            let leveled;
            let audio = match self.settings.embed_level_dbfs {
                Some(dbfs) => {
                    let rms =
                        (audio.iter().map(|x| x * x).sum::<f32>() / audio.len() as f32).sqrt();
                    let gain = if rms > 0.0 {
                        10f32.powf(dbfs / 20.0) / rms
                    } else {
                        1.0
                    };
                    leveled = audio
                        .iter()
                        .map(|x| (x * gain).clamp(-1.0, 1.0))
                        .collect::<Vec<_>>();
                    &leveled[..]
                }
                None => audio,
            };
            if let Some(embedding) = embedder.embed(audio)? {
                let ms = samples_to_ms(end - span.start);
                used += ms;
                items.push((embedding, ms as f32));
            }
        }
        self.report.embed_ms += elapsed_ms(started);
        Ok((weighted_mean(&items), used))
    }

    /// 모든 줄이 나온 뒤: 회의실 화자에 이름을 붙이고, 두 번 잡힌 줄을 빼고, 프로필을 고친다.
    /// `segments` 는 트랙마다 [`split`](Self::split) 이 돌려준 덩어리 순서대로 들어 있어야 한다.
    /// 저장소 오류는 숫자로만 남기고 회의는 계속한다.
    pub async fn finish(mut self, segments: &mut Vec<Segment>) -> SpeakersReport {
        let settings = self.settings;
        // Which recorded piece each line is.
        let mut cursor: HashMap<&str, usize> = HashMap::new();
        let by_device: HashMap<&str, usize> = self
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.device.as_str(), i))
            .collect();
        // (track, recorded piece) per line; a piece's cluster is read later,
        // after one-speaker tracks may have turned into room tracks.
        let mut line_piece: Vec<Option<(usize, Option<usize>)>> =
            Vec::with_capacity(segments.len());
        let mut mismatched = std::collections::HashSet::new();
        for segment in segments.iter() {
            let Some(&track) = by_device.get(segment.device.as_str()) else {
                line_piece.push(None);
                continue;
            };
            let at = cursor
                .entry(self.tracks[track].device.as_str())
                .or_insert(0);
            let index = *at;
            let recorded = self.tracks[track].pieces.get(index);
            *at += 1;
            // The pipeline writes `start = min(piece start, end)` with `end`
            // cut at the meeting end.
            match recorded {
                Some(piece) if piece.start_ms.min(segment.end_ms) == segment.start_ms => {
                    line_piece.push(Some((track, Some(index))));
                }
                _ => {
                    mismatched.insert(track);
                    line_piece.push(Some((track, None)));
                }
            }
        }
        for (track, state) in self.tracks.iter().enumerate() {
            if cursor.get(state.device.as_str()).copied().unwrap_or(0) != state.pieces.len() {
                mismatched.insert(track);
            }
        }
        self.report.mismatched_tracks = mismatched.len();

        // Stored profiles of this community, ready ones only. If the list cannot
        // be read, this meeting neither uses nor writes profiles.
        let model = settings.embedder.as_ref().map(|e| e.model());
        let (agree, max_samples) = (
            settings.profiles.update_min_similarity,
            settings.profiles.max_samples,
        );
        let mut store_ok = false;
        let mut stored: HashMap<String, VoiceProfile> = HashMap::new();
        if let (Some(store), Some(model)) = (&settings.store, &model) {
            match store.list(self.community).await {
                Ok(listing) => {
                    store_ok = true;
                    self.report.profiles_unreadable = listing.unreadable;
                    for (profile, _) in listing.profiles {
                        if !profile.same_model(model) {
                            self.report.profiles_other_model += 1;
                        } else if profile.is_ready(agree) {
                            self.report.profiles_loaded += 1;
                            stored.insert(profile.pubkey.clone(), profile);
                        } else {
                            self.report.profiles_pending += 1;
                        }
                    }
                }
                Err(_) => self.report.store_errors += 1,
            }
        }

        // A one-speaker track is its owner, unless the owner's stored voice is
        // clearly someone else's: then it is a room speaker like any other
        // (named by voice only) and never profile material.
        for track in self.tracks.iter_mut().filter(|t| !t.multi) {
            let Some(own) = &track.own else {
                continue;
            };
            let Some(similar) = stored
                .get(&track.device.to_ascii_lowercase())
                .and_then(|p| p.mean(agree, max_samples))
                .map(|m| cosine(&m, own))
            else {
                continue;
            };
            if similar >= agree {
                continue;
            }
            track.report.owner_voice_mismatch = true;
            track.multi = true;
            let spans_ms: Vec<(u64, u64)> = track
                .pieces
                .iter()
                .map(|p| (p.start_ms, p.end_ms))
                .collect();
            for piece in &mut track.pieces {
                piece.local = Some(0);
            }
            track.clusters = vec![Cluster {
                local: 0,
                embedding: track.own.take(),
                embedded_ms: track.report.own_embedded_ms,
                speech_ms: track.report.own_speech_ms,
                first_ms: spans_ms.first().map_or(u64::MAX, |s| s.0),
                spans_ms,
            }];
        }

        // Candidates: clean one-speaker tracks of this meeting and stored profiles.
        let mut candidates: Vec<(String, Vec<Vec<f32>>)> = Vec::new();
        let mut add_candidate = |pubkey: &str, embedding: Vec<f32>| match candidates
            .iter_mut()
            .find(|(p, _)| p == pubkey)
        {
            Some((_, list)) => list.push(embedding),
            None => candidates.push((pubkey.to_string(), vec![embedding])),
        };
        let min_material = settings.profiles.min_material_ms;
        if settings.naming.same_meeting {
            for track in self.tracks.iter().filter(|t| !t.multi) {
                if let Some(own) = &track.own {
                    if track.report.own_embedded_ms >= min_material {
                        add_candidate(&track.device, own.clone());
                    }
                }
            }
        }
        if settings.naming.profiles {
            for profile in stored.values() {
                if let Some(mean) = profile.mean(agree, max_samples) {
                    add_candidate(&profile.pubkey, mean);
                }
            }
        }
        // Same order every run (the map's order is not).
        candidates.sort_by(|a, b| a.0.cmp(&b.0));

        // Room clusters, scored against every candidate (best of its embeddings).
        let mut clusters: Vec<(usize, usize)> = Vec::new();
        let mut scores: Vec<Vec<(usize, f32)>> = Vec::new();
        for (t, track) in self.tracks.iter().enumerate().filter(|(_, t)| t.multi) {
            for (c, cluster) in track.clusters.iter().enumerate() {
                clusters.push((t, c));
                scores.push(match &cluster.embedding {
                    Some(embedding) => candidates
                        .iter()
                        .enumerate()
                        .map(|(i, (_, list))| {
                            let best = list
                                .iter()
                                .map(|e| cosine(e, embedding))
                                .fold(f32::MIN, f32::max);
                            (i, best)
                        })
                        .collect(),
                    None => Vec::new(),
                });
            }
        }
        let named = assign(&scores, settings.naming.threshold);

        // A named cluster whose speech sits on its person's own speech is the
        // same talk caught twice: drop it.
        let own_spans: HashMap<&str, Vec<(u64, u64)>> = self
            .tracks
            .iter()
            .filter(|t| !t.multi)
            .map(|t| {
                (
                    t.device.as_str(),
                    t.pieces.iter().map(|p| (p.start_ms, p.end_ms)).collect(),
                )
            })
            .collect();
        let mut duplicate = vec![false; clusters.len()];
        for (i, &(t, c)) in clusters.iter().enumerate() {
            let Some((person, _)) = named[i] else {
                continue;
            };
            let Some(spans) = own_spans.get(candidates[person].0.as_str()) else {
                continue;
            };
            let cluster = &self.tracks[t].clusters[c];
            let overlap: u64 = cluster
                .spans_ms
                .iter()
                .map(|&(a, b)| {
                    spans
                        .iter()
                        .map(|&(x, y)| b.min(y).saturating_sub(a.max(x)))
                        .sum::<u64>()
                })
                .sum();
            duplicate[i] = cluster.speech_ms > 0
                && overlap as f32 >= settings.naming.duplicate_overlap * cluster.speech_ms as f32;
        }

        // "회의실 화자 N" in order of first speech.
        let mut order: Vec<usize> = (0..clusters.len()).filter(|&i| !duplicate[i]).collect();
        order.sort_by_key(|&i| {
            let (t, c) = clusters[i];
            self.tracks[t].clusters[c].first_ms
        });
        let mut labels: Vec<String> = vec![String::new(); clusters.len()];
        for (n, &i) in order.iter().enumerate() {
            labels[i] = format!("{ROOM_SPEAKER_LABEL} {}", n + 1);
        }
        let index_of: HashMap<(usize, usize), usize> = clusters
            .iter()
            .enumerate()
            .map(|(i, &(t, c))| ((t, self.tracks[t].clusters[c].local), i))
            .collect();

        let mut keep = Vec::with_capacity(segments.len());
        for (segment, piece) in segments.iter_mut().zip(&line_piece) {
            let Some((track, index)) = *piece else {
                keep.push(true);
                continue;
            };
            if !self.tracks[track].multi {
                keep.push(true);
                continue;
            }
            // Lines and recorded pieces do not line up on this shared track: whose
            // line it is cannot be told, so it is nobody's.
            let recorded = index
                .filter(|_| !mismatched.contains(&track))
                .and_then(|n| self.tracks[track].pieces.get(n));
            let Some(&i) = recorded
                .and_then(|p| p.local)
                .and_then(|l| index_of.get(&(track, l)))
            else {
                segment.speaker = None;
                segment.speaker_confidence = None;
                segment.speaker_label = Some(crate::transcript::UNPLACED_ROOM_SPEAKER.to_string());
                keep.push(true);
                continue;
            };
            if duplicate[i] {
                self.report.duplicate_lines_removed += 1;
                self.report.duplicate_ms_removed += segment.end_ms - segment.start_ms;
                self.report.duplicate_spans_ms.push((
                    segment.device.clone(),
                    segment.start_ms,
                    segment.end_ms,
                ));
                keep.push(false);
                continue;
            }
            segment.speaker_label = Some(labels[i].clone());
            // A line where this speaker holds less than half (others talk over it)
            // keeps its room label but gets no name.
            let alone = recorded.is_some_and(|p| p.share >= MIN_NAMED_SHARE);
            match named[i].filter(|_| alone) {
                Some((person, score)) => {
                    segment.speaker = Some(candidates[person].0.clone());
                    segment.speaker_confidence = Some(score);
                }
                None => {
                    segment.speaker = None;
                    segment.speaker_confidence = None;
                }
            }
            keep.push(true);
        }
        let mut flags = keep.into_iter();
        segments.retain(|_| flags.next().unwrap_or(true));

        for (i, &(t, c)) in clusters.iter().enumerate() {
            let cluster = &self.tracks[t].clusters[c];
            self.report.clusters.push(ClusterReport {
                device: self.tracks[t].device.clone(),
                local: cluster.local,
                label: labels[i].clone(),
                speech_ms: cluster.speech_ms,
                embedded_ms: cluster.embedded_ms,
                scores: scores[i]
                    .iter()
                    .map(|&(p, s)| (short_key(&candidates[p].0), s))
                    .collect(),
                named: named[i].map(|(p, s)| (short_key(&candidates[p].0), s)),
                duplicate_of_own_track: duplicate[i],
            });
        }

        // Profiles (only when learning from tracks is on): only from clean
        // one-speaker tracks, never from room matches. A track pushed out by the
        // owner check only counts against the stored voice.
        let day = day_of(self.now_unix_ms);
        for track in self.tracks.iter_mut().filter(|_| settings.profiles.learn) {
            let (Some(store), Some(model)) = (&settings.store, &model) else {
                continue;
            };
            let sample = if track.report.owner_voice_mismatch {
                None
            } else if track.multi {
                continue;
            } else {
                let Some(own) = &track.own else {
                    continue;
                };
                if track.report.own_embedded_ms < min_material {
                    track.report.profile = ProfileUpdate::TooShort;
                    continue;
                }
                Some(VoiceSample {
                    source: SampleSource::OwnTrack,
                    seconds: track.report.own_embedded_ms as f32 / 1_000.0,
                    day: day.clone(),
                    confirmed_by: None,
                    confirmed_on: None,
                    embedding: own.clone(),
                })
            };
            if !store_ok {
                track.report.profile = ProfileUpdate::StoreError;
                continue;
            }
            let person = Person {
                community: self.community,
                pubkey: &track.device,
                model,
                day: &day,
            };
            track.report.profile =
                match update_profile(store.as_ref(), &person, sample, &settings.profiles).await {
                    Ok(update) => update,
                    Err(_) => {
                        self.report.store_errors += 1;
                        ProfileUpdate::StoreError
                    }
                };
        }
        self.report.tracks = self.tracks.iter().map(|t| t.report.clone()).collect();
        self.report
    }
}

/// 프로필을 고칠 사람.
struct Person<'a> {
    community: Uuid,
    pubkey: &'a str,
    model: &'a ModelId,
    day: &'a str,
}

/// 한 사람 프로필에 재료를 넣는다(`sample` 이 `None` 이면 반대 수만 올린다). 지운 사람이면 만들지
/// 않는다. 저장 직전에 다시 읽고 다음 판 번호로 "없을 때만" 쓴다. 다른 워커와 겹치면 한 번 더 하고,
/// 쓴 뒤 그 사이 지워졌으면 지운다.
async fn update_profile(
    store: &dyn VoiceStore,
    person: &Person<'_>,
    sample: Option<VoiceSample>,
    profiles: &ProfileSettings,
) -> Result<ProfileUpdate, VoiceStoreError> {
    let (agree, max_samples) = (profiles.update_min_similarity, profiles.max_samples);
    if store.is_forgotten(person.pubkey).await? {
        return Ok(ProfileUpdate::Forgotten);
    }
    let fresh = || {
        VoiceProfile::new(
            person.pubkey,
            person.community,
            person.model.clone(),
            person.day,
        )
    };
    for _ in 0..2 {
        let (mut profile, version, created) =
            match store.load(person.community, person.pubkey).await? {
                Some((profile, version)) if profile.same_model(person.model) => {
                    (profile, version, false)
                }
                // Another model's numbers cannot be compared: start over.
                Some((_, version)) => (fresh(), version, true),
                None => (fresh(), 0, true),
            };
        let update = match &sample {
            Some(sample) => {
                let similar = profile
                    .mean(agree, max_samples)
                    .map(|mean| cosine(&mean, &sample.embedding));
                if similar.is_some_and(|s| s < agree) {
                    profile.dissent += 1;
                    ProfileUpdate::Refused
                } else if !profile.add(sample.clone(), max_samples) {
                    return Ok(ProfileUpdate::Unchanged);
                } else if created {
                    ProfileUpdate::Created
                } else {
                    ProfileUpdate::Updated
                }
            }
            None if created => return Ok(ProfileUpdate::Unchanged),
            None => {
                profile.dissent += 1;
                ProfileUpdate::Refused
            }
        };
        if store.save(&profile, version + 1).await? {
            if store.is_forgotten(person.pubkey).await? {
                // `voices forget` ran meanwhile: take this save back.
                store.forget(person.pubkey).await?;
                return Ok(ProfileUpdate::Forgotten);
            }
            return Ok(update);
        }
    }
    Ok(ProfileUpdate::Raced)
}

impl SpeakersReport {
    /// 참가자 말 시간을 실제 화자 기준으로 고친다. 회의실 트랙(화자 나누기로 여럿이었거나 주인
    /// 목소리가 달라 돌린 트랙)의 기기 주인은 0 에서 다시 센다 — 목소리로 맞은 줄만 그 사람 몫이다.
    /// 회의실 마이크에서 목소리로 맞은 사람은 그 줄 길이만큼 더하고, 목록에 없으면 넣는다.
    /// 누군지 모르는 회의실 줄은 아무에게도 세지 않는다.
    pub fn update_participants(&self, participants: &mut Vec<Participant>, segments: &[Segment]) {
        let room: Vec<&str> = self
            .tracks
            .iter()
            .filter(|t| t.speakers >= 2 || t.owner_voice_mismatch)
            .map(|t| t.device.as_str())
            .collect();
        for participant in participants.iter_mut() {
            if room.contains(&participant.pubkey.as_str()) {
                participant.speech_ms = 0;
            }
        }
        for segment in segments
            .iter()
            .filter(|s| room.contains(&s.device.as_str()))
        {
            let Some(speaker) = &segment.speaker else {
                continue;
            };
            let ms = segment.end_ms.saturating_sub(segment.start_ms);
            match participants.iter_mut().find(|p| &p.pubkey == speaker) {
                Some(participant) => participant.speech_ms += ms,
                None => participants.push(Participant {
                    pubkey: speaker.clone(),
                    speech_ms: ms,
                }),
            }
        }
    }
}

/// 보고에 남기는 pubkey 앞 8자.
fn short_key(pubkey: &str) -> String {
    pubkey.chars().take(8).collect()
}

/// 단어 길이로 무게를 단 화자 몫.
fn weighted_share(items: &[HeardWord<'_>]) -> f32 {
    let (mut weight, mut sum) = (0.0f32, 0.0f32);
    for &(a, b, _, share) in items {
        let w = (b - a).max(1) as f32;
        weight += w;
        sum += share * w;
    }
    if weight > 0.0 {
        sum / weight
    } else {
        1.0
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// 화자 단계 명령줄 설정(`process`).
#[derive(Debug, Clone, clap::Args)]
pub struct SpeakerArgs {
    /// 트랙 안 화자 나누기와 누가 누군지. 끄면(기본) 트랙 하나 = 사람 한 명(예전 그대로).
    /// Cloud Run 에서 시간·메모리를 재기 전까지 기본은 끔.
    #[arg(long, env = "BUZZ_MINUTES_SPEAKERS", value_enum, default_value_t = OnOff::Off)]
    pub speakers: OnOff,
    /// 군집 문턱(클수록 화자를 적게 나눈다).
    #[arg(long, env = "BUZZ_MINUTES_CLUSTER_THRESHOLD", default_value_t = crate::diarize::DEFAULT_CLUSTER_THRESHOLD)]
    pub cluster_threshold: f32,
    /// 말이 이보다 적은 화자 묶음은 버린다(ms).
    #[arg(long, env = "BUZZ_MINUTES_MIN_CLUSTER_MS", default_value_t = DEFAULT_MIN_CLUSTER_MS)]
    pub min_cluster_ms: u64,
    /// 두 번째 합치기 문턱(묶음 평균 특징의 코사인). 안 주면 기본값.
    #[arg(long, env = "BUZZ_MINUTES_MERGE_THRESHOLD")]
    pub merge_threshold: Option<f32>,
    /// 말이 트랙 전체 말의 이 몫보다 적은 묶음도 버린다.
    #[arg(long, env = "BUZZ_MINUTES_MIN_CLUSTER_SHARE", default_value_t = DEFAULT_MIN_CLUSTER_SHARE)]
    pub min_cluster_share: f32,
    /// 회의실 화자를 사람으로 맞추는 코사인 문턱.
    #[arg(long, env = "BUZZ_MINUTES_NAMING_THRESHOLD", default_value_t = DEFAULT_NAMING_THRESHOLD)]
    pub naming_threshold: f32,
    /// 같은 회의 깨끗한 트랙으로 맞추기.
    #[arg(long, env = "BUZZ_MINUTES_SAME_MEETING_NAMING", value_enum, default_value_t = OnOff::On)]
    pub same_meeting_naming: OnOff,
    /// 새어 든 소리 지우기(A). 기본 끔(`--speakers on` 일 때만 효과가 있다).
    #[arg(long, env = "BUZZ_MINUTES_BLEED", value_enum, default_value_t = OnOff::Off)]
    pub bleed: OnOff,
    /// 화자 나누기·목소리 특징 ONNX 스레드 수.
    #[arg(long, env = "BUZZ_MINUTES_SPEAKER_THREADS", default_value_t = 2)]
    pub speaker_threads: i32,
    /// 여럿이 쓰는 트랙을 받아쓰기에 보내는 방식: cut(화자 토막마다, 기본) 또는 whole(VAD 덩어리 + 단어 시각).
    #[arg(long, env = "BUZZ_MINUTES_ROOM_PIECES", value_enum, default_value_t = RoomPieces::Cut)]
    pub room_pieces: RoomPieces,
    /// 자기 기기 혼자 트랙에서 목소리 프로필을 저절로 배우기. 기본 끔 — 회의실 기기에서 남의 목소리가
    /// 주인 프로필로 쌓이는 문제가 풀리기 전엔 켜지 않는다(문서 "알려진 한계").
    #[arg(long, env = "BUZZ_MINUTES_VOICES_LEARN", value_enum, default_value_t = OnOff::Off)]
    pub voices_learn: OnOff,
    /// 회의 사이 목소리 프로필 저장소(주지 않으면 저장 꺼짐).
    #[command(flatten)]
    pub store: crate::voices::VoiceStoreArgs,
}

/// 켜기/끄기.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum OnOff {
    /// 켜기.
    On,
    /// 끄기.
    Off,
}

impl SpeakerArgs {
    /// 모델을 `cache_dir` 에서 sha256 을 확인하고 읽어 설정을 만든다.
    pub fn settings(&self, cache_dir: &std::path::Path) -> anyhow::Result<SpeakerSettings> {
        use crate::diarize::{DiarizerSettings, SherpaDiarizer, SherpaEmbedder};
        use crate::models::{verify_model, SPEAKER_EMBEDDING, SPEAKER_SEGMENTATION};
        if self.speakers == OnOff::Off {
            // Exactly the old one-person-per-track path; the store is not even opened.
            return Ok(SpeakerSettings::default());
        }
        let mut settings = SpeakerSettings {
            min_cluster_ms: self.min_cluster_ms,
            merge_threshold: self.merge_threshold.or(DEFAULT_MERGE_THRESHOLD),
            min_cluster_share: self.min_cluster_share,
            naming: NamingSettings {
                same_meeting: self.same_meeting_naming == OnOff::On,
                threshold: self.naming_threshold,
                ..NamingSettings::default()
            },
            profiles: ProfileSettings {
                learn: self.voices_learn == OnOff::On,
                ..ProfileSettings::default()
            },
            room_pieces: self.room_pieces,
            bleed: BleedSettings {
                enabled: self.bleed == OnOff::On,
                ..BleedSettings::default()
            },
            store: self.store.open()?,
            ..SpeakerSettings::default()
        };
        let segmentation = verify_model(cache_dir, &SPEAKER_SEGMENTATION)?;
        let embedding = verify_model(cache_dir, &SPEAKER_EMBEDDING)?;
        settings.diarizer = Some(Arc::new(SherpaDiarizer::new(
            &segmentation,
            &embedding,
            DiarizerSettings {
                threshold: self.cluster_threshold,
                num_threads: self.speaker_threads,
                ..DiarizerSettings::default()
            },
        )?));
        settings.embedder = Some(Arc::new(SherpaEmbedder::new(
            &embedding,
            ModelId::from(&SPEAKER_EMBEDDING),
            self.speaker_threads,
        )?));
        Ok(settings)
    }
}

/// 실행 보고 한 줄(숫자만: pubkey·특징 값 없음).
pub fn report_line(report: &SpeakersReport) -> String {
    let multi = report.tracks.iter().filter(|t| t.speakers >= 2).count();
    let named = report
        .clusters
        .iter()
        .filter(|c| c.named.is_some() && !c.duplicate_of_own_track)
        .count();
    let room = report
        .clusters
        .iter()
        .filter(|c| !c.duplicate_of_own_track)
        .count();
    let bleed: usize = report.tracks.iter().map(|t| t.bleed_pieces).sum();
    let bleed_ms: u64 = report.tracks.iter().map(|t| t.bleed_ms).sum();
    let count =
        |update: ProfileUpdate| report.tracks.iter().filter(|t| t.profile == update).count();
    format!(
        "speakers: shared tracks {multi} | room speakers {room} named {named} | bleed pieces {bleed} ({bleed_ms} ms) | duplicate lines {} ({} ms) | profiles ready {} pending {} unreadable {} | created {} updated {} refused {} forgotten {} raced {} store errors {} | diarize {} ms for {} ms audio, embed {} ms",
        report.duplicate_lines_removed,
        report.duplicate_ms_removed,
        report.profiles_loaded,
        report.profiles_pending,
        report.profiles_unreadable,
        count(ProfileUpdate::Created),
        count(ProfileUpdate::Updated),
        count(ProfileUpdate::Refused),
        count(ProfileUpdate::Forgotten),
        count(ProfileUpdate::Raced),
        report.store_errors,
        report.diarize_ms,
        report.diarized_audio_ms,
        report.embed_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voices::{ForgetResult, Listing, LocalVoiceStore, StoreFuture, Version};

    fn piece(start_ms: u64, end_ms: u64, share: f32) -> RecordedPiece {
        RecordedPiece {
            start_ms,
            end_ms,
            local: Some(0),
            share,
        }
    }

    /// A room track ("aa…", one cluster with voice [1, 0]) and a clean track
    /// of "bb…" with the same voice, talking at another time.
    fn meeting(settings: &SpeakerSettings, pieces: Vec<RecordedPiece>) -> MeetingSpeakers<'_> {
        let spans_ms = pieces.iter().map(|p| (p.start_ms, p.end_ms)).collect();
        let room = TrackState {
            device: "aa".repeat(32),
            multi: true,
            sent: Vec::new(),
            subs: Vec::new(),
            pieces,
            own: None,
            clusters: vec![Cluster {
                local: 0,
                embedding: Some(vec![1.0, 0.0]),
                embedded_ms: 2_000,
                speech_ms: 2_000,
                first_ms: 0,
                spans_ms,
            }],
            report: TrackSpeakersReport {
                device: "aa".repeat(32),
                speakers: 2,
                ..TrackSpeakersReport::default()
            },
        };
        let own = TrackState {
            device: "bb".repeat(32),
            multi: false,
            sent: Vec::new(),
            subs: Vec::new(),
            pieces: vec![RecordedPiece {
                local: None,
                ..piece(5_000, 6_000, 1.0)
            }],
            own: Some(vec![1.0, 0.0]),
            clusters: Vec::new(),
            report: TrackSpeakersReport {
                device: "bb".repeat(32),
                speakers: 1,
                own_embedded_ms: settings.profiles.min_material_ms,
                ..TrackSpeakersReport::default()
            },
        };
        MeetingSpeakers {
            settings,
            community: Uuid::nil(),
            now_unix_ms: 0,
            envelopes: Vec::new(),
            tracks: vec![room, own],
            report: SpeakersReport::default(),
        }
    }

    fn line(device: &str, start_ms: u64, end_ms: u64) -> Segment {
        Segment::own(device.repeat(32), start_ms, end_ms, "말".into())
    }

    fn sub(start_ms: u64, end_ms: u64, local: usize, bleed: bool) -> Sub {
        Sub {
            start_ms,
            end_ms,
            local: Some(local),
            share: 1.0,
            bleed,
        }
    }

    fn sent(start_ms: u64, end_ms: u64, local: Option<usize>) -> Sent {
        Sent {
            start_ms,
            end_ms,
            local,
            share: 1.0,
        }
    }

    /// Cut pieces (the default): one line per piece, its speaker the piece's,
    /// no word times asked, words ignored.
    #[test]
    fn cut_pieces_give_one_line_each_with_their_speaker() {
        let settings = SpeakerSettings::default();
        let mut meeting = meeting(&settings, Vec::new());
        let track = &mut meeting.tracks[0];
        track.sent = vec![sent(0, 1_000, Some(0)), sent(1_000, 2_000, Some(1))];
        assert!(!meeting.needs_words(&"aa".repeat(32)));
        let words = [word(0, 300, "무시")];
        let first = meeting.lines(&"aa".repeat(32), 0, 0, "앞.", Some(&words));
        let second = meeting.lines(&"aa".repeat(32), 1, 1_000, "뒤.", None);
        assert_eq!(
            [first, second].concat(),
            vec![
                Line {
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "앞.".into()
                },
                Line {
                    start_ms: 1_000,
                    end_ms: 2_000,
                    text: "뒤.".into()
                },
            ]
        );
        let locals: Vec<_> = meeting.tracks[0].pieces.iter().map(|p| p.local).collect();
        assert_eq!(locals, [Some(0), Some(1)]);
    }

    fn word(start_ms: u64, end_ms: u64, text: &str) -> crate::stt::Word {
        crate::stt::Word {
            start_ms,
            end_ms,
            text: text.into(),
        }
    }

    /// A shared track with one piece, speech 0..2000 ms (audio from 0): the
    /// first second speaker 0, the second speaker 1 (or leaked in).
    fn shared(settings: &SpeakerSettings, second_leaked: bool) -> MeetingSpeakers<'_> {
        let mut meeting = meeting(settings, Vec::new());
        meeting.tracks.truncate(1);
        let track = &mut meeting.tracks[0];
        track.sent = vec![sent(0, 2_000, None)];
        track.subs = vec![sub(0, 1_000, 0, false), sub(1_000, 2_000, 1, second_leaked)];
        meeting
    }

    #[test]
    fn words_are_shared_out_by_time() {
        let settings = SpeakerSettings::default();
        let words = [
            word(100, 400, "가"),
            word(500, 900, "나"),
            word(1_100, 1_500, "다"),
            // Mostly over the second speaker's time.
            word(950, 1_900, "라."),
        ];
        let mut meeting = shared(&settings, false);
        assert!(meeting.needs_words(&"aa".repeat(32)));
        let lines = meeting.lines(&"aa".repeat(32), 0, 0, "가 나 다 라.", Some(&words));
        assert_eq!(
            lines,
            vec![
                Line {
                    start_ms: 100,
                    end_ms: 900,
                    text: "가 나".into()
                },
                Line {
                    start_ms: 950,
                    end_ms: 1_900,
                    text: "라. 다".into()
                },
            ],
            "words in time order, each to its speaker"
        );
        let locals: Vec<_> = meeting.tracks[0].pieces.iter().map(|p| p.local).collect();
        assert_eq!(locals, [Some(0), Some(1)]);
    }

    #[test]
    fn words_in_leaked_sound_are_dropped() {
        let settings = SpeakerSettings::default();
        let words = [word(100, 400, "가,"), word(1_100, 1_500, "다")];
        let mut meeting = shared(&settings, true);
        let lines = meeting.lines(&"aa".repeat(32), 0, 0, "가, 다", Some(&words));
        assert_eq!(
            lines,
            vec![Line {
                start_ms: 100,
                end_ms: 400,
                text: "가,".into()
            }]
        );
    }

    #[test]
    fn a_line_is_never_empty() {
        let settings = SpeakerSettings::default();
        // A zero-length word, and one stamped at the very end of the piece.
        let words = [
            word(100, 400, "가"),
            word(1_500, 1_500, "나"),
            word(2_000, 2_000, "다"),
        ];
        let mut meeting = shared(&settings, false);
        meeting.tracks[0].subs = vec![
            sub(0, 1_000, 0, false),
            sub(1_000, 1_800, 1, false),
            sub(1_800, 2_000, 0, false),
        ];
        let lines = meeting.lines(&"aa".repeat(32), 0, 0, "가 나 다", Some(&words));
        assert_eq!(lines.len(), 3, "{lines:?}");
        for line in &lines {
            assert!(line.end_ms > line.start_ms, "{line:?}");
            assert!(line.start_ms < 2_000 && line.end_ms <= 2_000, "{line:?}");
        }
    }

    #[test]
    fn one_speaker_for_every_word_keeps_the_engine_text() {
        let settings = SpeakerSettings::default();
        let words = [word(100, 400, "가,"), word(500, 900, "나.")];
        let mut meeting = shared(&settings, false);
        let lines = meeting.lines(&"aa".repeat(32), 0, 0, "가, 나.", Some(&words));
        assert_eq!(
            lines,
            vec![Line {
                start_ms: 100,
                end_ms: 900,
                text: "가, 나.".into()
            }]
        );
    }

    #[test]
    fn without_words_the_piece_goes_to_its_main_speaker() {
        let settings = SpeakerSettings::default();
        let mut meeting = shared(&settings, false);
        meeting.tracks[0].subs = vec![sub(0, 600, 0, false), sub(600, 2_000, 1, false)];
        let lines = meeting.lines(&"aa".repeat(32), 0, 0, "옛 결과", None);
        assert_eq!(
            lines,
            vec![Line {
                start_ms: 0,
                end_ms: 2_000,
                text: "옛 결과".into()
            }]
        );
        let piece = &meeting.tracks[0].pieces[0];
        assert_eq!(piece.local, Some(1));
        assert!((piece.share - 0.7).abs() < 1e-6, "{}", piece.share);
        // All of it leaked in: no line.
        let mut meeting = shared(&settings, false);
        meeting.tracks[0].subs = vec![sub(0, 2_000, 0, true)];
        assert!(meeting
            .lines(&"aa".repeat(32), 0, 0, "에코", None)
            .is_empty());
    }

    #[test]
    fn a_one_speaker_track_gives_one_line_per_piece_as_before() {
        let settings = SpeakerSettings::default();
        let mut meeting = meeting(&settings, Vec::new());
        let track = &mut meeting.tracks[1];
        track.pieces.clear();
        track.sent = vec![sent(5_000, 6_000, None)];
        let words = [word(0, 300, "무시")];
        let lines = meeting.lines(&"bb".repeat(32), 0, 4_800, "그대로.", Some(&words));
        assert_eq!(
            lines,
            vec![Line {
                start_ms: 5_000,
                end_ms: 6_000,
                text: "그대로.".into()
            }]
        );
        assert!(!meeting.needs_words(&"bb".repeat(32)));
    }

    #[tokio::test]
    async fn lines_of_a_shared_track_that_do_not_line_up_belong_to_nobody() {
        let settings = SpeakerSettings::default();
        let pieces = vec![piece(0, 1_000, 1.0), piece(1_000, 2_000, 1.0)];
        // Lined up: the room cluster is named "bb…" by the clean track's voice.
        let mut lines = vec![
            line("aa", 0, 1_000),
            line("aa", 1_000, 2_000),
            line("bb", 5_000, 6_000),
        ];
        let report = meeting(&settings, pieces.clone()).finish(&mut lines).await;
        assert_eq!(report.mismatched_tracks, 0);
        for l in &lines[..2] {
            assert_eq!(l.speaker.as_deref(), Some("bb".repeat(32).as_str()));
            assert_eq!(l.speaker_label.as_deref(), Some("회의실 화자 1"));
        }
        // The second line starts somewhere no recorded piece does.
        let mut lines = vec![
            line("aa", 0, 1_000),
            line("aa", 1_500, 2_000),
            line("bb", 5_000, 6_000),
        ];
        let report = meeting(&settings, pieces).finish(&mut lines).await;
        assert_eq!(report.mismatched_tracks, 1);
        for l in &lines[..2] {
            assert_eq!(l.speaker, None, "the device owner is not given either");
            assert_eq!(l.speaker_confidence, None);
            assert_eq!(l.speaker_label.as_deref(), Some("회의실 화자 ?"));
        }
        assert_eq!(lines[2].speaker.as_deref(), Some("bb".repeat(32).as_str()));
    }

    #[tokio::test]
    async fn the_report_keeps_only_key_prefixes_and_the_log_line_none() {
        let settings = SpeakerSettings::default();
        let pieces = vec![piece(0, 1_000, 1.0), piece(1_000, 2_000, 1.0)];
        let mut lines = vec![
            line("aa", 0, 1_000),
            line("aa", 1_000, 2_000),
            line("bb", 5_000, 6_000),
        ];
        let report = meeting(&settings, pieces).finish(&mut lines).await;
        let cluster = &report.clusters[0];
        assert_eq!(cluster.scores.len(), 1);
        assert_eq!(cluster.scores[0].0, "bb".repeat(4));
        assert_eq!(
            cluster.named.as_ref().map(|(p, _)| p.as_str()),
            Some("bbbbbbbb")
        );
        let log = report_line(&report);
        assert!(!log.contains("bbbb"), "{log}");
        assert!(!log.contains("aaaa"), "{log}");
    }

    #[tokio::test]
    async fn a_line_others_talk_over_keeps_its_label_but_no_name() {
        let settings = SpeakerSettings::default();
        let pieces = vec![piece(0, 1_000, 1.0), piece(1_000, 2_000, 0.3)];
        let mut lines = vec![
            line("aa", 0, 1_000),
            line("aa", 1_000, 2_000),
            line("bb", 5_000, 6_000),
        ];
        meeting(&settings, pieces).finish(&mut lines).await;
        assert_eq!(lines[0].speaker.as_deref(), Some("bb".repeat(32).as_str()));
        assert!(lines[0].speaker_confidence.is_some());
        assert_eq!(lines[1].speaker, None);
        assert_eq!(lines[1].speaker_confidence, None);
        assert_eq!(lines[1].speaker_label.as_deref(), Some("회의실 화자 1"));
    }

    #[test]
    fn participants_count_who_spoke_not_whose_device_it_was() {
        let report = SpeakersReport {
            tracks: vec![
                TrackSpeakersReport {
                    device: "aa".repeat(32),
                    speakers: 2,
                    ..TrackSpeakersReport::default()
                },
                TrackSpeakersReport {
                    device: "bb".repeat(32),
                    speakers: 1,
                    ..TrackSpeakersReport::default()
                },
            ],
            ..SpeakersReport::default()
        };
        let mut participants = vec![
            Participant {
                pubkey: "aa".repeat(32),
                speech_ms: 5_000,
            },
            Participant {
                pubkey: "bb".repeat(32),
                speech_ms: 3_000,
            },
        ];
        let mut named_bb = line("aa", 0, 1_000);
        named_bb.speaker = Some("bb".repeat(32));
        let mut unknown = line("aa", 1_000, 1_500);
        unknown.speaker = None;
        let mut named_cc = line("aa", 2_000, 2_700);
        named_cc.speaker = Some("cc".repeat(32));
        let segments = vec![named_bb, unknown, named_cc, line("bb", 5_000, 6_000)];
        report.update_participants(&mut participants, &segments);
        let got: Vec<(String, u64)> = participants
            .iter()
            .map(|p| (p.pubkey[..2].to_string(), p.speech_ms))
            .collect();
        assert_eq!(
            got,
            vec![("aa".into(), 0), ("bb".into(), 4_000), ("cc".into(), 700)]
        );
    }

    /// A store that refuses every save, or lets `voices forget` run between
    /// the "is this person forgotten?" check and the save.
    struct Scripted {
        inner: LocalVoiceStore,
        refuse_saves: bool,
        forget_before_save: bool,
    }

    impl VoiceStore for Scripted {
        fn list(&self, community: Uuid) -> StoreFuture<'_, Listing> {
            self.inner.list(community)
        }
        fn list_all(&self) -> StoreFuture<'_, Listing> {
            self.inner.list_all()
        }
        fn load<'a>(
            &'a self,
            community: Uuid,
            pubkey: &'a str,
        ) -> StoreFuture<'a, Option<(VoiceProfile, Version)>> {
            self.inner.load(community, pubkey)
        }
        fn save<'a>(
            &'a self,
            profile: &'a VoiceProfile,
            version: Version,
        ) -> StoreFuture<'a, bool> {
            Box::pin(async move {
                if self.refuse_saves {
                    return Ok(false);
                }
                if self.forget_before_save {
                    self.inner.forget(&profile.pubkey).await?;
                }
                self.inner.save(profile, version).await
            })
        }
        fn is_forgotten<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool> {
            self.inner.is_forgotten(pubkey)
        }
        fn forget<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, ForgetResult> {
            self.inner.forget(pubkey)
        }
        fn allow<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool> {
            self.inner.allow(pubkey)
        }
    }

    fn sample(v: [f32; 2], seconds: f32) -> VoiceSample {
        VoiceSample {
            source: SampleSource::OwnTrack,
            seconds,
            day: "2026-10-12".into(),
            confirmed_by: None,
            confirmed_on: None,
            embedding: crate::diarize::normalized(v.to_vec()).expect("unit"),
        }
    }

    #[tokio::test]
    async fn a_profile_update_lost_to_another_worker_or_to_forget_is_not_kept() {
        let model = ModelId {
            name: "m".into(),
            sha256: "ab".repeat(32),
        };
        let pubkey = "cd".repeat(32);
        let person = Person {
            community: Uuid::nil(),
            pubkey: &pubkey,
            model: &model,
            day: "2026-10-12",
        };
        let profiles = ProfileSettings::default();
        let store = |dir: &std::path::Path, refuse_saves, forget_before_save| Scripted {
            inner: LocalVoiceStore::open(dir).expect("store"),
            refuse_saves,
            forget_before_save,
        };

        let dir = tempfile::tempdir().expect("tempdir");
        let raced = store(dir.path(), true, false);
        let got = update_profile(&raced, &person, Some(sample([1.0, 0.0], 30.0)), &profiles).await;
        assert_eq!(got.expect("update"), ProfileUpdate::Raced);
        // A forgotten person is not even tried (no save to lose).
        raced.inner.forget(&pubkey).await.expect("forget");
        let got = update_profile(&raced, &person, Some(sample([1.0, 0.0], 30.0)), &profiles).await;
        assert_eq!(got.expect("update"), ProfileUpdate::Forgotten);

        let dir = tempfile::tempdir().expect("tempdir");
        let racing_forget = store(dir.path(), false, true);
        let got = update_profile(
            &racing_forget,
            &person,
            Some(sample([1.0, 0.0], 30.0)),
            &profiles,
        )
        .await;
        assert_eq!(got.expect("update"), ProfileUpdate::Forgotten);
        let left = racing_forget
            .load(Uuid::nil(), &pubkey)
            .await
            .expect("load");
        assert_eq!(left, None, "the save that raced forget was taken back");

        // Normal path: pending, then ready, then a different voice is refused.
        let dir = tempfile::tempdir().expect("tempdir");
        let plain = store(dir.path(), false, false);
        let mut got = Vec::new();
        for (v, seconds) in [([1.0, 0.0], 30.0), ([1.0, 0.1], 31.0), ([0.0, 1.0], 32.0)] {
            let update = update_profile(&plain, &person, Some(sample(v, seconds)), &profiles).await;
            got.push(update.expect("update"));
        }
        assert_eq!(
            got,
            vec![
                ProfileUpdate::Created,
                ProfileUpdate::Updated,
                ProfileUpdate::Refused
            ]
        );
        let (profile, version) = plain
            .load(Uuid::nil(), &pubkey)
            .await
            .expect("load")
            .expect("some");
        assert_eq!((profile.samples.len(), profile.dissent, version), (2, 1, 3));
    }
}
