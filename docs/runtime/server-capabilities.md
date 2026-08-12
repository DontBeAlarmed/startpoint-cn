# 服务端能力契约 v1

`GET /api/server/capabilities` 向本机发布工具提供当前运行实例的只读身份与能力事实。
它不执行同步、重载、数据库查询或玩家写入，也不返回文件系统路径、环境变量、令牌、账号或设备信息。

发布工具必须把目标地址限制为已验证的回环地址；服务端响应本身不能替代发布工具的目标隔离和兼容性校验。

## 响应形状

响应为 JSON 对象，顶层必须恰好包含以下七个字段：

```json
{
  "contractVersion": 1,
  "serverCapabilities": [
    "content.sync@1",
    "mode.hook.quest-start@1",
    "mode.hook.rush-finish@1",
    "mode.hook.rush-parties-serialized@1",
    "mode.host.base-table@1",
    "mode.host.transaction-server@1"
  ],
  "serverBundle": {
    "version": "1.0.1",
    "bundleId": null
  },
  "runtime": {
    "api": 1,
    "node": "20.19.0",
    "nodeAbi": "115",
    "platform": "win32",
    "arch": "x64"
  },
  "content": {
    "source": "bundled",
    "assetVersion": "1.4.0",
    "generatorVersion": 1,
    "releaseDigest": null,
    "contentDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "cdnTargetVersion": "1.4.0",
    "patchVersions": []
  },
  "modes": {
    "api": 1,
    "serverCapabilities": [
      "mode.hook.quest-start@1",
      "mode.hook.rush-finish@1",
      "mode.hook.rush-parties-serialized@1",
      "mode.host.base-table@1",
      "mode.host.transaction-server@1"
    ],
    "loaded": [],
    "modeDigest": "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e39a5b7c53b6f086b2a8a17"
  },
  "features": {
    "patchOverlaySchema": 1,
    "modeChangesRequireRestart": true,
    "activeContentManagement": false
  }
}
```

示例中的版本和摘要只展示形状，不代表任何部署目标。

## 字段语义

- `contractVersion`：当前固定为 `1`。字段缺失、未知字段或非 `1` 值均应失败关闭。
- `serverCapabilities`：服务端实际支持能力的去重并集，按 Unicode 码点序排列。它只能来自顶层，消费者不得从 `features` 或 `modes` 推导或补齐。
- `serverBundle`：当前代码包版本和可选的 canonical Bundle 身份。非嵌入式源码运行可没有 `bundleId`。
- `runtime`：Mode API、Node 版本、Node ABI、平台和架构事实。
- `content`：当前固定 Content Snapshot、CDN 链尾及已加载补丁边。
- `modes`：基础 Mode seam 能力、已验证并加载的模块身份，以及包含模块文件名、名称、能力和字节摘要的 canonical 集合摘要。
- `features`：当前固定的行为开关；不是 capability 的替代来源。

`content.contentDigest` 对当前全部内容表的有效状态作身份见证：bundled 模式从每张表的 canonical 内容摘要组合得到，Release 模式等于已验证 Release manifest 的摘要。它不包含本地绝对路径。

`modes.loaded` 只公开模块名、声明能力和模块字节 SHA-256，不公开模块目录或完整文件名。`modes.modeDigest` 仍把经 loader 验证的文件名纳入 canonical 身份，因此文件排序或替换会改变整体摘要。

## 当前能力边界

v1 当前只声明实际存在的能力：

- `content.sync@1`
- `mode.hook.quest-start@1`
- `mode.hook.rush-finish@1`
- `mode.hook.rush-parties-serialized@1`
- `mode.host.base-table@1`
- `mode.host.transaction-server@1`

服务端当前**不声明** `mode.release-contract@1`。需要该能力的 Mode Release 必须失败关闭，不能因为 Mode API 同为 `1` 就推断支持。新增或改变能力语义时必须引入新的 capability ID，并同步服务端测试和发布工具契约。

## 兼容性和演进

- `contractVersion: 1` 的字段和语义从本契约合入起冻结。
- 删除字段、改变既有字段语义或新增必需字段时必须提升主版本。
- capability 版本属于独立命名空间，不随 Content Schema、Mode API 或服务端版本自动变化。
- 所有数组都必须无重复；`serverCapabilities` 和 `patchVersions` 使用契约规定的稳定排序。
- 发布工具必须逐字段验证，不得把静态检查、HTTP 200 或 `/healthz` 成功当成 capability 证明。

## 安全边界

端点只读取启动后已固定的 Bundle、Content Snapshot 与 Mode loader 身份。它不得：

- 读取或返回 Data Volume、CDN、仓库或用户目录路径；
- 扫描玩家数据库、存档或设备；
- 触发 Content 同步、Mode 重载或任何写入；
- 根据客户端声明伪造服务端能力；
- 把未验证的 Mode manifest 或磁盘文件直接投影到响应。
