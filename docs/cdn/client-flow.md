# CDN 客户端资源下载逻辑
> 状态: 客户端逆向   关键文件: GlobalLoading.applyLoad (client SWF)   相关端点: -

> 基于 `wf-2.1.125-cn-decompiled` 反编译代码分析。服务端机制见 `overview.md`，排查/构建见 `debugging.md`。

---

## 一、入口：GlobalLoading.applyLoad()

文件：`pinball/loading/global/GlobalLoading.as:392-432`

游戏收到服务端 `/load` 响应后，`GlobalLoadingTask.loadingInput()` case `0` 提取 `assetVersion` 字段，调用 `applyLoad()`。

### 三路分支

```
applyLoad(rightAfterSignUp, serverAssetVersion)
│
├─ devConfig.assetReadKind != 2  → 直接 StartLoading（无 CDN）
│
├─ 路 A: isDownloaded() == false && needsDownloadAsset() == true
│   → ZIP 下载流（版本更新对话框）
│
├─ 路 B: isDownloaded() == true && isAssetComplete() == false && needsDownloadAsset() == true
│   → Recovery 流（资源不足对话框）
│
└─ 路 C: 两者都 true → 直接 StartLoading（无需下载）
```

---

## 二、判断器

三个判断器汇总：

| 方法 | 依据 | 返回 true 条件 |
|------|------|------|
| `isDownloaded()` | `info.json.version == serverVersion` | 版本匹配 |
| `isAssetComplete()` | `info.json.assetRecoveryInfo == []` | 无缺失文件 |
| `needsDownloadAsset()` | `logicStatus.loadedData.index == 0` | 已加载过数据 |

### 2.1 isDownloaded()

文件：`AssetDownloader.as:394-425`

```as3
public function isDownloaded(serverVersion:Option) : Boolean
{
    if(DevConfig.isFullPackage) return true;

    // 下游标记文件 → 下载未完成
    if(partial_downloaded.json.exists()) return false;
    // shortened 模式变更 → 强制重检
    if(AssetShortenedMode.shouldCheckDownload()) return false;

    // 比对 info.json.version 和服务端版本
    serverVer = serverVersion.params[0];     // e.g. "1.4.54"
    localVer = getResourceVersion();         // 读 info.json → .version
    if(localVer == Some(serverVer)) return true;
    return false;
}
```

| 条件 | 返回 |
|------|------|
| `isFullPackage` | `true` |
| `partial_downloaded.json` 存在 | `false` |
| `info.json.version == serverVersion` | `true` |
| `info.json` 不存在或版本不匹配 | `false` |

### 2.2 isAssetComplete()

文件：`AssetDownloader.as:427-452`

```as3
public function isAssetComplete() : Boolean
{
    if(DevConfig.isFullPackage) return true;
    if(devConfig.assetReadKind == 2)
    {
        if(devConfig.remote.index == 1)  // RealRemote
        {
            recoveryInfo = getAssetRecoveryInfo();  // 读 info.json.assetRecoveryInfo
            if(recoveryInfo == Some([])) return true;   // 空列表 = 完成
            return false;                               // 非空或不存在 = 未完成
        }
        return true;
    }
    return true;
}
```

| 条件 | 返回 |
|------|------|
| `isFullPackage` | `true` |
| `info.json.assetRecoveryInfo == []` | `true` |
| `info.json` 不存在或无 `assetRecoveryInfo` 字段 | `false` |
| `assetRecoveryInfo` 非空 | `false` |

### 2.3 needsDownloadAsset()

文件：`GlobalLogic.as:285-305`

```as3
public function needsDownloadAsset() : Boolean
{
    // 全量包 → bundle 已含全部资源，不需要 CDN
    if(DevConfig.isFullPackage) return false;

    switch(devConfig.tutorialBundleKind.index)
    {
        case 0: // Android
            // loadedData 存在 → 已登录过 → 需要 CDN 补充资源
            if(logicStatus.loadedData.index == 0) return true;
            // loadedData 不存在 → 首次启动/教程阶段 → 不触发 CDN
            return false;

        case 1: // iOS
            // 教程未完成 → false；教程完成后 → true
            return !isBeforeTutorialDownload();
    }
}
```

**行为说明**：首次启动（全新安装）时 `loadedData = None` → 返回 false → 不触发 CDN 下载 → 直接显示标题画面 → 用户交互后 `loadedData = Some` → 返回 true → CDN 触发。

---

## 三、路 A：ZIP 下载流

### 3.1 触发

`isDownloaded() == false` → `startCheckAssetDownload(Normal(shortenedMode), serverVersion, handler)`

### 3.2 AssetDownloadChecker

1. 读 `info.json` → 获取 `initialVersion`、`assetSizeKind`
2. `assetSizeKind` 缺失时默认 `"fulfill"`
3. 调用 `POST /asset/get_path`
4. 调用 `POST /asset/version_info`
5. 根据结果 dispatch `NeedToDownload` 或 `NoNeedToDownload`

### 3.3 POST /asset/get_path

文件：`AssetGetPathRealRemote.as`

**请求：**
```
Headers: RES_VER: <initialVersion>, ASSET_SIZE: "fulfill"|"shortened"
Body:    { "target_asset_version": "<serverVersion>" }
```

**服务端响应：**
```json
{
  "diff": [
    { "original_version": "1.4.0", "version": "1.4.1", "archive": [{"location":"...", "size":123}] },
    ...
  ],
  "full": {
    "version": "1.4.0",
    "archive": [{"location":"...", "size":456}]
  },
  "info": {
    "eventual_target_asset_version": "1.4.54",
    "is_initial": true
  }
}
```

**客户端处理（AneAssetDownloading.startDownload）：**

```
1. 收集 full.archive[] 全部 ZIP
2. 从 full.version 开始，遍历 diff 链：
   while (diffMap[version]) {
       archives += diffMap[version].archive
       version = diffMap[version].version
   }
3. 得到最终 version = eventual_target_asset_version
   后解压的同名文件覆盖先解压的
```

### 3.4 POST /asset/version_info

文件：`AssetVersionInfoRealRemote.as`

**请求：**
```
Body: { "asset_version": "<rootVersion>" }
```

**服务端响应：**
```json
{
  "base_url": "http://IP/patch/cn/EntityLists/",
  "files_list": "http://IP/patch/cn/EntityLists/xxx.csv",
  "total_size": 10735093396,
  "delayed_assets_size": 0
}
```

| 字段 | 用途 |
|------|------|
| `base_url` | recovery 下载根路径 |
| `files_list` | CSV URL，sufficiency check 下载 |
| `total_size` | 下载大小显示 |
| `delayed_assets_size` | shortened 模式减去的延迟量 |

### 3.5 用户确认对话框

`GlobalLoadingTask.loadingInput()` case `2`：

| dispatch 类型 | 对话框 |
|------|------|
| `ServerResponse` | "版本更新"（显示下载大小） |
| `ServerResponseForBothMode` | "选择下载模式"（fulfill vs shortened 二选一） |

### 3.6 Native ANE 下载解压

文件：`AneAssetDownloading.as`

```
AneAssetDownloading.run()
  1. 创建原生 AssetDownloadAne（Adobe AIR Native Extension）
  2. 设置进度追踪（下载 0.99 + 解压 0.01）
  3. 调用 startDownload()

startDownload()
  1. 收集所有 ZIP URL（full + diff chain）
  2. 计算 final version
  3. 写 partial_downloaded.json（进行中标记）
  4. 检查存储空间（需 > totalExtracted - currentSize + 500MB）
  5. downloadAne.startDownload(zipArchives, downloadDir, platformInfoFile)

downloadCompleteHandler() → finishDownload()
  1. downloadAne.finishDownload()（原生解压）
  2. startSaveVersionInfo() → 写 info.json
  3. 删 partial_downloaded.json
  4. dispatch Complete → 回到游戏
```

### 3.7 写 info.json

```json
{
  "version": "1.4.54",
  "assetRecoveryInfo": [],
  "totalSize": 10000000000,
  "assetSizeKind": "fulfill",
  "baseUrl": "http://IP/patch/cn/EntityLists/",
  "latestModifiedTimeOfArchive": "2024-01-01T00:00:00"
}
```

---

## 四、路 B：Recovery 下载流

### 4.1 触发

`isDownloaded() == true && isAssetComplete() == false` → `prepareAssetRecovery()`

### 4.2 AssetRecoveryPreparer

1. 读 `info.json.assetRecoveryInfo`（缺失文件列表）
2. dispatch `NeedToDownload(AssetRecovery(files))`

### 4.3 用户确认

同 ZIP 流，但 dialog kind = `AssetRecovery` → "资源不足/资源补全"对话框。

### 4.4 AssetRecovering — 独立文件下载

文件：`AssetRecoveryLoading.as` → `AssetRecovering.as`

```
run()
  1. 读 info.json.version
  2. 调用 asset/version_info → 获取 base_url
  3. 创建 AssetRecovering

update() — 每帧批量处理（最多 100 并发）
  对每个缺失文件：
    URL = base_url + file.hash
    RemoteUtil.startDownload(urlRequest, targetFile, ...)

dispose() — 全部完成
  写 info.json（assetRecoveryInfo: []）
```

**Recovery URL 构造：**

```
URL = response.base_url + file.hash

例：
  base_url = "http://IP/patch/cn/EntityLists/"
  file.hash = "a2bb73ae09bde51803..."  (SHA1+salt of logical path)
  URL = "http://IP/patch/cn/EntityLists/a2bb73ae09bde51803..."
```

---

## 五、Sufficiency Check 流

### 5.1 触发

运行时由 `LogicScene` 触发，不限于 `GlobalLoading` 阶段。

### 5.2 AssetSufficiencyCheckLoading

```
run()
  1. 读 info.json.version
  2. remote.assetVersionInfo(version, startDownloadCsv)
  3. startDownloadCsv() → GET files_list URL → 下载 CSV
  4. startReadCsv() → Reader.parseUtf8Bytes() → 创建 AssetSufficiencyChecking
```

### 5.3 AssetSufficiencyChecking — 磁盘扫描

```
update() — 每帧遍历 CSV 行
  对每行 {location, version, size, hash}:
    checkPath = downloadDir + "/" + location
    if (!fileExists(checkPath)):
      assetRecoveryInfo.push({hash, size, location, version})

completeHandler()
  1. 写 info.json（含 assetRecoveryInfo）
  2. dispatch Complete(AssetRecovery(assetRecoveryInfo))
```

### 5.4 CSV 格式（10939-android_medium.csv）

```
production/upload/2d/5cb9b28d...,1.4.43,72979,SHA256_BASE64,common
     ↑ SHA1路径             ↑版本 ↑大小 ↑校验hash    ↑平台标签
```

| 列 | 字段 | 客户端使用 |
|----|------|------|
| 1 | zipPath | 磁盘文件查找路径 |
| 2 | version | 文件引入版本 |
| 3 | size | 文件大小（Int） |
| 4 | hash | recovery 下载用 SHA256 |
| 5 | tag | 忽略（common/medium/android） |

---

## 六、info.json 状态机

### 位置

```
{appStorage}/asset/asset_download/dummy/info.json
```

### 完整结构

```json
{
  "version": "1.4.54",
  "assetRecoveryInfo": [],
  "totalSize": 10735093396,
  "assetSizeKind": "fulfill",
  "baseUrl": "http://IP/patch/cn/EntityLists/",
  "latestModifiedTimeOfArchive": "Mon, 04 Aug 2025 14:07:41 GMT"
}
```

### 各字段含义

| 字段 | 写时机 | 读时机 | 用途 |
|------|------|------|------|
| `version` | ZIP 下载完成 | `isDownloaded()` | 版本比对 |
| `assetRecoveryInfo` | Sufficiency check 完成 | `isAssetComplete()` | 缺失文件列表 |
| `totalSize` | ZIP 下载完成 | 存储空间检查 | 总下载大小 |
| `assetSizeKind` | ZIP 下载完成 | `gofulfilllChecker` | 下载模式标记 |
| `baseUrl` | ZIP 下载完成 | Recovery 下载 | 根 URL |
| `latestModifiedTimeOfArchive` | ZIP 下载完成 | — | 增量控制 |

### 读取场景

| 场景 | 方法 | 读取字段 |
|------|------|------|
| 启动判断 | `isDownloaded()` | `version` |
| 完整性判断 | `isAssetComplete()` | `assetRecoveryInfo` |
| Recovery 准备 | `AssetRecoveryPreparer.run()` | `assetRecoveryInfo` |
| 存储检查 | `checkStorageFreeSpace()` | `totalSize` |
| 下载模式 | `AssetDownloadChecker.run()` | `assetSizeKind` |

### 写入场景

| 场景 | 方法 | 写入内容 |
|------|------|------|
| ZIP 下载完成 | `AneAssetDownloading.startSaveVersionInfo()` | 全部字段（recoveryInfo=[]） |
| Recovery 完成 | `AssetRecovering.dispose()` | recoveryInfo=[] |
| Sufficiency check 完成 | `AssetSufficiencyChecking.completeHandler()` | recoveryInfo（可能非空） |

---

## 七、fulfill vs shortened 下载模式

| | fulfill | shortened |
|------|------|------|
| `ASSET_SIZE` header | `"fulfill"` | `"shortened"` |
| 提取大小 | `total_size` | `total_size - delayed_assets_size` |
| 入口 | 默认模式 | 用户选择或配置 |
| 存储的 mode | `FullDownload(1)` | `ShortenedDownload(2)` |
| 对话框 | 单模式确认框 | 双模式选择框（可选 fulfill） |

**当前服务端配置**：`delayed_assets_size = 0` → shortened = fulfill（无差异）。

---

## 八、partial_downloaded.json

**位置**：`{rootDir}/partial_downloaded.json`

**结构**：
```json
{
  "initialVersion": "1.4.0",
  "targetVersion": "1.4.54",
  "completedArchives": [],
  "assetSizeKind": "fulfill",
  "latestModifiedTimeOfArchive": null
}
```

**用途**：下载进行中标记。存在时 `isDownloaded()` 强制返回 `false`。

**生命周期**：`AneAssetDownloading.startDownload()` 写入 → `startSaveVersionInfo()` 删除。

---

## 九、关键文件索引

| 文件 | 类 | 职责 |
|------|------|------|
| `GlobalLoading.as:392` | GlobalLoading | 入口，三路分支 |
| `AssetDownloader.as:394,427` | AssetDownloader | `isDownloaded()`, `isAssetComplete()` |
| `AneAssetDownloading.as` | AneAssetDownloading | Native ANE ZIP 下载解压 |
| `AssetGetPathRealRemote.as` | AssetGetPathRealRemote | `get_path` API 调用 |
| `AssetVersionInfoRealRemote.as` | AssetVersionInfoRealRemote | `version_info` API 调用 |
| `AssetSufficiencyCheckLoading.as` | AssetSufficiencyCheckLoading | Sufficiency check 入口 |
| `AssetSufficiencyChecking.as` | AssetSufficiencyChecking | CSV 遍历 + 磁盘扫描 |
| `AssetRecoveryLoading.as` | AssetRecoveryLoading | Recovery 入口 |
| `AssetRecovering.as` | AssetRecovering | 独立文件下载（base_url + hash） |
| `FileReader.as:217` | FileReader | `resolveFiles()` 文件查找 |
| `FileReader.as:753` | FileReader | `notifyFileNotFoundError()` 缺文件处理 |
| `RootMasterBinary.as` | RootMasterBinary | Orderedmap 二进制解析 |
| `MasterSummary.as` | MasterSummary | 表路径映射（iosBundledPaths 合并机制） |
| `DevConfig.as` | DevConfig | `isFullPackage`, `enableAssetSufficiencyCheck`, `assetReadKind` 等 |
