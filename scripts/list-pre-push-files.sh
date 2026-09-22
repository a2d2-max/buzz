#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
base_ref=$("$script_dir/resolve-pre-push-base.sh")
git diff --name-only "${base_ref}...HEAD" --
