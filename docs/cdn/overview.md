# CDN 机制与架构总览
> 状态: 核心机制   关键文件: src/routes/cn/asset.ts   相关端点: /asset/get_path, /asset/version_info

World Flipper 国服（Leiting CN）CDN 私服的目录结构、文件寻址、版本链、服务端 API 与关键配置。客户端逆向下载流程见 `client-flow.md`，排查/构建/信标/已知问题见 `debugging.md`。

---

## 项目背景

### 目标

搭建国服（Leiting CN）World Flipper 的本地 CDN 服务端，使 CN APK 能连接本地服务器下载资源并正常进入游戏。

### 来源

| 组件 | 来源 | 版本 |
|------|------|------|
| CN APK | 第三方获取的 Leiting 渠道包（3 个不同大小但 SWF/bundle 完全相同） | appVersionCode 1.8.1 |
| CDN 数据 | 官方 `cn_cdn.rar` dump（停服前从 shijtswydl.leiting.com 下载） | v1.4.0 → 1.4.54 |
| 服务端 | 基于 `starpoint/`（全球服）改造为 `starpoint-cn/` | — |
| SWF 补丁 | `starview/` Rust + FFDec 工具链 | — |

> 参考：官方完整 CDN（含全部语言/平台）约 ~30GB，每语言约 ~12GB（来自上游 Starpoint 全球服 `npm run cdn` / `download_cdn.bat` 下载工具，停服后已失效；CN 资料用 `wfax` 获取，见 debugging.md 数据对齐工具链）。

### CN APK 版本对照

| 版本 | 渠道 | SWF 大小 | bundle db 文件数 | `69828cac...` | `isFullPackage` |
|------|------|------|------|------|------|
| 1.7.6 | Leiting 官方 | 28.2 MB | 12 | ✅ | `false` |
| 1.7.8 | 哔哩哔哩 | 28.2 MB | 12 | ✅ | `false` |
| 1.8.1 | Leiting 官方 | 29.0 MB | 13 | ✅ | `false` |
| 1.8.1 | Leiting 官方（米版） | 29.0 MB | 13 | ✅ | `false` |
| 1.8.1 | Leiting 官方（下载版） | 29.0 MB | 13 | ✅ | `false` |

**所有 CN 版本都包含 `69828cac...`（`character_iosbundled` 的 4 条目 stub）。** 换 APK 不能解决 C8601。

---

## 目录结构

```
.cdn/cn/
├── EntityLists/
│   ├── 10939-android_medium.csv   — Android 中画质资源清单（137,820 行，16.3MB）
│   ├── 10939-ios_medium.csv       — iOS 中画质资源清单（16.2MB）
│   ├── PathFile                   — 官方 get_path 响应快照（167KB，JSON，参考用）
│   └── empty.csv                  — 空文件（调试用，跳过 sufficiency check）
│
├── archive-common-full/           — 全量通用资源（322 ZIPs，6.25GB）
├── archive-medium-full/           — 全量中画质资源（164 ZIPs，3.19GB）
├── archive-android-full/          — 全量 Android 专用（4 ZIPs，79MB）
├── archive-ios-full/              — iOS 全量（5 ZIPs）
│
├── archive-common-diff/           — 通用增量（79 ZIPs，663MB）
├── archive-medium-diff/           — 中画质增量（54 ZIPs，48MB，内容为 .empty 占位）
├── archive-android-diff/          — Android 增量（54 ZIPs，~0，内容为 .empty 占位）
└── archive-ios-diff/              — iOS 增量（10 ZIPs）
```

**总计**：692 个 ZIP（322+164+4+5+79+54+54+10），约 10GB，覆盖版本 1.4.0 → 1.4.54（54 个增量版本）。

`medium-diff` 和 `android-diff` 的 ZIP 文件均为占位符（仅含 `.empty`），实际增量数据都在 `common-diff` 中。

---

## EntityLists CSV 格式

每行 5 列，逗号分隔：

```
production/upload/2d/5cb9b28d...,1.4.43,72979,SHA256_BASE64,common
     ↑ SHA1路径             ↑版本 ↑大小 ↑校验hash    ↑平台标签
```

| 列 | 字段 | 说明 |
|----|------|------|
| 1 | `zipPath` | ZIP 内的 SHA1 哈希相对路径 `production/upload/XX/hash` |
| 2 | `version` | 文件引入版本，如 `1.4.0` |
| 3 | `size` | 文件大小（字节） |
| 4 | `hash` | SHA256 urlsafe-base64 校验和（客户端 recovery 下载用） |
| 5 | `tag` | 平台标签 `common` / `medium` / `android`（客户端 sufficiency check 时忽略） |

---

## ZIP 内部结构

```
pinball-1.4.0-{index}-{hash}.zip
  └── production/upload/XX/{40-char-hex-hash}
       ├── 图片 (.png)
       ├── 音频 (.mp3)
       └── 二进制数据（zlib 压缩的自定义 orderedmap 格式）
```

---

## 文件寻址机制（SHA1 + Salt）

```
逻辑路径 → SHA1(路径 + Salt) → 物理路径

Salt: K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy

例：master/character/character.orderedmap
  → SHA1("master/character/character.orderedmapK6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy")
  → 2d5cb9b28d18f984a51b345a4d7aab03d77bddfc
  → ZIP 内路径: production/upload/2d/5cb9b28d18f984a51b345a4d7aab03d77bddfc
```

设备路径：`production/upload/{hash前2位}/{hash剩余}`。Salt 经 3/3 路径验证正确。

### 文件解析机制（Bundle filelist vs CDN upload）

Bundle 使用哈希索引文件（`bundle_amf.filelist`, `bundle_png.filelist` 等）记录哪些文件属于束内资源。`FileReader.resolveFiles()` 优先查 bundle 路径（白名单命中时），否则回退到 CDN `upload/` 路径：

```actionscript
// assetReadKind=2 时
if (bundleFiles.contains(hash)) {
    root = getBundleRootDirectory()  // app-storage:/asset/bundle
    prefix = "bundle"
} else {
    root = AssetDownloader.getDownloadedAssetDir()  // CDN 下载目录
    prefix = "upload"
}
// 最终构建路径
path = root + "/production/" + prefix + "/" + hash
```

> ⚠️ 这是 C8601 的机制根源：CharacterTable 的 bundle stub（`69828cac...`）在白名单中被**优先**加载，导致 CDN 中完整的 505 条目版本无法生效。详见 debugging.md 关键发现时间线。

### CharacterTable 发现

EntityLists CSV 中包含 `master/character/character.orderedmap` 的哈希路径，对应二进制文件位于 `pinball-1.4.0-61-cc592e56.zip` 内（72,970/72,979 字节）。解压后包含 **505 个角色条目**，与 `wf-assets-cn/orderedmap/character/character.json` 源数据一致（含角色 1 Alk 及所有 6 位 ID 角色）。CharacterTable 不在任何 bundle filelist 中，因此正常只能从 CDN 获取。

### SHA256 校验行为

客户端 `AssetGetPathRealRemote.successHandler` 不负责用该字段校验 ZIP；EntityLists CSV 中的 SHA256 用于校验 ZIP 内解压后的单个文件。服务端仍按固定 Catalog 返回每个归档的 SHA256，使清单可审计且与 Bundle 校验工具共用同一事实来源。

---

## Diff ZIP 命名规则与版本链

```
pinball-{from-version}-{to-version}-{index}-{hash}.zip

例: pinball-1.4.0-1.4.1-1-20227b86.zip
    从 1.4.0 升级到 1.4.1，第 1 个包
```

官方 1.4.54 基线 Catalog 的版本链（全量 + 增量）覆盖 `1.4.0 → 1.4.54`：

```
full: 1.4.0 基版 (490 ZIPs, 9.3GB)
  → diff: 1.4.0 → 1.4.1 (common 67 files, medium+android .empty)
  → diff: 1.4.1 → 1.4.2
  → ...
  → diff: 1.4.53 → 1.4.54 (common 46 files, medium+android .empty)
```

---

## asset/get_path 响应

### 请求

| 来源 | 字段 | 说明 |
|------|------|------|
| Header | `res_ver` / `RES_VER` | 客户端本地 CDN 版本（首次为空） |
| Header | `asset_size` / `ASSET_SIZE` | `fulfill`（全量）或 `shortened`（部分） |
| Body | `target_asset_version` | 可选 |

### 初始下载响应

```json
{
  "info": {
    "client_asset_version": "",
    "target_asset_version": "1.4.54",
    "eventual_target_asset_version": "1.4.54",
    "is_initial": true
  },
  "full": {
    "version": "1.4.0",
    "archive": [{ "location": "http://...", "size": 123, "sha256": "..." }]
  },
  "diff": [
    { "original_version": "1.4.0", "version": "1.4.1", "archive": [] }
  ],
  "asset_version_hash": "",
  "delayed_assets_size": 0
}
```

**关键字段**：
- `is_initial` 只在请求未上报 `RES_VER` 时为 `true`。
- `client_asset_version` 原样表达客户端当前版本，初始请求使用空字符串。
- `target_asset_version` 始终来自进程固定 Content snapshot，不接受 Body 覆盖。
- `full` 和 `diff` 都由 Catalog planner 生成；已是目标版本时两者均为 `null`。
- 归档 `size` 和 `sha256` 来自 Catalog，不在请求时扫描目录计算。

### 版本决策逻辑

```typescript
const currentVersion = request.headers['res_ver'] ?? null;
const targetVersion = contentSnapshot.cdn.targetVersion;
const plan = planCdnUpdate(contentSnapshot.cdn, {
    currentVersion,
    targetVersion,
    isInitial: currentVersion === null,
    platform: "android",
    assetSizeKind: "fulfill"
});
```

服务端只接受 Catalog 中唯一可达的更新路径。未知当前版本、无路径或多路径歧义都会明确失败；不会扫描 diff 目录自动发现新版本或归档。

---

## 服务端 API

### `POST /api/index.php/asset/version_info`

文件：`src/routes/cn/asset.ts:getVersionInfo()`

```json
{
  "base_url": "http://HOST:8001/patch/cn/",
  "files_list": "http://HOST:8001/patch/cn/recovery/empty.csv",
  "total_size": 123456789,
  "delayed_assets_size": 0
}
```

| 字段 | 作用 |
|------|------|
| `base_url` | 当前 Asset Provider 的下载根路径 |
| `files_list` | 固定兼容用零字节 Recovery CSV |
| `total_size` | 当前固定 Catalog 的 `installedBytes`，不是固定 700 MB 桩值 |
| `delayed_assets_size` | shortened 模式延迟下载量（=0 时 shortened = fulfill） |

### `POST /api/index.php/asset/get_path`

文件：`src/routes/cn/asset.ts` — 返回 `full[] + diff[]` ZIP 列表（结构见上节）。

### `POST /api/index.php/load`

文件：`src/routes/cn/load.ts:wrapOptionFields()`

`client-owned` 模式使用客户端上报且格式合法的 `RES_VER`；`local` 和 `remote` 模式使用进程固定 Content snapshot 的 `targetVersion`。

客户端用此值与 `info.json.version` 比对，决定是否触发 `get_path` 下载流程。

### 静态文件服务

文件：`src/routes/cn/cdnFiles.ts`。local 模式仅供给 Catalog allowlist 内的 ZIP；CDN 根内的非 ZIP 普通文件可按路径请求。两类文件都执行根目录、符号链接和文件类型边界检查；remote/client-owned 不注册本地 CDN 文件路由。

### `POST /assetintitle/version_info_in_title`（标题页）

文件：`src/routes/cn/assetInTitle.ts`，与主 `version_info` 共用固定 Content snapshot 和 Asset Provider 配置。

### 版本判断全链路

| 阶段 | 位置 | 字段 | 当前值 |
|------|------|------|------|
| 加载判断 | `cn/load.ts` | `available_asset_version` | client-owned 使用 `RES_VER`；其他模式使用 snapshot target |
| 下载目标 | `cn/asset.ts` | `client_asset_version` | `RES_VER ?? ""` |
| 下载目标 | `cn/asset.ts` | `target_asset_version` | snapshot `targetVersion` |
| 是否全量 | `cn/asset.ts` | `is_initial` | `RES_VER` 缺失时为 `true` |
| 增量列表 | `cn/asset.ts` | `diff` | Catalog 中从当前版本到目标版本的唯一路径 |
| Recovery | `cn/asset.ts` | `files_list` | `recovery/empty.csv` |
| 下载根 | `cn/asset.ts` | `base_url` | Asset Provider `baseUrl` |
| 显示大小 | `cn/asset.ts` | `total_size` | Catalog `installedBytes` |
| 延迟下载 | `cn/asset.ts` | `delayed_assets_size` | `0` |
| 客户端 | `info.json` | `version` | 服务端写入 |
| 客户端 | `info.json` | `assetRecoveryInfo` | 缺失文件列表 |
| 客户端 | `info.json` | `assetSizeKind` | fulfill/shortened |

### 客户端请求完整列表

**核心 CDN 流程（每次启动都会触发）：**

| 端点 | 方法 | 调用时机 | 实现文件 |
|------|------|------|------|
| `/api/index.php/tool/signup` | POST | 账号创建，获取 viewer_id | `cn/tool.ts` |
| `/api/index.php/load` | POST | 获取玩家数据 + available_asset_version | `cn/load.ts` |
| `/api/index.php/asset/version_info` | POST | CDN 版本查询（total_size, files_list, delayed_assets_size） | `cn/asset.ts` |
| `/api/index.php/asset/get_path` | POST | ZIP 列表获取（full + diff chain） | `cn/asset.ts` |
| `/patch/cn/archive-*/pinball-*.zip` | GET | planner 返回归档后按需下载 | `cn/cdnFiles.ts` |
| `/patch/cn/recovery/empty.csv` | GET | Recovery 兼容 CSV | `cn/cdnFiles.ts` |

**附加功能：**

| 端点 | 方法 | 调用时机 | 实现文件 |
|------|------|------|------|
| `/api/index.php/tool/custom_notify` | POST | 客户端推送通知（返回 `{}`） | `cn/tool.ts` |
| `/api/index.php/tool/get_header_response` | POST | 获取头部信息 | `cn/tool.ts` |
| `/api/index.php/assetintitle/version_info_in_title` | POST | 标题画面版本查询 | `cn-server.ts` |
| `/crash` | POST | 崩溃日志上报 | `cn-server.ts` 内置 |
| `/debug?loc=<ext>` | GET | **信标上报**（Beacon 系统） | `cn-server.ts` 内置 |

**教程相关：**

| 端点 | 方法 | 调用时机 | 实现文件 |
|------|------|------|------|
| `/api/index.php/tutorial/update_step` | POST | 教程步骤推进 | `cn-server.ts` stub |
| `/api/index.php/tutorial/finish_trigger` | POST | 教程完成 | `cn-server.ts` stub |

**当前 stub 响应：**

| 端点 | 响应 | 影响 |
|------|------|------|
| `tutorial/update_step` | `{ step, start_time, mail_arrived: false }` | 教程重播（未持久化，`enable_newbie=false` 缓解） |
| `tutorial/finish_trigger` | `[]`（附带 viewer_id） | 教程完成未保存 |
| `tool/custom_notify` | `{}` | 不影响主流程 |
| `assetintitle/version_info_in_title` | 与 version_info 共用固定 Content snapshot | 无影响 |

### 服务端文件索引

| 文件 | 职责 |
|------|------|
| `src/routes/cn/asset.ts` | CDN API（version_info, get_path）+ Catalog planner |
| `src/routes/cn/assetInTitle.ts` | 标题页版本查询，共用 snapshot 和 Asset Provider |
| `src/routes/cn/cdnFiles.ts` | local 模式 Catalog allowlist 文件供给与路径边界检查 |
| `src/routes/cn/load.ts` | load 响应 + wrapOptionFields + available_asset_version |
| `src/cn-server.ts` | 主入口 + 路由装配 + tutorial stub + /debug + /crash |
| `src/routes/api/tutorial.ts` | 教程完整逻辑（已导入但 CN 版本未启用） |
| `src/data/wdfpData.ts` | SQLite 玩家数据 |

---

## 关键配置点

### `total_size` 的来源

`version_info.total_size` 直接读取进程固定 Catalog 的 `installedBytes`。Catalog 在内容初始化时完成解析和校验，请求路径不会扫描 ZIP、重新计算大小或发现新归档。更换官方 CDN 或加入新版本后，必须先由内容同步生成包含新 Catalog 的 Release。

### `files_list`

| 值 | 效果 |
|------|------|
| `recovery/empty.csv` | 当前固定兼容行为：返回零字节 CSV，不提供逐文件 Recovery |

### `diff: []` vs `diff: [...]`

| 配置 | 下载内容 | 场景 |
|------|------|------|
| `full + diff` | 初始请求按 Catalog 返回 full base 和到目标版本的唯一路径 | 首次下载 |
| `diff` | 已知旧版本只返回剩余的唯一增量路径 | 版本升级 |
| `full: null, diff: null` | 客户端已处于目标版本 | 无需下载 |

### `delayed_assets_size: 0`

当 `delayed_assets_size = 0` 时，客户端的 shortened 模式等同于 fulfill 模式（下载全部），不会拆分延迟下载。

---

## 关键常量和参考值

| 常量 | 值 |
|------|-----|
| CDN Salt | `K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy` |
| CharacterTable 条目数 | 505 |
| `character_iosbundled` hash | `db69828cac33bfcdd1d4c65e8b354adf0e815e26`（bundle stub 含 4 条目） |
| CharacterTable 主路径 hash | `2d5cb9b28d18f984a51b345a4d7aab03d77bddfc` |
| CDN 总 ZIP 数 | 692（322+164+4+5+79+54+54+10） |
| CDN 总大小 | ~10 GB |
| 版本范围 | 1.4.0 → 1.4.54 |
| APK 壳版本 | 1.8.1（Leiting SDK） |
| SWF 引擎版本 | 2.1.125 |
| `isFullPackage`（原始） | `false`（所有版本） |
| `enableAssetSufficiencyCheck`（原始） | `true`（所有版本） |
| `fullResourceVersion`（原始） | `"1.0.19"`（所有版本） |
| `enable_newbie`（服务端） | `false`（修改后，避免教程重播） |
| `ANDROID_SERIAL`（构建） | 必设，否则跳过安装 |

---

## 已知限制

- **不做请求级哈希**：归档 SHA256 在 Catalog 中固定记录并随清单返回；文件请求只执行边界、类型和大小检查，不在每次下载时重新计算摘要。
- **不支持多语言/多平台**：仅 CN Android 配置。
- **CDN 来源**：`cn_cdn.rar` 来自 shijtswydl.leiting.com 官方 CDN（停止服务前下载）。两份 CN CDN dump（`cn_cdn.rar` 与 `cn_cdn_new/WF__CN2.zip`）byte-level 完全一致，唯一差异是目录名 `entities/` vs `EntityLists/`，换 CDN 不能解决任何缺失文件或兼容性问题。

> C8601 / 键体系不匹配 / recovery 循环 / bundle stub 等**问题与修复状态**记录在 `debugging.md`（关键发现时间线 + 已知问题与修复状态）。
