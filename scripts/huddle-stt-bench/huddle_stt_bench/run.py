"""manifest 를 읽어 엔진마다 받아쓰고, CER·RTF·처리 시간·실패 수·예상 비용을 낸다."""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

import soundfile as sf

from .engines import engine_for_rescore
from .metrics import char_errors, drop_parenthesized

ROOT = Path(__file__).resolve().parent.parent
METRIC_KEYS = ("nospace", "space", "noparen")


@dataclass
class Item:
    id: str
    audio: Path
    text: str
    duration: float


def load_manifest(path: Path, limit: int | None = None) -> list[Item]:
    """JSONL 한 줄에 {"id", "audio", "text"}. audio 가 상대 경로면 manifest 파일 위치 기준이다."""
    items = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        rec = json.loads(line)
        for key in ("id", "audio", "text"):
            if key not in rec:
                raise ValueError(f"{path}:{n} 에 '{key}' 가 없다")
        audio = Path(rec["audio"])
        if not audio.is_absolute():
            audio = (path.parent / audio).resolve()
        items.append(Item(str(rec["id"]), audio, rec["text"], sf.info(str(audio)).duration))
        if limit and len(items) >= limit:
            break
    return items


def machine_info(num_threads: int) -> dict:
    cpu = ""
    if sys.platform == "darwin":
        try:
            cpu = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=5
            ).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    elif Path("/proc/cpuinfo").exists():
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    return {
        "cpu": cpu or platform.processor() or "알 수 없음",
        "cpu_count": os.cpu_count(),
        "local_num_threads": num_threads,
        "os": platform.platform(),
        "python": platform.python_version(),
        "sherpa_onnx": metadata.version("sherpa-onnx"),
    }


def _rel(path: Path) -> str:
    """결과 파일에 절대 경로가 박히지 않게 이 도구 폴더 기준 상대 경로로 적는다."""
    return Path(os.path.relpath(path, ROOT)).as_posix()


def _scrub(msg: str) -> str:
    """오류 글에 섞인 이 도구 폴더·홈 폴더 경로를 줄인다."""
    return msg.replace(str(ROOT), ".").replace(str(Path.home()), "~")


def score_item(rec: dict) -> None:
    """rec 의 ref·hyp 로 채점 칸을 (다시) 채운다. 실패한 파일은 칸을 비운다."""
    for kind in METRIC_KEYS:
        rec.pop(f"edits_{kind}", None)
        rec.pop(f"ref_chars_{kind}", None)
    if rec["error"] is not None:
        return
    ref, hyp = rec["ref"], rec["hyp"]
    rec["edits_nospace"], rec["ref_chars_nospace"] = char_errors(ref, hyp, keep_spaces=False)
    rec["edits_space"], rec["ref_chars_space"] = char_errors(ref, hyp, keep_spaces=True)
    # 참고값: 정답에서 괄호 안 글을 빼고 센 공백 뺀 CER
    rec["edits_noparen"], rec["ref_chars_noparen"] = char_errors(drop_parenthesized(ref), hyp, keep_spaces=False)


def _one(engine, item: Item) -> dict:
    t0 = time.perf_counter()
    extra: dict = {}
    try:
        out = engine.transcribe(item.audio)
        hyp, extra = out if isinstance(out, tuple) else (out, {})
        error = None
    except Exception as e:  # 한 파일 실패가 나머지를 막지 않게 한다
        hyp, error = "", _scrub(f"{type(e).__name__}: {str(e)[:300]}")
    proc = time.perf_counter() - t0
    rec = {
        "id": item.id,
        "audio_sec": round(item.duration, 3),
        "proc_sec": round(proc, 3),
        "ref": item.text,
        "hyp": hyp,
        "error": error,
        **extra,
    }
    score_item(rec)
    return rec


def run_engine(engine, items: list[Item], concurrency: int) -> dict:
    out: dict = {"engine": engine.name, "kind": engine.kind}
    if engine.note:
        out["note"] = engine.note
    t0 = time.perf_counter()
    try:
        skip = engine.prepare()
    except Exception as e:
        skip = _scrub(f"준비 실패 {type(e).__name__}: {str(e)[:300]}")
    out["prepare_sec"] = round(time.perf_counter() - t0, 3)
    if skip:
        out["skipped"] = skip
        print(f"[{engine.name}] 건너뜀: {skip}", file=sys.stderr, flush=True)
        return out

    workers = concurrency if engine.kind == "remote" else 1
    t1 = time.perf_counter()
    done = 0

    def task(item: Item) -> dict:
        nonlocal done
        rec = _one(engine, item)
        done += 1
        mark = "실패 " + rec["error"] if rec["error"] else f"{rec['proc_sec']:.2f}s"
        print(f"[{engine.name}] {done}/{len(items)} {item.id} {mark}", file=sys.stderr, flush=True)
        return rec

    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(task, items))
    out["wall_sec"] = round(time.perf_counter() - t1, 3)
    out["concurrency"] = workers
    out["items"] = results
    out["summary"] = summarize(engine, results)
    out["warnings"] = engine_warnings(engine, out["summary"])
    return out


def _pieces(r: dict) -> int:
    return int(r.get("pieces", r.get("requests", 1)))  # 옛 결과 파일은 chirp 만 "requests" 로 적었다


def summarize(engine, results: list[dict]) -> dict:
    ok = [r for r in results if r["error"] is None]
    audio_all = sum(r["audio_sec"] for r in results)
    audio_ok = sum(r["audio_sec"] for r in ok)
    proc_ok = sum(r["proc_sec"] for r in ok)
    # 여러 파일을 합친 CER = 편집 거리 합 / 정답 글자 수 합 (성공한 파일만)
    sums = {
        kind: (sum(r[f"edits_{kind}"] for r in ok), sum(r[f"ref_chars_{kind}"] for r in ok)) for kind in METRIC_KEYS
    }
    chunked = [r for r in results if _pieces(r) > 1]
    billed = [r["billed_sec"] for r in results if "billed_sec" in r]
    if billed and hasattr(engine, "cost_billed"):
        cost, basis = engine.cost_billed(sum(billed)), "billed"  # 서비스가 실제로 매긴 초
    else:
        cost, basis = sum(engine.cost(r["audio_sec"]) for r in results), "audio"  # 오디오 길이로 어림
    return {
        "n": len(results),
        "n_ok": len(ok),
        "n_fail": len(results) - len(ok),
        **{f"cer_{k}": (e / n if n else None) for k, (e, n) in sums.items()},
        **{f"edits_{k}_total": e for k, (e, _) in sums.items()},
        **{f"ref_chars_{k}_total": n for k, (_, n) in sums.items()},
        "n_chunked": len(chunked),
        "chunked_pieces_total": sum(_pieces(r) for r in chunked),
        "n_resplit": sum(1 for r in results if r.get("resplit_after_cap")),
        "n_capped": sum(1 for r in results if r.get("capped_pieces")),
        "retries_total": sum(r.get("retries", 0) for r in results),
        "audio_sec": round(audio_all, 3),
        "proc_sec_total": round(sum(r["proc_sec"] for r in results), 3),
        "rtf": proc_ok / audio_ok if audio_ok else None,
        **({"billed_sec_total": round(sum(billed), 3)} if billed else {}),
        "cost": round(cost, 4),
        "cost_basis": basis,
        "cost_currency": engine.currency,
        "cost_per_hour": round(engine.cost(3600.0), 4),
    }


def engine_warnings(engine, s: dict) -> list[str]:
    """결과 표 아래에 붙일 경고. 조각으로 잘라 넣은 파일이 있거나 한도에 닿았으면 알린다."""
    w = []
    if s["n_chunked"]:
        w.append(
            f"{engine.name}: 파일 {s['n_chunked']}개를 VAD 조각으로 잘라 넣었다(조각 {s['chunked_pieces_total']}개)."
            f" 긴 오디오의 CER 은 자르는 방식에 따라 달라진다. {engine.chunk_note}".strip()
        )
    if s["n_resplit"]:
        w.append(f"{engine.name}: 파일 {s['n_resplit']}개는 한 번에 넣었다가 토큰 한도에 닿아 잘라서 다시 돌렸다.")
    if s["n_capped"]:
        w.append(f"{engine.name}: 파일 {s['n_capped']}개는 잘라 넣은 뒤에도 토큰 한도에 닿았다. 글이 잘렸을 수 있다.")
    if s["retries_total"]:
        w.append(f"{engine.name}: 429·5xx·연결 끊김으로 다시 보낸 요청 {s['retries_total']}번.")
    return w


def add_common(report: dict) -> None:
    """모든 엔진이 성공한 파일만 모아 엔진마다 CER 을 낸다(실패가 다른 엔진끼리 공정하게 비교하려고)."""
    ran = [e for e in report["engines"] if "items" in e]
    ok_sets = [{r["id"] for r in e["items"] if r["error"] is None} for e in ran]
    common = set.intersection(*ok_sets) if ok_sets else set()
    report["n_common_ok"] = len(common)
    for e in ran:
        rs = [r for r in e["items"] if r["id"] in common]
        ed, n = sum(r["edits_nospace"] for r in rs), sum(r["ref_chars_nospace"] for r in rs)
        e["summary"].update({"cer_common": ed / n if n else None, "edits_common_total": ed, "ref_chars_common_total": n})


def _fmt(v, spec: str) -> str:
    return "—" if v is None else format(v, spec)


def _cer(s: dict, kind: str) -> str:
    if s.get(f"cer_{kind}") is None:
        return "—"
    return f"{s[f'cer_{kind}']:.2%} ({s[f'edits_{kind}_total']}/{s[f'ref_chars_{kind}_total']})"


def _money(amount: float, currency: str) -> str:
    if not currency:
        return "0 (로컬)"
    return f"${amount:,.4f}"


def to_markdown(report: dict) -> str:
    env = report["machine"]
    lines = [
        f"# STT 측정 결과 — {report['started_at']}",
        "",
        f"- manifest: `{report['manifest']}` ({report['n_items']}개, 오디오 합계 {report['audio_sec_total']:.1f}초)",
        f"- 돌린 곳: {env['cpu']} · 논리 코어 {env['cpu_count']}개 · 로컬 엔진 스레드 {env['local_num_threads']}개"
        f" · {env['os']} · Python {env['python']} · sherpa-onnx {env['sherpa_onnx']}",
        "- CER: NFKC → 폭 없는 글자(Cf) 제거 → 문장부호 제거(`%` 와 숫자 사이 소수점은 남김) → 공백 제거 → 글자 편집 거리."
        " 칸은 `비율 (편집 거리 합/정답 글자 수 합)`. 성공한 파일만 센다.",
        "- 숫자 표기 차이(\"세 시\" vs \"3시\")와 영문 대소문자 차이도 오류로 섞여 있다.",
        f"- 모든 엔진 성공: 돌린 엔진이 모두 성공한 파일 {report['n_common_ok']}개만 센 CER.",
        "- 참고: 괄호 뺀 CER = 정답에서 괄호 안 글을 지우고 센 CER. FLEURS 정답에는 읽지 않은 괄호 병기가 있어서 같이 낸다.",
        "- RTF = 처리 시간 / 오디오 길이(성공한 파일만). 원격 엔진은 업로드·네트워크 왕복이 다 들어간다.",
    ]
    if report.get("rescored_at"):
        lines.append(f"- 다시 채점: {report['rescored_at']}. {report['rescore_note']}")
    lines += [
        "",
        "| 엔진 | 개수(성공/전체) | CER | 공백 포함 CER | 모든 엔진 성공 CER | 참고: 괄호 뺀 CER | RTF | 총 처리 시간(초)"
        " | 준비 시간(초) | 실패 | 예상 비용(이번 오디오) | 1시간 기준 |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for e in report["engines"]:
        if "skipped" in e:
            lines.append(f"| {e['engine']} | 건너뜀: {e['skipped']} | | | | | | | | | | |")
            continue
        s = e["summary"]
        cost = _money(s["cost"], s["cost_currency"])
        if s.get("cost_basis") == "billed":
            cost += f" (매긴 {s['billed_sec_total']:g}초)"
        lines.append(
            f"| {e['engine']} | {s['n_ok']}/{s['n']} | {_cer(s, 'nospace')} | {_cer(s, 'space')} | {_cer(s, 'common')}"
            f" | {_cer(s, 'noparen')} | {_fmt(s['rtf'], '.3f')} | {s['proc_sec_total']:.1f} | {e['prepare_sec']:.1f}"
            f" | {s['n_fail']} | {cost} | {_money(s['cost_per_hour'], s['cost_currency'])} |"
        )
    notes = [e["note"] for e in report["engines"] if e.get("note")]
    notes += [w for e in report["engines"] for w in e.get("warnings", [])]
    if notes:
        lines.append("")
        lines.extend(f"- {n}" for n in notes)
    lines.append("")
    return "\n".join(lines)


def _write(report: dict, json_path: Path) -> None:
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md = to_markdown(report)
    json_path.with_suffix(".md").write_text(md, encoding="utf-8")
    print(md)
    print(f"결과: {_rel(json_path)}", file=sys.stderr)


def run(manifest: Path, engines: list, out_dir: Path, concurrency: int, num_threads: int, limit: int | None) -> Path:
    started = datetime.now(timezone.utc).astimezone()
    items = load_manifest(manifest, limit)
    report = {
        "started_at": started.isoformat(timespec="seconds"),
        "manifest": _rel(manifest),
        "n_items": len(items),
        "audio_sec_total": round(sum(i.duration for i in items), 3),
        "machine": machine_info(num_threads),
        "engines": [],
    }
    for engine in engines:
        report["engines"].append(run_engine(engine, items, concurrency))
    add_common(report)

    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{started.strftime('%Y%m%d-%H%M%S')}-{manifest.parent.name}.json"
    _write(report, json_path)
    return json_path


def rescore(json_path: Path, cache_dir: Path) -> None:
    """이미 있는 결과 JSON 의 ref·hyp 를 지금 채점 규칙으로 다시 세어 같은 자리에 다시 쓴다.

    받아쓰기는 다시 돌리지 않는다(클라우드 요금 없음). 처리 시간·RTF·비용 근거는 그대로 둔다.
    """
    report = json.loads(json_path.read_text(encoding="utf-8"))
    for e in report["engines"]:
        if "items" not in e:
            continue
        for rec in e["items"]:
            score_item(rec)
        engine = engine_for_rescore(e["engine"], cache_dir)
        e["summary"] = summarize(engine, e["items"])
        e["warnings"] = engine_warnings(engine, e["summary"])
    add_common(report)
    report["rescored_at"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    report["rescore_note"] = "지금 채점 규칙으로 ref/hyp 를 다시 셌다. 받아쓰기는 다시 돌리지 않았다."
    _write(report, json_path)
