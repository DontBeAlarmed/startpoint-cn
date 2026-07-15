#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
ENTRY="$ROOT/out/cn-server.js"
CHECK_ONLY=false
NO_BUILD=false

usage() {
    cat <<'EOF'
Usage: bash scripts/start-cn.sh [--check-only] [--no-build]

Runs StarPoint CN in the foreground so the invoking shell or service manager
owns its lifetime. The launcher never stops an existing listener.
EOF
}

while (($#)); do
    case "$1" in
        --check-only) CHECK_ONLY=true ;;
        --no-build) NO_BUILD=true ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

command -v node >/dev/null 2>&1 || { printf 'node is not available in PATH\n' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'npm is not available in PATH\n' >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { printf '.env is missing; copy .env.example and configure it first\n' >&2; exit 1; }

node -e '
const current = process.versions.node.split(".").map(Number)
const required = [20, 19, 0]
for (let i = 0; i < required.length; i++) {
  if (current[i] > required[i]) process.exit(0)
  if (current[i] < required[i]) {
    console.error(`Node 20.19.0+ is required; found ${process.versions.node}`)
    process.exit(1)
  }
}
'

HOST="$(node --env-file="$ENV_FILE" -p 'process.env.CN_LISTEN_HOST || "127.0.0.1"')"
PORT="$(node --env-file="$ENV_FILE" -p 'process.env.CN_LISTEN_PORT || "8001"')"
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || {
    printf 'CN_LISTEN_PORT must be an integer from 1 to 65535; found %s\n' "$PORT" >&2
    exit 1
}

if ! node - "$HOST" "$PORT" <<'NODE'
const net = require('node:net')
const [, , host, rawPort] = process.argv
const server = net.createServer()
server.unref()
server.once('error', (error) => {
  if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
    console.error(`[PORT] refusing to start: ${host}:${rawPort} is unavailable (${error.code})`)
  } else {
    console.error(`[PORT] unable to verify ${host}:${rawPort}: ${error && error.message}`)
  }
  process.exit(1)
})
server.listen({ host, port: Number(rawPort), exclusive: true }, () => {
  server.close(() => process.exit(0))
})
NODE
then
    printf 'Stop the existing service through its original supervisor, then retry.\n' >&2
    exit 1
fi
printf '[PORT] %s:%s is available\n' "$HOST" "$PORT"

build_required=false
if [[ ! -f "$ENTRY" ]]; then
    build_required=true
elif [[ "$ROOT/package.json" -nt "$ENTRY" || "$ROOT/package-lock.json" -nt "$ENTRY" || "$ROOT/tsconfig.json" -nt "$ENTRY" ]]; then
    build_required=true
elif find "$ROOT/src" -type f -name '*.ts' -newer "$ENTRY" -print -quit | grep -q .; then
    build_required=true
fi

if [[ "$build_required" == true ]]; then
    printf '[BUILD] output is missing or stale\n'
    if [[ "$NO_BUILD" == true ]]; then
        printf 'Rerun without --no-build.\n' >&2
        exit 1
    fi
else
    printf '[BUILD] output is current\n'
fi

if [[ "$CHECK_ONLY" == true ]]; then
    printf '[CHECK] environment, port, and build checks passed\n'
    exit 0
fi

cd "$ROOT"
if [[ "$build_required" == true ]]; then
    npm run build
fi

printf '[START] StarPoint CN http://%s:%s (foreground; Ctrl-C to stop)\n' "$HOST" "$PORT"
exec node --env-file="$ENV_FILE" "$ENTRY"
