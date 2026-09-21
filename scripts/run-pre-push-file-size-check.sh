#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
merge_base=$("$script_dir/resolve-pre-push-base.sh" --merge-base)
CHECK_FILE_SIZES_BASE=$merge_base just file-size-check
