#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"

cat > "$tmp/bin/git" <<'STUB'
#!/usr/bin/env bash
case "$*" in
    "rev-parse --show-toplevel") printf '%s\n' "$BUZZ_TEST_REPO_ROOT" ;;
    "rev-parse --is-inside-work-tree") printf 'true\n' ;;
    "rev-parse --git-dir") printf '%s\n' "$BUZZ_TEST_REPO_ROOT/.git/worktrees/identity-test" ;;
    "rev-parse --git-common-dir") printf '%s\n' "$BUZZ_TEST_REPO_ROOT/.git" ;;
    "rev-parse --abbrev-ref HEAD") printf 'feat/identity-test\n' ;;
    *) echo "unexpected git invocation: $*" >&2; exit 2 ;;
esac
STUB

cat > "$tmp/bin/uname" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$BUZZ_TEST_PLATFORM"
STUB

cat > "$tmp/bin/swift" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB

cat > "$tmp/bin/security" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BUZZ_TEST_CREDENTIAL_CALLS"
printf '{"identity":"nsec-keychain"}\n'
STUB

cat > "$tmp/bin/secret-tool" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BUZZ_TEST_CREDENTIAL_CALLS"
printf '{"identity":"nsec-keychain"}\n'
STUB

chmod +x \
    "$tmp/bin/git" \
    "$tmp/bin/uname" \
    "$tmp/bin/swift" \
    "$tmp/bin/security" \
    "$tmp/bin/secret-tool"

run_case() {
    local platform="$1"
    local mode="$2"
    local file_state="$3"
    local case_dir="$tmp/${platform}-${mode}-${file_state}"
    local home_dir="$case_dir/home"
    local calls="$case_dir/credential-calls"
    local secrets_dir
    local fallback_dir="$home_dir/Library/Application Support/xyz.block.buzz.app.dev"
    if [[ "$platform" == "Darwin" ]]; then
        secrets_dir="$home_dir/Library/Application Support/xyz.block.buzz.app.dev"
    else
        secrets_dir="$home_dir/.local/share/xyz.block.buzz.app.dev"
    fi
    local secrets_file="$secrets_dir/secrets.buzz-desktop-dev.json"

    mkdir -p "$secrets_dir" "$fallback_dir"
    : > "$calls"
    if [[ "$file_state" == "present" ]]; then
        printf '{"identity":"nsec-file"}\n' > "$secrets_file"
    else
        printf 'nsec-fallback\n' > "$fallback_dir/identity.key"
    fi

    local identity
    identity="$({
        cd "$repo_root"
        HOME="$home_dir" \
        PATH="$tmp/bin:$PATH" \
        BUZZ_SHARE_IDENTITY=1 \
        BUZZ_DEV_USE_KEYCHAIN="$([[ "$mode" == "keychain" ]] && printf 1 || printf 0)" \
        BUZZ_TEST_CREDENTIAL_CALLS="$calls" \
        BUZZ_TEST_PLATFORM="$platform" \
        BUZZ_TEST_REPO_ROOT="$repo_root" \
        bash -c 'unset BUZZ_PRIVATE_KEY; source scripts/instance-env.sh >/dev/null 2>&1; printf "%s" "${BUZZ_PRIVATE_KEY:-}"'
    })"

    local call_count
    call_count="$(wc -l < "$calls" | tr -d ' ')"

    if [[ "$mode" == "keychain" ]]; then
        [[ "$call_count" == "1" ]] || {
            echo "FAIL: keychain mode with file $file_state must invoke security exactly once (got $call_count)" >&2
            return 1
        }
        if [[ "$platform" == "Darwin" ]]; then
            grep -Fx -- "find-generic-password -s buzz-desktop-dev -a secrets -w" "$calls" >/dev/null
        else
            grep -Fx -- "lookup service buzz-desktop-dev username secrets target default" "$calls" >/dev/null
        fi
        [[ "$identity" == "nsec-keychain" ]] || {
            echo "FAIL: keychain mode with file $file_state must use keychain identity (got '$identity')" >&2
            return 1
        }
    else
        [[ "$call_count" == "0" ]] || {
            echo "FAIL: file mode with file $file_state must not invoke security (got $call_count)" >&2
            return 1
        }
        if [[ "$file_state" == "present" ]]; then
            [[ "$identity" == "nsec-file" ]] || {
                echo "FAIL: file mode with a secrets file must use its identity (got '$identity')" >&2
                return 1
            }
        else
            [[ "$identity" == "nsec-fallback" ]] || {
                echo "FAIL: file mode without a secrets file must use identity.key fallback (got '$identity')" >&2
                return 1
            }
        fi
    fi

    printf 'ok: %s, %s mode, file %s\n' "$platform" "$mode" "$file_state"
}

for platform in Darwin Linux; do
    run_case "$platform" file present
    run_case "$platform" file absent
    run_case "$platform" keychain present
    run_case "$platform" keychain absent
done

echo "instance-env identity backend test passed"
