//! 트랙 안 화자 나누기 (B).
//!
//! 회의실 마이크 하나에 여럿이 말하면 트랙 하나에 여러 사람이 섞인다. 여기서는
//!
//! - [`TrackDiarizer`]: 한 트랙에서 누가 언제 말했는지(트랙 안에서만 통하는 번호)를 찾는다.
//!   실제 구현은 sherpa-onnx `OfflineSpeakerDiarization`(pyannote 분할 + 목소리 특징 + 군집).
//! - [`VoiceEmbedder`]: 소리 한 토막의 목소리 특징(임베딩)을 낸다. 누가 누군지(C)에 쓴다.
//! - [`cut_pieces`]: 받아쓰기 덩어리를 화자가 바뀌는 자리에서 잘라, 한 덩어리에 한 화자만 있게 한다.
//! - [`squeeze`]: 말 없는 곳을 빼고 말만 이어 붙여 화자 나누기에 넣는다(계산을 줄인다).

use std::path::Path;

use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};

use crate::models::ModelFile;
use crate::vad::{Piece, SpeechSpan, VAD_SAMPLE_RATE};

/// 10ms 를 샘플로(16kHz).
const FRAME: usize = (VAD_SAMPLE_RATE / 100) as usize;

/// 한 화자가 말한 구간. `[start, end)` 샘플(16kHz), `speaker` 는 그 트랙 안에서만 통하는 번호.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Turn {
    /// 첫 샘플.
    pub start: usize,
    /// 마지막 샘플 다음.
    pub end: usize,
    /// 트랙 안 화자 번호(0 부터).
    pub speaker: usize,
}

impl Turn {
    /// 길이(샘플).
    pub fn len(&self) -> usize {
        self.end.saturating_sub(self.start)
    }

    /// 빈 구간인가.
    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}

/// 화자 나누기·목소리 특징이 실패한 까닭.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpeakerError {
    /// 모델 파일이 없다.
    #[error("speaker model not found at {0}")]
    MissingModel(String),
    /// sherpa-onnx 가 설정을 받지 않았다.
    #[error("sherpa-onnx could not create the {0}")]
    CreateFailed(&'static str),
    /// sherpa-onnx 가 소리를 처리하지 못했다.
    #[error("sherpa-onnx could not {0}")]
    ProcessFailed(&'static str),
}

/// 목소리 특징을 낸 모델(이름과 sha256). 모델이 다르면 특징끼리 견줄 수 없다.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModelId {
    /// 모델 파일 이름.
    pub name: String,
    /// 모델 파일 sha256.
    pub sha256: String,
}

impl From<&ModelFile> for ModelId {
    fn from(model: &ModelFile) -> Self {
        Self {
            name: model.file.to_string(),
            sha256: model.sha256.to_string(),
        }
    }
}

/// 한 트랙 안에서 누가 언제 말했나.
pub trait TrackDiarizer: Send + Sync {
    /// 16kHz 소리 → 화자 구간(순서 상관없음, 겹칠 수 있음).
    fn diarize(&self, pcm_16k: &[f32]) -> Result<Vec<Turn>, SpeakerError>;
    /// 보고에 남길 설정(모델·문턱). 소리·글은 들어가지 않는다.
    fn describe(&self) -> String;
}

/// 소리 한 토막의 목소리 특징.
pub trait VoiceEmbedder: Send + Sync {
    /// 특징을 낸 모델.
    fn model(&self) -> ModelId;
    /// L2 정규화한 특징. 너무 짧아 못 내면 `None`.
    fn embed(&self, pcm_16k: &[f32]) -> Result<Option<Vec<f32>>, SpeakerError>;
}

/// sherpa-onnx 화자 나누기 설정.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DiarizerSettings {
    /// 군집 문턱. 클수록 화자를 적게 나눈다(sherpa-onnx `FastClusteringConfig::threshold`).
    /// 기본값은 `docs/huddle-minutes-worker.md` 의 잰 표로 정했다.
    pub threshold: f32,
    /// 이보다 짧은 말 구간은 버린다(초).
    pub min_duration_on: f32,
    /// 이보다 짧은 쉼은 메운다(초).
    pub min_duration_off: f32,
    /// ONNX 스레드 수.
    pub num_threads: i32,
}

impl Default for DiarizerSettings {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_CLUSTER_THRESHOLD,
            min_duration_on: 0.3,
            min_duration_off: 0.5,
            num_threads: 1,
        }
    }
}

/// 군집 문턱 기본값. Zeroth train(cal) 회의실 회의에서 0.6·0.75·0.9·1.05 를 잰 결과 두 3D-Speaker
/// 모델 모두 0.9 에서 화자 혼동이 가장 적었다(문서 "잰 값" 표). 0.5(sherpa-onnx 기본)는 2명을 6묶음으로 쪼갰다.
pub const DEFAULT_CLUSTER_THRESHOLD: f32 = 0.9;

/// sherpa-onnx `OfflineSpeakerDiarization`.
pub struct SherpaDiarizer {
    inner: OfflineSpeakerDiarization,
    describe: String,
}

impl SherpaDiarizer {
    /// 분할 모델과 목소리 특징 모델로 만든다.
    pub fn new(
        segmentation: &Path,
        embedding: &Path,
        settings: DiarizerSettings,
    ) -> Result<Self, SpeakerError> {
        for path in [segmentation, embedding] {
            if !path.is_file() {
                return Err(SpeakerError::MissingModel(path.display().to_string()));
            }
        }
        let config = OfflineSpeakerDiarizationConfig {
            segmentation: OfflineSpeakerSegmentationModelConfig {
                pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                    model: Some(segmentation.display().to_string()),
                },
                num_threads: settings.num_threads,
                debug: false,
                provider: Some("cpu".into()),
            },
            embedding: SpeakerEmbeddingExtractorConfig {
                model: Some(embedding.display().to_string()),
                num_threads: settings.num_threads,
                debug: false,
                provider: Some("cpu".into()),
            },
            clustering: FastClusteringConfig {
                num_clusters: -1,
                threshold: settings.threshold,
            },
            min_duration_on: settings.min_duration_on,
            min_duration_off: settings.min_duration_off,
        };
        let inner = OfflineSpeakerDiarization::create(&config)
            .ok_or(SpeakerError::CreateFailed("speaker diarization"))?;
        if inner.sample_rate() != VAD_SAMPLE_RATE as i32 {
            return Err(SpeakerError::CreateFailed("16 kHz speaker diarization"));
        }
        let name = |path: &Path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        Ok(Self {
            inner,
            describe: format!(
                "sherpa-onnx diarization: segmentation={} embedding={} threshold={} on={} off={}",
                name(segmentation),
                name(embedding),
                settings.threshold,
                settings.min_duration_on,
                settings.min_duration_off
            ),
        })
    }
}

impl TrackDiarizer for SherpaDiarizer {
    fn diarize(&self, pcm_16k: &[f32]) -> Result<Vec<Turn>, SpeakerError> {
        if pcm_16k.is_empty() {
            return Ok(Vec::new());
        }
        let result = self
            .inner
            .process(pcm_16k)
            .ok_or(SpeakerError::ProcessFailed("diarize a track"))?;
        let to_samples = |s: f32| (s.max(0.0) * VAD_SAMPLE_RATE as f32).round() as usize;
        Ok(result
            .sort_by_start_time()
            .into_iter()
            .filter_map(|segment| {
                let turn = Turn {
                    start: to_samples(segment.start).min(pcm_16k.len()),
                    end: to_samples(segment.end).min(pcm_16k.len()),
                    speaker: usize::try_from(segment.speaker).ok()?,
                };
                (!turn.is_empty()).then_some(turn)
            })
            .collect())
    }

    fn describe(&self) -> String {
        self.describe.clone()
    }
}

/// sherpa-onnx `SpeakerEmbeddingExtractor`.
pub struct SherpaEmbedder {
    inner: SpeakerEmbeddingExtractor,
    model: ModelId,
}

impl SherpaEmbedder {
    /// `path` 의 모델(`model` 이 그 이름과 sha256)로 만든다.
    pub fn new(path: &Path, model: ModelId, num_threads: i32) -> Result<Self, SpeakerError> {
        if !path.is_file() {
            return Err(SpeakerError::MissingModel(path.display().to_string()));
        }
        let inner = SpeakerEmbeddingExtractor::create(&SpeakerEmbeddingExtractorConfig {
            model: Some(path.display().to_string()),
            num_threads,
            debug: false,
            provider: Some("cpu".into()),
        })
        .ok_or(SpeakerError::CreateFailed("speaker embedding extractor"))?;
        Ok(Self { inner, model })
    }
}

impl VoiceEmbedder for SherpaEmbedder {
    fn model(&self) -> ModelId {
        self.model.clone()
    }

    fn embed(&self, pcm_16k: &[f32]) -> Result<Option<Vec<f32>>, SpeakerError> {
        let stream = self
            .inner
            .create_stream()
            .ok_or(SpeakerError::ProcessFailed("open an embedding stream"))?;
        stream.accept_waveform(VAD_SAMPLE_RATE as i32, pcm_16k);
        stream.input_finished();
        if !self.inner.is_ready(&stream) {
            return Ok(None);
        }
        let embedding = self
            .inner
            .compute(&stream)
            .ok_or(SpeakerError::ProcessFailed("compute an embedding"))?;
        Ok(normalized(embedding))
    }
}

/// L2 정규화. 길이가 0 이거나 숫자가 아니면 `None`.
pub fn normalized(mut v: Vec<f32>) -> Option<Vec<f32>> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= 0.0 {
        return None;
    }
    for x in &mut v {
        *x /= norm;
    }
    Some(v)
}

/// 코사인 유사도. 길이가 다르면 0.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na <= 0.0 || nb <= 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// 무게를 단 평균을 정규화한 것. 모두 같은 길이여야 한다.
pub fn weighted_mean(items: &[(Vec<f32>, f32)]) -> Option<Vec<f32>> {
    let dim = items.first()?.0.len();
    let mut sum = vec![0f32; dim];
    for (v, w) in items {
        if v.len() != dim {
            return None;
        }
        for (s, x) in sum.iter_mut().zip(v) {
            *s += x * w;
        }
    }
    normalized(sum)
}

/// 말만 이어 붙인 소리와, 그 위치를 트랙 위치로 되돌리는 표.
#[derive(Debug, Clone, PartialEq)]
pub struct Squeezed {
    /// 이어 붙인 소리(구간 사이에 짧은 무음).
    pub pcm: Vec<f32>,
    /// `(이어 붙인 소리에서의 시작, 트랙에서의 시작, 길이)`.
    parts: Vec<(usize, usize, usize)>,
}

impl Squeezed {
    /// 이어 붙인 소리의 `[start, end)` 를 트랙 위의 구간들로(무음 틈은 빠진다).
    pub fn to_track(&self, start: usize, end: usize) -> Vec<(usize, usize)> {
        self.parts
            .iter()
            .filter_map(|&(at, track, len)| {
                let a = start.max(at);
                let b = end.min(at + len);
                (a < b).then(|| (track + (a - at), track + (b - at)))
            })
            .collect()
    }

    /// 트랙 구간들로 되돌린 화자 구간.
    pub fn turns_to_track(&self, turns: &[Turn]) -> Vec<Turn> {
        turns
            .iter()
            .flat_map(|turn| {
                self.to_track(turn.start, turn.end)
                    .into_iter()
                    .map(move |(start, end)| Turn {
                        start,
                        end,
                        speaker: turn.speaker,
                    })
            })
            .collect()
    }
}

/// `spans`(트랙 샘플 위치, 겹쳐도 됨)의 소리만 `gap` 샘플 무음을 사이에 두고 이어 붙인다.
pub fn squeeze(pcm: &[f32], spans: &[SpeechSpan], gap: usize) -> Squeezed {
    let mut sorted: Vec<SpeechSpan> = spans
        .iter()
        .map(|s| SpeechSpan {
            start: s.start.min(pcm.len()),
            end: s.end.min(pcm.len()),
        })
        .filter(|s| !s.is_empty())
        .collect();
    sorted.sort_by_key(|s| s.start);
    let mut merged: Vec<SpeechSpan> = Vec::with_capacity(sorted.len());
    for span in sorted {
        match merged.last_mut() {
            Some(last) if span.start <= last.end + gap => last.end = last.end.max(span.end),
            _ => merged.push(span),
        }
    }
    let mut out = Vec::new();
    let mut parts = Vec::with_capacity(merged.len());
    for span in merged {
        if !out.is_empty() {
            out.extend(std::iter::repeat_n(0.0, gap));
        }
        parts.push((out.len(), span.start, span.len()));
        out.extend_from_slice(&pcm[span.start..span.end]);
    }
    Squeezed { pcm: out, parts }
}

/// 덩어리를 자르는 규칙.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CutSettings {
    /// 덩어리 안에서 이보다 짧게 끼어든 화자는 이웃에 붙인다(ms). 한두 음절만 따로
    /// 받아쓰기에 보내지 않으려고.
    pub min_run_ms: u64,
    /// 자르는 자리를 이 거리 안에서 가장 조용한 10ms 로 옮긴다(ms). 말 한가운데를 덜 자른다.
    pub snap_ms: u64,
}

impl Default for CutSettings {
    fn default() -> Self {
        Self {
            min_run_ms: 800,
            snap_ms: 200,
        }
    }
}

/// 화자가 붙은 받아쓰기 덩어리.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpeakerPiece {
    /// 덩어리(말 시각과 보내는 소리).
    pub piece: Piece,
    /// 트랙 안 화자 번호. 화자 구간이 하나도 없으면 `None`.
    pub speaker: Option<usize>,
    /// 이 덩어리 말 시간 가운데 화자 나누기가 이 화자에게 준 몫(0~1).
    pub share: f32,
}

/// 덩어리마다 10ms 칸에 화자를 매기고, 화자가 바뀌는 자리에서 자른다.
///
/// - 칸의 화자 = 그 칸을 가장 많이 덮는 화자 구간의 화자. 덮는 구간이 없으면 앞(없으면 뒤) 칸을 따른다.
/// - [`CutSettings::min_run_ms`] 보다 짧은 화자 토막은 이웃에 붙인다(가장 짧은 것부터).
/// - 자르는 자리는 [`CutSettings::snap_ms`] 안에서 가장 조용한 칸으로 옮긴다.
/// - 처음·끝 조각은 원래 덩어리의 여유(앞뒤 소리)를 그대로 갖고, 자른 자리에는 여유를 붙이지
///   않는다(다른 사람 말이 섞여 들어가지 않게).
///
/// 덩어리 하나에 화자가 하나뿐이면 덩어리는 그대로다(받아쓰기 장부 열쇠도 그대로).
pub fn cut_pieces(
    pieces: &[Piece],
    turns: &[Turn],
    pcm: &[f32],
    settings: &CutSettings,
) -> Vec<SpeakerPiece> {
    let ms_to_frames = |ms: u64| usize::try_from(ms / 10).unwrap_or(usize::MAX);
    let min_run = ms_to_frames(settings.min_run_ms).max(1);
    let snap = ms_to_frames(settings.snap_ms);
    let speakers = turns.iter().map(|t| t.speaker + 1).max().unwrap_or(0);
    let mut out = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let (s, e) = (piece.speech.start, piece.speech.end);
        if e <= s {
            continue;
        }
        let frames = (e - s).div_ceil(FRAME);
        // cover[f * speakers + k]: samples of frame f that speaker k's turns cover.
        let mut cover = vec![0usize; frames * speakers];
        for turn in turns.iter().filter(|t| t.start < e && s < t.end) {
            let a = turn.start.max(s) - s;
            let b = turn.end.min(e) - s;
            let mut f = a / FRAME;
            while f * FRAME < b {
                let from = (f * FRAME).max(a);
                let to = ((f + 1) * FRAME).min(b);
                cover[f * speakers + turn.speaker] += to - from;
                f += 1;
            }
        }
        let mut raw: Vec<Option<usize>> = Vec::with_capacity(frames);
        for f in 0..frames {
            if speakers == 0 {
                raw.push(None);
                continue;
            }
            let row = &cover[f * speakers..(f + 1) * speakers];
            let best = row.iter().copied().max().unwrap_or(0);
            if best == 0 {
                raw.push(None);
                continue;
            }
            // A tie keeps the speaker of the frame before.
            let previous = raw.last().copied().flatten();
            let pick = match previous {
                Some(p) if row.get(p) == Some(&best) => p,
                _ => row.iter().position(|&c| c == best).unwrap_or(0),
            };
            raw.push(Some(pick));
        }
        let Some(fallback) = raw.iter().flatten().next().copied().or_else(|| {
            // No turn inside the piece: the turn nearest to it.
            let middle = (s + e) / 2;
            turns
                .iter()
                .min_by_key(|t| {
                    if middle < t.start {
                        t.start - middle
                    } else {
                        middle.saturating_sub(t.end)
                    }
                })
                .map(|t| t.speaker)
        }) else {
            out.push(SpeakerPiece {
                piece: *piece,
                speaker: None,
                share: 0.0,
            });
            continue;
        };
        let mut filled = Vec::with_capacity(frames);
        let mut last = fallback;
        for label in &raw {
            if let Some(label) = label {
                last = *label;
            }
            filled.push(last);
        }
        // Runs: (speaker, first frame, one past the last frame).
        let mut runs: Vec<(usize, usize, usize)> = Vec::new();
        for (f, &label) in filled.iter().enumerate() {
            match runs.last_mut() {
                Some(run) if run.0 == label => run.2 = f + 1,
                _ => runs.push((label, f, f + 1)),
            }
        }
        // Fold short runs into a neighbour, shortest first.
        while runs.len() > 1 {
            let Some((i, run)) = runs
                .iter()
                .enumerate()
                .filter(|(_, r)| r.2 - r.1 < min_run)
                .min_by_key(|(_, r)| r.2 - r.1)
                .map(|(i, r)| (i, *r))
            else {
                break;
            };
            let before = i.checked_sub(1).map(|j| runs[j]);
            let after = runs.get(i + 1).copied();
            match (before, after) {
                (Some(b), Some(a)) if b.0 == a.0 => {
                    runs[i - 1].2 = a.2;
                    runs.drain(i..=i + 1);
                }
                (Some(b), Some(a)) if b.2 - b.1 >= a.2 - a.1 => {
                    runs[i - 1].2 = run.2;
                    runs.remove(i);
                }
                (_, Some(_)) => {
                    runs[i + 1].1 = run.1;
                    runs.remove(i);
                }
                (Some(_), None) => {
                    runs[i - 1].2 = run.2;
                    runs.remove(i);
                }
                (None, None) => break,
            }
        }
        // Move each cut to the quietest frame nearby.
        for i in 1..runs.len() {
            let cut = runs[i].1;
            let lo = cut.saturating_sub(snap).max(runs[i - 1].1 + 1);
            let hi = (cut + snap).min(runs[i].2.saturating_sub(1));
            if lo >= hi {
                continue;
            }
            let energy = |f: usize| -> f32 {
                let a = (s + f * FRAME).min(pcm.len());
                let b = (s + (f + 1) * FRAME).min(pcm.len());
                pcm[a..b].iter().map(|x| x * x).sum()
            };
            let best = (lo..=hi)
                .min_by(|&x, &y| {
                    energy(x)
                        .partial_cmp(&energy(y))
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(x.abs_diff(cut).cmp(&y.abs_diff(cut)))
                })
                .unwrap_or(cut);
            runs[i - 1].2 = best;
            runs[i].1 = best;
        }
        let count = runs.len();
        for (i, &(label, from, to)) in runs.iter().enumerate() {
            let start = if i == 0 { s } else { s + from * FRAME };
            let end = if i + 1 == count {
                e
            } else {
                (s + to * FRAME).min(e)
            };
            let own = raw[from..to].iter().filter(|r| **r == Some(label)).count();
            let speech = SpeechSpan { start, end };
            let audio = SpeechSpan {
                start: if i == 0 { piece.audio.start } else { start },
                end: if i + 1 == count { piece.audio.end } else { end },
            };
            out.push(SpeakerPiece {
                piece: Piece { speech, audio },
                speaker: Some(label),
                share: own as f32 / (to - from).max(1) as f32,
            });
        }
    }
    out
}

/// 화자 묶음마다 평균 목소리 특징(긴 구간부터 `max_samples` 까지)을 내고, 평균끼리
/// 코사인이 `threshold` 이상인 두 묶음을 하나로 합친다(가장 닮은 짝부터, 말 길이로 무게 단
/// 평균을 다시 내며). 돌려주는 값: 번호를 0 부터 다시 매긴 구간, 합친 횟수, 합치기 전 묶음끼리
/// 코사인 `(a, b, 유사도)`(진단용, 숫자만).
pub fn merge_similar(
    turns: &[Turn],
    pcm: &[f32],
    embedder: &dyn VoiceEmbedder,
    threshold: f32,
    min_turn: usize,
    max_samples: usize,
) -> Result<MergeResult, SpeakerError> {
    let speakers = turns.iter().map(|t| t.speaker + 1).max().unwrap_or(0);
    // (centroid, weight) per speaker; a speaker without one is never merged.
    let mut groups: Vec<Option<(Vec<f32>, f32)>> = Vec::with_capacity(speakers);
    for speaker in 0..speakers {
        let mut own: Vec<&Turn> = turns
            .iter()
            .filter(|t| t.speaker == speaker && t.len() >= min_turn)
            .collect();
        own.sort_by_key(|t| std::cmp::Reverse(t.len()));
        let mut items = Vec::new();
        let mut used = 0;
        for turn in own {
            if used >= max_samples {
                break;
            }
            let end = turn.end.min(pcm.len());
            if turn.start >= end {
                continue;
            }
            if let Some(e) = embedder.embed(&pcm[turn.start..end])? {
                used += end - turn.start;
                items.push((e, (end - turn.start) as f32));
            }
        }
        groups.push(weighted_mean(&items).map(|mean| (mean, used as f32)));
    }
    // Pairs reported by each cluster's rank in order of first speech (the
    // order "회의실 화자 N" is numbered in when nothing is merged).
    let mut firsts: Vec<(usize, usize)> = (0..speakers)
        .map(|k| {
            let first = turns
                .iter()
                .filter(|t| t.speaker == k)
                .map(|t| t.start)
                .min()
                .unwrap_or(usize::MAX);
            (first, k)
        })
        .collect();
    firsts.sort_unstable();
    let rank = |k: usize| firsts.iter().position(|&(_, x)| x == k).unwrap_or(k);
    let mut similarities = Vec::new();
    for a in 0..speakers {
        for b in a + 1..speakers {
            if let (Some((ea, _)), Some((eb, _))) = (&groups[a], &groups[b]) {
                let (ra, rb) = (rank(a).min(rank(b)), rank(a).max(rank(b)));
                similarities.push((ra, rb, cosine(ea, eb)));
            }
        }
    }
    similarities.sort_by_key(|&(a, b, _)| (a, b));
    // label[k]: which group speaker k ended up in.
    let mut label: Vec<usize> = (0..speakers).collect();
    let mut merged = 0;
    loop {
        let mut best: Option<(usize, usize, f32)> = None;
        for a in 0..speakers {
            for b in a + 1..speakers {
                let (Some((ea, _)), Some((eb, _))) = (&groups[a], &groups[b]) else {
                    continue;
                };
                let s = cosine(ea, eb);
                if s >= threshold && best.is_none_or(|(_, _, x)| s > x) {
                    best = Some((a, b, s));
                }
            }
        }
        let Some((a, b, _)) = best else {
            break;
        };
        let (Some((ea, wa)), Some((eb, wb))) = (groups[a].take(), groups[b].take()) else {
            break;
        };
        groups[a] = weighted_mean(&[(ea, wa), (eb, wb)]).map(|m| (m, wa + wb));
        for l in &mut label {
            if *l == b {
                *l = a;
            }
        }
        merged += 1;
    }
    // Number the surviving groups 0.. in order of first speech.
    let mut order: Vec<usize> = Vec::new();
    let mut sorted: Vec<&Turn> = turns.iter().collect();
    sorted.sort_by_key(|t| t.start);
    for t in sorted {
        let g = label[t.speaker];
        if !order.contains(&g) {
            order.push(g);
        }
    }
    let out = turns
        .iter()
        .map(|t| Turn {
            speaker: order
                .iter()
                .position(|&g| g == label[t.speaker])
                .unwrap_or(0),
            ..*t
        })
        .collect();
    Ok((out, merged, similarities))
}

/// [`merge_similar`] 결과: 다시 매긴 구간, 합친 횟수, 합치기 전 묶음끼리 코사인.
pub type MergeResult = (Vec<Turn>, usize, Vec<(usize, usize, f32)>);

/// 화자마다 말한 시간(샘플). 겹친 곳은 두 화자 모두에게 센다.
pub fn speech_per_speaker(turns: &[Turn]) -> Vec<usize> {
    let speakers = turns.iter().map(|t| t.speaker + 1).max().unwrap_or(0);
    let mut total = vec![0usize; speakers];
    for turn in turns {
        total[turn.speaker] += turn.len();
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn piece(start: usize, end: usize, pad: usize) -> Piece {
        Piece {
            speech: SpeechSpan { start, end },
            audio: SpeechSpan {
                start: start.saturating_sub(pad),
                end: end + pad,
            },
        }
    }

    fn turn(start_ms: usize, end_ms: usize, speaker: usize) -> Turn {
        Turn {
            start: start_ms * 16,
            end: end_ms * 16,
            speaker,
        }
    }

    fn ms(samples: usize) -> usize {
        samples / 16
    }

    #[test]
    fn one_speaker_leaves_the_piece_as_it_is() {
        let pcm = vec![0.1; 16 * 10_000];
        let p = piece(16 * 1_000, 16 * 5_000, 16 * 200);
        let cut = cut_pieces(&[p], &[turn(900, 5_100, 0)], &pcm, &CutSettings::default());
        assert_eq!(cut.len(), 1);
        assert_eq!(cut[0].piece, p);
        assert_eq!(cut[0].speaker, Some(0));
        assert!((cut[0].share - 1.0).abs() < 1e-6);
    }

    #[test]
    fn a_change_of_speaker_cuts_the_piece_without_padding_at_the_cut() {
        // Speaker 0 1.0–3.0 s, speaker 1 3.0–6.0 s, quiet frame at 3.1 s.
        let mut pcm = vec![0.1f32; 16 * 10_000];
        for x in &mut pcm[16 * 3_100..16 * 3_110] {
            *x = 0.0;
        }
        let p = piece(16 * 1_000, 16 * 6_000, 16 * 200);
        let cut = cut_pieces(
            &[p],
            &[turn(1_000, 3_000, 0), turn(3_000, 6_000, 1)],
            &pcm,
            &CutSettings::default(),
        );
        assert_eq!(cut.len(), 2, "{cut:#?}");
        assert_eq!(cut[0].speaker, Some(0));
        assert_eq!(cut[1].speaker, Some(1));
        // The cut moved to the quiet frame.
        assert_eq!(ms(cut[0].piece.speech.end), 3_100);
        assert_eq!(cut[1].piece.speech.start, cut[0].piece.speech.end);
        // Outer padding kept, none at the cut.
        assert_eq!(cut[0].piece.audio.start, p.audio.start);
        assert_eq!(cut[0].piece.audio.end, cut[0].piece.speech.end);
        assert_eq!(cut[1].piece.audio.start, cut[1].piece.speech.start);
        assert_eq!(cut[1].piece.audio.end, p.audio.end);
    }

    #[test]
    fn a_short_interjection_is_folded_into_its_neighbours() {
        let pcm = vec![0.1f32; 16 * 10_000];
        let p = piece(0, 16 * 6_000, 0);
        let cut = cut_pieces(
            &[p],
            &[
                turn(0, 3_000, 0),
                turn(3_000, 3_400, 1),
                turn(3_400, 6_000, 0),
            ],
            &pcm,
            &CutSettings::default(),
        );
        assert_eq!(cut.len(), 1);
        assert_eq!(cut[0].speaker, Some(0));
        // 400 ms of 6 000 went to someone else.
        assert!(
            (cut[0].share - 5_600.0 / 6_000.0).abs() < 0.01,
            "{}",
            cut[0].share
        );
    }

    #[test]
    fn gaps_between_turns_follow_the_speaker_before() {
        let pcm = vec![0.1f32; 16 * 10_000];
        let p = piece(0, 16 * 6_000, 0);
        let cut = cut_pieces(
            &[p],
            &[turn(0, 2_000, 1), turn(3_000, 6_000, 0)],
            &pcm,
            &CutSettings {
                min_run_ms: 800,
                snap_ms: 0,
            },
        );
        assert_eq!(cut.len(), 2);
        assert_eq!(ms(cut[0].piece.speech.end), 3_000);
        assert_eq!(cut[0].speaker, Some(1));
        assert!((cut[0].share - 2.0 / 3.0).abs() < 0.01);
    }

    #[test]
    fn a_piece_without_turns_takes_the_nearest_speaker() {
        let pcm = vec![0.1f32; 16 * 10_000];
        let cut = cut_pieces(
            &[piece(16 * 5_000, 16 * 6_000, 0)],
            &[turn(0, 1_000, 0), turn(6_500, 7_000, 1)],
            &pcm,
            &CutSettings::default(),
        );
        assert_eq!(cut[0].speaker, Some(1));
        assert_eq!(cut[0].share, 0.0);
        let none = cut_pieces(&[piece(0, 16_000, 0)], &[], &pcm, &CutSettings::default());
        assert_eq!(none[0].speaker, None);
    }

    #[test]
    fn squeezed_turns_map_back_onto_the_track() {
        let pcm: Vec<f32> = (0..1_000).map(|i| i as f32).collect();
        let spans = [
            SpeechSpan {
                start: 100,
                end: 200,
            },
            SpeechSpan {
                start: 150,
                end: 250,
            },
            SpeechSpan {
                start: 600,
                end: 700,
            },
        ];
        let squeezed = squeeze(&pcm, &spans, 10);
        // [100, 250) then 10 zeros then [600, 700).
        assert_eq!(squeezed.pcm.len(), 150 + 10 + 100);
        assert_eq!(squeezed.pcm[0], 100.0);
        assert_eq!(squeezed.pcm[150], 0.0);
        assert_eq!(squeezed.pcm[160], 600.0);
        assert_eq!(squeezed.to_track(140, 170), [(240, 250), (600, 610)]);
        let turns = squeezed.turns_to_track(&[Turn {
            start: 0,
            end: 260,
            speaker: 2,
        }]);
        assert_eq!(
            turns,
            [
                Turn {
                    start: 100,
                    end: 250,
                    speaker: 2
                },
                Turn {
                    start: 600,
                    end: 700,
                    speaker: 2
                }
            ]
        );
    }

    /// Test double: the voice is the sign of the audio.
    struct SignEmbedder;

    impl VoiceEmbedder for SignEmbedder {
        fn model(&self) -> ModelId {
            ModelId {
                name: "sign".into(),
                sha256: String::new(),
            }
        }

        fn embed(&self, pcm: &[f32]) -> Result<Option<Vec<f32>>, SpeakerError> {
            let mean = pcm.iter().sum::<f32>() / pcm.len().max(1) as f32;
            Ok(normalized(vec![mean.max(0.0), (-mean).max(0.0)]))
        }
    }

    #[test]
    fn clusters_with_the_same_voice_are_merged_and_renumbered() {
        // Speakers 2 and 0 have the same voice (+), speaker 1 another (-).
        let mut pcm = vec![1.0f32; 3_000];
        pcm[1_000..2_000].iter_mut().for_each(|x| *x = -1.0);
        let turns = [
            Turn {
                start: 0,
                end: 1_000,
                speaker: 2,
            },
            Turn {
                start: 1_000,
                end: 2_000,
                speaker: 1,
            },
            Turn {
                start: 2_000,
                end: 3_000,
                speaker: 0,
            },
        ];
        let (merged, count, similar) =
            merge_similar(&turns, &pcm, &SignEmbedder, 0.9, 100, 10_000).unwrap();
        assert_eq!(count, 1);
        assert_eq!(similar.len(), 3, "every pair is reported");
        let speakers: Vec<usize> = merged.iter().map(|t| t.speaker).collect();
        assert_eq!(speakers, [0, 1, 0], "renumbered by first speech");
        // A high threshold keeps them apart.
        let (kept, count, _) =
            merge_similar(&turns, &pcm, &SignEmbedder, 1.1, 100, 10_000).unwrap();
        assert_eq!(count, 0);
        assert_eq!(
            kept.iter().map(|t| t.speaker).collect::<Vec<_>>(),
            [0, 1, 2]
        );
    }

    #[test]
    fn cosine_and_mean() {
        assert!((cosine(&[1.0, 0.0], &[0.0, 1.0])).abs() < 1e-6);
        assert!((cosine(&[1.0, 1.0], &[2.0, 2.0]) - 1.0).abs() < 1e-6);
        let mean = weighted_mean(&[(vec![1.0, 0.0], 1.0), (vec![0.0, 1.0], 1.0)]).unwrap();
        assert!((mean[0] - mean[1]).abs() < 1e-6);
        assert!(normalized(vec![0.0, 0.0]).is_none());
    }
}
