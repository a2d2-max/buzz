#!/usr/bin/env bash
# 껍데기 .ipk 패키징. ares CLI(@webos-tools/cli)가 필요하다 — scripts/README.md 참조.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v ares-package >/dev/null 2>&1; then
  echo "ares-package 가 없습니다. 먼저 설치하세요: npm install -g @webos-tools/cli" >&2
  exit 1
fi

OUT_DIR="${1:-dist-ipk}"
mkdir -p "$OUT_DIR"
ares-package ./webos --outdir "$OUT_DIR"
echo "완료: $OUT_DIR/ 안의 .ipk"
