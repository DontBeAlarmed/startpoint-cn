# CDN 运行时支持边界

本文给出当前受信任 CDN 运行时的明确支持矩阵。它描述项目保证范围，不把尚未完成的内容构建、管理接口或客户端验收写成现有能力。

## 支持矩阵

| 输入或能力 | 状态 | 当前边界 |
|---|---|---|
| 官方 CN 1.8.1 客户端，仅修改服务器 IP 和跳过登录 | 保证 | 唯一保证的客户端；协议与行为以该版本为准 |
| 停服前从官方 CDN 主机下载的 CN 1.4.54 dump | 有限保证 | 支持资源清单目录为 `EntityLists/` 或 `entities/` 的两种已知官方布局；物理 dump 有 692 个 ZIP，运行时只保证 tracked manifest 引用的 677 个 Android common、medium（Catalog `quality` 层）和 platform 归档完整，不使用 15 个 iOS 归档 |
| latest 更新计划 | 保证 | 当前版本等于 active Catalog 目标版本时返回 `full=null`、`diff=null`；无补丁时目标为 1.4.54，安装合法补丁后以 Overlay 计算出的唯一末端为目标 |
| incremental 更新计划 | 有限保证 | 官方 manifest 提供 1.4.0 至 1.4.54 的基线链；合法 patch manifest 声明的 inner ZIP 可继续形成唯一、允许跳号的后续链；未知或不可达版本返回错误 |
| initial 更新计划 | 保证 | 返回 1.4.0 full 和到 active Catalog 目标版本的唯一链 |
| 完整归档下载 | 保证 | 从文件句柄直接流式返回 HTTP 200 |
| 标准单区间 Range | 服务端已实现，客户端待验收 | 服务端返回 206 或 416；官方客户端原生 ANE 行为仍需抓包确认 |
| Catalog ZIP allowlist 与路径边界 | 保证 | 拒绝 Catalog 外 ZIP、路径逃逸、Catalog ZIP 符号链接和根外解析路径 |
| Recovery CSV | 兼容占位 | `/patch/cn/recovery/empty.csv` 返回 HTTP 200 的零字节 CSV |
| dummy upload 兼容路由 | 可选 | 只从 `<DATA_DIR>/asset-provider/production/upload` 只读供给；目录或文件缺失返回 404，不创建目录、不回退 Bundle |
| 客户端逐文件 Recovery | 不支持 | 当前没有可按 `base_url + hash` 完整供给的官方逐文件对象库 |
| 启动时补丁扫描与完整哈希 | 保证 | 官方基线继续使用 tracked manifest 的存在性、类型和大小门禁；每个已激活 patch manifest 的 inner ZIP 在同步前校验完整 SHA-256、路径和文件身份 |
| 请求级 SHA-256、spool 或缓存写入 | 不支持且不执行 | 文件通过边界检查后直接流式发送 |
| 自动发现补丁 inner ZIP | 有限保证 | 只发现 `patches/<version>/patch-manifest.json` 明确声明的 inner ZIP；外层 ZIP、未知 ZIP和无 manifest 目录忽略 |
| CDN 自动修复、重新下载或回滚 | 不支持 | 缺失、类型错误或大小不一致时快速失败 |
| active CDN 管理接口 | 当前不存在 | 没有管理 API 可以直接写入、替换或激活当前 CDN |
| `asset-patch/manifest.json` | CN 运行时不使用 | 不参与 Catalog、目标版本、后台版本或 Content Release 选择 |

## 不支持的输入

以下输入不在兼容或兜底范围内：

- 缺失、不完整、损坏、被原地改写或重新打包的官方 CDN；
- 非法来源、自制或手工拼接的 CDN；
- 非官方 CN 1.4.54 基线；合法 Overlay 补丁目标版本不受此条限制；
- CN 1.8.1 之外的客户端；
- 除服务器 IP 和跳过登录外，还修改资源下载器、战斗逻辑或其他客户端行为的包；
- 只向 `cn` 写入 ZIP，或放入 `patches` 但没有合法 patch manifest、匹配版本边和三层 inner ZIP 的内容。

运行时不会为这些输入降级安全边界、猜测版本图或自动生成缺失数据。完整 SHA-256 的实际命令、参数和目录约束统一见 [`catalog-planner.md` 的“显式离线 SHA-256”章节](catalog-planner.md#显式离线-sha-256)，本页不重复维护命令副本。

## Recovery 边界

`version_info.files_list` 当前固定指向零字节 Recovery CSV。该响应只说明当前实现不向客户端声明需要逐文件补全的对象，不代表逐文件恢复已经实现。

如果客户端本地单个解压文件缺失，当前项目不保证能按 EntityLists 中的 `hash` 从 `base_url + hash` 恢复该文件，也不自动从 ZIP 重建逐文件对象、重新下载归档或修复服务端 CDN。逐文件 Recovery 不是当前实现的客户端验收通过条件。

若未来需要支持，应由独立 Content Builder 从受信任归档生成只读对象库，并验证所有正式 EntityLists 记录都能通过对应 URL 读取；在此之前不得返回无法完整供给的 Recovery 清单。

## 信任边界不影响业务校验

“信任官方 CDN”只缩小资源导入和发送阶段的支持范围，不表示信任客户端提交的业务数据。非法或自制 CDN 不提供资源兼容兜底，但库存、奖励、交易、防重复、种子校验及其他现有服务端业务校验仍须保留并按各模块规则执行，不能因 CDN 受信任模式而绕过。

## Mod 与新内容

新角色、Mod、卡池、商店、任务或其他内容不由当前运行时直接生成或激活。未来应使用独立的 Content Builder/Release 流程：

1. 接收结构化 source 或 overlay；
2. 生成客户端归档、资源索引、`EntityLists` 和服务端 runtime 数据；
3. 生成完整候选 release manifest；
4. 对候选执行完整哈希、Catalog/Planner 校验和差异报告；
5. 经认证和人工确认后，再由未来的激活流程切换统一 snapshot。

当前仓库没有 active CDN 管理接口，现有管理页面或 API 不能直接覆盖运行中的 CDN，也不能把任意 ZIP 自动提升为 active release。

## 已实现的 Patch Overlay

项目支持 `CDN_DIR/cn + CDN_DIR/patches/<version>` 多根 Overlay。运行时只接受版本目录内 `patch-manifest.json` 明确声明且通过完整校验的 inner ZIP；外层分发 ZIP、未知 ZIP和没有 manifest 的目录不会自动激活。manifest 一旦出现，目录版本、内容依赖、三层归档、字节数、SHA-256 或升级图不合法都会阻止受支持入口启动。完整的安装、版本、失败关闭和组件边界见 [`patch-overlay.md`](./patch-overlay.md)。

CDN 作者工具可使用 [`patch-manifest.schema.json`](./patch-manifest.schema.json) 生成清单，并在完整本地 CDN 布局中运行 `npm run cdn:patch:check` 做只读发布前校验。该入口不生成补丁、不修改 CDN，也不激活 Content Release。

框架支持合法的连续或跳号唯一链，但仓库不提供补丁包、配方或专用生成工具，也不为第三方补丁内容提供业务兼容保证。

## Range 客户端验收

服务端已经实现并测试无 Range 的 200、合法单区间的 206，以及非法、越界和多区间请求的 416。该事实不能证明官方客户端原生 ANE 会发送或正确消费 Range。

后续必须使用官方 CN 1.8.1 客户端抓包验收：中断单个 ZIP，确认重试请求是否携带单区间 `Range`，核对服务端 `Content-Range` 与 206，并确认下载可以完成；再中断多归档更新，确认客户端只跳过已经完成的归档。验收完成前不得声称归档内断点续传已获得客户端验证。
