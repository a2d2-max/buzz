"""모델과 FLEURS 한국어 시험 데이터 받기.

- 디스크를 아끼려고 아카이브는 저장하지 않고 받으면서 바로 푼다. 받은 것은 전부 .cache/ 아래에 둔다.
- 받은 것은 아래에 박아 둔 sha256 과 맞을 때만 쓴다. 임시 폴더에 받거나 풀고, 해시가 맞으면 제자리로 옮긴다.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import sys
import tarfile
from pathlib import Path

import requests
import soundfile as sf

RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"

# 이름 → (풀린 폴더 이름, 아카이브 주소, sha256)
# sha256 은 GitHub 릴리스 API(releases/tags/asr-models)의 asset digest 와 맞춰 본 값이다(2026-10-12).
MODELS = {
    "qwen3-asr": (
        "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
        f"{RELEASE}/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2",
        "393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96",
    ),
    "sense-voice": (
        "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
        f"{RELEASE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
        "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
    ),
}
SILERO_VAD_URL = f"{RELEASE}/silero_vad.onnx"
SILERO_VAD_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"

FLEURS_BASE = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/ko_kr"
# 오디오 아카이브: Hugging Face LFS 가 알려 준 sha256.
FLEURS_AUDIO_SHA256 = {
    "test": "3489e529f2aad18d3357b746c5f955941d258b79dc60d8a102d5bced2a223184",
    "dev": "496edcb5323e75b4a2830f5b5623684a0baf86d3728101853fd4fe503372157c",
}
# 정답 TSV: Hugging Face git blob 해시(test 205651a4…, dev b3619479…)와 맞는 것을 확인한 뒤 잰 sha256.
FLEURS_TSV_SHA256 = {
    "test": "cf2f7c8765f6203e3c46ef620d5e936d3f331b6e8865455557777dd1347517f5",
    "dev": "6b236de107c6a1672233f6d710d26adfdb55570a3e6e35aca9dc4ff2be01cea4",
}
FLEURS_SOURCE = "google/fleurs ko_kr (CC-BY-4.0)"


class _HashingStream:
    """읽는 대로 sha256 을 세는 얇은 감싸개. tarfile 스트림 모드는 read() 만 쓴다."""

    def __init__(self, raw):
        self._raw = raw
        self.sha256 = hashlib.sha256()
        self.nbytes = 0

    def read(self, n: int = -1) -> bytes:
        data = self._raw.read(n)
        self.sha256.update(data)
        self.nbytes += len(data)
        return data

    def drain(self) -> None:
        while self.read(1 << 20):
            pass


def _open_stream(url: str) -> requests.Response:
    resp = requests.get(url, stream=True, timeout=60)
    resp.raise_for_status()
    resp.raw.decode_content = True
    return resp


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _fresh_dir(path: Path) -> Path:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    return path


def ensure_model(name: str, cache_dir: Path) -> Path:
    dirname, url, sha256 = MODELS[name]
    models = cache_dir / "models"
    target = models / dirname
    done = target / ".complete"
    if done.exists() and json.loads(done.read_text()).get("sha256") == sha256:
        return target
    models.mkdir(parents=True, exist_ok=True)
    tmp = _fresh_dir(models / f".tmp-{dirname}")
    _log(f"[받기] {name} 모델: {url}")
    with _open_stream(url) as resp:
        hs = _HashingStream(resp.raw)
        with tarfile.open(fileobj=hs, mode="r|bz2") as tf:
            tf.extractall(tmp, filter="data")
        hs.drain()
    digest = hs.sha256.hexdigest()
    if digest != sha256:
        shutil.rmtree(tmp)
        raise RuntimeError(f"{name} 아카이브 sha256 이 다르다: {digest} != {sha256}")
    if not (tmp / dirname).is_dir():
        shutil.rmtree(tmp)
        raise RuntimeError(f"아카이브를 풀었는데 {dirname} 폴더가 없다")
    if target.exists():  # 해시가 안 맞던 옛 폴더
        shutil.rmtree(target)
    (tmp / dirname).rename(target)
    shutil.rmtree(tmp)
    done.write_text(json.dumps({"url": url, "bytes": hs.nbytes, "sha256": digest}) + "\n")
    _log(f"[받기] {name} 끝: {hs.nbytes / 1e6:.0f}MB, sha256 일치")
    return target


def ensure_silero_vad(cache_dir: Path) -> Path:
    path = cache_dir / "models" / "silero_vad.onnx"
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == SILERO_VAD_SHA256:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    _log(f"[받기] silero VAD: {SILERO_VAD_URL}")
    resp = requests.get(SILERO_VAD_URL, timeout=60)
    resp.raise_for_status()
    digest = hashlib.sha256(resp.content).hexdigest()
    if digest != SILERO_VAD_SHA256:
        raise RuntimeError(f"silero_vad.onnx sha256 이 다르다: {digest} != {SILERO_VAD_SHA256}")
    tmp = path.with_suffix(".part")
    tmp.write_bytes(resp.content)
    tmp.rename(path)
    return path


def fetch_fleurs(out_dir: Path, n: int, split: str = "test") -> Path:
    """FLEURS 한국어에서 문장마다 녹음 하나씩, 문장 번호 순으로 n 개를 골라 manifest 를 만든다.

    정답 글은 raw_transcription(원문 표기: 숫자·괄호·영문 대소문자 그대로)을 쓴다.
    """
    audio_dir = out_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    tsv = requests.get(f"{FLEURS_BASE}/{split}.tsv", timeout=60)
    tsv.raise_for_status()
    digest = hashlib.sha256(tsv.content).hexdigest()
    if digest != FLEURS_TSV_SHA256[split]:
        raise RuntimeError(f"FLEURS {split}.tsv sha256 이 다르다: {digest} != {FLEURS_TSV_SHA256[split]}")
    rows = []
    for line in tsv.content.decode("utf-8").splitlines():
        cols = line.split("\t")
        if len(cols) < 7:
            continue
        sent_id, fname, raw_text = cols[0], cols[1], cols[2]
        if not sent_id.isdigit() or not re.fullmatch(r"\d+\.wav", fname):
            raise RuntimeError(f"FLEURS tsv 형식이 예상과 다르다: {line[:80]!r}")
        rows.append((int(sent_id), fname, raw_text))

    picked: dict[int, tuple[int, str, str]] = {}
    for row in sorted(rows):
        picked.setdefault(row[0], row)
    chosen = list(picked.values())[:n]
    wanted = {fname for _, fname, _ in chosen}

    missing = {f for f in wanted if not (audio_dir / f).exists()}
    if missing:
        url = f"{FLEURS_BASE}/audio/{split}.tar.gz"
        tmp = _fresh_dir(out_dir / ".tmp-audio")
        _log(f"[받기] FLEURS {split} 오디오(파일 {len(missing)}개 뽑기): {url}")
        with _open_stream(url) as resp:
            hs = _HashingStream(resp.raw)
            with tarfile.open(fileobj=hs, mode="r|gz") as tf:
                for member in tf:
                    base = member.name.rsplit("/", 1)[-1]
                    if member.isfile() and base in missing and not (tmp / base).exists():
                        src = io.BytesIO(tf.extractfile(member).read())
                        samples, sr = sf.read(src, dtype="float32")
                        # 원본은 32비트 float WAV 다. 원격 API 가 확실히 받는 16비트 PCM 으로 바꿔 둔다.
                        # 아카이브 안 경로는 믿지 않고, tsv 에서 검사한 이름으로만 쓴다
                        sf.write(str(tmp / base), samples.clip(-1.0, 1.0), sr, subtype="PCM_16")
            hs.drain()
        digest = hs.sha256.hexdigest()
        if digest != FLEURS_AUDIO_SHA256[split]:
            shutil.rmtree(tmp)
            raise RuntimeError(f"FLEURS 아카이브 sha256 이 다르다: {digest} != {FLEURS_AUDIO_SHA256[split]}")
        got = {p.name for p in tmp.iterdir()}
        if missing - got:
            shutil.rmtree(tmp)
            raise RuntimeError(f"아카이브에 없는 파일: {sorted(missing - got)[:5]}")
        for name in missing:
            (tmp / name).rename(audio_dir / name)
        shutil.rmtree(tmp)

    manifest = out_dir / "manifest.jsonl"
    with manifest.open("w", encoding="utf-8") as fh:
        for sent_id, fname, raw_text in chosen:
            rec = {
                "id": f"fleurs-ko-{split}-{sent_id}-{fname.removesuffix('.wav')}",
                "audio": f"audio/{fname}",
                "text": raw_text,
                "source": FLEURS_SOURCE,
            }
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    _log(f"[받기] manifest {len(chosen)}줄: {manifest}")
    return manifest
