# Engineering Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前项目从“依赖本机经验才能安全运行”收敛为有统一验证入口、安全启动器、可重复 CI、可审计依赖升级和可控后台体积的工程状态。

**Architecture:** 以根 `package.json` 的 `verify` 作为唯一质量入口；Windows 启动逻辑迁入可测试的 PowerShell 脚本，批处理仅做薄包装；前后端依赖分别升级、分别锁定和审计；后台页面按路由懒加载并显式拆包；仓库卫生检查改为 NUL 分隔文件流并用精确白名单表达合法补丁包。所有工程改动都建立在 P0 修复及其测试通过之后，不改变 CN 游戏协议、角色数据和旧后台迁移边界。

**Tech Stack:** Node.js 20.19+、npm、TypeScript、Fastify 5、React 18、Vite 8、PowerShell 5.1+、Bash、GitHub Actions、Python `unittest`、Node test runner

## Global Constraints

- [ ] 按顺序先完成 `2026-07-15-p0-foundation-remediation.md`、`2026-07-15-reversible-asset-governance.md` 和 `2026-07-15-character-flow-consolidation.md`；本计划不得绕过前三阶段的验收门。
- [ ] 不修改或删除 `web/pages/`、`src/routes/web/`、`web/public/`；`web/dist/` 仍为构建产物且不得提交。
- [ ] 不修改当前用户 WIP：`assets/cdndata/character.json`、`assets/cdndata/character_text.json`、`assets/character.json`、`assets/mana_node.json`、`work/` 和两份未跟踪角色生成器文档。
- [ ] 不清理 `.git`，不执行 `git reset --hard`、`git clean`、通配路径暂存或全仓格式化。
- [ ] 依赖升级分根服务端和 `admin/` 两个独立提交；每批升级后立即运行对应测试与审计，失败即停在该批，不叠加下一批。
- [ ] 根运行时审计门槛：`npm audit --omit=dev --audit-level=high` 返回 0；完整审计不得有 `high` 或 `critical`。
- [ ] 后台审计门槛：`npm --prefix admin audit --audit-level=high` 返回 0。
- [ ] Node 最低版本统一为 `20.19.0`，CI 同时覆盖 Node 20 和 22；本机不满足时先升级 Node，不使用 `--force` 绕过 engine。
- [ ] 所有新文本保持 LF；`start-cn.bat` 保持 CRLF。
- [ ] 每个任务只暂存列出的明确路径；提交前再次运行 `git status --short`，确认用户 WIP 未进入暂存区。

---

## File Structure

### Create

- `scripts/start-cn.ps1` — 可测试的 Windows CN 启动器；负责环境、构建新鲜度、端口所有者和前台服务生命周期。
- `scripts/tests/test-start-cn.ps1` — 启动器的纯函数及“拒绝杀死陌生进程”回归测试。
- `scripts/tests/test-hygiene.sh` — 在临时 Git 仓库中覆盖空格、中文、换行文件名和合法补丁 ZIP 白名单。
- `admin/scripts/check-bundle.mjs` — 读取构建产物并强制执行路由/vendor chunk 预算。
- `.github/workflows/verify.yml` — 后端、前端、Python、启动器和审计的持续验证。
- `docs/security/dependency-audit-2026-07-15.md` — 两批升级前后审计结果、破坏性变化和残余风险。
- `docs/engineering-verification-2026-07-15.md` — 最终命令、版本、测试计数、bundle 指标和服务 smoke 证据。

### Modify

- `start-cn.bat` — 改成调用 `scripts/start-cn.ps1` 的薄包装，不再自行杀端口进程。
- `package.json` / `package-lock.json` — 统一脚本、Node engine 和 Fastify 依赖升级。
- `admin/package.json` / `admin/package-lock.json` — Vite 与 React 插件升级、增加前端类型检查脚本。
- `admin/src/App.tsx` — 页面路由懒加载和统一加载态。
- `admin/vite.config.ts` — 稳定 vendor chunk 分组和体积警戒线。
- `scripts/check-hygiene.sh` — NUL 分隔安全遍历、精确合法大文件策略和可测试入口。
- `.github/workflows/hygiene.yml` — 固定 action 版本并运行卫生脚本自测。
- `docs/deployment.md` — 新启动、停止、重建、鉴权和恢复说明。
- `AGENTS.md` — 更新真实验证命令、启动方式和当前工程门禁；保留 M4 限制。

---

### Task 1: 建立统一、可重复的验证入口

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 先记录当前命令缺口**

运行：

```powershell
npm run test:node
```

预期：失败并提示 `Missing script: "test:node"`，证明新增脚本不是重复已有入口。

- [ ] **Step 2: 将构建和测试命令拆成无副作用的明确脚本**

把根 `scripts` 收敛为包含以下条目；保留其他现有工具命令，但不得再使用 PowerShell/CMD 下语义不一致的单个 `&`：

```json
{
  "build": "npm run build:server && npm run css",
  "build:server": "tsc",
  "typecheck": "tsc --noEmit",
  "test:node": "npm run build:server && node --test out/tests",
  "test:python": "python -m unittest discover -s mod-tools/tests -p \"test_*.py\"",
  "build:admin": "npm --prefix admin run build",
  "typecheck:admin": "npm --prefix admin run typecheck",
  "test:hygiene": "bash scripts/tests/test-hygiene.sh",
  "test:launcher": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/test-start-cn.ps1",
  "verify": "npm run typecheck && npm run test:node && npm run typecheck:admin && npm run build:admin && npm run test:python"
}
```

同时把现有命令改成顺序执行：

```json
{
  "cdn": "npm run build:server && node --env-file=.env out/validate_cdn.js",
  "unzip": "npm run build:server && node --env-file=.env out/unzip_cdn.js",
  "dev:admin": "npm --prefix admin run dev"
}
```

`verify` 不包含会依赖 Git Bash 的卫生测试或 Windows 专属启动器测试；这两类由 CI 独立 job 和本机专项命令执行。

- [ ] **Step 3: 不安装依赖地刷新 lockfile 元数据**

运行：

```powershell
npm install --package-lock-only --ignore-scripts
npm run test:node
npm run test:python
```

预期：lockfile 更新；Node 集成测试全部通过，Python 测试保持当前通过/跳过基线且无失败。

- [ ] **Step 4: 提交统一验证入口**

```powershell
git add -- package.json package-lock.json
git diff --cached --check
git commit -m "build: add unified verification commands"
```

---

### Task 2: 用可测试的 PowerShell 启动器替换危险端口清理

**Files:**

- Create: `scripts/start-cn.ps1`
- Create: `scripts/tests/test-start-cn.ps1`
- Modify: `start-cn.bat`
- Modify: `package.json`

- [ ] **Step 1: 写失败的启动器契约测试**

`scripts/tests/test-start-cn.ps1` 点入脚本的函数定义模式并验证：

```powershell
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repo 'scripts\start-cn.ps1') -FunctionsOnly

$node = Get-Command node -ErrorAction Stop
$testRoot = Join-Path $env:TEMP ("startpoint-launcher-test-{0}" -f [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot
$missingPidFile = Join-Path $testRoot 'missing-pid.json'
$foreign = Start-Process -FilePath $node.Source `
    -ArgumentList '-e', 'require("net").createServer().listen(18001); setInterval(()=>{},1000)' `
    -WindowStyle Hidden -PassThru
try {
    Start-Sleep -Milliseconds 500
    $owner = Get-ListeningProcess -Port 18001
    Assert-True ($owner.Id -eq $foreign.Id) 'test fixture owns 18001'
    Assert-Throws { Assert-OwnedListener -ProcessId $owner.Id -RepoRoot $repo -PidFile $missingPidFile } 'refuse foreign owner'
    Assert-True (-not $foreign.HasExited) 'foreign process remains alive'
} finally {
    if (-not $foreign.HasExited) { Stop-Process -Id $foreign.Id -Force }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
```

测试还必须覆盖：

- 无监听进程时返回 `$null`；
- 只有 PID 文件中的 PID/绝对 entry 与监听进程命令行三者同时匹配时，才可识别为本项目实例；
- 缺失、陈旧、伪造或 JSON 损坏的 PID 文件一律拒绝停止进程；
- 缺失 `.env` 时返回可操作错误；
- 任意 `src/**/*.ts`、`tsconfig.json`、`package.json` 或 `package-lock.json` 比 `out/cn-server.js` 新时判定需要构建；
- `-NoBuild` 遇到陈旧构建必须失败，不能静默启动旧产物。

运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/test-start-cn.ps1
```

预期：失败，因为 `scripts/start-cn.ps1` 尚不存在。

- [ ] **Step 2: 实现纯函数和参数契约**

`scripts/start-cn.ps1` 的入口参数固定为：

```powershell
param(
    [int]$Port = 8001,
    [switch]$RestartOwned,
    [switch]$NoBuild,
    [switch]$CheckOnly,
    [switch]$FunctionsOnly
)
```

实现并导出以下纯函数；PowerShell 5.1 不依赖 `Convert.ToHexString` 或新式语法：

```powershell
function Get-ListeningProcess {
    param([Parameter(Mandatory = $true)][int]$Port)
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) { return $null }
    $ids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($ids.Count -ne 1) { throw "Port $Port has multiple listening owners: $($ids -join ', ')" }
    return Get-Process -Id $ids[0] -ErrorAction Stop
}

function Get-ProcessCommandLine {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $record = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$record.CommandLine
}

function Test-StarPointProcess {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($process.ProcessName -ne 'node') { return $false }
    $command = (Get-ProcessCommandLine -ProcessId $ProcessId).Replace('/', '\')
    $expected = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'out\cn-server.js'))
    return $command.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Read-OwnedPidRecord {
    param([Parameter(Mandatory = $true)][string]$PidFile)
    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return $null }
    $record = Get-Content -LiteralPath $PidFile -Raw -Encoding utf8 | ConvertFrom-Json
    if ($record.schema_version -ne 1 -or $record.pid -notmatch '^[1-9][0-9]*$' -or -not $record.entry) {
        throw "Invalid StarPoint PID record: $PidFile"
    }
    return $record
}

function Test-OwnedListener {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$PidFile
    )
    $record = Read-OwnedPidRecord -PidFile $PidFile
    if ($null -eq $record -or [int]$record.pid -ne $ProcessId) { return $false }
    $expected = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'out\cn-server.js'))
    $recordEntry = [IO.Path]::GetFullPath([string]$record.entry)
    if (-not $recordEntry.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return Test-StarPointProcess -ProcessId $ProcessId -RepoRoot $RepoRoot
}

function Assert-OwnedListener {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$PidFile
    )
    if (-not (Test-OwnedListener -ProcessId $ProcessId -RepoRoot $RepoRoot -PidFile $PidFile)) {
        $name = (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName
        $command = Get-ProcessCommandLine -ProcessId $ProcessId
        throw "Refusing to stop foreign listener PID=$ProcessId name=$name command=$command"
    }
}

function Test-BuildRequired {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $output = Join-Path $RepoRoot 'out\cn-server.js'
    if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { return $true }
    $outputTime = (Get-Item -LiteralPath $output).LastWriteTimeUtc
    $inputs = @(
        (Join-Path $RepoRoot 'package.json'),
        (Join-Path $RepoRoot 'package-lock.json'),
        (Join-Path $RepoRoot 'tsconfig.json')
    ) + @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'src') -Recurse -File -Filter '*.ts')
    foreach ($input in $inputs) {
        if ((Get-Item -LiteralPath $input).LastWriteTimeUtc -gt $outputTime) { return $true }
    }
    return $false
}

function Assert-Environment {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    foreach ($name in @('node', 'npm')) {
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is not available in PATH" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.env') -PathType Leaf)) {
        throw '.env is missing; copy .env.example and configure it first'
    }
    $nodeVersion = [version](& node -p 'process.versions.node')
    if ($nodeVersion -lt [version]'20.19.0') { throw "Node 20.19.0+ is required; found $nodeVersion" }
}
```

关键行为必须是：

1. PID 记录固定为忽略目录 `work/run/cn-server.pid.json`，包含 `schema_version=1`、PID、仓库绝对 entry 和启动 UTC 时间；用同目录临时文件原子替换。
2. 找到端口所有者后，只有 PID 记录、监听 PID、Node 进程名和命令行中的绝对 `out\cn-server.js` 全部匹配才视为 owned；否则打印 PID、进程名、命令行并以非零状态退出，绝不终止它。
3. 若是 owned 实例且没有 `-RestartOwned`，提示使用该开关并退出；只有显式 `-RestartOwned` 才允许 `Stop-Process`。
4. 启动新服务时把 `out\cn-server.js` 和 `.env` 都转换为绝对路径，用 `Start-Process -NoNewWindow -PassThru` 获得真实 PID，写入 PID 记录后在当前窗口 `Wait-Process`。`finally` 只终止该子进程并只删除仍指向该 PID 的记录，Ctrl+C 后不得留下孤儿进程。
5. 服务退出码由 `$server.ExitCode` 传回批处理；该监督进程在当前可见终端运行，不是隐藏后台 helper。
6. 每次启动都检查构建新鲜度；需要构建时运行 `npm run build`，而不是只看产物是否存在。
7. `-CheckOnly` 只执行 Node、npm、`.env`、PID/端口所有权和构建新鲜度检查，不启动服务。

- [ ] **Step 3: 把批处理降为 CRLF 薄包装**

`start-cn.bat` 仅保留：

```bat
@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-cn.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
```

用 PowerShell 检查 CRLF：

```powershell
$bytes = [IO.File]::ReadAllBytes((Resolve-Path 'start-cn.bat'))
$text = [Text.Encoding]::UTF8.GetString($bytes)
if ($text -match '(?<!`r)`n') { throw 'start-cn.bat contains bare LF' }
```

- [ ] **Step 4: 验证拒绝陌生进程且不泄漏后台测试进程**

```powershell
npm run test:launcher
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-cn.ps1 -CheckOnly
Get-NetTCPConnection -LocalPort 18001 -State Listen -ErrorAction SilentlyContinue
```

预期：启动器测试全过；`-CheckOnly` 明确报告 8001 状态和构建状态；测试端口 18001 无残留监听。

- [ ] **Step 5: 提交启动器**

```powershell
git add -- scripts/start-cn.ps1 scripts/tests/test-start-cn.ps1 start-cn.bat package.json
git diff --cached --check
git commit -m "fix(ops): make CN launcher ownership-safe"
```

---

### Task 3: 后台页面按路由加载并建立 bundle 预算

**Files:**

- Modify: `admin/src/App.tsx`
- Modify: `admin/vite.config.ts`
- Modify: `admin/package.json`
- Modify: `admin/package-lock.json`

- [ ] **Step 1: 记录改动前构建指标**

```powershell
npm --prefix admin ci
npm --prefix admin run build
Get-ChildItem -LiteralPath 'web/dist/assets' -File | Sort-Object Length -Descending | Select-Object -First 10 Name,Length
```

把最大 JS 文件的 raw bytes 和 Vite 输出的 gzip 大小记入 `docs/engineering-verification-2026-07-15.md` 的“before”栏。当前审计基线约为单包 1.32 MB raw / 413 KB gzip，但最终记录必须取本次实际输出。

- [ ] **Step 2: 先增加可自动检查的 chunk 预算脚本**

在 `admin/package.json` 增加：

```json
{
  "scripts": {
    "typecheck": "tsc -b --pretty false",
    "check:bundle": "node scripts/check-bundle.mjs",
    "build": "tsc -b && vite build && npm run check:bundle"
  }
}
```

并创建 `admin/scripts/check-bundle.mjs`，规则固定为：

- 扫描 `../web/dist/assets/*.js`；
- 任一业务路由 chunk 超过 350 KiB raw 时失败；
- `vendor-antd` 允许至 900 KiB raw，超过仍失败；
- 输出每个 JS chunk 的文件名和 bytes，便于 CI 留证。

先运行：

```powershell
npm --prefix admin run build
```

预期：现有单一大包超过预算而失败。

- [ ] **Step 3: 将五个页面改为 `lazy` 路由**

`admin/src/App.tsx` 使用：

```tsx
import { lazy, Suspense, useState } from "react"
import { Spin } from "antd"

const Dashboard = lazy(() => import("./pages/Dashboard"))
const Accounts = lazy(() => import("./pages/Accounts"))
const PlayerDetail = lazy(() => import("./pages/PlayerDetail"))
const Mail = lazy(() => import("./pages/Mail"))
const Seeds = lazy(() => import("./pages/Seeds"))
```

只在 `<Routes>` 外包一层：

```tsx
<Suspense fallback={<div style={{ display: "grid", placeItems: "center", minHeight: 240 }}><Spin size="large" /></div>}>
    <Routes>{/* existing routes unchanged */}</Routes>
</Suspense>
```

不得改变路径、菜单、旧后台或 API 行为。

- [ ] **Step 4: 配置稳定的 vendor chunk**

`admin/vite.config.ts` 的 `build.rollupOptions.output.manualChunks` 采用包前缀分组：

```ts
manualChunks(id) {
    if (!id.includes("node_modules")) return undefined
    if (id.includes("antd") || id.includes("@ant-design")) return "vendor-antd"
    if (id.includes("@tanstack")) return "vendor-query"
    if (id.includes("react") || id.includes("react-router")) return "vendor-react"
    return "vendor-misc"
}
```

设置 `chunkSizeWarningLimit: 900`。这只是 warning 门槛，真正强制门槛由 `check-bundle.mjs` 完成。

- [ ] **Step 5: 构建并核对路由 chunk**

```powershell
npm --prefix admin run typecheck
npm --prefix admin run build
Get-ChildItem -LiteralPath 'web/dist/assets' -File | Sort-Object Length -Descending | Select-Object Name,Length
git status --short -- web/dist
```

预期：每个页面有独立 chunk；预算脚本通过；`web/dist` 不出现在 Git 状态。

- [ ] **Step 6: 提交后台性能基线**

```powershell
git add -- admin/src/App.tsx admin/vite.config.ts admin/package.json admin/package-lock.json admin/scripts/check-bundle.mjs
git diff --cached --check
git commit -m "perf(admin): lazy-load routes and enforce bundle budget"
```

---

### Task 4: 修复 Unicode/特殊路径下的仓库卫生检查

**Files:**

- Modify: `scripts/check-hygiene.sh`
- Create: `scripts/tests/test-hygiene.sh`
- Modify: `.github/workflows/hygiene.yml`

- [ ] **Step 1: 写能复现当前缺陷的隔离测试**

`scripts/tests/test-hygiene.sh` 创建 `mktemp -d` 临时 Git 仓库，复制卫生脚本并依次提交/暂存以下文件：

1. `普通 文件.txt`：应通过；
2. `角色资料/测试.md`：应通过；
3. 文件名包含实际换行字符的文本文件：应被作为一个路径处理且通过；
4. `含IP 中文.md`，内容为 `192.168.0.130`：应失败；
5. `assets/asset-patch/active/pinball-1.4.139-1.4.140-1-mod07150000.zip`，有效 ZIP 且 1–5 MiB：应通过；
6. `assets/asset-patch/active/not-a-patch.zip`，同样大小：应失败；
7. 合法命名但 ZIP 验证失败：应失败；
8. `.env`：应失败。

测试用 `trap 'rm -rf -- "$tmp"' EXIT` 保证临时目录清理；不得在真实仓库生成大测试文件。

运行：

```powershell
bash scripts/tests/test-hygiene.sh
```

预期：至少换行文件名用例失败，证明当前 `files=$(git ls-files)` 和 here-string 不安全。

- [ ] **Step 2: 改为 NUL 分隔路径流**

`scripts/check-hygiene.sh` 不再把文件列表存进 shell 变量。实现统一函数：

```bash
scan_paths() {
    while IFS= read -r -d '' f; do
        scan_one "$f"
    done
}

if [[ "$MODE" == "--all" ]]; then
    git ls-files -z | scan_paths
else
    git diff --cached --name-only --diff-filter=ACM -z | scan_paths
fi
```

因为管道会启动 subshell，`fail` 不能依赖父 shell 可变变量；`scan_paths` 在发现问题时直接累积到临时结果文件，结束后父 shell据此返回非零，或改用 Bash process substitution：

```bash
if [[ "$MODE" == "--all" ]]; then
    scan_paths < <(git ls-files -z)
else
    scan_paths < <(git diff --cached --name-only --diff-filter=ACM -z)
fi
```

必须选第二种，保证 `fail=1` 在当前 shell 生效。

- [ ] **Step 3: 用精确函数表达合法大补丁包**

```bash
is_allowed_patch_zip() {
    local f="$1" sz="$2"
    [[ "$f" =~ ^assets/asset-patch/(active|inactive|archive)/pinball-[0-9]+\.[0-9]+\.[0-9]+-[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9._-]*)?\.zip$ ]] || return 1
    (( sz <= 5242880 )) || return 1
    unzip -tqq -- "$f" >/dev/null 2>&1
}
```

其余非 JSON/CSV/Markdown 的 >1 MiB 文件继续失败。合法补丁 ZIP 不是泛化 `*.zip` 白名单。

- [ ] **Step 4: 修复脚本自身乱码并保留安全扫描**

用 UTF-8 重写输出文本；保留私网 IP、用户主目录、个人邮箱、`.env` 和大二进制规则。对脚本和测试自身仅豁免“测试字符串所在的精确文件”，不能豁免整个 `scripts/`。

- [ ] **Step 5: 更新 CI 并跑隔离测试**

`.github/workflows/hygiene.yml` 在正式扫描前增加：

```yaml
- name: Test hygiene scanner
  run: bash scripts/tests/test-hygiene.sh
```

然后运行：

```powershell
bash scripts/tests/test-hygiene.sh
bash scripts/check-hygiene.sh --all
```

预期：隔离测试全过；真实仓库如仍失败，输出的是精确路径和实际政策冲突，不再因中文/引号/换行路径误拆分。对真实冲突只加窄白名单或修正内容，不删除资产。

- [ ] **Step 6: 提交卫生检查修复**

```powershell
git add -- scripts/check-hygiene.sh scripts/tests/test-hygiene.sh .github/workflows/hygiene.yml
git diff --cached --check
git commit -m "fix(ci): make hygiene scanning path-safe"
```

---

### Task 5: 分批升级服务端运行时依赖并清零高危项

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `docs/security/dependency-audit-2026-07-15.md`

- [ ] **Step 1: 保存升级前机器可复核基线**

```powershell
node --version
npm --version
npm audit --json | Set-Content -LiteralPath "$env:TEMP\startpoint-root-audit-before.json" -Encoding utf8
npm audit --omit=dev --audit-level=high
```

在审计文档记录日期、Node/npm 版本、总漏洞数、high/critical 数和直接受影响包；不得提交完整含路径的临时 JSON。

- [ ] **Step 2: 升级 Fastify 兼容批次**

只执行明确版本范围，不运行 `npm audit fix --force`：

```powershell
npm install --save-exact fastify@5.8.3 @fastify/multipart@9.0.3 @fastify/static@10.1.0
```

同时把 `engines.node` 改为：

```json
{ "node": ">=20.19.0" }
```

选择依据写入审计文档：Fastify 修复版本高于受影响的 5.8.2；`@fastify/static` 8+ 与 Fastify 5 兼容；multipart 采用修复后的 9.0.3。实施时必须再次读取各包 release notes；若 lockfile 实际解析版本或 peer 范围不一致，停止并记录，不凭猜测强装。

- [ ] **Step 3: 运行服务端完整回归和审计**

```powershell
npm run typecheck
npm run test:node
npm run test:python
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
```

预期：测试全部通过；运行时和完整审计都没有 high/critical。若只剩 moderate/low，逐项写入审计文档，包括是否仅为开发依赖和后续处理理由。

- [ ] **Step 4: 在隔离数据库上做服务 smoke**

```powershell
$env:WF_DATABASE_DIR = Join-Path $env:TEMP 'startpoint-hardening-db'
$env:CN_LISTEN_HOST = '127.0.0.1'
$env:CN_ADMIN_TOKEN = ('0' * 64)
npm run build:server
```

使用 P0 计划提供的隔离 smoke 工具启动服务，验证 `/api/server/currentTime` 未认证为 401、游戏 `/load` 不因管理鉴权被阻断、补丁路由合法文件仍为 200。结束后确认 8001 无测试进程残留。

- [ ] **Step 5: 提交服务端依赖批次**

```powershell
git add -- package.json package-lock.json docs/security/dependency-audit-2026-07-15.md
git diff --cached --check
git commit -m "fix(deps): upgrade Fastify security baseline"
```

---

### Task 6: 升级后台工具链并验证 Vite 8 迁移

**Files:**

- Modify: `admin/package.json`
- Modify: `admin/package-lock.json`
- Modify: `admin/vite.config.ts`
- Modify: `docs/security/dependency-audit-2026-07-15.md`

- [ ] **Step 1: 保存后台升级前审计**

```powershell
npm --prefix admin audit --json | Set-Content -LiteralPath "$env:TEMP\startpoint-admin-audit-before.json" -Encoding utf8
npm --prefix admin audit --audit-level=high
```

预期：现有 Vite/esbuild 链路复现 high 项；把计数写入审计文档。

- [ ] **Step 2: 升级 Vite 及官方 React 插件**

```powershell
npm --prefix admin install --save-dev --save-exact vite@8.1.4 @vitejs/plugin-react@6.0.2
```

迁移前核对：Node 为 20.19+ 或 22.12+；Vite 配置不使用已移除的 Sass legacy API、`splitVendorChunkPlugin` 或 `legacy.proxySsrExternalModules`。当前配置使用 `defineConfig`、`loadEnv` 和 Rollup-compatible `manualChunks`，应直接迁移；如实际构建报 Rolldown 兼容错误，只做最小配置适配并把错误与修复写入审计文档。

- [ ] **Step 3: 运行后台类型、构建、预算和审计**

```powershell
npm --prefix admin run typecheck
npm --prefix admin run build
npm --prefix admin audit --audit-level=high
npm run build:admin
```

预期：Vite 8 构建通过；bundle 预算通过；后台审计无 high/critical；根脚本不再隐式执行 `npm install`。

- [ ] **Step 4: 用服务挂载验证 SPA fallback**

在 P0 隔离服务上依次请求：

```powershell
$index = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8001/admin/'
$fallback = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8001/admin/accounts'
$assetPath = [regex]::Match($index.Content, '(?:src|href)="(?<path>/admin/assets/[^"]+\.js)"').Groups['path'].Value
if (-not $assetPath) { throw 'Built admin HTML did not reference a JavaScript asset' }
$asset = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:8001{0}" -f $assetPath)
```

`$index.StatusCode`、`$fallback.StatusCode` 和 `$asset.StatusCode` 均预期 200；`$asset.Headers['Content-Type']` 必须包含 JavaScript MIME。构建 hash 文件名来自 HTML，不硬编码。

- [ ] **Step 5: 更新审计文档并提交后台依赖批次**

```powershell
git add -- admin/package.json admin/package-lock.json admin/vite.config.ts docs/security/dependency-audit-2026-07-15.md
git diff --cached --check
git commit -m "fix(deps): migrate admin build to Vite 8"
```

---

### Task 7: 增加跨平台 CI 门禁

**Files:**

- Create: `.github/workflows/verify.yml`
- Modify: `.github/workflows/hygiene.yml`

- [ ] **Step 1: 创建服务端矩阵 job**

`verify.yml` 的 `server` job 使用 `windows-latest`，矩阵 Node `20.19.0` 与 `22.x`：

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: ${{ matrix.node }}
    cache: npm
- run: npm ci
- run: npm run typecheck
- run: npm run test:node
- run: npm audit --omit=dev --audit-level=high
```

不要在 CI 连接真实 `.database`；P0 测试必须通过 `WF_DATABASE_DIR` 使用临时目录。

- [ ] **Step 2: 创建后台 job**

Windows `admin` job：

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20.19.0
    cache: npm
    cache-dependency-path: admin/package-lock.json
- run: npm ci
  working-directory: admin
- run: npm run typecheck
  working-directory: admin
- run: npm run build
  working-directory: admin
- run: npm audit --audit-level=high
  working-directory: admin
```

- [ ] **Step 3: 创建 Python 与启动器 job**

Windows `tools` job 安装根 npm 依赖、Python 3.11 和 `mod-tools/requirements.txt` 后运行：

```yaml
- run: python -m unittest discover -s mod-tools/tests -p "test_*.py"
- shell: powershell
  run: ./scripts/tests/test-start-cn.ps1
```

若 Python 测试明确把可选依赖标为 skip，CI 接受 skip；不得把 import error 当 skip。

- [ ] **Step 4: 本地做 YAML 和命令静态检查**

```powershell
npx --yes yaml-lint .github/workflows/verify.yml .github/workflows/hygiene.yml
git diff --check -- .github/workflows
```

如 `yaml-lint` 包不可用，改用 Ruby/Python 已安装 YAML parser，只做读取验证，不把临时工具加入项目依赖。

- [ ] **Step 5: 提交 CI 门禁**

```powershell
git add -- .github/workflows/verify.yml .github/workflows/hygiene.yml
git diff --cached --check
git commit -m "ci: verify server admin and tooling"
```

---

### Task 8: 更新运行文档并完成全链路证据报告

**Files:**

- Modify: `docs/deployment.md`
- Modify: `AGENTS.md`
- Create: `docs/engineering-verification-2026-07-15.md`

- [ ] **Step 1: 更新部署文档**

`docs/deployment.md` 必须包含经过实际验证的命令：

```powershell
.\start-cn.bat
.\start-cn.bat -CheckOnly
.\start-cn.bat -RestartOwned
npm run verify
npm run test:launcher
bash scripts/tests/test-hygiene.sh
```

解释：

- 端口被陌生程序占用时启动器会拒绝运行，不会强杀；
- 只有确认是本项目旧实例后 `-RestartOwned` 才会重启；
- 源码或 lockfile 新于输出时自动重建；
- 管理 API 的 token/cookie 设置遵循 P0 文档；
- `web/dist` 是本地产物，不能提交；
- 资产隔离/恢复必须使用资产治理 CLI，而不是手工删除。

- [ ] **Step 2: 更新 AGENTS 工程门禁**

保留 M4 的旧后台零改动约束，新增：

- `npm run verify` 为合并前强制入口；
- 根/后台 high、critical 审计为零；
- 启动器不得终止未确认身份的端口所有者；
- 资产操作必须 plan → quarantine → verify → restore drill；
- 当前用户 WIP 与逆向目录保护清单。

- [ ] **Step 3: 执行最终验证并逐项落证**

```powershell
node --version
npm --version
npm ci
npm --prefix admin ci
npm run verify
npm run test:launcher
bash scripts/tests/test-hygiene.sh
bash scripts/check-hygiene.sh --all
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
npm --prefix admin audit --audit-level=high
git diff --check
git status --short
```

报告必须写实际值：Node/Python/7-Zip 版本、Node 测试通过数、Python 通过/跳过数、两份 audit 计数、最大 chunk bytes、隔离 smoke HTTP 状态、启动器陌生进程拒绝结果、卫生检查结果。

- [ ] **Step 4: 运行前台服务人工 smoke**

先执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-cn.ps1 -CheckOnly
```

然后在用户可见终端运行 `start-cn.bat`。验证：

- CN 服务绑定地址与 `.env` 一致；
- `/load` 使用请求可达 CDN 图；
- `/admin/` 可加载，未登录管理请求 401；
- 登录后服务器时间只读请求成功；
- Ctrl+C 后端口释放；
- 日志没有未捕获异常。

不在 smoke 中写玩家数据、不发布角色、不移动资产。

- [ ] **Step 5: 确认保护边界和提交文档**

```powershell
git diff --name-only --cached
git status --short -- assets/cdndata/character.json assets/cdndata/character_text.json assets/character.json assets/mana_node.json work mod-tools/docs
git add -- docs/deployment.md AGENTS.md docs/engineering-verification-2026-07-15.md
git diff --cached --check
git commit -m "docs: record hardened operation baseline"
```

预期：用户 WIP 仍仅在工作区且未暂存；文档提交只包含三条明确路径。

---

## Final Acceptance Gate

- [ ] `npm run verify` 从干净依赖安装后一次通过。
- [ ] `npm run test:launcher` 证明陌生 8001 所有者不会被杀。
- [ ] `bash scripts/tests/test-hygiene.sh` 覆盖空格、中文、换行文件名及合法补丁包。
- [ ] Node 20.19 和 22 的 CI 都通过。
- [ ] 根运行时、根完整、后台完整 audit 都无 high/critical。
- [ ] 后台路由懒加载，业务 chunk 不超过 350 KiB raw，`vendor-antd` 不超过 900 KiB raw。
- [ ] `web/dist`、测试数据库和临时审计 JSON 均未提交。
- [ ] 服务 smoke 不修改玩家数据、不发布角色、不移动资产。
- [ ] `web/pages/`、`src/routes/web/`、`web/public/` 没有任何变更。
- [ ] 用户现有四个 JSON 修改、`work/` 和角色生成器文档未被暂存或覆盖。
