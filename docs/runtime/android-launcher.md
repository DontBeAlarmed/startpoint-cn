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

## 资源模式

- `client-owned` 是首版默认模式。客户端已经下载全量 CDN 时，服务端不读取本机 CDN，也不主动发布资源更新；没有 `CDN_DIR` 仍可进入 `ready`。
- `local` 由用户选择外部 CDN 目录，Launcher 校验目录后传入 `CDN_DIR`；10GB 资源不进入 APK，也不随 Server Bundle 复制到应用私有目录。
- `remote` 只传入 `CDN_BASE_URL`，服务端声明外部地址，不由 Launcher 代理远端内容。

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
