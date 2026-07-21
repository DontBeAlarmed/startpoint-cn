# CDN 目录与更新计划审计

本文说明阶段 1 的 CDN 目录、更新计划、运行时快照和只读审计边界，并记录 2026-07-21 对真实 1.4.54 数据的审计结果。本文不表示阶段 2 内容构建器、后台管理或启动器已经完成。

## 数据流与权威边界

数据按以下顺序流动：

1. `resolveContentPaths` 解析 CDN 父目录、内容对象库、状态目录和运行时目录。`CDN_DIR` 必须指向包含 `cn` 子目录的父目录，不能直接指向末尾的 `cn`。
2. `scanCdnCatalogInput` 只读扫描 `cn` 下的归档和安卓中画质 `EntityLists`。它读取 ZIP 的稳定文件快照和 SHA-256，并把摘要缓存写入 `CONTENT_STATE_DIR`；它不解压、不重命名、不改权限，也不写 CDN。
3. `buildCdnCatalog` 从扫描结果构建规范化目录，校验版本、归档层、顺序、重复项、分叉、环和缺失路径。只有零校验问题的目录才能发布。
4. `ContentSnapshot` 把已经验证的目录与其他内容状态一起固定为单个运行时快照。请求处理只读取这个快照，不在请求期间重新扫描 CDN。
5. `planCdnUpdate` 根据当前版本、目标版本、平台、资源体积模式和是否初装，从固定目录中选择唯一连续路径并计算本次下载字节。
6. 路由序列化更新计划。只读审计命令复用前四个核心函数中的路径解析、扫描、目录构建和计划选择，但独立运行，不发布或替换服务器的 `ContentSnapshot`。

权威来源是只读 CDN 文件及其 `EntityLists`。摘要缓存只是加速索引，删除后可以重建，不能覆盖文件事实。目录负责表达经过验证的版本图，`ContentSnapshot` 是请求处理期间唯一可见的已发布状态，计划器只做纯选择和求和，不写任何运行状态。

## 体积与空值语义

旧实现出现约 700 MB 更新提示的原因，是把全部历史差分归档都返回给客户端。客户端弹窗会累加响应中的全部 `archive.size`，而实际更新只应下载当前版本到目标版本之间的唯一连续链。目录计划器因此只返回本次连续路径；例如 1.4.53 到 1.4.54 只能返回这一条边，不能夹带更早版本的归档。

`null` 与空数组 `[]` 不可互换：

- `null` 表示该部分计划不存在，对应客户端的 `None`。已是最新版本时 `full=null`、`diff=null`。
- `[]` 表示存在一个列表，但列表为空。它不能代替 `None`，否则会改变客户端的分支语义。
- 初装目标正好等于 full base 时，`full` 有值而 `diff=null`。
- 非空增量计划的 `diff` 必须至少包含一条严格连续边。

`total_size` 等于目标 `EntityLists` 中各项安装体积之和，也就是审计结果的 `installedBytes`。`downloadBytes` 等于本次计划所选 ZIP 归档的压缩字节之和，两者不是同一个指标。阶段 1 中 `shortened` 和 `delayed` 与路由保持兼容，统一复用 `fulfill` 范围；`delayedAssetsBytes` 固定为 0。

## 只读审计命令

以下命令使用同一个临时状态目录，因此第一次完整 SHA-256 扫描后，后两次会复用摘要缓存。`CONTENT_STORE_DIR` 和 `CONTENT_RUNTIME_DIR` 也显式放在 `/tmp`，不会污染仓库或正在运行的内容状态。

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

node tools/audit_cdn_catalog.cjs --json \
  --current 1.4.53 \
  --target 1.4.54 \
  --platform android \
  --asset-size fulfill \
  --cdn-dir <PROJECT_ROOT>/.cdn \
  --content-state-dir "$AUDIT_ROOT/state" \
  --content-store-dir "$AUDIT_ROOT/store" \
  --content-runtime-dir "$AUDIT_ROOT/runtime"

node tools/audit_cdn_catalog.cjs --json \
  --initial \
  --target 1.4.54 \
  --platform android \
  --asset-size fulfill \
  --cdn-dir <PROJECT_ROOT>/.cdn \
  --content-state-dir "$AUDIT_ROOT/state" \
  --content-store-dir "$AUDIT_ROOT/store" \
  --content-runtime-dir "$AUDIT_ROOT/runtime"
```

省略 `--target` 时使用目录的 `targetVersion`。省略 `--platform` 和 `--asset-size` 时分别使用 `android` 和 `fulfill`。非初装审计必须提供 `--current`；`--initial` 不能与 `--current` 同时使用。默认输出为中文，`--json` 输出稳定机器结构。参数、目录、目录校验或计划失败时命令非零退出，只输出稳定错误代码，不输出堆栈、绝对主目录或半成品计划。

## 真实 1.4.54 结果

审计日期：2026-07-21。

### 目录概况

| 项目 | 结果 |
|---|---:|
| full base | 1.4.0 |
| 目录目标版本 | 1.4.54 |
| 安装体积 `installedBytes` | 10,177,212,635 字节 |
| 有效范围边数 | 55 |
| 差分边数 | 54 |
| 归档数 | 677 |
| 全部归档压缩字节 | 10,735,093,396 字节 |
| `EntityLists` 相对路径 | `EntityLists/10939-android_medium.csv` |
| 分叉、环、重复、缺失路径、缺失层 | 均为 0 |

### 分层归档

| 层 | 归档数 | 压缩字节 |
|---|---:|---:|
| common | 401 | 7,252,868,774 |
| quality | 218 | 3,399,065,737 |
| platform | 58 | 83,158,885 |

### 三种计划

| 场景 | full | 连续差分 | 本次下载字节 |
|---|---|---:|---:|
| 当前 1.4.54，目标 1.4.54 | `null` | `null` | 0 |
| 当前 1.4.53，目标 1.4.54 | `null` | 1 条边、3 个归档 | 10,392 |
| 清缓存初装到 1.4.54 | 1.4.0、490 个归档、9,989,433,861 字节 | 54 条连续边、187 个归档 | 10,735,093,396 |

后两次审计复用了第一次生成的 `cdn-digest-cache.json`。本次临时状态目录中只有 1 个 195,972 字节的缓存文件；独立的内容对象库和运行时目录均保持为空。

### CDN 前后只读校验

审计前后均枚举完整 CDN 文件树，只读取相对路径、文件大小和纳秒级修改时间，按相对路径排序并把 JSON 元数据数组生成 SHA-256；没有再次读取 10 GB 文件内容。

| 项目 | 审计前 | 审计后 |
|---|---:|---:|
| 文件数 | 695 | 695 |
| 总字节 | 10,865,836,327 | 10,865,836,327 |
| 元数据摘要 | `4bda4b9a8fef343fabd7c34fb5f16e38482cde4c2362be3ddc2ebd317d380241` | `4bda4b9a8fef343fabd7c34fb5f16e38482cde4c2362be3ddc2ebd317d380241` |

三条代表性文件的相对路径、大小和修改时间也完全一致：

| 相对路径 | 字节 | 修改时间（纳秒） |
|---|---:|---:|
| `archive-android-diff/pinball-1.4.0-1.4.1-1-e41c3c7f.zip` | 111 | 1754316460421380996 |
| `archive-common-full/pinball-1.4.0-289-a2165de2.zip` | 20,417,629 | 1754316305456563949 |
| `EntityLists/PathFile` | 171,358 | 1754314780515449523 |

## Recovery 空文件策略

阶段 1 的 Recovery 地址采用零字节 CSV：仅对明确允许的 Recovery 相对路径返回 HTTP 200、CSV 内容类型和空响应体。它不生成虚假记录，不把目录扫描失败降级成任意文件访问，也不借此写入 CDN。客户端验收必须确认该地址为 200 且响应体确实为零字节。

## ZIP 安全发送

阶段 1 继续采用安全 spool：发送前固定归档文件身份并校验 SHA-256，把文件复制到隔离的运行时 spool 时再次校验大小、摘要和快照，响应前再确认 spool 身份。路由同时限制并发 spool 数和在途字节，避免多个大归档耗尽磁盘或内存。

这种方式的代价是首字节延迟增加，并产生读取源文件、写入并再次读取 spool 的双倍输入输出。后续应以按摘要寻址、写入后不可变的对象库替代可变 CDN 源文件，使已验证对象可以直接发送；这属于后续阶段，不是本次审计的完成项。

## 当前兼容边界

当前 CDN 层负责读取、校验、规划和供给已经存在的合法归档，不负责生成新角色、卡池、商店或客户端资源补丁，也没有向 Mod 工具开放直接修改当前 CDN 的接口。外部补丁工具不能只写入一个 ZIP：它还需要通过后续 Content Builder 同步生成客户端资源索引、版本边、`EntityLists` 和服务端 runtime 数据，再形成可审计的候选 release。导入、校验、差异报告和激活必须分开，不能由未认证接口直接覆盖当前快照。

目标客户端协议以 CN 1.8.1 反编译源码为依据。客户端会记录目标版本和已完成归档，但实际下载由原生 ANE 执行，AS3 层无法证明是否需要 HTTP `Range` 完成单个 ZIP 内的字节级续传。旧静态文件插件默认支持 Range，新 `cdnFiles` 安全路由目前按完整 ZIP 返回，尚未实现或验证 `206 Partial Content`。因此当前只能确认版本图和已完成归档级恢复语义，不能宣称归档内断点续传已经兼容。

新实现也比旧服务端更严格：Catalog 或补丁映射无效时拒绝启动，禁用补丁 ZIP 不再供给，Recovery 暂时使用空清单，且 `/patch/<非 cn>` 不再作为通用静态目录开放。这些是明确的安全和一致性边界，不属于无差别兼容。

## 后续客户端验收

1. 已是最新：从 1.4.54 请求 1.4.54，不发生下载，`full` 和 `diff` 都是 `None`。
2. 单边增量：从 1.4.53 更新到 1.4.54，只返回一条差分边，客户端弹窗字节必须等于审计值 10,392。
3. 清缓存初装：返回 1.4.0 full 加到 1.4.54 的严格连续差分链，不返回任何旁支或无关历史边。
4. 体积模式：`shortened`、`fulfill` 和 `delayed` 在阶段 1 结果一致，且 delayed 字节为 0。
5. 版本信息：`version_info.total_size` 与审计的 `installedBytes` 10,177,212,635 完全一致。
6. Recovery：Recovery 地址返回 HTTP 200 和零字节 CSV。
7. ZIP 权限：未授权请求和禁用状态下的 ZIP 请求都返回 HTTP 404。
8. 断点续传：分别中断完整归档下载和多归档更新，确认客户端是否发送 HTTP `Range`、服务端是否需要返回 206，以及重启后是否只跳过已完成归档。

本次工作没有启动或重启服务，也没有执行上述客户端验收。这些项目必须在用户确认后使用实际客户端和受控服务环境继续验证。
