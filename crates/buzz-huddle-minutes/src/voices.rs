//! 목소리 프로필: 회의 사이에 사람마다 목소리 특징(임베딩)을 저장해서, 회의실 마이크에
//! 섞인 화자가 누구인지 맞춘다 (C). 사용자 결정(2026-10-12, 법무 확인 끝).
//!
//! - **저장하는 것**: 목소리 특징 숫자와 메타데이터만(모델 이름·sha256, 재료마다 출처 종류·초·날짜
//!   (일 단위), 확인된 재료면 확인한 사람·날짜, 만든·고친 날짜). 원본 소리·잘라 낸 소리·회의 id 는
//!   저장하지 않는다.
//! - **재료**: 자기 기기로 혼자 말한 깨끗한 트랙(화자 나누기 결과 1명, 새어 든 소리를 뺀 것,
//!   말이 충분히 긴 것), 그리고 사람이 확인한 이름표([`SampleSource::Confirmed`]).
//!   기계가 혼자 맞힌 회의실 화자는 재료로 쓰지 않는다(틀린 짝이 굳어진다).
//! - **대기와 준비**: 첫 재료만으로는 쓰지 않는다(회의실 기기에 다른 사람이 혼자 말한 것일 수 있다).
//!   서로 닮은(코사인 [`AGREE`] 이상) 자기 트랙 재료가 둘 이상 모이거나 사람이 확인한 재료가 있어야
//!   "준비된" 프로필이 되고, 그때부터 맞추기·주인 목소리 검사에 쓴다([`VoiceProfile::is_ready`]).
//! - **위치**: [`VoiceStore`] 하나에 구현 둘 — 로컬 폴더(시험용, 0700/0600)와 GCS(전용 버킷).
//!   `voices/{community_id}/{sha256(pubkey)}/{판 번호}.json`. 커뮤니티마다 따로 두고, 그 커뮤니티
//!   것만 맞추기 후보다. 고칠 때마다 새 판을 "없을 때만 쓰기"로 써서 두 워커가 동시에 고쳐도 한쪽이
//!   다른 쪽을 덮지 않는다(진 쪽은 다시 읽고 한 번 더 한다).
//! - **지우기**: `voices forget <pubkey>` 는 모든 커뮤니티의 그 사람 것을 지우고 "지운 사람"
//!   표시(`voices/forgotten/{sha256(pubkey)}.json`)를 남겨 다음 회의에서 다시 생기지 않게 한다.
//!   다시 허락은 사람이 `voices allow <pubkey>` 로만. 보기는 `voices list`(앞 8자·날짜·분량).
//! - 로그·`Debug` 에 특징 값이 나오지 않는다.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::diarize::{cosine, weighted_mean, ModelId};

/// [`VoiceProfile::format`] 값.
pub const VOICE_PROFILE_FORMAT: &str = "huddle-voice-profile/2";
/// 저장 위치 안의 폴더(접두사).
pub const VOICES_PREFIX: &str = "voices/";
/// "지운 사람" 표시 폴더(`voices/forgotten/`).
const FORGOTTEN: &str = "forgotten";
/// 서로 같은 사람 목소리로 보는 코사인(재료끼리, 그리고 준비된 프로필과 새 재료). cal: 깨끗한 소리끼리
/// 같은 사람 최소 0.873, 다른 사람 최고 0.636.
pub const AGREE: f32 = 0.75;
/// 이보다 닮은 같은 출처 재료는 같은 재료를 다시 넣은 것(같은 회의를 다시 돌림)으로 본다. 다른
/// 녹음끼리는 같은 사람이라도 이만큼 닮지 않는다.
const DUPLICATE: f32 = 0.9999;

/// 재료가 어디서 왔나.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SampleSource {
    /// 자기 기기로 혼자 말한 깨끗한 트랙.
    OwnTrack,
    /// 사람이 "회의실 화자 N = 이 사람" 이라고 확인한 구간.
    Confirmed,
}

/// 재료 하나(회의 하나에서 낸 목소리 특징).
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct VoiceSample {
    /// 어디서 왔나.
    pub source: SampleSource,
    /// 특징을 만든 말 길이(초).
    pub seconds: f32,
    /// 넣은 날짜(UTC, `YYYY-MM-DD`).
    pub day: String,
    /// 확인된 재료면 확인한 사람의 pubkey(자리만: 누가 확인할 수 있는지 권한 검사는 앱을 붙일 때 정한다).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_by: Option<String>,
    /// 확인된 재료면 확인한 날짜(UTC, `YYYY-MM-DD`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_on: Option<String>,
    /// L2 정규화한 목소리 특징.
    pub embedding: Vec<f32>,
}

impl std::fmt::Debug for VoiceSample {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VoiceSample")
            .field("source", &self.source)
            .field("seconds", &self.seconds)
            .field("day", &self.day)
            .field(
                "confirmed_by",
                &self.confirmed_by.as_deref().map(|p| &p[..p.len().min(8)]),
            )
            .field("confirmed_on", &self.confirmed_on)
            .field(
                "embedding",
                &format_args!("[{} numbers]", self.embedding.len()),
            )
            .finish()
    }
}

/// 한 커뮤니티 안 한 사람의 목소리 프로필.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VoiceProfile {
    /// 늘 [`VOICE_PROFILE_FORMAT`].
    pub format: String,
    /// 그 사람의 hex pubkey(소문자).
    pub pubkey: String,
    /// 커뮤니티 id.
    pub community: Uuid,
    /// 특징을 낸 모델. 다른 모델의 특징과는 견줄 수 없다.
    pub model: ModelId,
    /// 처음 만든 날짜(UTC).
    pub created_on: String,
    /// 마지막으로 고친 날짜(UTC).
    pub updated_on: String,
    /// 준비된 프로필과 너무 달라 넣지 않은 깨끗한 트랙 수(마지막으로 재료를 넣은 뒤로). 쌓이면
    /// 프로필이 틀렸을 수 있다 — 사람이 `voices list` 로 보고 `forget` → `allow` 로 새로 만들게 한다.
    #[serde(default)]
    pub dissent: u32,
    /// 재료들, 오래된 것부터.
    pub samples: Vec<VoiceSample>,
}

impl VoiceProfile {
    /// 빈 프로필.
    pub fn new(pubkey: &str, community: Uuid, model: ModelId, day: &str) -> Self {
        Self {
            format: VOICE_PROFILE_FORMAT.into(),
            pubkey: pubkey.to_ascii_lowercase(),
            community,
            model,
            created_on: day.into(),
            updated_on: day.into(),
            dissent: 0,
            samples: Vec::new(),
        }
    }

    /// 재료를 다 합친 말 길이(초).
    pub fn seconds(&self) -> f32 {
        self.samples.iter().map(|s| s.seconds).sum()
    }

    /// 자기 트랙 재료를 서로 닮음(코사인 ≥ `agree`)으로 이은 묶음 가운데 가장 큰 것(같으면 가장
    /// 최근 재료가 든 것). 재료 순번들.
    fn largest_group(&self, agree: f32) -> Vec<usize> {
        let own: Vec<usize> = (0..self.samples.len())
            .filter(|&i| self.samples[i].source == SampleSource::OwnTrack)
            .collect();
        let mut group: Vec<usize> = (0..own.len()).collect();
        fn root(group: &mut [usize], mut i: usize) -> usize {
            while group[i] != i {
                group[i] = group[group[i]];
                i = group[i];
            }
            i
        }
        for a in 0..own.len() {
            for b in a + 1..own.len() {
                let s = cosine(
                    &self.samples[own[a]].embedding,
                    &self.samples[own[b]].embedding,
                );
                if s >= agree {
                    let (ra, rb) = (root(&mut group, a), root(&mut group, b));
                    group[ra] = rb;
                }
            }
        }
        let mut best: Vec<usize> = Vec::new();
        for a in 0..own.len() {
            let r = root(&mut group, a);
            let members: Vec<usize> = (0..own.len())
                .filter(|&b| root(&mut group, b) == r)
                .map(|b| own[b])
                .collect();
            let newer = members.iter().max() > best.iter().max();
            if members.len() > best.len() || (members.len() == best.len() && newer) {
                best = members;
            }
        }
        best
    }

    /// 맞추기·주인 검사에 써도 되나: 사람이 확인한 재료가 있거나, 서로 닮은 자기 트랙 재료가 둘 이상.
    pub fn is_ready(&self, agree: f32) -> bool {
        self.samples
            .iter()
            .any(|s| s.source == SampleSource::Confirmed)
            || self.largest_group(agree).len() >= 2
    }

    /// 준비된 프로필의 평균 특징: 가장 큰 닮은 묶음의 최근 `max_samples` 개 + 확인된 재료, 말 길이로
    /// 무게. 준비 안 됐으면 `None`.
    pub fn mean(&self, agree: f32, max_samples: usize) -> Option<Vec<f32>> {
        if !self.is_ready(agree) {
            return None;
        }
        let group = self.largest_group(agree);
        let mut picked: Vec<&VoiceSample> = Vec::new();
        if group.len() >= 2 {
            picked.extend(
                group
                    .iter()
                    .rev()
                    .take(max_samples.max(1))
                    .map(|&i| &self.samples[i]),
            );
        }
        picked.extend(
            self.samples
                .iter()
                .filter(|s| s.source == SampleSource::Confirmed),
        );
        let items: Vec<(Vec<f32>, f32)> = picked
            .into_iter()
            .map(|s| (s.embedding.clone(), s.seconds.max(1.0)))
            .collect();
        weighted_mean(&items)
    }

    /// 재료를 넣는다. 같은 출처의 거의 같은 재료가 이미 있으면(같은 회의를 다시 돌림) 넣지 않고
    /// `false` — 한 회의를 두 번 돌려 "준비"가 되는 일은 없다. 자기 트랙 재료는 최근 `max_samples` 개만 남긴다(오래된 것부터 빠지므로 처음에 잘못
    /// 들어간 남의 목소리도 결국 빠진다). 확인된 재료는 늘 남는다.
    pub fn add(&mut self, sample: VoiceSample, max_samples: usize) -> bool {
        let duplicate = self.samples.iter().any(|s| {
            s.source == sample.source && cosine(&s.embedding, &sample.embedding) >= DUPLICATE
        });
        if duplicate {
            return false;
        }
        self.updated_on = sample.day.clone();
        self.dissent = 0;
        self.samples.push(sample);
        let own = self
            .samples
            .iter()
            .filter(|s| s.source == SampleSource::OwnTrack)
            .count();
        let mut drop = own.saturating_sub(max_samples.max(1));
        self.samples.retain(|s| {
            if drop > 0 && s.source == SampleSource::OwnTrack {
                drop -= 1;
                false
            } else {
                true
            }
        });
        true
    }

    /// 이 프로필의 특징을 `model` 과 견줄 수 있나.
    pub fn same_model(&self, model: &ModelId) -> bool {
        self.model.sha256 == model.sha256
    }
}

/// 사람이 확인한 이름표(3단계 앱에서 "회의실 화자 1 = 이 사람" 이라고 고친 것). 요청 형식이다
/// (프로필에는 회의 id 를 남기지 않는다). 지금은 형식과 함수만 있고, 앱 연결은 나중에 한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceConfirmation {
    /// 그 회의의 첫 세션 id(구간을 찾는 데만 쓴다).
    pub meeting: Uuid,
    /// 회의실 트랙(기기) pubkey.
    pub device: String,
    /// 스크립트의 `speaker_label`(예: "회의실 화자 1").
    pub speaker_label: String,
    /// 그 사람이라고 확인된 pubkey.
    pub pubkey: String,
    /// 확인한 사람의 pubkey.
    pub confirmed_by: String,
    /// 확인한 시각(UTC).
    pub confirmed_at: String,
}

/// 확인된 이름표가 가리키는 스크립트 구간들 `(start_ms, end_ms)`. 워커는 이 구간의 녹음을
/// 다시 풀어 특징을 낸 뒤 [`add_confirmed`] 로 넣는다(소리는 저장하지 않는다).
pub fn confirmed_spans(
    transcript: &crate::transcript::Transcript,
    confirmation: &VoiceConfirmation,
) -> Vec<(u64, u64)> {
    transcript
        .segments
        .iter()
        .filter(|s| {
            s.device == confirmation.device
                && s.speaker_label.as_deref() == Some(confirmation.speaker_label.as_str())
        })
        .map(|s| (s.start_ms, s.end_ms))
        .collect()
}

/// 사람이 확인한 구간에서 낸 특징을 프로필에 넣는다. 모델·사람이 다르면 넣지 않고 `false`.
pub fn add_confirmed(
    profile: &mut VoiceProfile,
    confirmation: &VoiceConfirmation,
    embedding: Vec<f32>,
    seconds: f32,
    model: &ModelId,
    day: &str,
    max_samples: usize,
) -> bool {
    if !profile.same_model(model) || profile.pubkey != confirmation.pubkey.to_ascii_lowercase() {
        return false;
    }
    profile.add(
        VoiceSample {
            source: SampleSource::Confirmed,
            seconds,
            day: day.into(),
            confirmed_by: Some(confirmation.confirmed_by.to_ascii_lowercase()),
            confirmed_on: Some(confirmation.confirmed_at.chars().take(10).collect()),
            embedding,
        },
        max_samples,
    )
}

/// `sha256(소문자 hex pubkey 글자)`: 저장 이름에 pubkey 가 드러나지 않게.
pub fn person_key(pubkey: &str) -> String {
    crate::models::sha256_hex(pubkey.to_ascii_lowercase().as_bytes())
}

fn person_prefix(community: Uuid, pubkey: &str) -> String {
    format!("{VOICES_PREFIX}{community}/{}/", person_key(pubkey))
}

fn version_name(community: Uuid, pubkey: &str, version: u64) -> String {
    format!("{}{version:010}.json", person_prefix(community, pubkey))
}

fn forgotten_name(pubkey: &str) -> String {
    format!("{VOICES_PREFIX}{FORGOTTEN}/{}.json", person_key(pubkey))
}

/// 저장 이름 `voices/{community}/{key}/{version}.json` → `(community, key, version)`.
fn parse_name(name: &str) -> Option<(Uuid, String, u64)> {
    let rest = name.strip_prefix(VOICES_PREFIX)?;
    let mut parts = rest.split('/');
    let community = parts.next()?.parse().ok()?;
    let key = parts.next()?.to_string();
    let version = parts.next()?.strip_suffix(".json")?.parse().ok()?;
    if parts.next().is_some() || key.len() != 64 {
        return None;
    }
    Some((community, key, version))
}

/// 사람 폴더 안 파일 이름 `voices/{community}/{key}/…` → `(community, key)`. 판 이름이 아니어도(임시 파일·
/// 다른 파일) 그 사람 폴더 안이면 돌려준다.
fn person_of(name: &str) -> Option<(Uuid, String)> {
    let mut parts = name.strip_prefix(VOICES_PREFIX)?.splitn(3, '/');
    let community = parts.next()?.parse().ok()?;
    let key = parts.next()?;
    let rest = parts.next()?;
    (key.len() == 64 && !rest.is_empty()).then(|| (community, key.to_string()))
}

/// 로컬 저장소가 쓰는 중인 임시 파일(`.tmp-…`).
fn is_temp(name: &str) -> bool {
    name.rsplit('/')
        .next()
        .is_some_and(|f| f.starts_with(".tmp-"))
}

/// pubkey 가 64자 hex 인지 보고 소문자로.
pub fn checked_pubkey(pubkey: &str) -> Result<String, VoiceStoreError> {
    let lower = pubkey.trim().to_ascii_lowercase();
    if lower.len() == 64 && lower.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(lower)
    } else {
        Err(VoiceStoreError::BadPubkey)
    }
}

/// 저장소 실패. 특징 값·pubkey 는 담지 않는다.
#[derive(Debug, thiserror::Error)]
pub enum VoiceStoreError {
    /// 로컬 파일.
    #[error("voice store: {0}")]
    Io(#[from] std::io::Error),
    /// GCS.
    #[error("voice store: {0}")]
    Gcs(#[from] buzz_gcp::gcs::GcsError),
    /// pubkey 가 64자 hex 가 아니다.
    #[error("pubkey must be 64 hex characters")]
    BadPubkey,
    /// 그 사람의 가장 새 판을 읽지 못했다(못 읽는 것 위에 새로 쓰지 않는다).
    #[error("voice store: the newest stored profile could not be read")]
    Unreadable,
    /// 읽는 동안 판이 계속 바뀌었다(세 번 다시 읽어도). 다음에 다시 한다.
    #[error("voice store: profiles kept changing while being read")]
    Busy,
}

/// 저장소가 돌려주는 미래 값.
pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, VoiceStoreError>> + Send + 'a>>;

/// 판 번호(1 부터, 고칠 때마다 1 씩).
pub type Version = u64;

/// 읽은 프로필들.
#[derive(Debug, Clone, Default)]
pub struct Listing {
    /// 프로필과 그 판 번호.
    pub profiles: Vec<(VoiceProfile, Version)>,
    /// 읽지 못해 건너뛴 것(깨진 파일, 이름과 내용이 안 맞는 것).
    pub unreadable: usize,
    /// "지운 사람" 표시가 있는데 남아 있던 파일(지우기가 중간에 실패했거나 저장이 겹친 것). 쓰지 않고
    /// 그 자리에서 지운다.
    pub forgotten_leftovers: usize,
}

/// [`VoiceStore::forget`] 결과.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ForgetResult {
    /// 지운 파일 수.
    pub deleted: usize,
    /// 지우지 못한 파일 수(0 이 아니면 다시 돌린다. 그동안도 표시 때문에 쓰이지 않는다).
    pub failed: usize,
}

/// 목소리 프로필 저장소.
pub trait VoiceStore: Send + Sync {
    /// 한 커뮤니티의 프로필들(사람마다 가장 새 판). 못 읽는 것은 건너뛰고 센다. "지운 사람" 표시가 있는
    /// 사람 것은 남아 있어도 돌려주지 않는다.
    fn list(&self, community: Uuid) -> StoreFuture<'_, Listing>;
    /// 모든 커뮤니티의 프로필들(보기용).
    fn list_all(&self) -> StoreFuture<'_, Listing>;
    /// 한 사람 것(가장 새 판), 없으면 `None`. 가장 새 판을 못 읽으면 오류([`VoiceStoreError::Unreadable`]).
    fn load<'a>(
        &'a self,
        community: Uuid,
        pubkey: &'a str,
    ) -> StoreFuture<'a, Option<(VoiceProfile, Version)>>;
    /// `version` 판으로 쓴다 — 그 판이 아직 없을 때만. 다른 워커가 먼저 썼으면 `false`(다시 읽고
    /// 해야 한다). 쓰고 나면 더 오래된 판은 지운다.
    fn save<'a>(&'a self, profile: &'a VoiceProfile, version: Version) -> StoreFuture<'a, bool>;
    /// 지운 사람인가.
    fn is_forgotten<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool>;
    /// "지운 사람" 표시를 남기고 모든 커뮤니티의 그 사람 폴더(`voices/{커뮤니티}/{열쇠}/`) 안 파일을 모두
    /// 지운다. 하나 못 지워도 끝까지 돌고 지운 수·못 지운 수를 돌려준다.
    fn forget<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, ForgetResult>;
    /// "지운 사람" 표시를 지운다(사람이 다시 허락할 때만). 있었으면 `true`.
    fn allow<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool>;
}

/// 이름 붙은 바이트 덩어리 저장소(로컬 폴더 또는 GCS 버킷). [`BlobVoiceStore`] 가 이 위에서 판을 다룬다.
pub trait Blobs: Send + Sync {
    /// `prefix` 로 시작하는 이름들.
    fn names<'a>(&'a self, prefix: &'a str) -> StoreFuture<'a, Vec<String>>;
    /// 내용, 없으면 `None`.
    fn get<'a>(&'a self, name: &'a str) -> StoreFuture<'a, Option<Vec<u8>>>;
    /// 없을 때만 쓴다. 이미 있으면 `false`.
    fn put_if_absent<'a>(&'a self, name: &'a str, bytes: Vec<u8>) -> StoreFuture<'a, bool>;
    /// 쓴다(있으면 바꾼다).
    fn put<'a>(&'a self, name: &'a str, bytes: Vec<u8>) -> StoreFuture<'a, ()>;
    /// 지운다. 있었으면 `true`.
    fn delete<'a>(&'a self, name: &'a str) -> StoreFuture<'a, bool>;
}

/// [`Blobs`] 위의 판 붙은 프로필 저장소.
#[derive(Debug)]
pub struct BlobVoiceStore<B> {
    blobs: B,
}

impl<B: Blobs> BlobVoiceStore<B> {
    /// `blobs` 를 쓰는 저장소.
    pub fn new(blobs: B) -> Self {
        Self { blobs }
    }

    /// "지운 사람" 표시가 있는 사람 열쇠들.
    async fn forgotten_keys(&self) -> Result<std::collections::HashSet<String>, VoiceStoreError> {
        let marks = format!("{VOICES_PREFIX}{FORGOTTEN}/");
        Ok(self
            .blobs
            .names(&marks)
            .await?
            .iter()
            .filter_map(|n| Some(n.strip_prefix(&marks)?.strip_suffix(".json")?.to_string()))
            .collect())
    }

    /// `prefix` 아래 사람마다 가장 새 판을 읽는다. 지운 사람 것은 건너뛰고 지운다. 목록을 본 뒤 가장 새
    /// 판이 사라졌으면(그 사이 새 판이 써짐) 처음부터 다시 읽는다(세 번까지).
    async fn latest(&self, prefix: &str) -> Result<Listing, VoiceStoreError> {
        let marks = format!("{VOICES_PREFIX}{FORGOTTEN}/");
        'attempt: for _ in 0..3 {
            let forgotten = self.forgotten_keys().await?;
            let mut newest: std::collections::BTreeMap<(Uuid, String), (u64, String)> =
                Default::default();
            let mut listing = Listing::default();
            let mut leftovers = Vec::new();
            for name in self.blobs.names(prefix).await? {
                if name.starts_with(&marks) || is_temp(&name) {
                    continue;
                }
                if person_of(&name).is_some_and(|(_, key)| forgotten.contains(&key)) {
                    leftovers.push(name);
                    continue;
                }
                let Some((community, key, version)) = parse_name(&name) else {
                    listing.unreadable += 1;
                    continue;
                };
                let slot = newest.entry((community, key)).or_insert((0, String::new()));
                if version > slot.0 {
                    *slot = (version, name);
                }
            }
            listing.forgotten_leftovers = leftovers.len();
            for name in &leftovers {
                // Best effort: whatever stays is still never used.
                let _ = self.blobs.delete(name).await;
            }
            for ((community, key), (version, name)) in newest {
                let Some(bytes) = self.blobs.get(&name).await? else {
                    // Replaced by a newer version since the listing: read again.
                    continue 'attempt;
                };
                match serde_json::from_slice::<VoiceProfile>(&bytes) {
                    Ok(profile)
                        if profile.format == VOICE_PROFILE_FORMAT
                            && profile.community == community
                            && person_key(&profile.pubkey) == key =>
                    {
                        listing.profiles.push((profile, version));
                    }
                    _ => listing.unreadable += 1,
                }
            }
            return Ok(listing);
        }
        Err(VoiceStoreError::Busy)
    }
}

impl<B: Blobs> VoiceStore for BlobVoiceStore<B> {
    fn list(&self, community: Uuid) -> StoreFuture<'_, Listing> {
        Box::pin(async move { self.latest(&format!("{VOICES_PREFIX}{community}/")).await })
    }

    fn list_all(&self) -> StoreFuture<'_, Listing> {
        Box::pin(async move { self.latest(VOICES_PREFIX).await })
    }

    fn load<'a>(
        &'a self,
        community: Uuid,
        pubkey: &'a str,
    ) -> StoreFuture<'a, Option<(VoiceProfile, Version)>> {
        Box::pin(async move {
            let listing = self.latest(&person_prefix(community, pubkey)).await?;
            if listing.unreadable > 0 {
                return Err(VoiceStoreError::Unreadable);
            }
            Ok(listing.profiles.into_iter().next())
        })
    }

    fn save<'a>(&'a self, profile: &'a VoiceProfile, version: Version) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            let json = serde_json::to_vec(profile).map_err(std::io::Error::other)?;
            let name = version_name(profile.community, &profile.pubkey, version);
            if !self.blobs.put_if_absent(&name, json).await? {
                return Ok(false);
            }
            // Older versions are no longer needed (best effort).
            for old in self
                .blobs
                .names(&person_prefix(profile.community, &profile.pubkey))
                .await?
            {
                if parse_name(&old).is_some_and(|(_, _, v)| v < version) {
                    let _ = self.blobs.delete(&old).await;
                }
            }
            Ok(true)
        })
    }

    fn is_forgotten<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool> {
        Box::pin(async move { Ok(self.blobs.get(&forgotten_name(pubkey)).await?.is_some()) })
    }

    fn forget<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, ForgetResult> {
        Box::pin(async move {
            // The mark first, so a worker that saves meanwhile sees it and undoes its save.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(0));
            let mark = serde_json::json!({ "forgotten": true, "on": day_of(now) });
            self.blobs
                .put(&forgotten_name(pubkey), mark.to_string().into_bytes())
                .await?;
            let key = person_key(pubkey);
            let mut result = ForgetResult::default();
            for name in self.blobs.names(VOICES_PREFIX).await? {
                if person_of(&name).is_none_or(|(_, k)| k != key) {
                    continue;
                }
                match self.blobs.delete(&name).await {
                    Ok(true) => result.deleted += 1,
                    Ok(false) => {}
                    Err(_) => result.failed += 1,
                }
            }
            Ok(result)
        })
    }

    fn allow<'a>(&'a self, pubkey: &'a str) -> StoreFuture<'a, bool> {
        Box::pin(async move { self.blobs.delete(&forgotten_name(pubkey)).await })
    }
}

/// 로컬 폴더(시험용): 폴더 0700, 파일 0600.
#[derive(Debug, Clone)]
pub struct LocalBlobs {
    dir: PathBuf,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

impl LocalBlobs {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// 같은 폴더 안 고유한 임시 파일에 0600 으로 쓴다(두 워커가 같은 이름을 쓰지 않게).
    fn write_temp(&self, target: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
        use std::io::Write;
        let parent = target.parent().unwrap_or(&self.dir);
        crate::runner::create_private_dir(parent)?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let temp = parent.join(format!(
            ".tmp-{}-{nanos}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(temp)
    }

    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                Self::walk(&path, root, out)?;
            } else if let Ok(relative) = path.strip_prefix(root) {
                out.push(
                    relative
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
        Ok(())
    }
}

impl Blobs for LocalBlobs {
    fn names<'a>(&'a self, prefix: &'a str) -> StoreFuture<'a, Vec<String>> {
        Box::pin(async move {
            let folder = match prefix.rfind('/') {
                Some(i) => &prefix[..i],
                None => "",
            };
            let mut out = Vec::new();
            Self::walk(&self.dir.join(folder), &self.dir, &mut out)?;
            out.retain(|n| n.starts_with(prefix));
            out.sort();
            Ok(out)
        })
    }

    fn get<'a>(&'a self, name: &'a str) -> StoreFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move {
            match std::fs::read(self.path(name)) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error.into()),
            }
        })
    }

    fn put_if_absent<'a>(&'a self, name: &'a str, bytes: Vec<u8>) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            let target = self.path(name);
            let temp = self.write_temp(&target, &bytes)?;
            // A hard link fails when the name is taken: written whole, only if absent.
            let linked = std::fs::hard_link(&temp, &target);
            let _ = std::fs::remove_file(&temp);
            match linked {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(error) => Err(error.into()),
            }
        })
    }

    fn put<'a>(&'a self, name: &'a str, bytes: Vec<u8>) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            let target = self.path(name);
            let temp = self.write_temp(&target, &bytes)?;
            std::fs::rename(&temp, &target)?;
            Ok(())
        })
    }

    fn delete<'a>(&'a self, name: &'a str) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            match std::fs::remove_file(self.path(name)) {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error.into()),
            }
        })
    }
}

/// 로컬 폴더 저장소(시험용): `<dir>/voices/...`, 폴더 0700, 파일 0600.
pub type LocalVoiceStore = BlobVoiceStore<LocalBlobs>;

impl LocalVoiceStore {
    /// `dir` 을 쓴다(`voices/` 를 0700 으로 만든다).
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        crate::runner::create_private_dir(&dir.join(VOICES_PREFIX))?;
        Ok(Self::new(LocalBlobs {
            dir: dir.to_path_buf(),
        }))
    }
}

/// GCS 버킷.
#[derive(Debug)]
pub struct GcsBlobs {
    gcs: buzz_gcp::gcs::Gcs,
    bucket: String,
}

impl Blobs for GcsBlobs {
    fn names<'a>(&'a self, prefix: &'a str) -> StoreFuture<'a, Vec<String>> {
        Box::pin(async move {
            Ok(self
                .gcs
                .list(&self.bucket, prefix)
                .await?
                .into_iter()
                .map(|o| o.name)
                .collect())
        })
    }

    fn get<'a>(&'a self, name: &'a str) -> StoreFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move {
            match self.gcs.get(&self.bucket, name).await {
                Ok(bytes) => Ok(Some(bytes.to_vec())),
                Err(error) if error.kind == buzz_gcp::gcs::GcsErrorKind::NotFound => Ok(None),
                Err(error) => Err(error.into()),
            }
        })
    }

    fn put_if_absent<'a>(&'a self, name: &'a str, bytes: Vec<u8>) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            match self
                .gcs
                .put(
                    &self.bucket,
                    name,
                    bytes,
                    "application/json",
                    buzz_gcp::gcs::Write::IfAbsent,
                )
                .await
            {
                Ok(_) => Ok(true),
                Err(error) if error.kind == buzz_gcp::gcs::GcsErrorKind::AlreadyExists => Ok(false),
                Err(error) => Err(error.into()),
            }
        })
    }

    fn put<'a>(&'a self, name: &'a str, bytes: Vec<u8>) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            self.gcs
                .put(
                    &self.bucket,
                    name,
                    bytes,
                    "application/json",
                    buzz_gcp::gcs::Write::Overwrite,
                )
                .await?;
            Ok(())
        })
    }

    fn delete<'a>(&'a self, name: &'a str) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            match self.gcs.delete(&self.bucket, name).await {
                Ok(()) => Ok(true),
                Err(error) if error.kind == buzz_gcp::gcs::GcsErrorKind::NotFound => Ok(false),
                Err(error) => Err(error.into()),
            }
        })
    }
}

/// GCS 저장소: `gs://<bucket>/voices/...`. 분(회의록) 버킷과 따로 둔다(소프트 삭제 0 인 전용 버킷).
pub type GcsVoiceStore = BlobVoiceStore<GcsBlobs>;

impl GcsVoiceStore {
    /// `bucket` 을 쓰는 저장소.
    pub fn gcs(gcs: buzz_gcp::gcs::Gcs, bucket: &str) -> Self {
        Self::new(GcsBlobs {
            gcs,
            bucket: bucket.to_string(),
        })
    }
}

/// 어디에 저장하나(명령줄·환경 변수).
#[derive(Debug, Clone, clap::Args)]
pub struct VoiceStoreArgs {
    /// 로컬 폴더에 저장(시험용). `<폴더>/voices/` 를 쓴다.
    #[arg(
        long,
        env = "BUZZ_MINUTES_VOICES_DIR",
        conflicts_with = "voices_bucket"
    )]
    pub voices_dir: Option<PathBuf>,
    /// GCS 버킷에 저장(`gs://<버킷>/voices/`). 회의록 버킷과 다른 전용 버킷(소프트 삭제 0).
    #[arg(long, env = "BUZZ_MINUTES_VOICES_BUCKET")]
    pub voices_bucket: Option<String>,
    /// GCS 인증: 메타데이터 서버(GCP 안) 또는 지금 gcloud 계정.
    #[arg(long, env = "BUZZ_MINUTES_VOICES_AUTH", value_enum, default_value_t = GcpAuth::Metadata)]
    pub voices_auth: GcpAuth,
}

/// GCS 인증 방법.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum GcpAuth {
    /// GCE·Cloud Run 메타데이터 서버(서비스 계정).
    Metadata,
    /// 개발 맥의 `gcloud auth print-access-token`.
    Gcloud,
}

impl VoiceStoreArgs {
    /// 고른 저장소. 아무것도 안 주면 `None`(회의 사이 저장 꺼짐).
    pub fn open(&self) -> anyhow::Result<Option<Arc<dyn VoiceStore>>> {
        if let Some(dir) = &self.voices_dir {
            return Ok(Some(Arc::new(LocalVoiceStore::open(dir)?)));
        }
        let Some(bucket) = &self.voices_bucket else {
            return Ok(None);
        };
        let source = match self.voices_auth {
            GcpAuth::Metadata => buzz_gcp::token::TokenSource::metadata_server(),
            GcpAuth::Gcloud => buzz_gcp::token::TokenSource::gcloud(),
        };
        let gcs = buzz_gcp::gcs::Gcs::new(buzz_gcp::token::Tokens::new(source)?)?;
        Ok(Some(Arc::new(GcsVoiceStore::gcs(gcs, bucket))))
    }
}

/// `voices` 명령.
#[derive(Debug, Clone, clap::Subcommand)]
pub enum VoicesCommand {
    /// 저장된 프로필: 커뮤니티, pubkey 앞 8자, 만든 날짜, 분량(초), 준비 여부, 반대 수만 보여 준다.
    /// 보기 전용이 아니다: 읽다가 지운 사람의 남은 파일을 만나면 그 파일을 지운다.
    List {
        /// 저장 위치.
        #[command(flatten)]
        store: VoiceStoreArgs,
    },
    /// 한 사람의 프로필을 모든 커뮤니티에서 지우고 다시 만들지 않게 한다(삭제 요청 대응).
    Forget {
        /// 지울 사람의 hex pubkey(64자).
        pubkey: String,
        /// 저장 위치.
        #[command(flatten)]
        store: VoiceStoreArgs,
    },
    /// 지운 사람을 다시 허락한다(그 사람이 명시적으로 동의했을 때만). 프로필은 다음 회의부터 새로 모인다.
    Allow {
        /// 허락할 사람의 hex pubkey(64자).
        pubkey: String,
        /// 저장 위치.
        #[command(flatten)]
        store: VoiceStoreArgs,
    },
}

/// `voices list` 한 줄.
pub fn list_line(profile: &VoiceProfile) -> String {
    format!(
        "{}  {}  created {}  {:.0} s  {} samples  {}  dissent {}",
        &profile.community.to_string()[..8],
        profile.pubkey.chars().take(8).collect::<String>(),
        profile.created_on,
        profile.seconds(),
        profile.samples.len(),
        if profile.is_ready(AGREE) {
            "ready"
        } else {
            "pending"
        },
        profile.dissent
    )
}

/// `voices` 명령을 돌린다.
pub async fn run_command(command: VoicesCommand) -> anyhow::Result<()> {
    let open = |store: &VoiceStoreArgs| -> anyhow::Result<Arc<dyn VoiceStore>> {
        store
            .open()?
            .ok_or_else(|| anyhow::anyhow!("give --voices-dir or --voices-bucket"))
    };
    match command {
        VoicesCommand::List { store } => {
            let store = open(&store)?;
            let listing = store.list_all().await?;
            for (profile, _) in &listing.profiles {
                println!("{}", list_line(profile));
            }
            eprintln!(
                "{} profile(s), {} unreadable, {} leftover file(s) of forgotten people removed",
                listing.profiles.len(),
                listing.unreadable,
                listing.forgotten_leftovers
            );
        }
        VoicesCommand::Forget { pubkey, store } => {
            let pubkey = checked_pubkey(&pubkey)?;
            let store = open(&store)?;
            let result = store.forget(&pubkey).await?;
            eprintln!(
                "forgot {}… ({} file(s) removed, {} not; will not be recreated or used)",
                &pubkey[..8],
                result.deleted,
                result.failed
            );
            if result.failed > 0 {
                anyhow::bail!(
                    "{} file(s) could not be removed; run forget again",
                    result.failed
                );
            }
        }
        VoicesCommand::Allow { pubkey, store } => {
            let pubkey = checked_pubkey(&pubkey)?;
            let store = open(&store)?;
            let was = store.allow(&pubkey).await?;
            eprintln!(
                "{}… {}",
                &pubkey[..8],
                if was {
                    "allowed again"
                } else {
                    "was not forgotten"
                }
            );
        }
    }
    Ok(())
}

/// 회의실 화자 묶음 → 사람 맞추기. 점수가 높은 짝부터 정하고, 사람 하나에 묶음 하나만
/// 준다(두 묶음이 같은 사람에 맞으면 더 높은 쪽만). `scores[c]` 는 묶음 `c` 의 `(사람, 점수)`.
/// 돌려주는 값: 묶음마다 `(사람 순번, 점수)` 또는 `None`.
pub fn assign(scores: &[Vec<(usize, f32)>], threshold: f32) -> Vec<Option<(usize, f32)>> {
    let mut pairs: Vec<(usize, usize, f32)> = scores
        .iter()
        .enumerate()
        .flat_map(|(c, row)| row.iter().map(move |&(p, s)| (c, p, s)))
        .filter(|&(_, _, s)| s >= threshold)
        .collect();
    pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = vec![None; scores.len()];
    let mut taken = std::collections::HashSet::new();
    for (c, p, s) in pairs {
        if out[c].is_none() && !taken.contains(&p) {
            out[c] = Some((p, s));
            taken.insert(p);
        }
    }
    out
}

/// 날짜(UTC `YYYY-MM-DD`).
pub fn day_of(unix_ms: u64) -> String {
    buzz_huddle_recording::format_utc_millis(unix_ms)[..10].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> ModelId {
        ModelId {
            name: "m.onnx".into(),
            sha256: "ab".repeat(32),
        }
    }

    fn sample(source: SampleSource, v: [f32; 2]) -> VoiceSample {
        VoiceSample {
            source,
            seconds: 10.0,
            day: "2026-10-12".into(),
            confirmed_by: None,
            confirmed_on: None,
            embedding: crate::diarize::normalized(v.to_vec()).unwrap(),
        }
    }

    const COMMUNITY: Uuid = Uuid::from_u128(7);

    #[test]
    fn one_recording_is_pending_two_agreeing_make_it_ready() {
        let mut p = VoiceProfile::new(&"A".repeat(64), COMMUNITY, model(), "2026-10-12");
        assert_eq!(p.pubkey, "a".repeat(64));
        // Someone else's voice first (a room device), then the owner twice.
        assert!(p.add(sample(SampleSource::OwnTrack, [0.0, 1.0]), 5));
        assert!(!p.is_ready(AGREE));
        assert_eq!(p.mean(AGREE, 5), None);
        assert!(p.add(sample(SampleSource::OwnTrack, [1.0, 0.05]), 5));
        assert!(!p.is_ready(AGREE), "two recordings that disagree");
        assert!(p.add(sample(SampleSource::OwnTrack, [1.0, 0.0]), 5));
        assert!(p.is_ready(AGREE));
        let mean = p.mean(AGREE, 5).unwrap();
        assert!(
            mean[0] > 0.99,
            "the agreeing pair wins, the stray first one is left out"
        );
        // The same recording again (a rerun) is not added twice.
        assert!(!p.add(sample(SampleSource::OwnTrack, [1.0, 0.0]), 5));
        assert_eq!(p.samples.len(), 3);
    }

    #[test]
    fn old_own_samples_age_out_confirmed_ones_stay() {
        let mut p = VoiceProfile::new(&"a".repeat(64), COMMUNITY, model(), "d");
        p.add(sample(SampleSource::Confirmed, [0.0, 1.0]), 2);
        p.add(sample(SampleSource::OwnTrack, [1.0, 0.0]), 2);
        p.add(sample(SampleSource::OwnTrack, [1.0, 0.1]), 2);
        p.add(sample(SampleSource::OwnTrack, [1.0, 0.2]), 2);
        assert_eq!(p.samples.len(), 3);
        assert_eq!(p.samples[0].source, SampleSource::Confirmed);
        assert!(p.is_ready(AGREE));
    }

    #[test]
    fn debug_never_prints_embedding_values() {
        let mut p = VoiceProfile::new(&"a".repeat(64), COMMUNITY, model(), "d");
        p.add(sample(SampleSource::OwnTrack, [0.123_456, 0.654_321]), 5);
        let text = format!("{p:?}");
        assert!(!text.contains("0.18"), "{text}");
        assert!(text.contains("[2 numbers]"));
    }

    #[test]
    fn names_hide_the_pubkey_and_parse_back() {
        let pubkey = "c0ffee".repeat(10) + "abcd";
        let name = version_name(COMMUNITY, &pubkey, 3);
        assert!(name.starts_with(&format!("voices/{COMMUNITY}/")));
        assert!(!name.contains("c0ffee"));
        assert_eq!(parse_name(&name), Some((COMMUNITY, person_key(&pubkey), 3)));
        assert_eq!(
            person_key(&pubkey),
            person_key(&pubkey.to_ascii_uppercase())
        );
        assert_eq!(parse_name("voices/zz.json"), None);
        assert!(checked_pubkey("zz").is_err());
        assert_eq!(
            checked_pubkey(&pubkey.to_ascii_uppercase()).unwrap(),
            pubkey
        );
    }

    #[test]
    fn two_clusters_on_one_person_give_it_to_the_higher() {
        let scores = vec![
            vec![(0, 0.71), (1, 0.30)],
            vec![(0, 0.80), (1, 0.20)],
            vec![(0, 0.10), (1, 0.40)],
        ];
        let got = assign(&scores, 0.5);
        assert_eq!(got[1], Some((0, 0.80)));
        assert_eq!(
            got[0], None,
            "the lower match on the same person stays unnamed"
        );
        assert_eq!(got[2], None, "below the threshold");
    }

    #[tokio::test]
    async fn versions_never_overwrite_and_unreadable_files_are_skipped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LocalVoiceStore::open(dir.path()).expect("store");
        let pubkey = "ab".repeat(32);
        let mut p = VoiceProfile::new(&pubkey, COMMUNITY, model(), "d");
        p.add(sample(SampleSource::OwnTrack, [1.0, 0.0]), 5);
        assert!(store.save(&p, 1).await.expect("save"));
        // A second worker writing the same version loses and must re-read.
        assert!(!store.save(&p, 1).await.expect("save"));
        p.add(sample(SampleSource::OwnTrack, [1.0, 0.1]), 5);
        assert!(store.save(&p, 2).await.expect("save"));
        let (loaded, version) = store
            .load(COMMUNITY, &pubkey)
            .await
            .expect("load")
            .expect("some");
        assert_eq!((loaded.samples.len(), version), (2, 2));
        // Version 1 was cleaned up.
        let names = store.blobs.names(VOICES_PREFIX).await.expect("names");
        assert_eq!(names.len(), 1, "{names:?}");
        // A broken file is skipped and counted, the good profile still reads.
        std::fs::write(dir.path().join("voices").join("zz.json"), b"not json").expect("write");
        let broken = dir.path().join(format!(
            "voices/{COMMUNITY}/{}/0000000009.json",
            "0".repeat(64)
        ));
        std::fs::create_dir_all(broken.parent().expect("parent")).expect("mkdir");
        std::fs::write(&broken, b"{").expect("write");
        let listing = store.list(COMMUNITY).await.expect("list");
        assert_eq!(listing.profiles.len(), 1);
        assert_eq!(listing.unreadable, 1, "the bad version file");
        // Another community sees nothing.
        let other = store.list(Uuid::from_u128(8)).await.expect("list");
        assert!(other.profiles.is_empty());
        // A newest version that does not read is never written over or around.
        std::fs::write(dir.path().join(version_name(COMMUNITY, &pubkey, 3)), b"{").expect("write");
        assert!(matches!(
            store.load(COMMUNITY, &pubkey).await,
            Err(VoiceStoreError::Unreadable)
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = dir.path().join(version_name(COMMUNITY, &pubkey, 2));
            let mode = std::fs::metadata(&file).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            for folder in [
                dir.path().join("voices"),
                dir.path().join(format!("voices/{COMMUNITY}")),
                dir.path().join(person_prefix(COMMUNITY, &pubkey)),
            ] {
                let mode = std::fs::metadata(&folder)
                    .expect("meta")
                    .permissions()
                    .mode();
                assert_eq!(mode & 0o777, 0o700, "{}", folder.display());
            }
        }
    }

    /// Local blobs that fail to delete names containing `fail_delete`, and
    /// report `vanish` as gone the first time it is read.
    struct Flaky {
        inner: LocalBlobs,
        fail_delete: Option<String>,
        vanish: std::sync::Mutex<Option<String>>,
    }

    impl Blobs for Flaky {
        fn names<'a>(&'a self, prefix: &'a str) -> StoreFuture<'a, Vec<String>> {
            self.inner.names(prefix)
        }
        fn get<'a>(&'a self, name: &'a str) -> StoreFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move {
                let gone = {
                    let mut vanish = self.vanish.lock().expect("lock");
                    let gone = vanish.as_deref() == Some(name);
                    if gone {
                        *vanish = None;
                    }
                    gone
                };
                if gone {
                    return Ok(None);
                }
                self.inner.get(name).await
            })
        }
        fn put_if_absent<'a>(&'a self, name: &'a str, bytes: Vec<u8>) -> StoreFuture<'a, bool> {
            self.inner.put_if_absent(name, bytes)
        }
        fn put<'a>(&'a self, name: &'a str, bytes: Vec<u8>) -> StoreFuture<'a, ()> {
            self.inner.put(name, bytes)
        }
        fn delete<'a>(&'a self, name: &'a str) -> StoreFuture<'a, bool> {
            Box::pin(async move {
                if self
                    .fail_delete
                    .as_deref()
                    .is_some_and(|f| name.contains(f))
                {
                    return Err(std::io::Error::other("delete failed").into());
                }
                self.inner.delete(name).await
            })
        }
    }

    fn flaky(dir: &Path, fail_delete: Option<&str>) -> BlobVoiceStore<Flaky> {
        crate::runner::create_private_dir(&dir.join(VOICES_PREFIX)).expect("dir");
        BlobVoiceStore::new(Flaky {
            inner: LocalBlobs {
                dir: dir.to_path_buf(),
            },
            fail_delete: fail_delete.map(str::to_string),
            vanish: std::sync::Mutex::new(None),
        })
    }

    fn files_under(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        LocalBlobs::walk(dir, dir, &mut out).expect("walk");
        out.sort();
        out
    }

    #[tokio::test]
    async fn forget_clears_the_whole_person_folder_and_goes_on_past_a_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let other = Uuid::from_u128(8);
        let (p0, p1) = ("ab".repeat(32), "cd".repeat(32));
        let store = flaky(dir.path(), Some("notes.json"));
        for community in [COMMUNITY, other] {
            for pubkey in [&p0, &p1] {
                let mut p = VoiceProfile::new(pubkey, community, model(), "d");
                p.add(sample(SampleSource::OwnTrack, [1.0, 0.0]), 5);
                assert!(store.save(&p, 1).await.expect("save"));
            }
        }
        // Files in P0's folder that are not versions: a note and a left-over temp file.
        let folder = dir.path().join(person_prefix(COMMUNITY, &p0));
        std::fs::write(folder.join("notes.json"), b"{}").expect("write");
        std::fs::write(folder.join(".tmp-1-2-3"), b"{}").expect("write");
        let result = store.forget(&p0).await.expect("forget");
        // Two versions + the temp file gone; the note could not be deleted, and
        // forget still went on and said so.
        assert_eq!(
            result,
            ForgetResult {
                deleted: 3,
                failed: 1
            }
        );
        let left = files_under(dir.path());
        let p1_files = left.iter().filter(|n| n.contains(&person_key(&p1))).count();
        assert_eq!(p1_files, 2, "the other person is untouched: {left:?}");
        let p0_left: Vec<&String> = left
            .iter()
            .filter(|n| n.contains(&person_key(&p0)))
            .collect();
        assert_eq!(p0_left.len(), 2, "the note and the mark: {p0_left:?}");
    }

    #[tokio::test]
    async fn files_of_a_forgotten_person_are_never_read_and_are_removed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LocalVoiceStore::open(dir.path()).expect("store");
        let pubkey = "ab".repeat(32);
        let mut p = VoiceProfile::new(&pubkey, COMMUNITY, model(), "d");
        p.add(sample(SampleSource::OwnTrack, [1.0, 0.0]), 5);
        assert!(store.save(&p, 1).await.expect("save"));
        let file = dir.path().join(version_name(COMMUNITY, &pubkey, 1));
        let bytes = std::fs::read(&file).expect("read");
        store.forget(&pubkey).await.expect("forget");
        // A save that raced the forget (or a forget that failed half way) left a file.
        std::fs::create_dir_all(file.parent().expect("parent")).expect("mkdir");
        std::fs::write(&file, &bytes).expect("write");
        let listing = store.list(COMMUNITY).await.expect("list");
        assert!(listing.profiles.is_empty());
        assert_eq!(listing.forgotten_leftovers, 1);
        assert!(!file.exists(), "removed while reading");
        assert_eq!(store.load(COMMUNITY, &pubkey).await.expect("load"), None);
    }

    #[tokio::test]
    async fn a_newest_version_that_vanishes_after_the_listing_is_read_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = flaky(dir.path(), None);
        let pubkey = "ab".repeat(32);
        let mut p = VoiceProfile::new(&pubkey, COMMUNITY, model(), "d");
        p.add(sample(SampleSource::OwnTrack, [1.0, 0.0]), 5);
        assert!(store.save(&p, 1).await.expect("save"));
        *store.blobs.vanish.lock().expect("lock") = Some(version_name(COMMUNITY, &pubkey, 1));
        let loaded = store.load(COMMUNITY, &pubkey).await.expect("load");
        assert_eq!(
            loaded.map(|(_, v)| v),
            Some(1),
            "not taken for \"no profile\""
        );
    }

    #[tokio::test]
    async fn forget_lasts_until_allowed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LocalVoiceStore::open(dir.path()).expect("store");
        let pubkey = "ab".repeat(32);
        for community in [COMMUNITY, Uuid::from_u128(8)] {
            let mut p = VoiceProfile::new(&pubkey, community, model(), "d");
            p.add(sample(SampleSource::OwnTrack, [1.0, 0.0]), 5);
            assert!(store.save(&p, 1).await.expect("save"));
        }
        assert_eq!(
            store.forget(&pubkey).await.expect("forget"),
            ForgetResult {
                deleted: 2,
                failed: 0
            }
        );
        assert!(store.is_forgotten(&pubkey).await.expect("forgotten"));
        assert!(store.list_all().await.expect("list").profiles.is_empty());
        assert!(store.allow(&pubkey).await.expect("allow"));
        assert!(!store.is_forgotten(&pubkey).await.expect("forgotten"));
        assert!(!store.allow(&pubkey).await.expect("allow again"));
    }

    #[test]
    fn confirmed_material_needs_the_same_model_and_person() {
        let pubkey = "ab".repeat(32);
        let mut p = VoiceProfile::new(&pubkey, COMMUNITY, model(), "d");
        let confirmation = VoiceConfirmation {
            meeting: Uuid::from_u128(9),
            device: "dd".repeat(32),
            speaker_label: "회의실 화자 1".into(),
            pubkey: pubkey.clone(),
            confirmed_by: "ee".repeat(32),
            confirmed_at: "2026-10-12T05:00:00.000Z".into(),
        };
        let other = ModelId {
            name: "x".into(),
            sha256: "cd".repeat(32),
        };
        assert!(!add_confirmed(
            &mut p,
            &confirmation,
            vec![1.0, 0.0],
            5.0,
            &other,
            "d1",
            5
        ));
        assert!(add_confirmed(
            &mut p,
            &confirmation,
            vec![1.0, 0.0],
            5.0,
            &model(),
            "d1",
            5
        ));
        assert_eq!(p.samples[0].source, SampleSource::Confirmed);
        let ee = "ee".repeat(32);
        assert_eq!(p.samples[0].confirmed_by.as_deref(), Some(ee.as_str()));
        assert_eq!(p.samples[0].confirmed_on.as_deref(), Some("2026-10-12"));
        assert!(
            p.is_ready(AGREE),
            "a confirmed sample makes a profile ready"
        );
        assert_eq!(p.updated_on, "d1");
    }
}
