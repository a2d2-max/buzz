#!/usr/bin/env bash
# TV(개발자 모드)에 .ipk 설치. 사용법: ./scripts/install.sh <device> [ipk]
set -euo pipefail

cd "$(dirname "$0")/.."

DEVICE="${1:?사용법: install.sh <device 이름> [ipk 경로]}"
IPK="${2:-$(ls -t dist-ipk/*.ipk 2>/dev/null | head -1)}"

if [ -z "$IPK" ]; then
  echo "설치할 .ipk 가 없습니다. 먼저 ./scripts/package.sh 를 돌리세요." >&2
  exit 1
fi

ares-install --device "$DEVICE" "$IPK"
ares-install --device "$DEVICE" --list
