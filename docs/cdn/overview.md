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

客户端 `AssetGetPathRealRemote.successHandler` **不校验** ZIP 文件的 SHA256（`sha256: ""` 保持空即可）。EntityLists CSV 中的 SHA256 用于校验 ZIP 内**解压后的单个文件**。验证结果：CDN 文件实际 SHA256 与 CSV 记录一致（urlsafe base64 格式），CDN 文件完整性正确。

---

## Diff ZIP 命名规则与版本链

```
pinball-{from-version}-{to-version}-{index}-{hash}.zip

例: pinball-1.4.0-1.4.1-1-20227b86.zip
    从 1.4.0 升级到 1.4.1，第 1 个包
```

版本链（全量 + 增量），Diff 范围 `1.4.0 → 1.4.54`（54 组）：

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

### full-only 响应（无 diff）

```json
{
  "info": {
    "client_asset_version": null,
    "target_asset_version": "1.4.0",
    "eventual_target_asset_version": "1.4.0",
    "is_initial": true,
    "latest_maj_first_version": "1.4.0"
  },
  "full": {
    "version": "1.4.0",
    "archive": [{ "location": "http://...", "size": N, "sha256": "" }]
  },
  "diff": [],
  "asset_version_hash": ""
}
```

### full+diff 响应

```json
{
  "info": {
    "client_asset_version": "",          // ← 客户端当前版本（空字符串，非 null，匹配全局服格式）
    "target_asset_version": "1.4.54",     // ← 目标版本
    "eventual_target_asset_version": "1.4.54",
    "is_initial": true,                  // ← 强制全量下载
    "latest_maj_first_version": "1.4.0"
  },
  "full": { "version": "1.4.0", "archive": [...] },
  "diff": [
    { "original_version": "1.4.0", "version": "1.4.1", "archive": [...] },
    { "original_version": "1.4.1", "version": "1.4.2", "archive": [...] },
    ...
    { "original_version": "1.4.53", "version": "1.4.54", "archive": [...] }
  ],
  "asset_version_hash": ""
}
```

**关键字段**：
- `is_initial: true` — 告知客户端这是首次下载，需下载全部 full ZIP
- `diff[]` — 增量链，客户端按 `original_version` 链式追加下载
- `client_asset_version` — 空字符串 `""`（非 null）
- `sha256: ""` — 客户端源码不校验此字段，保持空即可

### 版本决策逻辑

```typescript
const resVer = request.headers['res_ver'] as string | undefined;
const targetVer = resVer ?? highestDiff;    // 首次 → 1.4.54
const clientVer = resVer ?? null;           // null → 首次下载
const isInitial = true;                     // 强制全量下载
```

---

## 服务端 API

### `POST /api/index.php/asset/version_info`

文件：`src/routes/cn/asset.ts:getVersionInfo()`

```json
{
  "base_url": "http://IP:8001/patch/cn/EntityLists/",
  "files_list": "http://IP:8001/patch/cn/EntityLists/empty.csv",
  "total_size": 10735093396,
  "delayed_assets_size": 0
}
```

| 字段 | 作用 |
|------|------|
| `base_url` | recovery 下载根路径 |
| `files_list` | 指向 `empty.csv` 跳过 sufficiency check；指向 `10939-android_medium.csv` 则激活完整检查 |
| `total_size` | 显示给用户的下载大小（启动时动态扫描 ZIP 计算） |
| `delayed_assets_size` | shortened 模式延迟下载量（=0 时 shortened = fulfill） |

### `POST /api/index.php/asset/get_path`

文件：`src/routes/cn/asset.ts` — 返回 `full[] + diff[]` ZIP 列表（结构见上节）。

### `POST /api/index.php/load`

文件：`src/routes/cn/load.ts:wrapOptionFields()`

```typescript
d.available_asset_version = resVer ?? "1.4.0";
```

客户端用此值与 `info.json.version` 比对，决定是否触发 `get_path` 下载流程。

### 静态文件服务

文件：`src/cn-server.ts`

```typescript
fastify.register(fastifyStatic, {
    root: ".cdn",
    prefix: "/patch"   // → .cdn/cn/archive-*/XXX.zip → /patch/cn/archive-*/XXX.zip
});
```

### `POST /assetintitle/version_info_in_title`（标题页）

文件：`src/cn-server.ts:89` — 引用 `cn/asset.ts` 导出的 `CDN_TOTAL_SIZE`，与主 `version_info` 同步。

### 版本判断全链路

| 阶段 | 位置 | 字段 | 当前值 |
|------|------|------|------|
| 加载判断 | `cn/load.ts:21` | `available_asset_version` | `resVer ?? "1.4.0"` |
| 下载目标 | `cn/asset.ts:114` | `client_asset_version` | `resVer ?? ""` |
| 下载目标 | `cn/asset.ts:115` | `target_asset_version` | `resVer ?? "1.4.54"` |
| 是否全量 | `cn/asset.ts:117` | `is_initial` | `true` |
| 增量列表 | `cn/asset.ts` | `diff` | 54 组（1.4.0→1.4.54） |
| 完整检查 | `cn/asset.ts:14` | `files_list` | `entities/10939-android_medium.csv` |
| 完整检查 | `cn/asset.ts:13` | `base_url` | `CDN_BASE/EntityLists/` |
| 显示大小 | `cn/asset.ts` | `total_size` | 动态扫描计算（~10GB） |
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
| `/patch/cn/archive-*/pinball-*.zip` | GET | **ZIP 下载**（每次 490+187=677 次） | `cn-server.ts` fastifyStatic |
| `/patch/cn/EntityLists/10939-android_medium.csv` | GET | Sufficiency check CSV 下载 | `cn-server.ts` fastifyStatic |

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
| `assetintitle/version_info_in_title` | 与 version_info 同步（TOTAL_SIZE 动态） | 无影响 |

### 服务端文件索引

| 文件 | 职责 |
|------|------|
| `src/routes/cn/asset.ts` | CDN API（version_info, get_path）+ TOTAL_SIZE 动态计算 |
| `src/routes/cn/load.ts` | load 响应 + wrapOptionFields + available_asset_version |
| `src/cn-server.ts` | 主入口 + 静态文件服务 + tutorial stub + /debug + /crash |
| `src/routes/api/tutorial.ts` | 教程完整逻辑（已导入但 CN 版本未启用） |
| `src/data/wdfpData.ts` | SQLite 玩家数据 |

---

## 关键配置点

### `TOTAL_SIZE` 动态计算

`cn/asset.ts` 在模块加载时扫描全部 ZIP，计算总大小：

```typescript
const TOTAL_SIZE = (() => {
    let total = 0;
    for (const subdir of ["archive-common-full", "archive-medium-full", "archive-android-full",
                          "archive-common-diff", "archive-medium-diff", "archive-android-diff"]) {
        for (const f of readdirSync(path.join(cdnDir, subdir)).filter(f => f.endsWith(".zip")))
            total += statSync(path.join(cdnDir, subdir, f)).size;
    }
    return total;
})();
```

只在启动时执行一次（~100ms），换 CDN 无需手动更新代码。

### `files_list`

| 值 | 效果 |
|------|------|
| `empty.csv` | sufficiency check 空操作，不弹 recovery 对话框 |
| `10939-android_medium.csv`（正式） | sufficiency check 激活，检测所有缺失文件 |

### `diff: []` vs `diff: [...]`

| 配置 | 下载内容 | 场景 |
|------|------|------|
| `diff: []` | 仅 full ZIP（490 个，~9.3GB） | 调试/极简模式 |
| `diff: [...]` | full + 增量（677 个，~10GB） | 生产模式，覆盖全版本文件 |

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

- **SHA256 字段为空**：`buildArchiveList()` 不计算 ZIP 文件哈希，但不影响客户端行为（客户端不校验 ZIP sha256）。
- **不支持多语言/多平台**：仅 CN Android 配置。
- **CDN 来源**：`cn_cdn.rar` 来自 shijtswydl.leiting.com 官方 CDN（停止服务前下载）。两份 CN CDN dump（`cn_cdn.rar` 与 `cn_cdn_new/WF__CN2.zip`）byte-level 完全一致，唯一差异是目录名 `entities/` vs `EntityLists/`，换 CDN 不能解决任何缺失文件或兼容性问题。

> C8601 / 键体系不匹配 / recovery 循环 / bundle stub 等**问题与修复状态**记录在 `debugging.md`（关键发现时间线 + 已知问题与修复状态）。
