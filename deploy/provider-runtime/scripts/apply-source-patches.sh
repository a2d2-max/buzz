#!/usr/bin/env bash
set -Eeuo pipefail

kit_root=$(cd "$(dirname "$0")/.." && pwd)
plane_checkout=${1:?Usage: apply-source-patches.sh PLANE_CHECKOUT AFFINE_CHECKOUT}
affine_checkout=${2:?Usage: apply-source-patches.sh PLANE_CHECKOUT AFFINE_CHECKOUT}

python3 "$kit_root/scripts/verify-provider-kit.py" --patches-only

preflight_one() {
  local name=$1
  local checkout=$2
  local expected_head=$3
  local patch=$4

  git -C "$checkout" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    echo "$name checkout is not a Git checkout: $checkout" >&2
    return 2
  }
  test "$(git -C "$checkout" rev-parse HEAD)" = "$expected_head" || {
    echo "$name checkout is not at the locked upstream commit" >&2
    return 2
  }
  if [[ -n $(git -C "$checkout" status --porcelain=v1 --untracked-files=all) ]]; then
    python3 "$kit_root/scripts/verify-provider-kit.py" \
      --provider "$name" --checkout "$checkout" >/dev/null || {
      echo "$name checkout is dirty but is not the exact applied patch" >&2
      return 2
    }
    printf 'already_applied'
    return 0
  fi
  git -C "$checkout" apply --check "$patch"
  printf 'needs_apply'
}

plane_state=$(preflight_one plane "$plane_checkout" \
  2f895b82dad839c730c36a5c0cbc046f1e5d6b56 \
  "$kit_root/patches/plane-a2d2.patch")
affine_state=$(preflight_one affine "$affine_checkout" \
  b4c8548c09da21b2898443559a5b846f0ccf5dd8 \
  "$kit_root/patches/affine-a2d2.patch")

if [[ $plane_state == needs_apply ]]; then
  git -C "$plane_checkout" apply "$kit_root/patches/plane-a2d2.patch"
fi
if [[ $affine_state == needs_apply ]]; then
  git -C "$affine_checkout" apply "$kit_root/patches/affine-a2d2.patch"
fi

python3 "$kit_root/scripts/verify-provider-kit.py" \
  --plane-checkout "$plane_checkout" \
  --affine-checkout "$affine_checkout"
