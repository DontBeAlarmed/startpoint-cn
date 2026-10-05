# 专项交接：壳内 WebView 存档导出无反应（服务端侧修复）

> 状态：待执行
> 范围：仅 `starpoint-cn` 仓库（admin 前端 + web_api）。**壳（worldflipper-cn-launcher）本专项零改动**。
> 关联：launcher 侧分析与现有下载管线见 launcher 仓库 `.superpowers/HANDOFF-2026-09-04-game-native-ui.md` 及 `LauncherAdminWebViewHost.kt`。

## 问题现象

在启动器壳内的管理后台 WebView 中，玩家详情页「导出存档」按钮点击后**无任何反应**；同一地址用系统浏览器打开则导出正常。

## 根因（已分析确认）

导出链路：

```
PlayerDetail.tsx 导出按钮
  → apiDownloadFile("/api/player/save?id=N")     // admin/src/api/client.ts:55
  → fetch → res.blob() → URL.createObjectURL     // client.ts:63-74
  → <a download>.click() → revokeObjectURL
服务端 GET /api/player/save（挂载在 /player/save）
  → 200 JSON + content-disposition: attachment; filename="save_N.json"
```

Android WebView 的 `DownloadListener`（壳已实现并接入下载管线）**只对导航式下载触发**：即浏览器自身识别 `Content-Disposition: attachment` 并接管下载时。而当前前端是 **JS 内存 Blob 下载**：`createObjectURL` 是 JS 运行时行为，不产生网络请求、不产生导航——`onDownloadStart` 永远不会回调，`shouldInterceptRequest` 也无可拦截点。壳侧因此完全无感知。系统浏览器有完整 Blob 下载支持，Android WebView 没有（平台长期限制），故壳内静默失败、浏览器正常。

## 修复方案（已选定）：导航式下载

把导出从「fetch+blob」改为「让浏览器自己发起 attachment 导航」，使壳的现成 `DownloadListener` 管线接管。**不采用 JS 桥方案**（需要壳注册 `@JavascriptInterface`、扩大壳攻击面，违背"壳零改动"约束）。

### 服务端已具备的配套（无需新增）

`GET /player/save` 已实现 JSON/HTML 双通道（`src/routes/web_api/player.ts:143-166`）：

- 请求带 `Accept: application/json` → 返回结构化 JSON（404/413/500 带 `error` 字段）；
- 否则 → 错误时 `302 redirect` 到 `/player/:id?error=…`（页面顶部已有 error 展示逻辑），成功时返回 attachment。

导航式导出天然走后一条通道，错误处理服务端已经完备。

### 改动点 1：`admin/src/api/client.ts` — `apiDownloadFile`

当前（55-75 行）：fetch → blob → createObjectURL → a.click。

改为：**检测 WebView 环境，是则用隐藏 iframe 触发导航，否则保留原 blob 路径**（浏览器里保留 blob 的好处：错误能就地抛 `ApiError` 给 React Query 显示）。

```ts
// WebView 检测：Android WebView 的 UA 必含 "; wv)"
const isAndroidWebView = () =>
    typeof navigator !== "undefined" && /;\s*wv\)/.test(navigator.userAgent)

export async function apiDownloadFile(url: string, fallbackFilename: string): Promise<void> {
    if (isAndroidWebView()) {
        // 壳内：走导航式下载，让 WebView DownloadListener 接管。
        // 用隐藏 iframe 而非 location.href，避免离开当前页面状态。
        const frame = document.createElement("iframe")
        frame.style.display = "none"
        frame.src = url
        document.body.appendChild(frame)
        // attachment 响应不会渲染 iframe；错误页会渲染但被 iframe 吞掉——
        // 可接受：失败时用户重试，或后续在 URL 上加时间戳避免缓存。
        setTimeout(() => frame.remove(), 60_000)
        return
    }
    // ……以下原 blob 路径原样保留……
}
```

注意点：
- iframe 导航时浏览器仍会收到 `Content-Disposition: attachment`，WebView 对**主框架级别的 attachment 导航**（iframe 算独立框架的主框架）会回调 `DownloadListener`——这是该方案的机制基础；
- URL 加缓存击穿参数（如 `?id=N&_=${Date.now()}`）可选，防止 WebView/服务端缓存吞掉第二次导出；
- `fallbackFilename` 参数在 WebView 分支用不到（文件名由服务端 `content-disposition` 提供，壳的 `LauncherAdminPolicy.safeFileName` 会解析），保留参数以兼容浏览器分支。

### 改动点 2：`admin/src/pages/PlayerDetail.tsx` — 错误提示降级（可选）

当前导出用 React Query mutation，`onError` 弹 `message.error`。WebView 分支下 `apiDownloadFile` 立即返回（下载成败异步发生在壳侧），mutation 会走 `onSuccess`。建议：

- WebView 分支下把就地错误提示改为提示「已交由系统导出」或直接不提示；
- 真正的失败（404/413/500）会以服务端 302 → `/player/:id?error=…` 呈现，但发生在 iframe 里用户看不到——**接受此限制**（与现状"点了没反应"相比已是改善），或在 iframe 方案上加 `sandbox` 属性阻止错误页渲染（不影响 attachment 拦截）。

### 改动点 3（确认项，预计零改动）：服务端路由无需变更

`/player/save` 的双通道逻辑（`wantsJson` 判定）已满足需求，无需修改。唯一要确认的是 iframe 请求的 `Accept` 头：iframe 导航发送的是浏览器默认 `Accept: text/html,...`，不含 `application/json`，恰好正确落入 attachment 通道。**不要**给 iframe URL 附加任何 JSON 语义参数。

### 影响面确认（已核实）

- `apiDownloadFile` 全仓调用方**仅一处**：`PlayerDetail.tsx:168`（存档导出）。Dashboard 的"上传导出 JSON"是 `apiUpload`（上传方向），不受影响；
- 其他管理页（邮件、种子、账号清理）无下载动作；
- `web/dist` 构建产物需重新生成并随 Server Bundle 发布（见下）。

## 发布与验证

1. `cd admin && npm run build`（生成新 `web/dist`，注意 index.html 引用的 assets hash 会变）；
2. 重新打 Server Bundle（含新 `web/dist`），launcher 侧通过「设置 → 组件与更新」导入或新分享包分发；**壳 APK 不需要重新构建**；
3. 真机验证清单：
   - 壳内打开后台 → 玩家详情 → 导出存档 → 系统出现下载完成/通知（壳的下载管线落盘，路径见 launcher `LauncherAdminDownloadCore`），文件可打开且 JSON 内容正确；
   - 导出后当前页面状态不丢失（iframe 方案应停留在详情页）；
   - 浏览器（Chrome）打开同一后台 → 导出仍走 blob 路径、错误就地提示，行为与现状一致；
   - 导出不存在的玩家 ID（构造 404）在浏览器分支就地报错；壳分支允许静默或跳转（见改动点 2 的取舍）。

## 边界与非目标

- 不改 launcher 仓库任何文件；
- 不引入 `@JavascriptInterface` 桥；
- 不改 `/player/save` 路由语义（双通道保持）；
- 不处理管理后台其他潜在下载点（当前不存在）；
- 构建产物 `web/dist` 的更新随 Server Bundle 走既有导入流程，本专项不负责分发。

## 背景补充（供执行者快速上手）

- admin 前端技术栈：React + TS + Vite + Ant Design + React Query，源码 `admin/src`，构建输出 `web/dist`，服务端在 `/admin/` 挂载；
- `apiDownloadFile` 的既有注释（client.ts:53-54）说明了它走 fetch 通道的原因（携带部署层认证、错误就地显示）——WebView 分支保留了这一通道的浏览器行为，只是壳内换导航式；
- 壳侧已就绪的接收端（无需对方动手，仅供验证时参考）：`DownloadListener` → `LauncherAdminPolicy.classify` 放行同源（127.0.0.1:<port>）下载 → `LauncherAdminDownloadCore` 落盘并通知 UI。
