#!/usr/bin/env bash
# TV 에서 앱 실행. 사용법: ./scripts/launch.sh <device>
set -euo pipefail

DEVICE="${1:?사용법: launch.sh <device 이름>}"
ares-launch --device "$DEVICE" xyz.a2d2.tv
