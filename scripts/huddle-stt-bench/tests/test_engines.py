"""네트워크·모델 없이 도는 엔진 시험."""

from pathlib import Path

import pytest
import requests

from huddle_stt_bench import engines
from huddle_stt_bench.engines import EngineError, GoogleChirp3Engine, Qwen3AsrEngine, qwen3_audio_tokens


def _resp(status: int, body: bytes = b"{}") -> requests.Response:
    r = requests.Response()
    r.status_code = status
    r._content = body
    return r


class _FakeSession:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def post(self, *args, **kwargs):
        self.calls += 1
        out = self.outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


def _chirp(monkeypatch, outcomes):
    eng = GoogleChirp3Engine("p", "us", Path("."), 30.0, "gcloud")
    eng._local.session = _FakeSession(outcomes)
    waits = []
    monkeypatch.setattr(engines.time, "sleep", waits.append)
    return eng, waits


OK = b'{"results": [{"alternatives": [{"transcript": " \xec\x95\x88\xeb\x85\x95 "}]}], "metadata": {"totalBilledDuration": "3s"}}'


def test_chirp_retries_5xx_then_succeeds(monkeypatch):
    eng, waits = _chirp(monkeypatch, [_resp(503), _resp(429), _resp(200, OK)])
    assert eng._recognize(b"x") == ("안녕", 3.0, 2)
    assert waits == [1.0, 2.0]


def test_chirp_retries_connection_errors(monkeypatch):
    eng, waits = _chirp(monkeypatch, [requests.ConnectionError("끊김"), requests.Timeout("늦음"), _resp(200, OK)])
    assert eng._recognize(b"x")[2] == 2
    assert waits == [1.0, 2.0]


def test_chirp_gives_up_after_three_retries(monkeypatch):
    eng, waits = _chirp(monkeypatch, [_resp(503)] * 4)
    with pytest.raises(EngineError, match="HTTP 503"):
        eng._recognize(b"x")
    assert waits == [1.0, 2.0, 4.0] and eng._local.session.calls == 4


def test_chirp_does_not_retry_client_errors(monkeypatch):
    body = b'{"error": {"status": "INVALID_ARGUMENT", "message": "secret-ish detail"}}'
    eng, waits = _chirp(monkeypatch, [_resp(400, body)])
    with pytest.raises(EngineError) as exc:
        eng._recognize(b"x")
    assert str(exc.value) == "요청 HTTP 400 INVALID_ARGUMENT"  # 본문 메시지는 남기지 않는다
    assert waits == []


@pytest.mark.parametrize("loc", ["asia-northeast3", "US", "us/../x", "us.evil.com", ""])
def test_chirp_rejects_unknown_locations(loc):
    with pytest.raises(ValueError):
        GoogleChirp3Engine("p", loc, Path("."), 30.0, "gcloud")


def test_chirp_cost_from_billed_seconds():
    eng = GoogleChirp3Engine("p", "eu", Path("."), 30.0, "gcloud")
    assert eng.cost(11.94) == pytest.approx(12 / 60 * 0.016)  # 요청마다 1초 올림
    assert eng.cost_billed(407) == pytest.approx(407 / 60 * 0.016)


def test_qwen3_audio_tokens_match_sherpa_onnx():
    assert qwen3_audio_tokens(1.0) == 13
    assert qwen3_audio_tokens(20.0) == 260
    assert qwen3_audio_tokens(108.3) == 1408  # 실제 sherpa-onnx 잘림 로그의 audio_token_len


def test_qwen3_budget_split():
    eng = Qwen3AsrEngine(Path("."), 1, 30.0)
    assert not eng._needs_split(25.8)  # 18 + 335 + 6×25.8 = 507.8 ≤ 512
    assert eng._needs_split(26.5)  # 18 + 345 + 159 = 522 > 512
    assert eng._needs_split(31.0)  # long_audio_sec 넘음
