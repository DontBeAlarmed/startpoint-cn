"use strict"

// 壳内 WebView 存档导出（导航式下载）专项：源码断言。
// - client.ts：Android WebView UA 检测（"; wv)"）、apiDownloadFile 的 iframe 导航分支、
//   缓存击穿参数（Date.now()）、非 WebView 分支 fetch+blob 路径原样保留；
// - PlayerDetail.tsx：导出 onClick 的壳内分支（isAndroidWebView → 「已交由系统下载」，
//   不弹成功 toast）与浏览器分支行为不变（错误就地提示）；
// - 其他调用方（Accounts.tsx）零改动；服务端 /player/save 双通道判定零改动。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const rootDir = path.join(__dirname, "..")
const clientPath = path.join(rootDir, "admin/src/api/client.ts")
const playerDetailPath = path.join(rootDir, "admin/src/pages/PlayerDetail.tsx")
const accountsPath = path.join(rootDir, "admin/src/pages/Accounts.tsx")
const saveRoutePath = path.join(rootDir, "src/routes/web_api/player.ts")

const client = fs.readFileSync(clientPath, "utf8")
const playerDetail = fs.readFileSync(playerDetailPath, "utf8")
const accounts = fs.readFileSync(accountsPath, "utf8")
const saveRoute = fs.readFileSync(saveRoutePath, "utf8")

// ── 1. client.ts：WebView 检测函数（导出，供调用方分支） ───────────────────
assert.match(client, /export function isAndroidWebView\(\): boolean \{/, "应导出 isAndroidWebView 检测函数")
assert.match(client, /typeof navigator !== "undefined"/, "检测需防护非浏览器环境")
assert.match(client, /\/;\\s\*wv\\\)\/\.test\(navigator\.userAgent\)/, "Android WebView UA 必含 \"; wv)\" 的检测正则")

// ── 2. client.ts：apiDownloadFile 的 WebView 分支（iframe 导航式下载） ─────
assert.match(client, /export async function apiDownloadFile\(url: string, fallbackFilename: string\): Promise<void> \{/)
const fnBody = client.slice(client.indexOf("export async function apiDownloadFile"))
const webviewBranchStart = fnBody.indexOf("if (isAndroidWebView()) {")
const fetchStart = fnBody.indexOf("await fetch(url,")
assert.notEqual(webviewBranchStart, -1, "apiDownloadFile 应含 WebView 分支")
assert.notEqual(fetchStart, -1, "apiDownloadFile 应保留 fetch 通道")
assert.ok(webviewBranchStart < fetchStart, "WebView 分支必须在 fetch 之前短路返回")

const webviewBranch = fnBody.slice(webviewBranchStart, fetchStart)
// iframe 导航四件套 + 60s 兜底清理
assert.match(webviewBranch, /document\.createElement\("iframe"\)/, "应创建隐藏 iframe")
assert.match(webviewBranch, /frame\.style\.display = "none"/, "iframe 必须隐藏")
assert.match(webviewBranch, /frame\.src = /, "iframe 以 src 触发导航式下载")
assert.match(webviewBranch, /document\.body\.appendChild\(frame\)/)
assert.match(webviewBranch, /setTimeout\(\(\) => frame\.remove\(\), 60_000\)/, "60s 后兜底移除 iframe")
// 缓存击穿参数（防 WebView 缓存吞第二次导出）
assert.match(webviewBranch, /Date\.now\(\)/, "iframe URL 应带 Date.now() 缓存击穿参数")
assert.match(webviewBranch, /_=\$\{Date\.now\(\)\}/, "缓存击穿参数形如 _=<timestamp>")
// iframe 请求不带任何 JSON 语义：不设 Accept 头、不发 fetch
assert.doesNotMatch(webviewBranch, /Accept/, "WebView 分支不得设置 Accept（iframe 导航走默认 text/html，落入服务端 attachment 通道）")
assert.doesNotMatch(webviewBranch, /fetch\(/, "WebView 分支不得发 fetch")

// ── 3. client.ts：非 WebView 分支 blob 路径原样保留 ────────────────────────
const browserBranch = fnBody.slice(fetchStart)
assert.match(browserBranch, /Accept: "application\/json"/, "浏览器分支保留部署层认证 fetch 通道")
assert.match(browserBranch, /res\.blob\(\)/)
assert.match(browserBranch, /URL\.createObjectURL\(blob\)/)
assert.match(browserBranch, /a\.download = filename/)
assert.match(browserBranch, /URL\.revokeObjectURL\(objectUrl\)/)
assert.match(browserBranch, /filename="([^"]+)"/, "content-disposition 文件名解析保留")
assert.match(browserBranch, /\?\? fallbackFilename/, "fallbackFilename 参数仍供浏览器分支使用")

// ── 4. PlayerDetail.tsx：导出 onClick 的壳内分支 ───────────────────────────
assert.match(playerDetail, /import \{[^}]*isAndroidWebView[^}]*\} from "\.\.\/api\/client"/, "应从 client 导入 isAndroidWebView")
const exportBtnIdx = playerDetail.indexOf(">导出存档</Button>")
assert.notEqual(exportBtnIdx, -1, "导出存档按钮应存在")
const onClickStart = playerDetail.lastIndexOf("onClick={() => {", exportBtnIdx)
assert.notEqual(onClickStart, -1, "导出存档按钮 onClick 应为块级箭头函数")
const onClickBlock = playerDetail.slice(onClickStart, exportBtnIdx)
assert.match(onClickBlock, /if \(isAndroidWebView\(\)\)/, "onClick 应检测 WebView 环境")
assert.match(onClickBlock, /message\.info\("已交由系统下载"\)/, "壳内分支应提示「已交由系统下载」")
assert.doesNotMatch(onClickBlock, /message\.success/, "壳内不弹成功 toast（成败由壳侧下载管线接管）")
// 浏览器分支行为完全不变：既有 fetch/blob 通道调用与错误就地提示保留
assert.match(playerDetail, /apiDownloadFile\(`\/api\/player\/save\?id=\$\{pid\}`/, "导出 API 路径不变")
assert.match(playerDetail, /存档导出失败：\$\{e\.message\}/, "浏览器分支错误就地提示保留")

// ── 5. 其他调用方零改动：Accounts.tsx 仍走原调用形态 ───────────────────────
assert.match(accounts, /apiDownloadFile\(`\/api\/player\/save\?id=\$\{playerId\}`/, "账号页导出调用零改动")
assert.doesNotMatch(accounts, /isAndroidWebView/, "其他调用方不得引入 WebView 分支逻辑")

// ── 6. 服务端 /player/save 双通道判定零改动（wantsJson → attachment/redirect）──
assert.match(saveRoute, /const json = wantsJson\(request\)/, "GET /save 双通道判定保留")
assert.match(saveRoute, /content-disposition", `attachment; filename="save_\$\{playerId\}\.json"/, "attachment 响应头保留")
assert.match(saveRoute, /reply\.redirect\(`\/player\/\$\{playerId\}\?error=/, "非 JSON 错误 302 通道保留")

console.log("admin webview save export tests passed")
