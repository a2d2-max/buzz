"""긴 트랙을 Chirp 3 에 어떻게 보낼지 비교한다 (long-compare).

FLEURS 문장을 이어 붙여 사람별 긴 트랙(16kHz 모노)을 만들고, 방식마다 받아쓰기·시각 정확도를 잰다.

- A  : VAD 로 찾은 자연스러운 말 덩어리(합치지 않음, 0.5초 이상 쉬면 끊음, 덩어리 최대 29초)를 하나씩 Recognize.
- A2 : 20초까지 합친 조각(engines.merged_spans, 측정 도구의 chirp3 긴 오디오 처리와 같음)을 하나씩 Recognize.
- B  : 트랙 전체를 GCS(dev/ 아래)에 올리고 BatchRecognize. 단어 시각 끔.
- Bw : B 와 같고 단어 시각 켬(enableWordTimeOffsets).

Chirp 사용량은 장부(<cache>/long-compare/chirp-ledger.jsonl)에 요청마다 적는다. 계획한 초가 상한을 넘으면
아무 요청도 보내지 않고 멈춘다. 돌다가도 다음 요청이 상한을 넘기면 보내지 않는다.
"""

from __future__ import annotations

import difflib
import json
import math
import random
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf

from . import fetch
from .engines import VAD_SR, EngineError, GoogleChirp3Engine, _check, _wav_bytes, load_mono, merged_spans, vad_spans
from .metrics import char_errors, normalize

SR = 16000
GCS_BUCKET = "a2d2-huddle-recordings"
GCS_ALLOWED_PREFIX = f"gs://{GCS_BUCKET}/dev/"
DEFAULT_GCS_PREFIX = f"gs://{GCS_BUCKET}/dev/stt-bench"
NOISE_STD = 3e-4  # 무음 자리에도 마이크 바닥 잡음(약 -70dBFS)을 깐다
FOUND_RATIO = 0.5  # 정답 문장 글자의 절반 이상이 받아쓴 글과 맞으면 "찾음"
METHODS = ("A", "A2", "B", "Bw")
METHOD_LABEL = {
    "A": "A: 말 덩어리마다 Recognize",
    "A2": "A′: 20초까지 합친 조각 Recognize",
    "B": "B: BatchRecognize (단어 시각 끔)",
    "Bw": "B: BatchRecognize (단어 시각 켬)",
}


class BudgetError(RuntimeError):
    pass


class Ledger:
    """이번 일에서 Chirp 가 매긴 초를 적는 장부. 여러 번 돌려도 이어서 센다."""

    def __init__(self, path: Path, cap_sec: float):
        self.path = path
        self.cap = cap_sec
        self._lock = threading.Lock()
        self._held = 0.0  # 보냈지만 아직 매긴 초를 못 받은 요청의 예정 초
        path.parent.mkdir(parents=True, exist_ok=True)

    def spent(self) -> float:
        if not self.path.exists():
            return 0.0
        return sum(json.loads(line)["billed_sec"] for line in self.path.read_text().splitlines() if line.strip())

    def hold(self, planned_sec: float, what: str) -> None:
        """보내기 전에 예정 초를 잡아 둔다. 동시에 보내는 요청끼리도 상한을 넘지 않게 한다."""
        with self._lock:
            used = self.spent() + self._held
            if used + planned_sec > self.cap:
                raise BudgetError(f"{what}: 쓴 {used:.0f}초 + 이번 {planned_sec:.0f}초 > 상한 {self.cap:.0f}초")
            self._held += planned_sec

    def settle(self, planned_sec: float, billed_sec: float, what: str) -> None:
        """잡아 둔 초를 풀고 실제로 매긴 초를 적는다. 요청이 실패해도 불러서 잡아 둔 것을 푼다."""
        with self._lock:
            self._held -= planned_sec
            with self.path.open("a") as fh:
                fh.write(json.dumps({"at": _now(), "what": what, "billed_sec": billed_sec}, ensure_ascii=False) + "\n")


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- 트랙 만들기


def build_tracks(cache_dir: Path, run_dir: Path, n_tracks: int, track_sec: float, speech_sec: float, seed: int):
    """사람별 트랙을 만든다. 트랙마다 한 성별의 FLEURS 문장을 순서대로 이어 붙이고, 문장 사이에 0.5~3초 쉼,
    일부 자리에 10~30초 긴 침묵(다른 사람이 말하는 동안)을 넣는다. 정답 시각은 문장마다 VAD 로 찾은 말소리 시작·끝이다.
    """
    manifest = fetch.fetch_fleurs(cache_dir / "fleurs-ko-test-long", 40 * n_tracks, "test")
    recs = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines()]
    pools = {g: [r for r in recs if r["gender"] == g] for g in ("MALE", "FEMALE")}
    vad_model = fetch.ensure_silero_vad(cache_dir)
    (run_dir / "tracks").mkdir(parents=True, exist_ok=True)
    tracks = []
    for t in range(n_tracks):
        gender = ("MALE", "FEMALE")[t % 2]
        rng = random.Random(seed * 100 + t)
        clips, total_speech = [], 0.0
        while total_speech < speech_sec:
            if not pools[gender]:
                raise RuntimeError(f"{gender} 문장이 모자라다")
            r = pools[gender].pop(0)
            x, sr = load_mono(manifest.parent / r["audio"])
            if sr != SR:
                raise RuntimeError(f"FLEURS 샘플레이트가 {sr}")
            spans, _ = vad_spans(x, sr, vad_model)
            if not spans:
                continue
            clips.append((r, x, spans[0][0] / VAD_SR, spans[-1][1] / VAD_SR))
            total_speech += len(x) / SR
        lead, tail = 1.0, 1.0
        gaps = [rng.uniform(0.5, 3.0) for _ in range(len(clips) - 1)]
        long_idx: list[int] = []
        order = list(range(len(gaps)))
        rng.shuffle(order)
        total = lead + sum(len(c[1]) / SR for c in clips) + sum(gaps) + tail
        for i in order:
            if total >= track_sec:
                break
            new = rng.uniform(10.0, 30.0)
            total += new - gaps[i]
            gaps[i] = new
            long_idx.append(i)
        tail += max(0.0, track_sec - total)
        noise = np.random.default_rng(seed * 100 + t)
        n = int(round((lead + sum(len(c[1]) / SR for c in clips) + sum(gaps) + tail) * SR))
        y = noise.normal(0.0, NOISE_STD, n).astype(np.float32)
        sentences, pos = [], lead
        for k, (r, x, on, off) in enumerate(clips):
            i0 = int(round(pos * SR))
            y[i0 : i0 + len(x)] += x
            sentences.append({"id": r["id"], "text": r["text"], "start": round(pos + on, 3), "end": round(pos + off, 3)})
            pos += len(x) / SR + (gaps[k] if k < len(gaps) else 0.0)
        path = run_dir / "tracks" / f"track-{t + 1}.wav"
        sf.write(str(path), y.clip(-1.0, 1.0), SR, subtype="PCM_16")
        tracks.append({
            "id": f"track-{t + 1}",
            "gender": gender,
            "path": path.name,
            "duration": round(n / SR, 3),
            "speech_clip_sec": round(sum(len(c[1]) / SR for c in clips), 3),
            "long_silences": sorted(round(gaps[i], 2) for i in long_idx),
            "sentences": sentences,
        })
    (run_dir / "tracks.json").write_text(json.dumps(tracks, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return tracks


# ---------------------------------------------------------------- 자르는 자리


def natural_spans(samples: np.ndarray, vad_model: Path) -> list[tuple[int, int]]:
    """방식 A: 합치지 않은 말 덩어리. 0.5초 이상 쉬면 끊고, 덩어리는 29초를 넘지 않는다. 앞뒤 0.2초 여유."""
    spans, n16 = vad_spans(samples, SR, vad_model, max_speech_sec=29.0, min_silence_sec=0.5)
    pad = int(0.2 * VAD_SR)
    out: list[tuple[int, int]] = []
    for a, b in spans:
        a, b = max(0, a - pad), min(n16, b + pad)
        if out:
            a = max(a, out[-1][1])
        if b > a:
            out.append((a, b))
    return out  # SR == VAD_SR 라 그대로 원래 위치다


def plan(tracks: list[dict], run_dir: Path, methods: list[str], vad_model: Path) -> dict:
    """방식마다 트랙별로 보낼 조각과 예상 매긴 초(요청마다 1초 올림)."""
    out: dict = {}
    for m in methods:
        for tr in tracks:
            x, _ = load_mono(run_dir / "tracks" / tr["path"])
            if m == "A":
                spans = natural_spans(x, vad_model)
            elif m == "A2":
                spans = merged_spans(x, SR, vad_model)
            else:
                spans = [(0, len(x))]
            out.setdefault(m, {})[tr["id"]] = {
                "spans": spans,
                "planned_sec": sum(math.ceil((b - a) / SR) for a, b in spans),
            }
    return out


# ---------------------------------------------------------------- 보내기


def _offset(v) -> float | None:
    if v is None:
        return None
    return float(str(v).rstrip("s") or 0)


def run_recognize(eng: GoogleChirp3Engine, ledger: Ledger, x: np.ndarray, spans, label: str, concurrency: int):
    """조각마다 Recognize. 시각은 조각 위치로 정해진다."""

    def one(span):
        a, b = span
        sec = math.ceil((b - a) / SR)
        ledger.hold(sec, label)
        t0 = time.perf_counter()
        billed = float(sec)  # 실패하면 매겼다고 보고 예정 초를 적는다(장부가 모자라게 세지 않게)
        try:
            text, billed, retries = eng._recognize(_wav_bytes(x[a:b], SR))
        finally:
            ledger.settle(sec, billed, label)
        return {"start": a / SR, "end": b / SR, "text": text, "billed_sec": billed, "retries": retries,
                "latency": time.perf_counter() - t0}

    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        segs = list(pool.map(one, spans))
    wall = time.perf_counter() - t0
    return {
        "segments": segs,
        "timing": "segment",
        "hyp": " ".join(s["text"] for s in segs if s["text"]),
        "billed_sec": sum(s["billed_sec"] for s in segs),
        "requests": len(segs),
        "retries": sum(s["retries"] for s in segs),
        "proc_sec": wall,
        "latency_sum_sec": sum(s["latency"] for s in segs),
    }


def upload(eng: GoogleChirp3Engine, path: Path, gcs_uri: str) -> float:
    if not gcs_uri.startswith(GCS_ALLOWED_PREFIX):
        raise ValueError(f"GCS 쓰기는 {GCS_ALLOWED_PREFIX} 아래만 허용: {gcs_uri}")
    bucket, _, name = gcs_uri.removeprefix("gs://").partition("/")
    t0 = time.perf_counter()
    resp = eng._session().post(
        f"https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o",
        params={"uploadType": "media", "name": name},
        data=path.read_bytes(),
        headers={"Content-Type": "audio/wav"},
        timeout=300,
    )
    _check(resp, "GCS 올리기")
    return time.perf_counter() - t0


def run_batch(eng: GoogleChirp3Engine, ledger: Ledger, gcs_uri: str, duration: float, words: bool, label: str):
    planned = math.ceil(duration)
    ledger.hold(planned, label)
    billed = float(planned)  # 실패하면 매겼다고 보고 예정 초를 적는다(장부가 모자라게 세지 않게)
    try:
        out = _batch(eng, gcs_uri, words)
        billed = out["billed_sec"]
        return out
    finally:
        ledger.settle(planned, billed, label)


def _batch(eng: GoogleChirp3Engine, gcs_uri: str, words: bool) -> dict:
    body = {
        "config": {
            "autoDecodingConfig": {},
            "languageCodes": ["ko-KR"],
            "model": "chirp_3",
            "features": {"enableAutomaticPunctuation": True, "enableWordTimeOffsets": words},
        },
        "files": [{"uri": gcs_uri}],
        "recognitionOutputConfig": {"inlineResponseConfig": {}},
        "processingStrategy": "PROCESSING_STRATEGY_UNSPECIFIED",
    }
    t0 = time.perf_counter()
    resp, retries = eng._post(body, method="batchRecognize")
    _check(resp, "batchRecognize")
    op_name = resp.json()["name"]
    deadline = time.monotonic() + 1800
    while True:
        time.sleep(3)
        got = eng._session().get(f"https://{eng.location}-speech.googleapis.com/v2/{op_name}", timeout=60)
        _check(got, "작업 조회")
        op = got.json()
        if op.get("done"):
            break
        if time.monotonic() > deadline:
            raise EngineError("batchRecognize 30분 시간 초과")
    proc = time.perf_counter() - t0
    out = parse_batch_op(op, gcs_uri)
    out.update({"requests": 1, "retries": retries, "proc_sec": proc})
    return out


def parse_batch_op(op: dict, gcs_uri: str) -> dict:
    """끝난 batchRecognize 작업에서 글·시각·매긴 초를 꺼낸다.

    시각 칸은 proto3 JSON 이라 0 이면 빠진다(첫 단어의 startOffset 이 그렇다). 단어 안에서 빠진 시각은 0 으로 본다.
    Chirp 3 결과에는 resultEndOffset 이 없어서, 단어 시각을 끄면 시각이 하나도 없다(2026-10-12 시험에서 확인).
    """
    if op.get("error"):
        raise EngineError(f"batchRecognize 실패 {op['error'].get('code')} {op['error'].get('status', '')}".strip())
    response = op.get("response") or {}
    fr = (response.get("results") or {}).get(gcs_uri) or {}
    if fr.get("error"):
        raise EngineError(f"batchRecognize 파일 실패 {fr['error'].get('code')}")
    transcript = (fr.get("inlineResult") or {}).get("transcript") or fr.get("transcript") or {}
    billed = _offset((fr.get("metadata") or {}).get("totalBilledDuration")) or _offset(response.get("totalBilledDuration")) or 0.0
    segs, words_out, prev_end = [], [], 0.0
    for res in transcript.get("results") or []:
        alts = res.get("alternatives") or []
        if not alts:
            continue
        alt = alts[0]
        end = _offset(res.get("resultEndOffset"))
        segs.append({"start": prev_end if end is not None else None, "end": end, "text": alt.get("transcript", "").strip()})
        if end is not None:
            prev_end = end
        for w in alt.get("words") or []:
            words_out.append({
                "start": _offset(w.get("startOffset", "0s")),
                "end": _offset(w.get("endOffset", "0s")),
                "text": w.get("word", ""),
            })
    has_seg_time = bool(segs) and all(s["end"] is not None for s in segs)
    return {
        "segments": segs,
        "words": words_out,
        "timing": "word" if words_out else ("segment" if has_seg_time else "none"),
        "hyp": " ".join(s["text"] for s in segs if s["text"]),
        "billed_sec": billed,
        "result_keys": sorted({k for res in transcript.get("results") or [] for k in res}),
    }


# ---------------------------------------------------------------- 맞추기


def timed_chars(segs: list[dict]) -> tuple[str, list[float | None]]:
    """구간마다 글을 정규화하고, 글자 시각을 구간 안에서 고르게 나눠 매긴다."""
    chars, times = [], []
    for s in segs:
        t = normalize(s["text"], keep_spaces=False)
        for k, ch in enumerate(t):
            chars.append(ch)
            if s.get("start") is None or s.get("end") is None:
                times.append(None)
            else:
                times.append(s["start"] + (s["end"] - s["start"]) * k / max(1, len(t)))
    return "".join(chars), times


def evaluate(track: dict, result: dict) -> dict:
    sentences = track["sentences"]
    ref_full = " ".join(s["text"] for s in sentences)
    ed_ns, n_ns = char_errors(ref_full, result["hyp"], keep_spaces=False)
    ed_sp, n_sp = char_errors(ref_full, result["hyp"], keep_spaces=True)

    ref_norm = [normalize(s["text"], keep_spaces=False) for s in sentences]
    ref_cat = "".join(ref_norm)
    bounds, pos = [], 0
    for r in ref_norm:
        bounds.append((pos, pos + len(r)))
        pos += len(r)
    timing_segs = result["words"] if result["timing"] == "word" else result["segments"]
    hyp_cat, hyp_times = timed_chars(timing_segs)
    ref_to_hyp: dict[int, int] = {}
    for a, b, size in difflib.SequenceMatcher(None, ref_cat, hyp_cat, autojunk=False).get_matching_blocks():
        for k in range(size):
            ref_to_hyp[a + k] = b + k

    per_sentence = []
    for s, (b0, b1) in zip(sentences, bounds):
        matched = [i for i in range(b0, b1) if i in ref_to_hyp]
        found = bool(b1 > b0) and len(matched) / (b1 - b0) >= FOUND_RATIO
        t_hyp = hyp_times[ref_to_hyp[matched[0]]] if found and result["timing"] != "none" else None
        per_sentence.append({
            "id": s["id"],
            "found": found,
            "match_ratio": round(len(matched) / (b1 - b0), 3) if b1 > b0 else 0.0,
            "ref_start": s["start"],
            "hyp_start": None if t_hyp is None else round(t_hyp, 3),
            "start_error": None if t_hyp is None else round(t_hyp - s["start"], 3),
        })
    return {
        "edits_nospace": ed_ns, "ref_chars_nospace": n_ns,
        "edits_space": ed_sp, "ref_chars_space": n_sp,
        "n_sentences": len(sentences),
        "n_missed": sum(not p["found"] for p in per_sentence),
        "sentences": per_sentence,
    }


# ---------------------------------------------------------------- 실행


def long_compare(
    cache_dir: Path, n_tracks: int, track_sec: float, speech_sec: float, seed: int, methods: list[str],
    budget_sec: float, gcp_project: str, gcp_auth: str, gcs_prefix: str, concurrency: int, dry_run: bool,
) -> Path:
    for m in methods:
        if m not in METHODS:
            raise ValueError(f"모르는 방식: {m} (가능: {', '.join(METHODS)})")
    if not (gcs_prefix.rstrip("/") + "/").startswith(GCS_ALLOWED_PREFIX):
        raise ValueError(f"--gcs-prefix 는 {GCS_ALLOWED_PREFIX} 아래여야 한다: {gcs_prefix}")
    run_id = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d-%H%M%S")
    root = cache_dir / "long-compare"
    run_dir = root / run_id
    ledger = Ledger(root / "chirp-ledger.jsonl", budget_sec)
    vad_model = fetch.ensure_silero_vad(cache_dir)

    tracks = build_tracks(cache_dir, run_dir, n_tracks, track_sec, speech_sec, seed)
    for tr in tracks:
        _log(f"[트랙] {tr['id']} {tr['gender']} {tr['duration']:.1f}초, 문장 {len(tr['sentences'])}개,"
             f" 문장 클립 합 {tr['speech_clip_sec']:.1f}초, 긴 침묵 {tr['long_silences']}")
    plans = plan(tracks, run_dir, methods, vad_model)
    planned_total = sum(p["planned_sec"] for m in plans.values() for p in m.values())
    spent = ledger.spent()
    _log("[계획] " + ", ".join(
        f"{m} {sum(p['planned_sec'] for p in plans[m].values())}초({sum(len(p['spans']) for p in plans[m].values())}요청)"
        for m in methods))
    _log(f"[계획] 합 {planned_total}초 + 이미 쓴 {spent:.0f}초 = {planned_total + spent:.0f}초 / 상한 {budget_sec:.0f}초")
    report = {
        "run_id": run_id, "started_at": _now(), "seed": seed, "methods": methods,
        "tracks": [{k: v for k, v in tr.items() if k != "sentences"} | {"n_sentences": len(tr["sentences"])} for tr in tracks],
        "plan": {m: {t: {"requests": len(p["spans"]), "planned_sec": p["planned_sec"]} for t, p in v.items()} for m, v in plans.items()},
        "ledger_before_sec": spent, "budget_sec": budget_sec,
    }
    if spent + planned_total > budget_sec:
        raise BudgetError(f"계획 {planned_total}초 + 이미 쓴 {spent:.0f}초가 상한 {budget_sec:.0f}초를 넘어 아무것도 보내지 않았다")
    if dry_run:
        (run_dir / "plan.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _log(f"[계획만] {run_dir}")
        return run_dir

    eng = GoogleChirp3Engine(gcp_project, "us", cache_dir, 30.0, gcp_auth)
    skip = eng.prepare()
    if skip:
        raise EngineError(f"chirp3 준비 실패: {skip}")
    results: dict = {m: {} for m in methods}

    def job(m: str, tr: dict, uri: str | None, up_sec: float) -> None:
        label = f"{run_id} {m} {tr['id']}"
        try:
            if m in ("A", "A2"):
                x, _ = load_mono(run_dir / "tracks" / tr["path"])
                res = run_recognize(eng, ledger, x, plans[m][tr["id"]]["spans"], label, concurrency)
            else:
                res = run_batch(eng, ledger, uri, tr["duration"], m == "Bw", label)
                res.update({"upload_sec": up_sec, "gcs_uri": uri})
            res["eval"] = evaluate(tr, res)
        except BudgetError as e:
            res = {"error": f"예산: {e}"}
        except EngineError as e:
            res = {"error": str(e)}
        results[m][tr["id"]] = res
        _log(f"[{m}] {tr['id']} " + (res["error"] if "error" in res else
             f"CER {res['eval']['edits_nospace']}/{res['eval']['ref_chars_nospace']}, 놓침 {res['eval']['n_missed']},"
             f" 매긴 {res['billed_sec']:.0f}초, {res['proc_sec']:.1f}초, 시각 {res['timing']}"))

    # BatchRecognize 는 대기가 길고 들쭉날쭉하다(시험에서 같은 20초 파일이 369초·13초). 먼저 다 걸어 두고
    # 그동안 Recognize 방식을 돌린다. 처리 시간은 작업마다 따로 잰다.
    batch_methods = [m for m in methods if m in ("B", "Bw")]
    uploaded: dict[str, tuple[str, float]] = {}
    if batch_methods:
        for tr in tracks:
            uri = f"{gcs_prefix.rstrip('/')}/{run_id}/{tr['path']}"
            uploaded[tr["id"]] = (uri, upload(eng, run_dir / "tracks" / tr["path"], uri))
    with ThreadPoolExecutor(max_workers=max(1, len(batch_methods) * len(tracks))) as pool:
        futures = [pool.submit(job, m, tr, *uploaded[tr["id"]]) for m in batch_methods for tr in tracks]
        for m in methods:
            if m in ("A", "A2"):
                for tr in tracks:
                    job(m, tr, None, 0.0)
        for f in futures:
            f.result()
    report["results"] = results
    report["summary"] = summarize(results, methods)
    report["ledger_after_sec"] = ledger.spent()
    (run_dir / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md = to_markdown(report)
    (run_dir / "summary.md").write_text(md, encoding="utf-8")
    print(md)
    _log(f"[결과] {run_dir}")
    return run_dir


def summarize(results: dict, methods: list[str]) -> dict:
    out = {}
    for m in methods:
        rs = [r for r in results[m].values() if "error" not in r]
        if not rs:
            out[m] = {"n_tracks": 0}
            continue
        errs = [abs(p["start_error"]) for r in rs for p in r["eval"]["sentences"] if p["start_error"] is not None]
        signed = [p["start_error"] for r in rs for p in r["eval"]["sentences"] if p["start_error"] is not None]
        billed = sum(r["billed_sec"] for r in rs)
        e = {k: sum(r["eval"][k] for r in rs) for k in ("edits_nospace", "ref_chars_nospace", "edits_space",
                                                       "ref_chars_space", "n_sentences", "n_missed")}
        out[m] = {
            "n_tracks": len(rs),
            "n_failed_tracks": len(results[m]) - len(rs),
            **e,
            "cer_nospace": e["edits_nospace"] / e["ref_chars_nospace"],
            "cer_space": e["edits_space"] / e["ref_chars_space"],
            "timing": sorted({r["timing"] for r in rs}),
            "n_timed": len(errs),
            "start_err_median": statistics.median(errs) if errs else None,
            "start_err_max": max(errs) if errs else None,
            "start_err_signed_median": statistics.median(signed) if signed else None,
            "proc_sec": sum(r["proc_sec"] for r in rs),
            "upload_sec": sum(r.get("upload_sec", 0.0) for r in rs),
            "requests": sum(r["requests"] for r in rs),
            "retries": sum(r["retries"] for r in rs),
            "billed_sec": billed,
            "cost_usd": billed / 60 * GoogleChirp3Engine.USD_PER_MIN,
        }
    return out


def to_markdown(report: dict) -> str:
    s = report["summary"]
    tr = report["tracks"]
    lines = [
        f"# 긴 트랙 Chirp 3 방식 비교 — {report['run_id']}",
        "",
        "- 트랙: " + ", ".join(f"{t['id']}({t['gender']}, {t['duration']:.1f}초, 문장 {t['n_sentences']}개,"
                                f" 긴 침묵 {len(t['long_silences'])}번)" for t in tr),
        "- CER: 트랙마다 정답 문장을 이어 붙인 것 기준(지금 채점 규칙), 트랙 합.",
        f"- 놓친 문장: 정답 문장 글자의 {FOUND_RATIO:.0%} 미만만 받아쓴 글과 맞은 문장.",
        "- 시각 오차: 찾은 문장마다 |받아쓴 글에서 그 문장 첫 맞은 글자의 시각 − 정답 말소리 시작|.",
        "  구간 시각뿐이면 구간 안에서 글자 시각을 고르게 나눠 어림한다.",
        f"- Chirp 장부: 이 실행 전 {report['ledger_before_sec']:.0f}초, 후 {report['ledger_after_sec']:.0f}초 / 상한 {report['budget_sec']:.0f}초",
        "",
        "| 방식 | CER | 공백 포함 CER | 놓친 문장 | 시각 오차 중앙값 / 최대 (초) | 처리 시간(초) | 요청 | 매긴 초 | 비용 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for m in report["methods"]:
        x = s[m]
        if not x.get("n_tracks"):
            lines.append(f"| {METHOD_LABEL[m]} | 실패 | | | | | | | |")
            continue
        if x["n_timed"]:
            terr = f"{x['start_err_median']:.2f} / {x['start_err_max']:.2f} ({x['n_timed']}문장)"
        else:
            terr = "시각 없음"
        proc = f"{x['proc_sec']:.1f}" + (f" (+올리기 {x['upload_sec']:.1f})" if x["upload_sec"] else "")
        lines.append(
            f"| {METHOD_LABEL[m]} | {x['cer_nospace']:.2%} ({x['edits_nospace']}/{x['ref_chars_nospace']})"
            f" | {x['cer_space']:.2%} ({x['edits_space']}/{x['ref_chars_space']})"
            f" | {x['n_missed']}/{x['n_sentences']} | {terr} | {proc} | {x['requests']}"
            f" | {x['billed_sec']:.0f} | ${x['cost_usd']:.4f} |"
        )
    lines.append("")
    return "\n".join(lines)
