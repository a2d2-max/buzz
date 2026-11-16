#!/usr/bin/env bash
# 회의록 작업기 이미지를 Cloud Build 로 만든다. 배포는 하지 않는다.
#   build-image.sh <커밋>
# 빌드 문맥은 그 커밋의 깨끗한 소스(git archive)다. worktree 의 고치는 중인
# 파일은 섞이지 않는다. Dockerfile 만 이 폴더 것을 쓴다(아직 커밋 전일 수 있어서).
# 로컬 docker 는 쓰지 않는다.
set -Eeuo pipefail
export LC_ALL=C

commit=${1:?빌드할 커밋}
project=a2d2-lab
region=asia-northeast3
image=asia-northeast3-docker.pkg.dev/a2d2-lab/services/a2d2-huddle-minutes

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
full="$(git -C "$repo" rev-parse --verify "${commit}^{commit}")"
short="$(git -C "$repo" rev-parse --short=9 "$full")"

work="$(mktemp -d "${TMPDIR:-/tmp}/huddle-minutes-build.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Rust 빌드에 필요한 것만: 작업 공간 정의, 잠금 파일, 도구 버전, cargo 설정,
# 크레이트들(작업 공간 멤버를 다 읽어야 해서 crates·examples 전부).
git -C "$repo" archive --format=tar "$full" -- \
  Cargo.toml Cargo.lock rust-toolchain.toml .cargo crates examples |
  tar -x -C "$work"
mkdir -p "$work/deploy/a2d2/huddle-minutes"
cp "$here/Dockerfile" "$work/deploy/a2d2/huddle-minutes/Dockerfile"

echo "커밋 $full → $image:$short"
echo "빌드 문맥 $(du -sh "$work" | cut -f1)"
gcloud builds submit "$work" \
  --project "$project" \
  --region "$region" \
  --config "$here/cloudbuild.yaml" \
  --substitutions "_IMAGE=$image,_TAG=$short,_SOURCE_SHA=$full"

digest="$(gcloud artifacts docker images describe "$image:$short" \
  --project "$project" --format='value(image_summary.digest)')"
echo "이미지 $image@$digest"
