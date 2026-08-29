# 通用嵌入式运行契约 v1

> 状态：服务端契约 v1
> 适用对象：Android Launcher、桌面托管器、容器 Supervisor 和其他进程管理器

## 目标

本契约定义外部程序如何安装、配置、启动、检查和停止 `starpoint-cn`。它只约束部署与生命周期，不改变游戏客户端协议，也不让服务端依赖 Android 或某一种启动器。

```text
Supervisor
  ├─ Runtime Pack
  ├─ Server Bundle
  ├─ Data Volume
  └─ Asset Provider
```

双方只通过以下边界协作：

- 进程入口和退出码；
- 环境变量；
- `server-manifest.json`；
- stdout / stderr；
- `GET /healthz`。

Supervisor 不得 import 服务端源码模块、直接修改 SQLite 表、替服务端执行 migration，或通过猜测内部文件布局判断业务状态。

## 非目标

契约 v1 不定义：

- Android 前台服务、后台保活和系统权限；
- APK 补丁、签名和安装；
- CDN orderedmap 生成、补丁版本分配或回滚；
- 玩家、关卡、扭蛋、联机等业务 API；
- 在线更新源和自动下载协议；
- 数据库导入、导出和跨版本数据转换工具。

## 组件职责

### Supervisor

Supervisor 负责：

- 校验 Runtime Pack 和 Server Bundle；
- 创建可写 Data Volume；
- 传入环境变量并启动 manifest 的入口；
- 捕获 stdout、stderr、信号和退出码；
- 轮询 `/healthz`；
- 更新前备份 Data Volume；
- 在自己的 staging 和不可变版本目录中完成发布或回滚。

服务端不会写 Supervisor 的 active/previous 指针，也不会删除旧 Bundle 或备份。

### Runtime Pack

Runtime Pack 低频更新，至少包含：

- 满足 `package.json.engines.node` 的 Node.js；
- 生产依赖；
- 与 Node ABI、平台和 CPU ABI 匹配的 `better-sqlite3`；
- Runtime Pack 自己的版本与摘要清单。

规范布局：

```text
runtime-pack/
  node/bin/node
  node_modules/
  runtime-pack-manifest.json
```

`runtime-pack-manifest.json` 固定记录 `runtimeId`、`schemaVersion=1`、`runtimeApi=1`、完整 Node 版本、`process.versions.modules`、平台、CPU 架构、`dependencyLock`、可执行文件和完整文件摘要清单。`runtimeId` 是移除自身后的 canonical manifest SHA256；`dependencyLock` 是构建 Runtime Pack 所用原始 `package-lock.json` 字节的小写 SHA256（均带 `sha256:` 前缀）。生产依赖必须由这份 lock 执行 `npm ci --omit=dev` 得到。完整格式和独立 verifier 见 [`runtime/runtime-pack.md`](./runtime/runtime-pack.md)。

Supervisor 必须先验证 Runtime Pack 文件集合、摘要、平台/架构和 Node ABI，再核对 Runtime Pack 与 Server Bundle 的 `runtimeApi`、Node 版本和 `dependencyLock`；任一条件不兼容时不得执行运行入口。

日常开发和普通服务器部署使用当前环境默认 Node.js，不维护 Node 20/22 两套命令。Runtime Pack 制作者仍必须记录实际打包的完整 Node 版本和 ABI；依赖或原生模块变化时发布新的 Runtime Pack。

### Server Bundle

Server Bundle 是高频更新的只读代码包：

```text
server-bundle/
  out/
  assets/
  web/
    dist/                 # 必需管理后台产物
  LICENSE
  NOTICE
  server-manifest.json
```

Bundle 不包含：

- Node、`node_modules` 和原生模块；
- 玩家数据库和运行状态；
- Content Store / 激活指针；
- CDN 归档和 `asset-patch` payload；
- 日志、APK、签名材料和 `web/public/` 本地内容（包括漫画大图）。

漫画由部署者在 Bundle 外准备，并通过绝对 `COMIC_DIR` 显式挂载；未配置时嵌入模式不提供漫画图片。图片仍只通过 `/api/index.php/comic/image` 业务接口读取，Server Bundle 不提供通用 `/public` 静态根。

构建、清单和 verifier 见 [`runtime/server-bundle.md`](./runtime/server-bundle.md)。Supervisor 必须在执行 `out/cn-server.js` 前运行等价的完整校验。服务进程只读取 manifest 的版本和 `bundleId` 用于健康报告，不在每次启动时重复哈希整个 Bundle。

`dist/server-bundle` 是离线构建输出，不是 active Bundle。运行中版本切换由 Supervisor 在独占 staging 校验后完成。

### Data Volume

全部服务端可变状态由 `DATA_DIR` 承载：

```text
<DATA_DIR>/
  wdfp_data.db
  wdfp_data.db.version
  content/
    store/
  asset-provider/
    production/upload/
    legacy-metadata.json
  state/
    active_account.json
    default_save.json
    content/
    seeds/
```

默认开发路径是项目根的 `.database`。嵌入模式必须显式传入由 Supervisor 管理的绝对 `DATA_DIR`。服务端在打开数据库前解析现有祖先的物理路径，拒绝 Data Volume 与 Server Bundle 或 local CDN 相等、互为祖先/后代；通过祖先符号链接指回这些只读输入也会被拒绝。替换 Server Bundle 不得覆盖 Data Volume。

数据库 schema 由服务端代码拥有。当前 Bundle 接受 schema `0..22`，启动时由服务端事务化迁移到 `22`，并拒绝高于 `22` 的数据库。Supervisor 只在停服后复制备份，不直接执行 SQL。

### Asset Provider

资源提供模式相互独立：

| 模式 | 输入 | 行为 |
|---|---|---|
| `client-owned` | 客户端 `RES_VER` | 不发布资源下载，不读取本地 CDN |
| `local` | `CDN_DIR` | 只读供给 Catalog 声明的 ZIP 和 CDN 根内普通文件 |
| `remote` | `CDN_BASE_URL` | 只声明外部 URL，不代理或探测远端内容 |

Content Release / fallback Catalog 是 CN 目标版本和归档清单的唯一权威。Asset Provider 不负责补丁版本分配、候选发布或自动回滚。

## Server Manifest v3

manifest 核心字段如下：

```json
{
  "schemaVersion": 3,
  "name": "starpoint-cn",
  "serverVersion": "1.0.1",
  "bundleId": "sha256:<digest>",
  "entry": "out/cn-server.js",
  "startup": {
    "localPrepareEntry": "out/content/sync/entry.js"
  },
  "requires": {
    "runtimeApi": 1,
    "node": ">=20.12.0",
    "dependencyLock": "sha256:<package-lock digest>",
    "minDataSchema": 0,
    "targetDataSchema": 22
  },
  "admin": {
    "path": "web/dist",
    "required": true
  },
  "assets": {
    "supportedModes": ["client-owned", "local", "remote"],
    "minClientAssetVersion": "1.4.54"
  },
  "ports": {
    "http": 8001,
    "tcp": 8003
  },
  "files": []
}
```

正式 manifest 的 `files` 枚举除 manifest 自身外的全部 Bundle 文件。每项记录 POSIX 相对路径、字节数和小写 SHA256。`bundleId` 对移除 `bundleId` 后的 canonical manifest 求 SHA256，不包含构建时间、设备路径或操作者信息。

`requires.dependencyLock` 由 Builder 从仓库根 `package-lock.json` 原始字节计算。Supervisor 调用 verifier 时必须传入 Runtime Pack manifest 的同名值；不一致时不得启动候选 Bundle。

`entry` 始终是长期运行的服务进程。`startup.localPrepareEntry` 是仅供 `ASSET_MODE=local` 使用的一次性内容准备进程；它与 `entry` 使用同一个受验证 Node、Bundle 工作目录和环境，成功标准是正常退出且退出码为 `0`。Supervisor 必须直接持有两个阶段各自的进程句柄，准备成功并确认进程退出后才能启动 `entry`。准备失败、收到信号、被取消或无法确认退出时不得启动服务进程。

Manifest v2 继续作为兼容输入，只允许 `client-owned` 和 `remote`。要求 local 模式的 Supervisor 必须拒绝缺少 `startup.localPrepareEntry` 的 v2 Bundle；旧 Supervisor 则会因未知 schema 拒绝 v3，不能把 v3 当作 v2 降级执行。

## 启动配置

Supervisor 以 Server Bundle 根为工作目录。local 模式先执行 manifest `startup.localPrepareEntry`，成功后再执行 manifest `entry`；其他模式直接执行 `entry`。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EMBEDDED_RUNTIME` | `0` | 嵌入模式必须设为 `1`，强制有效 manifest 和 Data Volume 边界 |
| `DATA_DIR` | `.database` | 嵌入模式必须显式传入绝对路径 |
| `BETTER_SQLITE3_NATIVE_BINDING` | 无 | 可选外置 better-sqlite3 addon；仅接受绝对普通文件路径及 `.node` / `.so` 扩展名 |
| `CN_LISTEN_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `CN_LISTEN_PORT` | `8001` | HTTP 端口 |
| `SESSION_HOST` | `127.0.0.1` | TCP 监听地址 |
| `SESSION_PORT` | `8003` | TCP 端口 |
| `SESSION_PUBLIC_HOST` | 自动推导 | 客户端可达的 TCP 地址 |
| `ASSET_MODE` | `local` | `client-owned` / `local` / `remote` |
| `CDN_DIR` | `.cdn` | local 模式 CDN 父目录 |
| `CDN_BASE_URL` | 无 | remote 必填；local 可覆盖公开地址 |
| `COMIC_DIR` | 嵌入模式无 | 可选外置漫画根目录；设置时必须是与 Bundle、Data Volume、local CDN 隔离的绝对路径 |

嵌入模式禁止设置旧 `WDFP_DATABASE_DIR`，也禁止设置 `CONTENT_DIR`、`CONTENT_STORE_DIR`、`CONTENT_STATE_DIR` 或 `CONTENT_RUNTIME_DIR`。Content Store、激活状态和 Asset Provider 可变数据因此都保留在唯一 `DATA_DIR`，bundled fallback 固定来自候选 Bundle 的 `assets/`；Supervisor 的一次停服备份可以覆盖全部可变状态。普通开发/服务器运行仍可使用这些兼容覆盖。

默认监听回环地址。开放局域网或公网监听必须由部署者显式配置并承担访问控制。`NODE_PATH` 是 Runtime Pack 与 CommonJS Bundle 之间唯一规范的模块解析桥梁。`client-owned` 和 `remote` 直接启动服务入口；local 的等价受支持顺序如下：

```bash
cd <SERVER_BUNDLE>
export NODE_PATH=<RUNTIME_PACK>/node_modules
export EMBEDDED_RUNTIME=1
export DATA_DIR=<ABSOLUTE_DATA_VOLUME>
export BETTER_SQLITE3_NATIVE_BINDING=<ABSOLUTE_RUNTIME_ADDON>
export ASSET_MODE=local
export CDN_DIR=<ABSOLUTE_CDN_PARENT>
<RUNTIME_PACK>/node/bin/node out/content/sync/entry.js

# 只有上一进程正常退出且退出码为 0 才执行
<RUNTIME_PACK>/node/bin/node out/cn-server.js
```

Supervisor 在 Runtime Pack 的原生 addon 不位于 better-sqlite3 默认解析位置时必须传入 `BETTER_SQLITE3_NATIVE_BINDING`。桌面 `.node` 路径由 better-sqlite3 直接加载；Android 等以 `.so` 暴露 Node addon 的宿主由服务端先通过 `process.dlopen()` 加载，再把导出对象交给 better-sqlite3。加载失败统一作为配置错误处理，不向日志或结果暴露宿主绝对路径。

## 生命周期

Supervisor 和服务端的完整启动顺序：

1. Supervisor 校验 Runtime Pack、Server Bundle 和配置；
2. local 模式启动内容准备入口并等待成功退出，其他模式跳过；
3. Supervisor 清除准备阶段进程身份并启动服务入口；
4. 服务解析配置，打开 Data Volume 和数据库并执行 migration；
5. 服务加载 Content snapshot；
6. 服务配置并监听 HTTP 与 TCP Session；
7. 健康状态切换为 `ready`。

任一步失败都会清理已打开资源并设置非零退出码。嵌入模式缺少或损坏 `server-manifest.json`、使用相对或与 Bundle/local CDN 重叠的 `DATA_DIR`，以及覆盖内容路径，均视为配置错误。退出码分类：

| 退出码 | 含义 |
|---:|---|
| `0` | 正常停止 |
| `10` | 配置无效 |
| `11` | Runtime Pack 不兼容（保留） |
| `12` | 数据库打开或迁移失败 |
| `13` | HTTP 启动失败 |
| `14` | TCP 启动或运行失败 |
| `15` | Content snapshot 初始化失败 |
| `1` | 未分类错误 |

收到 `SIGTERM` 或 `SIGINT` 后，服务端依次停止 HTTP、停止 TCP、执行 SQLite WAL checkpoint、关闭数据库。Supervisor 超过自己的停止超时后才可强制终止。

## 健康接口

`GET /healthz` 是普通 JSON，不经过管理后台 SPA fallback：

- `200`：HTTP、TCP、数据库和 Content snapshot 全部就绪；
- `503`：仍在启动、正在停止或关键组件不可用。

最小响应：

```json
{
  "contractVersion": 1,
  "status": "ready",
  "serverBundle": {
    "version": "1.0.1",
    "bundleId": "sha256:<digest>"
  },
  "runtime": {
    "api": 1,
    "node": "v20.12.0"
  },
  "database": {
    "ready": true,
    "schema": 12
  },
  "services": {
    "http": true,
    "tcp": true
  },
  "admin": {
    "required": true,
    "available": true
  },
  "assets": {
    "mode": "client-owned",
    "status": "unknown",
    "minClientVersion": "1.4.54",
    "observedClientVersion": null
  }
}
```

源码开发运行没有 manifest 时，`serverBundle.bundleId` 为 `null`，版本回退到 `package.json`。嵌入模式不允许该回退。后台是必需组件：缺少 `web/dist/index.html` 时运行时拒绝初始化，`admin.available=false` 也会阻止健康状态进入 ready；client-owned 的资源 `unknown` 仍不阻止 ready。

## 日志流

服务端 stdout、stderr 都是 UTF-8 字节流，以 `\n` 分隔记录；Supervisor 必须保留跨读取块的未完成行，并兼容最后一行没有换行的进程退出。stdout 用于普通运行信息，stderr 用于需要关注或导致失败的信息，但流本身不等价于最终日志级别。

服务端现有普通文本是稳定兼容输入。逐步结构化的记录使用单行 JSON Lines：

```json
{"time":"2026-07-22T00:00:00.000Z","level":"info","source":"server","message":"ready"}
```

只有同时满足以下条件的行才按结构化日志解析：顶层是 JSON 对象，`time` 是 ISO-8601 字符串，`level` 是 `debug`、`info`、`warn`、`error` 之一，`source` 和 `message` 是字符串。解析失败或字段不完整时必须保留原始文本，不得丢弃。Supervisor 可以为普通文本补充接收时间，并根据来源流或已知前缀推导显示级别，但导出时必须保留原始行。

服务端不负责长期保存进程日志。Launcher/Supervisor 负责容量限制、脱敏和导出；Android Launcher 的五分钟环形缓冲和错误快照策略见 [`runtime/android-launcher.md`](./runtime/android-launcher.md)。错误快照至少附带 Runtime Pack `runtimeId` 和 Node 版本、Server Bundle version 和 `bundleId`、数据库 schema、`ASSET_MODE`、退出码及最后一次健康状态。

## 更新与回滚

契约 v1 只定义本地导入，不定义联网更新。可验证对象始终是解包后的目录；用于文件选择器和跨设备传输时，标准容器是 ZIP：

```text
starpoint-cn-server-<serverVersion>.zip
  server-bundle/
    server-manifest.json
    out/
    assets/
    web/dist/
    LICENSE
    NOTICE
```

ZIP 必须只有一个顶层 `server-bundle/` 目录，不得加密，不得包含符号链接、特殊文件、绝对路径、`..`、反斜杠路径或重复规范化路径。Supervisor 必须在解包前限制压缩包字节数、条目数和总解压字节数，在独占 staging 内解包，再对 `server-bundle/` 运行完整 verifier；不能直接从 ZIP 执行入口。具体上限属于宿主资源策略，必须在开始解包前配置，不能依赖 ZIP 声明值无限分配空间。

推荐 Supervisor 布局：

```text
<EMBEDDED_ROOT>/server/
  staging/
  bundles/<bundleId>/
  active-bundle.json
  previous-bundle.json
```

更新流程：

1. 复制候选 Bundle 到独占 staging；
2. 校验 manifest、文件摘要、Runtime API、Node、数据 schema，并以 `--dependency-lock` 核对 Runtime Pack；
3. 优雅停止当前服务并备份 Data Volume；
4. 注册不可变 Bundle，原子切换 Supervisor 自己的 active 指针；
5. 以 `EMBEDDED_RUNTIME=1` 启动候选，等待 `/healthz` 返回 `200`，并要求响应中的 `serverBundle.bundleId` 精确等于 staging verifier 得到的候选 ID；
6. 失败时停止候选，恢复 previous 指针和匹配的 Data Volume 备份。

Builder 和服务进程都不能自行操作这些指针。

## 安全与兼容边界

- manifest、导入目录和环境变量都按不可信输入处理；
- verifier 拒绝绝对路径、`..`、重复项、错序、符号链接、特殊文件、额外文件、摘要不符和非允许 Bundle 根；
- Supervisor 在 staging 校验期间必须拥有独占写权限，避免同权限进程并发替换输入；
- `/healthz` 不暴露令牌、设备 ID、玩家数据、绝对私有路径或环境变量原文；
- keystore、密码和私钥不能进入 Bundle、Data Volume、日志或仓库。

契约的稳定面是 manifest schema、环境变量、进程/退出码和健康响应。新增可选字段可以向后兼容；删除字段、改变语义或增加必需字段必须提升对应契约主版本。

## 当前实现状态

服务端已完成：

- Data Volume 路径统一与旧状态迁移；
- 三种 Asset Provider 模式；
- Content Store、状态和 bundled runtime 分离；
- 数据库失败即终止、稳定退出码和优雅停止；
- `/healthz`；
- 可重复 Server Bundle、canonical manifest 和独立 verifier；
- Runtime Pack 依赖锁兼容校验与嵌入模式严格身份检查；
- Runtime Pack canonical manifest 和独立 verifier；
- 可选外置 `COMIC_DIR`，嵌入模式不再依赖 Bundle 内的 `web/public/`；
- 必需管理后台产物。

尚未属于服务端仓库的工作：

- 各平台 Runtime Pack；
- Android / 桌面 Supervisor；
- Supervisor 的备份、active/previous 指针和回滚实现；
- 在线更新与下载源。
