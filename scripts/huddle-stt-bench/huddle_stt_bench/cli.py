"""huddle-stt-bench 명령줄.

  huddle-stt-bench fetch-fleurs --n 30
  huddle-stt-bench run --manifest .cache/fleurs-ko-test/manifest.jsonl
  huddle-stt-bench rescore results/<결과>.json
"""

from __future__ import annotations

import argparse
from pathlib import Path

from . import engines, fetch, long_compare, run

GCP_PROJECT = "a2d2-lab"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CACHE = ROOT / ".cache"
DEFAULT_ENGINES = "chirp3,qwen3-asr,sense-voice"


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="huddle-stt-bench", description="한국어 STT 엔진 비교 측정")
    p.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE, help="모델·데이터·결과 캐시 (기본: %(default)s)")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch-fleurs", help="FLEURS 한국어 일부를 받아 manifest 를 만든다")
    f.add_argument("--n", type=int, default=30, help="문장 개수 (기본: %(default)s)")
    f.add_argument("--split", default="test", choices=["test", "dev"])

    r = sub.add_parser("run", help="manifest 로 엔진들을 돌리고 결과를 쓴다")
    r.add_argument("--manifest", type=Path, required=True, help="JSONL: 줄마다 {id, audio, text}")
    r.add_argument("--engines", default=DEFAULT_ENGINES, help=f"쉼표로 구분. 가능: {engines.ENGINE_HELP} (기본: %(default)s)")
    r.add_argument(
        "--out",
        type=Path,
        default=None,
        help="결과 폴더 (기본: <cache-dir>/results, 저장소에 안 들어감). FLEURS 결과를 저장소에 남길 때만 --out results",
    )
    r.add_argument("--num-threads", type=int, default=4, help="로컬 엔진 스레드 수 (기본: %(default)s)")
    r.add_argument("--concurrency", type=int, default=4, help="원격 엔진 동시 요청 수 (기본: %(default)s)")
    r.add_argument("--long-audio-sec", type=float, default=30.0,
                   help="이보다 긴 오디오는 VAD 로 잘라 넣는다. qwen3-asr 는 토큰 예산을 따로 재서 더 짧아도 자른다 (기본: %(default)s초)")
    r.add_argument("--gcp-project", default=GCP_PROJECT, help="chirp3 를 부를 GCP 프로젝트 (기본: %(default)s)")
    r.add_argument("--gcp-auth", default="adc", choices=["adc", "gcloud"],
                   help="chirp3 인증. adc=ADC·서비스 계정, gcloud=gcloud 에 지금 로그인한 계정 (기본: %(default)s)")
    r.add_argument("--limit", type=int, default=None, help="앞에서 몇 개만 (시험용)")

    s = sub.add_parser("rescore", help="이미 있는 결과 JSON 을 지금 채점 규칙으로 다시 센다(받아쓰기는 안 돌림)")
    s.add_argument("result_json", type=Path)

    lc = sub.add_parser("long-compare", help="긴 트랙을 Chirp 3 에 보내는 방식(A·A2·B·Bw)을 비교한다")
    lc.add_argument("--tracks", type=int, default=2, help="사람(트랙) 수 (기본: %(default)s)")
    lc.add_argument("--track-sec", type=float, default=240.0, help="트랙 길이 하한(초) (기본: %(default)s)")
    lc.add_argument("--speech-sec", type=float, default=120.0, help="트랙마다 문장 클립 합(초) (기본: %(default)s)")
    lc.add_argument("--seed", type=int, default=20261012)
    lc.add_argument("--methods", default="A,A2,B,Bw", help="쉼표로 구분 (기본: %(default)s)")
    lc.add_argument("--budget-sec", type=float, default=1800.0,
                    help="Chirp 가 매긴 초 상한. 장부(.cache/long-compare/chirp-ledger.jsonl)에 이어서 센다 (기본: %(default)s)")
    lc.add_argument("--gcp-project", default=GCP_PROJECT)
    lc.add_argument("--gcp-auth", default="adc", choices=["adc", "gcloud"])
    lc.add_argument("--gcs-prefix", default=long_compare.DEFAULT_GCS_PREFIX,
                    help=f"BatchRecognize 입력을 올릴 곳. {long_compare.GCS_ALLOWED_PREFIX} 아래만 허용 (기본: %(default)s)")
    lc.add_argument("--concurrency", type=int, default=4, help="Recognize 동시 요청 수 (기본: %(default)s)")
    lc.add_argument("--dry-run", action="store_true", help="트랙과 계획(예상 매긴 초)만 만들고 아무것도 보내지 않는다")

    args = p.parse_args(argv)
    cache_dir = args.cache_dir.resolve()

    if args.cmd == "fetch-fleurs":
        fetch.fetch_fleurs(cache_dir / f"fleurs-ko-{args.split}", args.n, args.split)
        return
    if args.cmd == "rescore":
        run.rescore(args.result_json.resolve(), cache_dir)
        return
    if args.cmd == "long-compare":
        long_compare.long_compare(
            cache_dir, args.tracks, args.track_sec, args.speech_sec, args.seed,
            [m.strip() for m in args.methods.split(",") if m.strip()], args.budget_sec,
            args.gcp_project, args.gcp_auth, args.gcs_prefix, args.concurrency, args.dry_run,
        )
        return

    built = [
        engines.make_engine(
            spec.strip(), cache_dir, args.num_threads, args.long_audio_sec, args.gcp_project, args.gcp_auth
        )
        for spec in args.engines.split(",")
        if spec.strip()
    ]
    out_dir = args.out if args.out is not None else cache_dir / "results"
    run.run(args.manifest.resolve(), built, out_dir.resolve(), args.concurrency, args.num_threads, args.limit)


if __name__ == "__main__":
    main()
