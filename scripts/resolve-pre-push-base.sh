#!/usr/bin/env bash
# Resolve the integration base shared by every path-scoped pre-push gate.
set -euo pipefail

fetch=0
print_merge_base=0
for arg in "$@"; do
  case "$arg" in
    --fetch) fetch=1 ;;
    --merge-base) print_merge_base=1 ;;
    *)
      echo "Unknown resolve-pre-push-base option: $arg" >&2
      exit 2
      ;;
  esac
done

configured=0
branch=$(git symbolic-ref --quiet --short HEAD || true)
if [ -n "$branch" ] && base_ref=$(git config --get "branch.${branch}.base"); then
  configured=1
  if [ -z "$base_ref" ]; then
    echo "branch.${branch}.base is empty; configure a full refs/heads/... or refs/remotes/... ref." >&2
    exit 1
  fi
else
  base_ref=refs/remotes/origin/main
fi

case "$base_ref" in
  refs/heads/*|refs/remotes/*) ;;
  *)
    echo "Invalid pre-push base '$base_ref': use a full refs/heads/... or refs/remotes/... ref." >&2
    exit 1
    ;;
esac

if ! git check-ref-format "$base_ref" >/dev/null 2>&1; then
  echo "Invalid pre-push base ref '$base_ref'." >&2
  exit 1
fi

case "$base_ref" in
  refs/remotes/*)
    remote_path=${base_ref#refs/remotes/}
    remote=${remote_path%%/*}
    remote_branch=${remote_path#*/}
    if [ "$remote" = "$remote_path" ] || [ -z "$remote_branch" ] || \
      ! git remote get-url "$remote" >/dev/null 2>&1; then
      echo "Cannot map pre-push base '$base_ref' to a configured remote branch." >&2
      exit 1
    fi
    if [ "$fetch" -eq 1 ]; then
      if ! git fetch --quiet "$remote" \
        "+refs/heads/${remote_branch}:${base_ref}"; then
        echo "Failed to refresh pre-push base '$base_ref'." >&2
        exit 1
      fi
    fi
    ;;
esac

if ! git show-ref --verify --quiet "$base_ref" || \
  ! git cat-file -e "${base_ref}^{commit}" 2>/dev/null; then
  if [ "$configured" -eq 1 ]; then
    echo "Configured pre-push base '$base_ref' is missing or is not a commit." >&2
  else
    echo "Default pre-push base origin/main is missing; fetch origin/main first." >&2
  fi
  exit 1
fi

base_sha=$(git rev-parse "${base_ref}^{commit}")
head_sha=$(git rev-parse "HEAD^{commit}")
if [ "$configured" -eq 1 ] && [ "$base_sha" = "$head_sha" ]; then
  echo "Configured pre-push base '$base_ref' resolves to HEAD and would disable differential checks." >&2
  exit 1
fi

merge_base=$(git merge-base HEAD "$base_ref") || {
  echo "Pre-push base '$base_ref' has no merge base with HEAD." >&2
  exit 1
}

if [ "$print_merge_base" -eq 1 ]; then
  printf '%s\n' "$merge_base"
else
  printf '%s\n' "$base_ref"
fi
