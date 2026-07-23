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

日常开发和普通服务器部署使用当前环境默认 Node.js，不维护 Node 20/22 两套命令。Runtime Pack 制作者仍必须记录实际打包的完整 Node 版本和 ABI；依赖或原生模块变化时发布新的 Runtime Pack。

### Server Bundle

Server Bundle 是高频更新的只读代码包：

```text
server-bundle/
  out/
  assets/
  web/
    pages/
    public/
    dist/                 # 可选
  LICENSE
  NOTICE
  server-manifest.json
```

Bundle 不包含：

- Node、`node_modules` 和原生模块；
- 玩家数据库和运行状态；
- Content Store / 激活指针；
- CDN 归档和 `asset-patch` payload；
- 日志、APK、签名材料和漫画大图。

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

默认开发路径是项目根的 `.database`。嵌入模式必须显式传入由 Supervisor 管理的绝对 `DATA_DIR`。替换 Server Bundle 不得覆盖 Data Volume。

数据库 schema 由服务端代码拥有。当前 Bundle 接受 schema `0..4`，启动时由服务端事务化迁移到 `4`，并拒绝高于 `4` 的数据库。Supervisor 只在停服后复制备份，不直接执行 SQL。

### Asset Provider

资源提供模式相互独立：

| 模式 | 输入 | 行为 |
|---|---|---|
| `client-owned` | 客户端 `RES_VER` | 不发布资源下载，不读取本地 CDN |
| `local` | `CDN_DIR` | 只读供给 Catalog 声明的 ZIP 和 CDN 根内普通文件 |
| `remote` | `CDN_BASE_URL` | 只声明外部 URL，不代理或探测远端内容 |

Content Release / fallback Catalog 是 CN 目标版本和归档清单的唯一权威。Asset Provider 不负责补丁版本分配、候选发布或自动回滚。

## Server Manifest v1

manifest 核心字段如下：

```json
{
  "schemaVersion": 1,
  "name": "starpoint-cn",
  "serverVersion": "1.0.1",
  "bundleId": "sha256:<digest>",
  "entry": "out/cn-server.js",
  "requires": {
    "runtimeApi": 1,
    "node": ">=20.12.0",
    "minDataSchema": 0,
    "targetDataSchema": 4
  },
  "admin": {
    "path": "web/dist",
    "required": false
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

## 启动配置

Supervisor 以 Server Bundle 根为工作目录并执行 manifest `entry`。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATA_DIR` | `.database` | 可写 Data Volume；嵌入模式显式传入 |
| `CONTENT_RUNTIME_DIR` | `assets` | Bundle 内只读 bundled fallback |
| `CONTENT_STORE_DIR` | `<DATA_DIR>/content/store` | 可选覆盖 Content Store |
| `CONTENT_STATE_DIR` | `<DATA_DIR>/state/content` | 可选覆盖激活状态 |
| `CN_LISTEN_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `CN_LISTEN_PORT` | `8001` | HTTP 端口 |
| `SESSION_HOST` | `127.0.0.1` | TCP 监听地址 |
| `SESSION_PORT` | `8003` | TCP 端口 |
| `SESSION_PUBLIC_HOST` | 自动推导 | 客户端可达的 TCP 地址 |
| `ASSET_MODE` | `local` | `client-owned` / `local` / `remote` |
| `CDN_DIR` | `.cdn` | local 模式 CDN 父目录 |
| `CDN_BASE_URL` | 无 | remote 必填；local 可覆盖公开地址 |

默认监听回环地址。开放局域网或公网监听必须由部署者显式配置并承担访问控制。

## 生命周期

启动顺序：

1. 解析并校验配置；
2. 打开 Data Volume 和数据库，执行 migration；
3. 加载 Content snapshot；
4. 配置并监听 HTTP；
5. 监听 TCP Session；
6. 健康状态切换为 `ready`。

任一步失败都会清理已打开资源并设置非零退出码。退出码分类：

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

`GET /healthz` 是普通 JSON，不依赖管理后台：

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
    "schema": 4
  },
  "services": {
    "http": true,
    "tcp": true
  },
  "admin": {
    "available": false
  },
  "assets": {
    "mode": "client-owned",
    "status": "unknown",
    "minClientVersion": "1.4.54",
    "observedClientVersion": null
  }
}
```

源码开发运行没有 manifest 时，`serverBundle.bundleId` 为 `null`，版本回退到 `package.json`。`admin.available=false` 和 client-owned 的资源 `unknown` 不阻止游戏服务进入 ready。

## 更新与回滚

契约 v1 只定义本地导入，不定义联网更新。推荐 Supervisor 布局：

```text
<EMBEDDED_ROOT>/server/
  staging/
  bundles/<bundleId>/
  active-bundle.json
  previous-bundle.json
```

更新流程：

1. 复制候选 Bundle 到独占 staging；
2. 校验 manifest、文件摘要、Runtime API、Node 和数据 schema；
3. 优雅停止当前服务并备份 Data Volume；
4. 注册不可变 Bundle，原子切换 Supervisor 自己的 active 指针；
5. 启动候选并等待 `/healthz` 返回 `200`；
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
- 可选管理后台产物。

尚未属于服务端仓库的工作：

- 各平台 Runtime Pack；
- Android / 桌面 Supervisor；
- Supervisor 的备份、active/previous 指针和回滚实现；
- 在线更新与下载源。
