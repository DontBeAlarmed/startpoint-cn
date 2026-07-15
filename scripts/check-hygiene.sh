#!/usr/bin/env bash
# 提交卫生检查：阻止个人 IP、家目录、个人邮箱、.env 和无授权大二进制进入仓库。
# 用法：
#   bash scripts/check-hygiene.sh          # 检查已暂存文件（pre-commit）
#   bash scripts/check-hygiene.sh --all    # 检查全部已跟踪文件（CI）
set -uo pipefail

MODE="${1:-staged}"
fail=0
note() { printf '  [x] %s\n' "$*"; fail=1; }

IP_RE='192\.168\.[0-9]+\.[0-9]+'
HOME_RE='(/Users/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)'
EMAIL_RE='[A-Za-z0-9._%+-]+@(qq|gmail|163|126|outlook|hotmail|foxmail|yahoo)\.com'
# 有意保留的通用占位示例。
IP_ALLOW='192\.168\.1\.10'

paths_file=$(mktemp)
trap 'rm -f -- "$paths_file"' EXIT

is_allowed_patch_zip() {
    local path="$1" size="$2"
    [[ "$path" =~ ^assets/asset-patch/(active|inactive|archive)/pinball-[0-9]+\.[0-9]+\.[0-9]+-[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9._-]*)?\.zip$ ]] || return 1
    (( size <= 5242880 )) || return 1
    unzip -tqq -- "$path" >/dev/null 2>&1
}

is_allowed_large_runtime_text() {
    local path="$1" size="$2"
    [[ "$path" == 'mod-tools/WF_PATHLIST_recovered.txt' ]] && (( size <= 8388608 ))
}

print_matches() {
    printf '%s\n' "$1" | sed -n '1,3{s/^/      /;p;}'
}

# 保留 NUL 分隔，不把路径列表放进普通 shell 字符串。
scan_paths() {
    local path
    while IFS= read -r -d '' path; do
        [[ -f "$path" ]] || continue
        # 只有包含测试策略字面量的两个文件需要精确豁免。
        case "$path" in
            scripts/check-hygiene.sh|scripts/tests/test-hygiene.sh) continue ;;
        esac
        printf '%s\0' "$path" >> "$paths_file"
        if [[ "$path" == '.env' ]]; then
            note '.env 不得提交（仅提交 .env.example）'
        fi
    done
}

scan_sizes() {
    local size path
    while IFS= read -r -d '' size && IFS= read -r -d '' path; do
        (( size > 1048576 )) || continue
        case "$path" in
            *.json|*.csv|*.md)
                ;;
            *)
                if ! is_allowed_patch_zip "$path" "$size" && ! is_allowed_large_runtime_text "$path" "$size"; then
                    note "大文件 >1MiB（仅允许命名合规、有效且不超过 5MiB 的资产补丁 ZIP）：$path"
                fi
                ;;
        esac
    done
}

scan_ip_matches() {
    local path hits
    while IFS= read -r -d '' path; do
        # 这些文件使用私网地址验证拒绝逻辑；只豁免 IP 规则，不豁免其他检查。
        case "$path" in
            docs/superpowers/plans/2026-07-15-engineering-hardening.md|mod-tools/tests/test_remediation_baseline.py|mod-tools/tests/test_server_auth.py|src/tests/admin-auth.test.ts) continue ;;
        esac
        hits=$(grep -nE "$IP_RE" "$path" 2>/dev/null || true)
        hits=$(printf '%s\n' "$hits" | grep -vE "$IP_ALLOW" || true)
        if [[ -n "$hits" ]]; then
            note "个人 IP：$path"
            print_matches "$hits"
        fi
    done
}

scan_simple_matches() {
    local pattern="$1" label="$2" path hits
    while IFS= read -r -d '' path; do
        hits=$(grep -niE "$pattern" "$path" 2>/dev/null || true)
        if [[ -n "$hits" ]]; then
            note "$label：$path"
            print_matches "$hits"
        fi
    done
}

if [[ "$MODE" == '--all' ]]; then
    scan_paths < <(git ls-files -z)
else
    scan_paths < <(git diff --cached --name-only --diff-filter=ACM -z)
fi

if [[ -s "$paths_file" ]]; then
    # stat/grep 由 xargs 分批调用，避免 Windows 上逐文件启动数万个进程。
    scan_sizes < <(xargs -0 -r stat --printf='%s\0%n\0' -- < "$paths_file" 2>/dev/null)
    scan_ip_matches < <(xargs -0 -r grep -IlZ -E "$IP_RE" -- < "$paths_file" 2>/dev/null)
    scan_simple_matches "$HOME_RE" '家目录路径' < <(xargs -0 -r grep -IlZ -E "$HOME_RE" -- < "$paths_file" 2>/dev/null)
    scan_simple_matches "$EMAIL_RE" '个人邮箱' < <(xargs -0 -r grep -IlZ -E "$EMAIL_RE" -- < "$paths_file" 2>/dev/null)
fi

if (( fail != 0 )); then
    printf '\n提交卫生检查失败：请清除上述个人 IP、家目录、个人邮箱、.env 或无授权大二进制后再提交。\n'
    printf '%s\n' '（host/port 用 env 或 request.headers.host；路径用相对路径；确为占位示例时仅加窄白名单。）'
    exit 1
fi
exit 0
