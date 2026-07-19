#!/usr/bin/env bash
# =============================================================================
# CN Server 启动脚本
# 用法: bash scripts/start-cn.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== CN StarPoint Server ==="

# Build before touching the running process. A failed build must never start stale output.
echo "[build] npm run build:server..."
npm run build:server

# Kill old process
if pkill -f "cn-server.js" 2>/dev/null; then
    echo "[kill] 已终止旧进程"
    sleep 1
fi

# Start
echo "[start] node --env-file=.env out/cn-server.js"
nohup node --env-file=.env out/cn-server.js > /tmp/cn-server.log 2>&1 &

sleep 2
if pgrep -f "cn-server.js" > /dev/null; then
    echo ""
    grep "CN StarPoint\|SEED\|Mode:\|SESSION" /tmp/cn-server.log | tail -5
    echo ""
    echo "=== 启动成功 ==="
    echo "  Web:  http://$(hostname -s):8001"
    echo "  Log:  tail -f /tmp/cn-server.log"
else
    echo ""
    echo "=== 启动失败 — 检查 /tmp/cn-server.log ==="
    tail -10 /tmp/cn-server.log
    exit 1
fi
