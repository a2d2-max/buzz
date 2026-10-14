"""long-compare 의 응답 해석과 맞추기 시험(네트워크 없음)."""

import pytest

from huddle_stt_bench.engines import EngineError
from huddle_stt_bench.long_compare import Ledger, BudgetError, evaluate, parse_batch_op

URI = "gs://a2d2-huddle-recordings/dev/stt-bench/x/track-1.wav"


def _op(results, billed="20s"):
    return {"done": True, "response": {"results": {URI: {
        "inlineResult": {"transcript": {"results": results}},
        "metadata": {"totalBilledDuration": billed},
    }}}}


def test_parse_batch_words_first_start_missing_means_zero():
    # 2026-10-12 시험에서 본 모양: resultEndOffset 없음, 첫 단어 startOffset 빠짐
    op = _op([{"alternatives": [{"transcript": "그는 감산", "words": [
        {"endOffset": "3.560s", "word": "그는"},
        {"startOffset": "3.560s", "endOffset": "4.120s", "word": "감산"},
    ]}], "languageCode": "ko-kr"}])
    out = parse_batch_op(op, URI)
    assert out["timing"] == "word"
    assert out["words"][0] == {"start": 0.0, "end": 3.56, "text": "그는"}
    assert out["billed_sec"] == 20.0 and out["hyp"] == "그는 감산"


def test_parse_batch_without_words_has_no_timing():
    out = parse_batch_op(_op([{"alternatives": [{"transcript": "안녕"}], "languageCode": "ko-kr"}]), URI)
    assert out["timing"] == "none" and out["segments"][0]["start"] is None


def test_parse_batch_error():
    with pytest.raises(EngineError):
        parse_batch_op({"done": True, "error": {"code": 3, "status": "INVALID_ARGUMENT"}}, URI)


def test_evaluate_finds_and_times_sentences():
    track = {"sentences": [
        {"id": "s1", "text": "가나다라마", "start": 1.0, "end": 2.0},
        {"id": "s2", "text": "바사아자차", "start": 10.0, "end": 11.0},
    ]}
    res = {"hyp": "가나다라마 바사아자차", "timing": "segment", "words": [], "segments": [
        {"start": 0.8, "end": 2.2, "text": "가나다라마"},
        {"start": 9.9, "end": 11.1, "text": "바사아자차"},
    ]}
    ev = evaluate(track, res)
    assert ev["n_missed"] == 0 and ev["edits_nospace"] == 0
    assert [p["start_error"] for p in ev["sentences"]] == [pytest.approx(-0.2), pytest.approx(-0.1)]


def test_evaluate_counts_missed_sentence():
    track = {"sentences": [
        {"id": "s1", "text": "가나다라마", "start": 1.0, "end": 2.0},
        {"id": "s2", "text": "바사아자차", "start": 10.0, "end": 11.0},
    ]}
    res = {"hyp": "가나다라마", "timing": "none", "words": [], "segments": [{"start": None, "end": None, "text": "가나다라마"}]}
    ev = evaluate(track, res)
    assert ev["n_missed"] == 1 and ev["sentences"][0]["start_error"] is None


def test_ledger_holds_concurrent_requests(tmp_path):
    led = Ledger(tmp_path / "l.jsonl", cap_sec=30)
    led.hold(20, "a")
    with pytest.raises(BudgetError):
        led.hold(15, "b")  # 아직 안 끝난 20초가 잡혀 있다
    led.settle(20, 18, "a")
    led.hold(12, "c")  # 18 + 12 = 30
    assert led.spent() == 18
