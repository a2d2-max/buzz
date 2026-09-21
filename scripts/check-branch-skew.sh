#!/usr/bin/env bash
# Pre-push guard: local runs on a skewed feature branch can pass while its
# configured integration build fails. Block the push only when the integration
# base has changed files this branch also touches.
set -euo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
branch=$(git symbolic-ref --quiet --short HEAD || printf 'HEAD')
if [ "$branch" = "main" ] || [ "$branch" = "HEAD" ]; then
  exit 0
fi

base_ref=$("$script_dir/resolve-pre-push-base.sh" --fetch)
base=$(git merge-base HEAD "$base_ref")
base_tip=$(git rev-parse "${base_ref}^{commit}")

if [ "$base" = "$base_tip" ]; then
  exit 0
fi

overlap=$(comm -12 \
  <(git diff --name-only "$base" "$base_ref" -- | sort) \
  <(git diff --name-only "$base" HEAD -- | sort))

if [ -z "$overlap" ]; then
  exit 0
fi

{
  echo "Branch is behind $base_ref, and that base changed files this branch also touches:"
  printf '%s\n' "$overlap" | awk '{ print "  " $0 }'
  echo "Local checks ran on a tree the integration build will never test. Integrate"
  echo "$base_ref, resolve, re-run checks, then push."
} >&2
exit 1
