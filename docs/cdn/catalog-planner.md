# CDN Catalog、Planner 与受信任运行时

本文说明官方 CN 1.8.1 客户端与 CN 1.4.54 官方 CDN dump 的运行时加载、更新计划、资源发送和离线审计流程。完整支持边界见 [`runtime-support.md`](runtime-support.md)。

## 唯一保证组合

当前项目只保证以下组合：

- 官方 CN 1.8.1 客户端，仅修改服务器 IP 和跳过登录所需内容；
- 停服前从官方 CDN 主机下载的 CN 1.4.54 dump；
- Content Sync 从该官方 dump 生成 current Release；没有 current Release 时，服务端才使用版本库跟踪的 `assets/cdn/catalog-cn-1.4.54.json` 作为 fallback Catalog。该 Catalog 只引用 Android 所需的 common、medium（Catalog `quality` 层）和 platform 归档。

物理 dump 共含 692 个 ZIP，其中包括 Android 和 iOS 归档；tracked manifest 引用 677 个 Android common/medium/platform Catalog 归档，即 490 个 full 和 187 个 diff，不引用 5 个 iOS full 与 10 个 iOS diff。“完整”只表示这 677 个归档覆盖 manifest 声明的 Android Catalog 范围，不表示运行时使用全部 692 个物理 ZIP。

Android Catalog 范围缺失、不完整、被修改、重新打包或自制的 CDN 不属于运行时兼容目标。CN 1.8.1 之外的客户端、额外修改资源下载器或战斗逻辑的客户端也不在保证范围内。

## Content Release 与启动加载流程

受支持入口先执行 normal Content Sync；版本或生成器变化时生成并原子激活新的 Release，同步失败则不启动游戏服务。详细命令、对象布局、smoke 和回退步骤见 [`content-sync.md`](content-sync.md)。

游戏服务初始化按以下顺序构建受信任运行时：

1. `resolveContentPaths` 解析 CDN 和内容目录。`CDN_DIR` 必须指向包含 `cn` 子目录的父目录，不能直接指向末尾的 `cn`。
2. `ContentSnapshotProvider` 只读取一次 `.content/current.json` 对应的完整 Release snapshot。
3. current 存在时，`CdnCatalogLoader` 从该 snapshot 的 Catalog 对象构建 Catalog，`ContentRepository` 从同一 snapshot 加载全部 94 张表；两者版本必须一致。
4. current 不存在时，两者一起退回 tracked 官方 1.4.54 Catalog 与 bundled JSON。current、manifest 或对象损坏时明确失败，不静默 fallback。
5. Catalog 严格校验 schema、版本、归档层、顺序、相对路径、大小、版本图、重复项、分叉、环和缺失层。
6. 运行时逐项 `stat` Catalog 引用的归档和 `EntityLists`，只确认路径存在、是普通文件且大小与 `compressedBytes` 一致。
7. `ContentSnapshotProvider` 将 Catalog 与 Repository 深度冻结为统一 `ContentSnapshot`，随后各路由只读取该 snapshot；运行期间 current 变化不会热切换。

游戏服务初始化本身不会扫描 CDN、读取全部 ZIP 计算 SHA-256、写 digest cache 或生成 Release。受支持入口在它之前执行的 Content Sync 会做目标扫描；只有版本或生成器变化、current 缺失或显式 `--force` 时才建立 ArchiveIndex 并转换内容。目录中新增 ZIP 不会被已经运行的服务热加载。

## 统一 Snapshot 与更新计划

`/load`、`version_info`、`get_path`、标题页版本信息和 ZIP allowlist 使用同一份固定 `ContentSnapshot`：

- `/load` 的可用资源版本来自 `snapshot.cdn.targetVersion`；
- `version_info.total_size` 来自 manifest 中已经审计的 `installedBytes`；
- `get_path` 始终以 snapshot 的目标版本规划，客户端提交的不同目标版本不会覆盖它；
- ZIP allowlist 由 snapshot 中的 Catalog 归档生成。

Planner 保持三种语义：

| 场景 | 结果 |
|---|---|
| latest：当前版本等于目标版本 | `full=null`、`diff=null`，下载 0 字节 |
| incremental：当前版本是 manifest 版本图中的已知起点 | 本基线只保证从 1.4.0 至 1.4.53 的已知节点到 1.4.54 的唯一严格连续差分链 |
| initial：客户端没有当前版本 | 返回 1.4.0 full，并在需要时追加从 1.4.0 到目标版本的唯一连续差分链 |

`null` 表示该部分计划不存在，对应客户端的 `None`；空数组 `[]` 不能代替 `null`。初装目标恰好等于 full base 时，`full` 有值而 `diff=null`。incremental 当前版本不在 manifest 版本图中时，Planner 返回稳定错误 `UNKNOWN_CURRENT_VERSION`，不承诺推断或拼接更新路径。`total_size` 是目标 `EntityLists` 的安装体积，`downloadBytes` 是本次计划所选 ZIP 的压缩字节总和，两者不是同一指标。

当前实现中客户端请求的 `shortened`、`fulfill` 和 `delayed` 均统一按 `fulfill` 规划，`delayed_assets_size` 固定为 0。

## 资源发送与 Range

资源路由先规范化请求相对路径并限制在 CDN root 内。ZIP 还必须属于当前 Catalog allowlist；Catalog 外 ZIP 返回 404。Catalog ZIP 的路径组件不得包含符号链接，解析后的物理路径必须仍位于 CDN root 内；打开文件时还会复核文件身份和 manifest 大小，拒绝路径逃逸、根外符号链接，以及打开验证阶段可观察到的路径、身份或大小变化。同一 inode、同一大小的内容原地改写不在运行时检测范围内；官方 CDN 通过离线审计后，部署后不得原地改写文件，这是运行时信任前提。

通过检查后，路由从已打开的文件句柄直接流式发送，不计算请求级 SHA-256，不复制到 spool，也不执行 digest cache 写入：

| 请求 | 响应 |
|---|---|
| 无 `Range` | `200`、完整 `Content-Length`、`Accept-Ranges: bytes` |
| 单区间 `bytes=start-end`、`bytes=start-` 或 `bytes=-suffix` | `206`、正确的 `Content-Range` 和区间 `Content-Length` |
| 非法、越界、多区间或过长的 `Range` | `416`、`Content-Range: bytes */<size>`、零长度响应体 |

旧的 verified spool、spool 并发/字节预算和临时目录清理状态机已经删除，不是当前资源发送流程。运行时信任已离线审计且部署后不原地改写的官方 CDN；对不受支持输入不提供请求级重新哈希兜底。

服务端 Range 行为已有自动测试，但不能据此声称官方客户端原生 ANE 已验证归档内断点续传。AS3 反编译只能确认客户端记录已完成归档；仍需通过真实客户端抓包确认中断后的请求是否携带 `Range`、服务端 `206` 是否被 ANE 正确接受，以及多归档更新是否只跳过已经完成的归档。

## 显式离线 SHA-256

完整 SHA-256 只在显式离线生成或审计时执行，不是服务器启动或资源请求的前置步骤。

下文 `<PROJECT_ROOT>` 专指包含 `package.json`、`src/` 和 `tools/` 的 `starpoint-cn` 仓库根目录；`<PROJECT_ROOT>/.cdn` 必须包含 `cn/` 子目录。命令使用占位符和 `/tmp` 临时目录，不记录构建机器的绝对主目录。

`npm run cdn:manifest` 是实际存在的 manifest 生成命令。它调用 `scanCdnCatalogInput` 完整扫描并计算 SHA-256，默认把候选 manifest 输出到 stdout；使用 `--output` 时才写入指定文件。建议把状态目录和候选输出放在 `/tmp`，评审后再决定是否更新跟踪文件：

```bash
cd <PROJECT_ROOT>
AUDIT_ROOT="$(mktemp -d /tmp/starpoint-cn-cdn-manifest.XXXXXX)"

npm run cdn:manifest -- \
  --cdn-dir <PROJECT_ROOT>/.cdn \
  --content-state-dir "$AUDIT_ROOT/state" \
  --content-store-dir "$AUDIT_ROOT/store" \
  --content-runtime-dir "$AUDIT_ROOT/runtime" \
  --output "$AUDIT_ROOT/catalog-cn-1.4.54.json"
```

项目当前没有 `npm run cdn:audit` 脚本。完整审计的实际入口是 `node tools/audit_cdn_catalog.cjs`：

```bash
cd <PROJECT_ROOT>
AUDIT_ROOT="$(mktemp -d /tmp/starpoint-cn-cdn-audit.XXXXXX)"

node tools/audit_cdn_catalog.cjs --json \
  --current 1.4.54 \
  --platform android \
  --asset-size fulfill \
  --cdn-dir <PROJECT_ROOT>/.cdn \
  --content-state-dir "$AUDIT_ROOT/state" \
  --content-store-dir "$AUDIT_ROOT/store" \
  --content-runtime-dir "$AUDIT_ROOT/runtime"
```

审计命令也可使用 `--current 1.4.53 --target 1.4.54` 检查增量计划，或使用 `--initial --target 1.4.54` 检查初装计划。离线扫描可以在临时 `CONTENT_STATE_DIR` 写入并复用 `cdn-digest-cache.json`；删除该审计缓存不影响服务器运行。

## 官方 1.4.54 审计基线

审计日期：2026-07-21。

| 项目 | 结果 |
|---|---:|
| full base | 1.4.0 |
| 目标版本 | 1.4.54 |
| 安装体积 `installedBytes` | 10,177,212,635 字节 |
| 有效范围边数 | 55 |
| 差分边数 | 54 |
| 归档数 | 677 |
| 全部归档压缩字节 | 10,735,093,396 字节 |
| `EntityLists` 相对路径 | `EntityLists/10939-android_medium.csv` |
| 分叉、环、重复、缺失路径、缺失层 | 均为 0 |

| 场景 | full | 连续差分 | 本次下载字节 |
|---|---|---:|---:|
| 当前 1.4.54，目标 1.4.54 | `null` | `null` | 0 |
| 当前 1.4.53，目标 1.4.54 | `null` | 1 条边、3 个归档 | 10,392 |
| 清缓存初装到 1.4.54 | 1.4.0、490 个归档、9,989,433,861 字节 | 54 条连续边、187 个归档 | 10,735,093,396 |

该结果来自显式离线完整扫描。它证明候选 manifest 与当时的官方 CDN 一致，不表示运行时会再次读取 10 GB 文件内容。

## Recovery 与内容同步

`version_info.files_list` 当前指向 `/patch/cn/recovery/empty.csv`。该地址只返回 HTTP 200 的零字节 CSV，不提供逐文件 Recovery，也不会自动修复、重新下载或回滚 CDN。Content Release 负责让 Planner Catalog 与服务端 Repository 同源，不替代客户端 Recovery；错误 CDN 的服务端回退和客户端缓存处理见 [`content-sync.md` 的“回退步骤”](content-sync.md#回退步骤)。

## 客户端验收清单

1. 已是最新：1.4.54 到 1.4.54 不发生下载，`full` 和 `diff` 均为 `None`。
2. 单边增量：1.4.53 到 1.4.54 只返回一条差分边和 3 个归档，下载字节为 10,392。
3. 清缓存初装：返回 1.4.0 full 加 54 条严格连续差分，不返回旁支或无关历史边。
4. 版本信息：`version_info.total_size` 为 10,177,212,635。
5. Recovery：Recovery 地址返回 HTTP 200、CSV 内容类型和零字节响应体。
6. ZIP 边界：Catalog 外 ZIP、路径逃逸和符号链接路径均被拒绝。
7. 断点续传：中断单个 ZIP 后抓包确认客户端是否发送单区间 `Range`，并确认 `206` 后可以完成下载。
8. 多归档恢复：中断更新后确认客户端只跳过已经完成的归档。

本文档更新没有启动或重启服务。原生 ANE 的 Range 行为必须在用户确认后使用实际客户端和受控服务环境验收。
