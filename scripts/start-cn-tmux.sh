#!/usr/bin/env bash
set -e

SESSION="starpoint-cn"
WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$WORKDIR"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already exists. Attaching..."
    tmux attach-session -t "$SESSION"
    exit 0
fi

tmux new-session -d -s "$SESSION" -n "server"

tmux send-keys -t "$SESSION:0" "npm run dev:cn" Enter

tmux split-window -h -t "$SESSION:0"

tmux send-keys -t "$SESSION:0.1" "mitmweb -p 8080 -s scripts/cn-capture-only.py" Enter

tmux select-pane -t "$SESSION:0.0"

echo "=== StarPoint CN started ==="
echo "Left pane : CN Server  (http://localhost:8001)"
echo "Right pane: mitmweb    (http://localhost:8081)"
echo ""

tmux attach-session -t "$SESSION"
