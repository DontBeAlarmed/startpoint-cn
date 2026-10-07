#!/usr/bin/env bash
# 提交卫生检查:阻止个人 IP / 家目录 / 个人邮箱 / .env / 大二进制 进入提交或仓库。
# 用法:
#   bash scripts/check-hygiene.sh          # 检查已暂存(pre-commit 钩子用)
#   bash scripts/check-hygiene.sh --all     # 检查整树(CI 用,含 docs:check 文档索引)
set -uo pipefail

MODE="${1:-staged}"
fail=0
note() { echo "  [x] $*"; fail=1; }

if [ "$MODE" = "--all" ]; then
    files=$(git ls-files)
else
    files=$(git diff --cached --name-only --diff-filter=ACM)
fi
if [ -z "$files" ] && [ "$MODE" != "--all" ]; then exit 0; fi

# CI hygiene 工作流同时跑 docs:check;整树模式一并对齐,避免推送后 CI 才发现文档漏索引。
if [ "$MODE" = "--all" ]; then
    if ! docs_output=$(node tools/docs_check.cjs 2>&1); then
        note "文档结构/链接检查失败(docs:check):"
        printf '%s\n' "$docs_output" | grep -v '^$' | tail -6 | sed 's/^/      /'
    fi
fi
[ -z "$files" ] && exit 0

IP_RE='192\.168\.[0-9]+\.[0-9]+'
HOME_RE='/Users/[A-Za-z0-9_]+'
EMAIL_RE='[A-Za-z0-9._%+-]+@(qq|gmail|163|126|outlook|hotmail|foxmail|yahoo)\.com'
# 有意保留的通用占位示例(白名单)
IP_ALLOW='192\.168\.1\.10'

while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    case "$f" in
        scripts/check-hygiene.sh|scripts/hooks/*|.github/workflows/hygiene.yml) continue ;;
    esac

    if [ "$f" = ".env" ]; then note ".env 不得提交(仅提交 .env.example)"; continue; fi

    sz=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [ "$sz" -gt 1048576 ]; then
        case "$f" in
            *.json|*.csv|*.md) ;;                 # 允许大数据/文档
            *) note "大文件 >1MB(二进制不应入库,改用生成脚本): $f" ;;
        esac
    fi

    # 仅扫描文本文件
    if grep -Iq . "$f" 2>/dev/null; then
        if grep -nE "$IP_RE" "$f" 2>/dev/null | grep -vE "$IP_ALLOW" | grep -q .; then
            note "个人 IP: $f"; grep -nE "$IP_RE" "$f" | grep -vE "$IP_ALLOW" | head -3 | sed 's/^/      /'
        fi
        if grep -nqE "$HOME_RE" "$f" 2>/dev/null; then
            note "家目录路径: $f"; grep -nE "$HOME_RE" "$f" | head -3 | sed 's/^/      /'
        fi
        if grep -niqE "$EMAIL_RE" "$f" 2>/dev/null; then
            note "个人邮箱: $f"; grep -niE "$EMAIL_RE" "$f" | head -3 | sed 's/^/      /'
        fi
    fi
done <<< "$files"

if [ "$fail" -ne 0 ]; then
    echo ""
    echo "提交卫生检查失败:请清除上述 个人 IP / 家目录 / 个人邮箱 / .env / 大二进制 后再提交。"
    echo "(host/port 用 env 或 request.headers.host;路径用相对/__dirname;确为占位示例则加入白名单)"
    exit 1
fi
exit 0
