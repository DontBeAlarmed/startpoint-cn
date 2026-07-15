#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LAUNCHER="$ROOT/scripts/start-cn.sh"
passed=0

pass() {
    passed=$((passed + 1))
    printf '[PASS] %s\n' "$1"
}

assert_not_contains() {
    local pattern="$1"
    local message="$2"
    if grep -Eq -- "$pattern" "$LAUNCHER"; then
        printf '[FAIL] %s\n' "$message" >&2
        exit 1
    fi
    pass "$message"
}

assert_contains() {
    local pattern="$1"
    local message="$2"
    if ! grep -Eq -- "$pattern" "$LAUNCHER"; then
        printf '[FAIL] %s\n' "$message" >&2
        exit 1
    fi
    pass "$message"
}

assert_not_contains '(^|[[:space:]])pkill([[:space:]]|$)' 'launcher never uses process-name-wide pkill'
assert_not_contains '(^|[[:space:]])nohup([[:space:]]|$)' 'launcher does not detach an unowned background process'
assert_not_contains '(^|[[:space:]])pgrep([[:space:]]|$)' 'launcher does not infer ownership from a broad process match'
assert_contains 'exec[[:space:]]+node' 'launcher keeps the CN server in the supervised foreground'
assert_contains '--check-only' 'launcher exposes a read-only preflight mode'
assert_contains 'CN_LISTEN_PORT' 'launcher derives the checked port from environment configuration'
assert_contains '20\.19\.0' 'launcher enforces the supported Node baseline'
assert_contains '\.cn-server-build-stamp' 'launcher uses an explicit successful-build stamp'

printf '[PASS] Linux launcher safety suite (%d assertions)\n' "$passed"
