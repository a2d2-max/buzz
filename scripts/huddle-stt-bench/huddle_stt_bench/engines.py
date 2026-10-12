"""STT 엔진 어댑터.

모든 엔진은 같은 모양이다:
- prepare() → 건너뛸 까닭(문자열) 또는 None. 인증·모델 준비, 로컬 모델 올리기.
- transcribe(audio_path) → (받아쓴 글, 결과 파일에 같이 남길 값 dict). dict 에는 늘 "pieces"(넣은 조각 수)가 있다.
- cost(duration_sec) → 그 길이 오디오 하나의 예상 비용(currency 단위).
- note → 결과 표 아래에 꼭 남길 말(없으면 빈 문자열).
- chunk_note → 긴 오디오를 조각으로 잘라 넣었을 때 결과 표 아래에 덧붙일 말.

액세스 토큰은 어떤 메시지·로그·결과 파일에도 넣지 않는다.
원격 API 가 실패하면 HTTP 상태와 오류 코드만 남긴다(본문 메시지에 계정·자원 정보가 섞여 올 수 있어서).
"""

from __future__ import annotations

import base64
import io
import math
import re
import subprocess
import threading
import time
from pathlib import Path

import google.auth
import google.auth.credentials
import google.auth.exceptions
import numpy as np
import requests
import soundfile as sf

from . import fetch


class EngineError(RuntimeError):
    pass


def load_mono(path: Path) -> tuple[np.ndarray, int]:
    samples, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return samples.mean(axis=1).astype(np.float32), sr


VAD_SR = 16000


def vad_spans(
    samples: np.ndarray, sr: int, vad_model: Path, max_speech_sec: float = 20.0, min_silence_sec: float = 0.25
) -> tuple[list[tuple[int, int]], int]:
    """silero VAD 말소리 구간을 찾는다. (16kHz 기준 [시작, 끝) 샘플 위치 목록, 16kHz 로 본 전체 길이).

    VAD 는 16kHz 만 받는다. 다른 샘플레이트면 경계만 찾으려고 선형 보간으로 줄인 사본을 쓴다.
    """
    import sherpa_onnx

    vad_sr = VAD_SR
    if sr != vad_sr:
        n = int(len(samples) * vad_sr / sr)
        x = np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples)
        x = x.astype(np.float32)
    else:
        x = samples
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(vad_model)
    cfg.silero_vad.min_silence_duration = min_silence_sec
    cfg.silero_vad.max_speech_duration = max_speech_sec
    cfg.sample_rate = vad_sr
    cfg.num_threads = 1
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)
    window = cfg.silero_vad.window_size
    spans: list[tuple[int, int]] = []

    def drain() -> None:
        while not vad.empty():
            seg = vad.front
            spans.append((seg.start, seg.start + len(seg.samples)))
            vad.pop()

    for i in range(0, len(x), window):
        vad.accept_waveform(x[i : i + window])
        drain()
    vad.flush()
    drain()
    return spans, len(x)


def vad_pieces(samples: np.ndarray, sr: int, vad_model: Path) -> list[np.ndarray]:
    """긴 오디오를 silero VAD 로 말소리 조각(약 20초까지)으로 자른다."""
    return [samples[a:b] for a, b in merged_spans(samples, sr, vad_model)]


def merged_spans(samples: np.ndarray, sr: int, vad_model: Path) -> list[tuple[int, int]]:
    """vad_pieces 가 자르는 자리. 원래 샘플레이트 기준 [시작, 끝) 위치 목록."""
    spans, n16 = vad_spans(samples, sr, vad_model)
    vad_sr = VAD_SR

    # VAD 는 짧은 쉼마다 잘라서 조각이 너무 잘다. 짧은 조각에서는 모델이 없는 말을 지어내고
    # 조각 앞머리 소리도 잘린다. 그래서 앞뒤로 0.2초 여유를 두고, 이어진 조각을 20초까지 합친다.
    pad = int(0.2 * vad_sr)
    max_len = 20 * vad_sr
    merged: list[list[int]] = []
    for a, b in spans:
        a, b = max(0, a - pad), min(n16, b + pad)
        if merged and b - merged[-1][0] <= max_len:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            if merged:
                a = max(a, merged[-1][1])  # 여유 때문에 앞 조각과 겹치지 않게
            merged.append([a, b])
    scale = sr / vad_sr
    return [(int(a * scale), int(b * scale)) for a, b in merged if b > a]


def qwen3_audio_tokens(sec: float) -> int:
    """Qwen3-ASR 이 소리에 쓰는 토큰 수. sherpa-onnx 1.13.8 의 FeatToAudioTokensLen 과 같은 계산이다.

    특징은 1초에 100프레임이고, 1초(100프레임) 덩어리마다 stride 2 를 세 번 거쳐 13토큰이 된다.
    프레임 수는 길이×100 으로 어림한다(108.3초 → 1408토큰으로 실제 로그와 같았다).
    """
    full, rem = divmod(int(sec * 100), 100)

    def three_halvings(n: int) -> int:
        for _ in range(3):
            n = (n - 1) // 2 + 1
        return n

    return full * three_halvings(100) + (three_halvings(rem) if rem > 0 else 0)


# ---------------------------------------------------------------- 로컬 (sherpa-onnx)


class _SherpaEngine:
    kind = "local"
    currency = ""
    note = ""
    chunk_note = ""

    def __init__(self, cache_dir: Path, num_threads: int, long_audio_sec: float):
        self.cache_dir = cache_dir
        self.num_threads = num_threads
        self.long_audio_sec = long_audio_sec
        self.rec = None
        self.vad_model: Path | None = None

    def _build(self):
        raise NotImplementedError

    def _set_options(self, stream) -> None:
        pass

    def _needs_split(self, sec: float) -> bool:
        return sec > self.long_audio_sec

    def _hit_cap(self, piece_sec: float, result) -> bool:
        """디코딩이 모델 한도에 닿아 글이 잘렸을 수 있으면 True."""
        return False

    def prepare(self) -> str | None:
        self.rec = self._build()
        self.vad_model = fetch.ensure_silero_vad(self.cache_dir)
        return None

    def cost(self, duration_sec: float) -> float:
        return 0.0

    def _decode_all(self, pieces: list[np.ndarray], sr: int) -> tuple[list[str], int]:
        texts, capped = [], 0
        for piece in pieces:
            stream = self.rec.create_stream()
            self._set_options(stream)
            stream.accept_waveform(sr, piece)
            self.rec.decode_stream(stream)
            capped += self._hit_cap(len(piece) / sr, stream.result)
            text = stream.result.text.strip()
            if text:
                texts.append(text)
        return texts, capped

    def transcribe(self, audio: Path) -> tuple[str, dict]:
        samples, sr = load_mono(audio)
        whole = [samples]
        pieces = vad_pieces(samples, sr, self.vad_model) if self._needs_split(len(samples) / sr) else whole
        texts, capped = self._decode_all(pieces, sr)
        resplit = bool(capped) and pieces is whole
        if resplit:
            # 한 번에 넣었는데 한도에 닿았다. 잘라서 다시 한다.
            pieces = vad_pieces(samples, sr, self.vad_model)
            texts, capped = self._decode_all(pieces, sr)
        extra = {"pieces": len(pieces)}
        if resplit:
            extra["resplit_after_cap"] = True
        if capped:
            extra["capped_pieces"] = capped
        return " ".join(texts), extra


class Qwen3AsrEngine(_SherpaEngine):
    name = "qwen3-asr"
    KV_LIMIT = 512  # max_total_len. 이 모델 내보내기의 KV 캐시 한도
    PROMPT_TOKENS = 18  # language=Korean 일 때 sherpa-onnx 로그 "before=9 after=9"
    OUT_TOKENS_PER_SEC = 6.0  # FLEURS 30개에서 잰 글 토큰은 소리 1초에 최대 5.77개. 그걸 올린 값
    MAX_NEW_TOKENS = 256

    def __init__(self, *args, language: str = "Korean", **kwargs):
        super().__init__(*args, **kwargs)
        self.language = language

    def _build(self):
        import sherpa_onnx

        d = fetch.ensure_model("qwen3-asr", self.cache_dir)
        return sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
            conv_frontend=str(d / "conv_frontend.onnx"),
            encoder=str(d / "encoder.int8.onnx"),
            decoder=str(d / "decoder.int8.onnx"),
            tokenizer=str(d / "tokenizer"),
            num_threads=self.num_threads,
            max_total_len=self.KV_LIMIT,
            max_new_tokens=self.MAX_NEW_TOKENS,
        )

    def _set_options(self, stream) -> None:
        if self.language:
            stream.set_option("language", self.language)

    def _needs_split(self, sec: float) -> bool:
        # 미리 재기: 프롬프트 + 소리 + 예상 글 토큰이 KV 한도를 넘으면 처음부터 자른다
        budget = self.PROMPT_TOKENS + qwen3_audio_tokens(sec) + self.OUT_TOKENS_PER_SEC * sec
        return super()._needs_split(sec) or budget > self.KV_LIMIT

    def _hit_cap(self, piece_sec: float, result) -> bool:
        # 끝나고 재기: 한도에 닿으면 sherpa-onnx 는 오류 없이 글을 끊는다
        n_out = len(result.tokens)
        used = self.PROMPT_TOKENS + qwen3_audio_tokens(piece_sec) + n_out
        return used >= self.KV_LIMIT - 1 or n_out >= self.MAX_NEW_TOKENS - 1


class SenseVoiceEngine(_SherpaEngine):
    name = "sense-voice"
    chunk_note = "sense-voice 는 시험에서 20초로 합친 조각의 낱말을 통째로 빠뜨린 적이 있다(README)."

    def _build(self):
        import sherpa_onnx

        d = fetch.ensure_model("sense-voice", self.cache_dir)
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(d / "model.int8.onnx"),
            tokens=str(d / "tokens.txt"),
            num_threads=self.num_threads,
            language="ko",
            use_itn=True,
        )


# ---------------------------------------------------------------- 원격 API


def _error_code(resp: requests.Response) -> str:
    """오류 본문에서 상태·이유 코드만 뽑는다. 메시지 글은 남기지 않는다.

    Google 오류 모양: {"error": {"status": "PERMISSION_DENIED", "details": [{"reason": "SERVICE_DISABLED"}]}}
    """
    try:
        body = resp.json()
    except ValueError:
        return ""
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        return ""
    reasons = [d.get("reason") for d in err.get("details") or [] if isinstance(d, dict) and d.get("reason")]
    return " ".join(str(x) for x in [err.get("status"), *reasons] if x)


def _check(resp: requests.Response, what: str) -> None:
    if resp.status_code != 200:
        raise EngineError(f"{what} HTTP {resp.status_code} {_error_code(resp)}".strip())


class _GcloudCliCredentials(google.auth.credentials.CredentialsWithQuotaProject):
    """gcloud 에 지금 로그인한 계정의 액세스 토큰. 토큰이 만료돼 401 이 오면 AuthorizedSession 이 다시 받는다."""

    def refresh(self, request) -> None:
        proc = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True, timeout=60)
        if proc.returncode != 0 or not proc.stdout.strip():
            raise google.auth.exceptions.RefreshError(f"gcloud auth print-access-token 실패 (exit {proc.returncode})")
        self.token = proc.stdout.strip()

    def with_quota_project(self, quota_project_id):
        creds = _GcloudCliCredentials()
        creds._quota_project_id = quota_project_id
        return creds


def _wav_bytes(samples: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples.clip(-1.0, 1.0), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class GoogleChirp3Engine:
    """Google Cloud Speech-to-Text v2, 모델 chirp_3.
    https://docs.cloud.google.com/speech-to-text/v2/docs/chirp_3-model

    인증(auth):
    - "adc": ADC(gcloud auth application-default login) 또는 GOOGLE_APPLICATION_CREDENTIALS 서비스 계정
    - "gcloud": gcloud 에 지금 로그인한 계정 (gcloud auth print-access-token)
    오디오는 로컬 엔진과 같게 모노 16비트 PCM WAV 로 만들어 보낸다.
    Recognize 는 1분 미만 오디오용이라, long_audio_sec 보다 긴 오디오는 VAD 조각(20초까지)으로 나눠 보낸다.
    """

    kind = "remote"
    currency = "USD"
    # Speech-to-Text V2 Recognition, 월 0~50만 분, 데이터 로깅 안 켬 (Cloud Billing Catalog, 2026-10-12)
    USD_PER_MIN = 0.016
    USD_PER_MIN_DYNAMIC_BATCH = 0.003
    LOCATIONS = ("us", "eu")  # Chirp 3 이 GA 인 멀티리전
    RETRY_STATUS = {429, 500, 502, 503, 504}
    RETRY_WAITS = (1.0, 2.0, 4.0)  # 세 번까지, 간격을 늘려 가며
    chunk_note = (
        "chirp_3 은 시험에서 조각 뒷부분 말을 버린 적이 있어 긴 오디오의 CER 은 믿기 어렵다."
        " 제대로 재려면 BatchRecognize(GCS 입력)가 필요하다(README)."
    )

    def __init__(self, project: str, location: str, cache_dir: Path, long_audio_sec: float, auth: str = "adc"):
        if auth not in ("adc", "gcloud"):
            raise ValueError(f"모르는 인증 방식: {auth} (가능: adc, gcloud)")
        if not re.fullmatch(r"[a-z0-9-]+", location) or location not in self.LOCATIONS:
            raise ValueError(f"chirp3 지역은 {', '.join(self.LOCATIONS)} 중 하나여야 한다: {location!r}")
        self.auth = auth
        self.project = project
        self.location = location
        self.cache_dir = cache_dir
        self.long_audio_sec = long_audio_sec
        self.name = f"chirp_3@{location}"
        self.base = f"https://{location}-speech.googleapis.com/v2/projects/{project}/locations/{location}"
        self.note = (
            f"{self.name}: 음성이 Google {location} 멀티리전에서 처리됨(한국 밖으로 나감). 인증 {auth}, 프로젝트 {project}. "
            f"비용은 Recognize 단가 ${self.USD_PER_MIN}/분, 요청마다 1초 단위 올림. "
            f"같은 모델을 Dynamic Batch 로 돌리면 ${self.USD_PER_MIN_DYNAMIC_BATCH}/분(1시간 ${self.USD_PER_MIN_DYNAMIC_BATCH * 60:.2f})."
        )
        self._creds = None
        self._local = threading.local()
        self.vad_model: Path | None = None

    def _session(self):
        from google.auth.transport.requests import AuthorizedSession

        if not hasattr(self._local, "session"):
            self._local.session = AuthorizedSession(self._creds)
        return self._local.session

    def prepare(self) -> str | None:
        if self.auth == "gcloud":
            creds = _GcloudCliCredentials()
        else:
            try:
                creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
            except google.auth.exceptions.DefaultCredentialsError:
                return "인증 없음 (gcloud auth application-default login 필요)"
        # 사용자 자격은 쿼터 프로젝트가 비어 있을 수 있다. 요청을 이 프로젝트로 달게 한다.
        if hasattr(creds, "with_quota_project"):
            creds = creds.with_quota_project(self.project)
        self._creds = creds
        # 돈이 안 드는 목록 조회로 API 가 켜져 있는지, 권한이 있는지 먼저 본다
        resp = self._session().get(f"{self.base}/recognizers", params={"pageSize": 1}, timeout=30)
        if resp.status_code != 200:
            code = _error_code(resp)
            if "SERVICE_DISABLED" in code:
                return "API 꺼짐 (speech.googleapis.com)"
            hint = " (이 인증 계정에 권한 없음, --gcp-auth 를 바꿔 볼 것)" if "IAM_PERMISSION_DENIED" in code else ""
            return f"준비 실패 HTTP {resp.status_code} {code}{hint}".strip()
        self.vad_model = fetch.ensure_silero_vad(self.cache_dir)
        return None

    def cost(self, duration_sec: float) -> float:
        return math.ceil(duration_sec) / 60.0 * self.USD_PER_MIN

    def cost_billed(self, billed_sec: float) -> float:
        """Google 이 응답에 적어 준 초(이미 요청마다 올림된 값)로 계산한 비용."""
        return billed_sec / 60.0 * self.USD_PER_MIN

    def _post(self, body: dict, method: str = "recognize") -> tuple[requests.Response, int]:
        """429·5xx·연결 끊김·타임아웃이면 간격을 늘려 가며 세 번까지 다시 보낸다. (응답, 다시 보낸 횟수)."""
        for retries, wait in enumerate((*self.RETRY_WAITS, None)):
            try:
                resp = self._session().post(f"{self.base}/recognizers/_:{method}", json=body, timeout=300)
            except (requests.ConnectionError, requests.Timeout) as e:
                if wait is None:
                    raise EngineError(f"요청 실패 {type(e).__name__} ({retries}번 다시 보냄)") from None
                time.sleep(wait)
                continue
            if resp.status_code in self.RETRY_STATUS and wait is not None:
                time.sleep(wait)
                continue
            return resp, retries
        raise AssertionError("닿지 않는 곳")

    def _recognize(self, content: bytes) -> tuple[str, float, int]:
        body = {
            "config": {
                "autoDecodingConfig": {},
                "languageCodes": ["ko-KR"],
                "model": "chirp_3",
                "features": {"enableAutomaticPunctuation": True},
            },
            "content": base64.b64encode(content).decode("ascii"),
        }
        resp, retries = self._post(body)
        _check(resp, f"요청({retries}번 다시 보낸 뒤)" if retries else "요청")
        data = resp.json()
        texts = []
        for result in data.get("results") or []:
            alts = result.get("alternatives") or []
            if alts and alts[0].get("transcript", "").strip():
                texts.append(alts[0]["transcript"].strip())
        billed = str((data.get("metadata") or {}).get("totalBilledDuration") or "0s")
        return " ".join(texts), float(billed.rstrip("s") or 0), retries

    def transcribe(self, audio: Path) -> tuple[str, dict]:
        samples, sr = load_mono(audio)
        if len(samples) / sr <= self.long_audio_sec:
            pieces = [samples]
        else:
            pieces = vad_pieces(samples, sr, self.vad_model)
        texts, billed, retries = [], 0.0, 0
        for piece in pieces:
            text, sec, n = self._recognize(_wav_bytes(piece, sr))
            billed += sec
            retries += n
            if text:
                texts.append(text)
        extra = {"billed_sec": billed, "pieces": len(pieces)}
        if retries:
            extra["retries"] = retries
        return " ".join(texts), extra


ENGINE_HELP = "chirp3, chirp3:<지역>(us·eu), qwen3-asr, sense-voice"


def make_engine(
    spec: str, cache_dir: Path, num_threads: int, long_audio_sec: float, gcp_project: str, gcp_auth: str
):
    if spec == "chirp3" or spec.startswith("chirp3:"):
        return GoogleChirp3Engine(gcp_project, spec.partition(":")[2] or "us", cache_dir, long_audio_sec, gcp_auth)
    if spec == "qwen3-asr":
        return Qwen3AsrEngine(cache_dir, num_threads, long_audio_sec)
    if spec == "sense-voice":
        return SenseVoiceEngine(cache_dir, num_threads, long_audio_sec)
    raise ValueError(f"모르는 엔진: {spec} (가능: {ENGINE_HELP})")


def engine_for_rescore(name: str, cache_dir: Path):
    """결과 JSON 의 엔진 이름으로 비용 계산만 쓸 엔진을 만든다(인증·모델 올리기 없음)."""
    spec = f"chirp3:{name.partition('@')[2]}" if name.startswith("chirp_3@") else name
    return make_engine(spec, cache_dir, 1, 30.0, "rescore", "adc")
