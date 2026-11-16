//! Model files, fetched once into a cache folder and pinned by sha256.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use sha2::{Digest, Sha256};

/// Silero VAD as published by sherpa-onnx (the same file and digest
/// scripts/huddle-stt-bench pins).
pub const SILERO_VAD_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
/// sha256 of [`SILERO_VAD_URL`].
pub const SILERO_VAD_SHA256: &str =
    "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6";
const SILERO_VAD_FILE: &str = "silero_vad.onnx";

/// Path of the Silero model inside `cache_dir` (`models/silero_vad.onnx`).
pub fn silero_vad_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("models").join(SILERO_VAD_FILE)
}

/// Make sure the Silero model is in `cache_dir` with the pinned digest,
/// downloading it if it is missing or different.
pub async fn ensure_silero_vad(cache_dir: &Path) -> anyhow::Result<PathBuf> {
    let path = silero_vad_path(cache_dir);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        if sha256_hex(&bytes) == SILERO_VAD_SHA256 {
            return Ok(path);
        }
    }
    let bytes = reqwest::get(SILERO_VAD_URL)
        .await
        .and_then(reqwest::Response::error_for_status)
        .context("download silero_vad.onnx")?
        .bytes()
        .await
        .context("download silero_vad.onnx")?;
    let digest = sha256_hex(&bytes);
    if digest != SILERO_VAD_SHA256 {
        bail!("silero_vad.onnx sha256 is {digest}, expected {SILERO_VAD_SHA256}");
    }
    let parent = path.parent().context("model path has no folder")?;
    tokio::fs::create_dir_all(parent).await?;
    let partial = path.with_extension("partial");
    tokio::fs::write(&partial, &bytes).await?;
    tokio::fs::rename(&partial, &path).await?;
    Ok(path)
}

/// Lower-case hex sha256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// 받는 주소와 sha256 을 고정한 모델 파일 하나. `cache/models/<file>` 에 둔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelFile {
    /// 캐시 안 파일 이름.
    pub file: &'static str,
    /// 받는 주소(바뀌지 않는 주소: 배포 태그 또는 커밋 고정).
    pub url: &'static str,
    /// 파일의 sha256.
    pub sha256: &'static str,
    /// 라이선스(보고·문서용).
    pub license: &'static str,
}

/// 화자 분할 모델: pyannote segmentation-3.0 을 sherpa-onnx 가 ONNX 로 바꾼 것
/// (Hugging Face `csukuangfj/sherpa-onnx-pyannote-segmentation-3-0`, 커밋 고정).
/// 원본 `pyannote/segmentation-3.0` 은 MIT.
pub const SPEAKER_SEGMENTATION: ModelFile = ModelFile {
    file: "pyannote-segmentation-3-0.onnx",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx",
    sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    license: "MIT (pyannote/segmentation-3.0)",
};

/// 목소리 특징 모델 후보(sherpa-onnx 배포 목록 `speaker-recongition-models`).
/// sha256 은 그 배포의 `checksum.txt` 와 같다. 고른 것은 [`SPEAKER_EMBEDDING`].
pub const SPEAKER_EMBEDDING_CANDIDATES: [ModelFile; 8] = [
    ModelFile {
        file: "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/",
            "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
        ),
        sha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
        license: "Apache-2.0 (3D-Speaker)",
    },
    ModelFile {
        file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/",
            "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
        ),
        sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
        license: "Apache-2.0 (3D-Speaker)",
    },
    ModelFile {
        file: "wespeaker_en_voxceleb_resnet34_LM.onnx",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/",
            "wespeaker_en_voxceleb_resnet34_LM.onnx"
        ),
        sha256: "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012",
        license: "CC-BY-4.0 (WeSpeaker, VoxCeleb)",
    },
    ModelFile {
        file: "nemo_en_titanet_small.onnx",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/",
            "nemo_en_titanet_small.onnx"
        ),
        sha256: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
        license: "Apache-2.0 (NGC nvidia/nemo 모델 카드: NeMo 툴킷 라이선스를 따름)",
    },
    ModelFile {
        file: "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/",
            "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"
        ),
        sha256: "bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239",
        license: "Apache-2.0 (3D-Speaker)",
    },
    ModelFile {
        file: "nemo_en_titanet_large.onnx",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/",
            "nemo_en_titanet_large.onnx"
        ),
        sha256: "d51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77",
        license: "Apache-2.0 (NGC nvidia/nemo 모델 카드: NeMo 툴킷 라이선스를 따름)",
    },
    ModelFile {
        file: "wespeaker_en_voxceleb_CAM++.onnx",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/",
            "wespeaker_en_voxceleb_CAM++.onnx"
        ),
        sha256: "c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef",
        license: "CC-BY-4.0 (WeSpeaker, VoxCeleb)",
    },
    ModelFile {
        file: "wespeaker_zh_cnceleb_resnet34.onnx",
        url: concat!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/",
            "wespeaker_zh_cnceleb_resnet34.onnx"
        ),
        sha256: "f86cd6c509f331f0e20b07bd48d1b2eb7de54202643401c4e84695ac861a0e5a",
        license: "CN-Celeb 데이터 라이선스(CC BY-SA 4.0) (WeSpeaker)",
    },
];

/// 쓰기로 고른 목소리 특징 모델: eres2net base(3D-Speaker). Zeroth train(cal) 회의실 회의에서 화자 혼동이
/// 가장 적었다(0.070, 1인 트랙 쪼갬 0, 한 명으로 뭉침 0). titanet small 은 실제 허들 줄 짝 EER 이 더 낮았지만
/// (21.7% vs 38.6%, 22줄뿐) cal 에서 어떤 군집·합치기 조합도 짧은 회의 혼동 0.120(eres2net 0.070), 긴 회의
/// 0.085(eres2net 0.034) 아래로 못 내려갔고, 짧은 회의에서 회의실 트랙을 한 명으로 뭉친 회의가 늘 1개 이상 있어서
/// 후보로만 둔다. 표는 `docs/huddle-minutes-worker.md`.
pub const SPEAKER_EMBEDDING: ModelFile = SPEAKER_EMBEDDING_CANDIDATES[0];

/// 후보 이름으로 찾는다.
pub fn embedding_candidate(file: &str) -> Option<ModelFile> {
    SPEAKER_EMBEDDING_CANDIDATES
        .iter()
        .copied()
        .find(|model| model.file == file)
}

/// `cache_dir` 안의 모델 경로(`models/<file>`).
pub fn model_path(cache_dir: &Path, model: &ModelFile) -> PathBuf {
    cache_dir.join("models").join(model.file)
}

/// 캐시에 있는 모델 파일이 고정한 sha256 과 같은지 본다. 다르면 쓰지 않는다.
pub fn verify_model(cache_dir: &Path, model: &ModelFile) -> anyhow::Result<PathBuf> {
    let path = model_path(cache_dir, model);
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let digest = sha256_hex(&bytes);
    if digest != model.sha256 {
        bail!(
            "{} has sha256 {digest}, expected {}; run `buzz-huddle-minutes fetch-models`",
            path.display(),
            model.sha256
        );
    }
    Ok(path)
}

/// 모델이 캐시에 고정한 sha256 으로 있게 한다. 없거나 다르면 받는다.
pub async fn ensure_model(cache_dir: &Path, model: &ModelFile) -> anyhow::Result<PathBuf> {
    let path = model_path(cache_dir, model);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        if sha256_hex(&bytes) == model.sha256 {
            return Ok(path);
        }
    }
    let bytes = reqwest::get(model.url)
        .await
        .and_then(reqwest::Response::error_for_status)
        .with_context(|| format!("download {}", model.file))?
        .bytes()
        .await
        .with_context(|| format!("download {}", model.file))?;
    let digest = sha256_hex(&bytes);
    if digest != model.sha256 {
        bail!(
            "{} sha256 is {digest}, expected {}",
            model.file,
            model.sha256
        );
    }
    let parent = path.parent().context("model path has no folder")?;
    tokio::fs::create_dir_all(parent).await?;
    let partial = path.with_extension("partial");
    tokio::fs::write(&partial, &bytes).await?;
    tokio::fs::rename(&partial, &path).await?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMBEDDING_RELEASE: &str =
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/";

    #[test]
    fn candidate_urls_are_the_pinned_release() {
        for model in SPEAKER_EMBEDDING_CANDIDATES {
            assert_eq!(model.url, format!("{EMBEDDING_RELEASE}{}", model.file));
            assert_eq!(model.sha256.len(), 64);
        }
        assert!(embedding_candidate(SPEAKER_EMBEDDING.file).is_some());
        assert_eq!(
            SPEAKER_EMBEDDING.file,
            "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
        );
    }
}
