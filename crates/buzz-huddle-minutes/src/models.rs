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
