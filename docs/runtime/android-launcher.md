# Android Launcher 接入契约 v1

Android 壳是 `starpoint-cn` 的 Launcher/Supervisor 和控制台，不拥有服务端业务逻辑、CDN 数据或游戏数据库。它通过 [嵌入式运行契约](../embedded-runtime-contract.md)、Server Bundle manifest、Runtime Pack manifest、stdout/stderr 和 `/healthz` 管理服务端。

## 首版范围

首版只验收“服务端和游戏客户端在同一台 Android 设备上”的本机模式：

```text
HTTP:       127.0.0.1:8001
TCP Session: 127.0.0.1:8003
客户端 API: http://127.0.0.1:8001
```

ADB 代理、代理拦截、root 静默安装、设备兼容矩阵、厂商保活和完整局域网体验不属于 v1。监听地址和客户端 API 地址仍必须在 profile 中分开保存，为后续局域网或自定义服务地址保留配置边界。

## 可选多人模式

Launcher 不提供多人业务逻辑。未配置时始终使用服务端默认 `MULTI_MODE=embedded`，普通用户不需要看到 Hub、令牌或额外端口设置。

后续可信局域网或 VPN profile 可以把同一 Server Bundle 作为 `host` 或 `client` 启动：

- `host` 保留本机 `8001`，并提供可达的 `8003` Hub TCP 与 `8004` Hub 控制接口；
- `client` 只保留本机 `8001`，设置 `MULTI_HUB_URL` 和一条服主分发的 `MULTI_HUB_TOKEN`，游戏 TCP 按房间响应直连 Host `8003`；
- 每台设备的 `DATA_DIR`、SQLite、体力、门票、奖励和任务结算保持本地独立；
- Launcher 不自动复制、下载或对齐另一节点的 CDN、Content Release、Mod 或服务器时间。

当前令牌流程以 Host 上的 `npm run multi:token -- create/list/revoke` 为权威 CLI，Client 令牌只进入壳私有配置或环境变量，不进入 profile 导出、日志、二维码历史或仓库。`8004` 只承载运行中的房间控制，不暴露令牌管理。完整契约见[可信多人 Hub](../protocol/trusted-multi-hub.md)。

## 资源模式

- `client-owned` 是首版默认模式。客户端已经下载全量 CDN 时，服务端不读取本机 CDN，也不主动发布资源更新；没有 `CDN_DIR` 仍可进入 `ready`。
- `local` 使用固定外部目录 `/storage/emulated/0/Starpoint/cdn`，Launcher 校验特殊存储授权及 `cn/` 可读性后传入 `CDN_DIR`；10GB 资源不进入 APK，也不随 Server Bundle 复制到应用私有目录。
- `remote` 只传入 `CDN_BASE_URL`，服务端声明外部地址，不由 Launcher 代理远端内容。

普通设置页只显示 `client-owned` 和 `local`。`remote` 保留在配置模型和运行契约中，不提供首版可见入口。local 模式要求 Server Manifest v3；Launcher 先运行 `startup.localPrepareEntry`，确认退出码为 `0` 后再启动长期服务入口。准备进程失败、取消或未确认退出时不能继续启动服务。

## CDN 补丁管理

Launcher 可以通过系统文档选择器导入符合服务端 Patch Overlay schema 1 的外层 ZIP，但不生成、修复或解释补丁业务内容。导入目标固定为：

```text
/storage/emulated/0/Starpoint/cdn/
|-- cn/
`-- patches/
    `-- <targetVersion>/
        |-- patch-manifest.json
        `-- archive-*-diff/
```

导入仅在服务停止时可用。Launcher 把选择的 ZIP 复制到 `/storage/emulated/0/Starpoint/.staging/cdn-patches/<operationId>`，拒绝加密条目、绝对路径、`..`、反斜线、重复规范化路径、符号链接和特殊文件，并按 manifest 校验目标版本、声明文件、字节数和 SHA-256。通过后把解包目录在同一存储卷内原子改名为 `patches/<targetVersion>`；目标已存在时拒绝覆盖。补丁依赖、三层版本边和完整升级图仍由 Server Bundle 的 Content Sync 权威校验，Launcher 不复制这部分服务端规则。

删除同样只在服务停止时可用，只删除用户明确选择的 `patches/<targetVersion>`，不修改 `cn/`。删除后下次 local 启动重新同步内容并回到剩余补丁集合的有效最终版本。

补丁真机验收分为两段：导入后启动 local 服务并打开客户端，登录后看到客户端自动弹出目标版本更新提示即停止，不点击下载、更新或安装；退出客户端并停服后删除补丁，再启动服务确认版本回到基线。客户端是否真正下载资源始终由用户控制。

## 客户端补丁

补丁器是手机全流程的准备能力，不是启动服务端的前置条件。用户也可以使用电脑生成并安装的合法 patched APK。

补丁器固定执行以下操作：

1. 选择目标 CN 原始 APK 并保留原文件。
2. 修改 `apiServer` 为 profile 的 `clientApiBaseUrl`。
3. 将 `sdkDummy` 固定设置为 `true`，不提供普通 UI 开关。
4. 重新打包、签名并导出 patched APK 和 patch profile。
5. 通过系统安装器交给用户自行安装；不卸载、覆盖安装、迁移客户端数据或调用 ADB 静默安装。

patched APK 重新签名后不能保证覆盖官方原包。若当前安装包的签名证书与生成签名不同，Launcher 必须在生成前提示用户：卸载旧包可能删除已有账号数据和已下载 CDN。相同签名身份生成的后续 patched APK 才可继续覆盖更新。签名材料只能保存在壳私有目录或 Android Keystore 中，不进入 profile、日志、Bundle 或仓库。

建议的 patch profile 最少包含：

```json
{
  "sourceApkSha256": "<digest>",
  "patchedApkSha256": "<digest>",
  "apiBaseUrl": "http://127.0.0.1:8001",
  "skipLogin": true,
  "generatedAt": "<ISO-8601>",
  "signingCertificateSha256": "<digest>"
}
```

只有 `clientApiBaseUrl`、原始 APK 或补丁器版本要求变化时，客户端 profile 才必须标记过期。CDN、数据库、日志和后台页面变化不强制重新打包客户端。

## Supervisor 行为

Launcher 启动游戏前检查 Runtime Pack、Server Bundle、Data Volume、profile 和 `/healthz`。服务端未运行时，Launcher 可以提供“启动服务并打开游戏”的组合动作，但必须等待健康接口返回 `200` 后再启动客户端。

服务端 Bundle 更新采用本地导入、staging、active/previous 和健康检查回滚流程。Launcher 不修改 SQLite、不执行 migration、不替服务端维护 active 指针。

## 日志与后台

Launcher 提供服务端、TCP、CDN 校验、补丁器和壳自身的来源筛选，以及 `info`、`warn`、`error`、`debug` 级别筛选、关键词和时间范围搜索、当前缓冲区导出。`/debug`、`/crash` 和已识别 beacon 的原始文本必须保留。

正常运行只保留最近五分钟内存环形缓冲，不持续写普通日志文件。`error`/`fatal`、未捕获异常、服务端非零退出、客户端补丁失败和已识别的 `/crash`/错误 beacon 触发错误快照：保存触发前五分钟，并在服务仍运行时继续收集一分钟；服务已经退出时只保存退出前内容。磁盘最多保留最近五次错误快照，用户可以导出或删除。

日志导出默认脱敏本机私有路径、设备 ID、会话令牌和局域网 IP；脱敏不能修改内存中的原始诊断记录。错误快照附带的运行身份字段由[日志流契约](../embedded-runtime-contract.md#日志流)定义。

壳以前台服务运行服务端并显示常驻通知。只保证应用未被系统杀死或强制停止时服务正常运行；不实现开机启动、厂商保活、双进程守护或无限自动重启。

后台由服务端 Bundle 的 React 产物提供，Launcher 只打开 `http://<host>:<port>/admin/`，不复制或内嵌后台业务逻辑。

多人管理以后统一通过服务端 `MultiManagementService` 边界实现；CLI、React 后台和 Launcher 只能作为适配器，不得各自直接改密钥表或多人内部状态。在后台账号与权限系统完成前，React 后台只能显示多人只读诊断，不能提供令牌创建、撤销或配置写入。服务器时间分享是独立管理能力，不属于 Hub，也不得由加入房间自动触发。
