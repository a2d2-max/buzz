#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

kit_root=$(cd "$(dirname "$0")/.." && pwd)
builder=${A2D2_DOCKER_BUILDER:-desktop-linux}
plane_tag=${A2D2_PLANE_IMAGE_TAG:-a2d2-plane-backend:a2d2-managed}
affine_tag=${A2D2_AFFINE_IMAGE_TAG:-a2d2-affine-managed:0.27.4-a2d2}

write_overrides() {
  local output=$1 plane_image=$2 affine_image=$3
  [[ $plane_image =~ ^sha256:[0-9a-f]{64}$ && $affine_image =~ ^sha256:[0-9a-f]{64}$ ]]
  test ! -e "$output" || {
    echo "Runtime override output already exists: $output" >&2
    return 2
  }
  mkdir -m 700 "$output"
  cat >"$output/plane.candidate.override.yml" <<EOF
services:
  api:
    image: $plane_image
  worker:
    image: $plane_image
  beat-worker:
    image: $plane_image
EOF
  cat >"$output/affine.candidate.override.yml" <<EOF
services:
  affine:
    image: $affine_image
EOF
  chmod 600 "$output/plane.candidate.override.yml" "$output/affine.candidate.override.yml"
}

if [[ ${1:-} == --accepted-overrides ]]; then
  out=${2:?Usage: build-provider-images.sh --accepted-overrides OUT_DIR}
  python3 "$kit_root/scripts/verify-provider-kit.py" --patches-only >/dev/null
  read -r accepted_plane accepted_affine < <(python3 - "$kit_root/sources.lock.json" <<'PY'
import json, pathlib, sys
lock = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(lock["providers"]["plane"]["accepted_image_id"], lock["providers"]["affine"]["accepted_image_id"])
PY
  )
  write_overrides "$out" "$accepted_plane" "$accepted_affine"
  printf 'accepted_runtime_overrides=PASS\n'
  exit 0
fi

plane_checkout=${1:?Usage: build-provider-images.sh PLANE_CHECKOUT AFFINE_CHECKOUT OUT_DIR}
affine_checkout=${2:?Usage: build-provider-images.sh PLANE_CHECKOUT AFFINE_CHECKOUT OUT_DIR}
out=${3:?Usage: build-provider-images.sh PLANE_CHECKOUT AFFINE_CHECKOUT OUT_DIR}

python3 "$kit_root/scripts/verify-provider-kit.py" \
  --plane-checkout "$plane_checkout" \
  --affine-checkout "$affine_checkout"

test ! -e "$out/plane" || {
  echo "Plane output already exists: $out/plane" >&2
  exit 2
}
test ! -e "$out/affine" || {
  echo "AFFiNE output already exists: $out/affine" >&2
  exit 2
}
mkdir -p "$out/plane" "$out/affine"

python3 - "$plane_checkout/apps/api/Dockerfile.api" "$out/plane/Dockerfile.api.locked" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
unpinned = "FROM python:3.12.12-alpine\n"
pinned = (
    "FROM python:3.12.12-alpine@"
    "sha256:2d91681153dd4b8cdb52d4fd34a17b9edbafa4dd3086143cfd4b6c3a84c1acb0\n"
)
if source.count(unpinned) != 1:
    raise SystemExit("Plane Dockerfile base declaration does not match the reviewed source")
Path(sys.argv[2]).write_text(source.replace(unpinned, pinned, 1))
PY

docker buildx build \
  --builder "$builder" \
  --platform linux/amd64 \
  --pull \
  --load \
  -f "$out/plane/Dockerfile.api.locked" \
  -t "$plane_tag" \
  "$plane_checkout/apps/api" 2>&1 | tee "$out/plane/image-build.log"

plane_image=$(docker image inspect "$plane_tag" --format '{{.Id}}')
test "$(docker image inspect "$plane_tag" --format '{{.Architecture}}/{{.Os}}')" = amd64/linux
docker save "$plane_tag" | gzip -1 > "$out/plane/plane-backend-linux-amd64.tar.gz"
plane_archive=$(shasum -a 256 "$out/plane/plane-backend-linux-amd64.tar.gz" | awk '{print $1}')
cat > "$out/plane/image-build-result.txt" <<EOF
image_tag=$plane_tag
image_id=$plane_image
platform=amd64/linux
archive_sha256=$plane_archive
source_delta_sha256=$(python3 "$kit_root/scripts/verify-provider-kit.py" --print-delta-sha plane)
EOF

A2D2_DOCKER_BUILDER="$builder" \
  "$affine_checkout/deploy/a2d2/build-managed-image.sh" "$out/affine" "$affine_tag"
cat >> "$out/affine/image-build-result.txt" <<EOF
source_delta_sha256=$(python3 "$kit_root/scripts/verify-provider-kit.py" --print-delta-sha affine)
EOF

affine_image=$(awk -F= '$1=="image_id" {print $2}' "$out/affine/image-build-result.txt")
write_overrides "$out/runtime-overrides" "$plane_image" "$affine_image"

echo "provider_image_build=PASS"
