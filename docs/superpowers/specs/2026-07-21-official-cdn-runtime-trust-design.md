# 官方 CDN 受信任运行时设计

日期：2026-07-21

## 一、目标

本设计将运行时 CDN 支持范围固定为：

- 官方提取的国服 1.4.54 CDN。
- 官方 CN 1.8.1 客户端，仅允许修改服务器地址和跳过登录所需内容。
- 服务端负责在该组合下正确返回版本信息、唯一更新路径和资源文件。

完整 SHA-256 校验属于导入和人工审计阶段，不再放在服务启动或每次下载请求中。运行时信任已经准备好的官方 CDN，不尝试修复、回滚或兼容被修改的归档。

## 二、支持范围

### 2.1 项目保证

- 官方 1.4.54 CDN 可以被快速加载为固定 `ContentSnapshot`。
- `/load`、`version_info`、`get_path` 和标题页使用同一目标版本。
- 已最新返回 `full=null`、`diff=null`。
- 增量更新只返回当前版本到目标版本的唯一连续差分链。
- 初装返回 1.4.0 full 和到 1.4.54 的连续差分链。
- Catalog 引用的资源可直接下载，并支持标准单区间 HTTP Range/206。
- 未授权 ZIP、路径逃逸和 Catalog 外归档不能通过服务端文件路由访问。

### 2.2 不保证

- 缺失、不完整、被修改或重新打包的 CDN。
- 官方 1.4.54 之外的客户端资源版本。
- CN 1.8.1 之外的客户端协议兼容。
- 修改战斗、资源下载器或其他客户端逻辑后产生的问题。
- 自动修复服务端 CDN、自动重新下载归档或自动回滚目录内容。
- 新角色、卡池、商店、任务或 Mod 包的自动生成与激活。

上述输入发生错误时，项目可以快速失败或由审计工具报告，但不提供复杂兜底。该约束只适用于 CDN 和客户端资源；库存、奖励、交易、防重复等服务端业务仍必须执行服务端校验。

## 三、方案选择

### 3.1 采用：受信任运行时与独立审计

- 版本库跟踪一份由官方 1.4.54 CDN 生成的 Catalog manifest。
- manifest 保存相对路径、版本边、层、顺序、大小和审计阶段得到的 SHA-256。
- 服务启动读取 manifest，构建并校验版本图，只检查引用文件存在且大小一致。
- 启动和请求不重新读取 ZIP 全部内容，不重新计算 SHA-256。
- 手动运行 `audit_cdn_catalog` 时才完整读取归档并验证 SHA-256。

### 3.2 不采用：每次启动完整哈希

它能发现运行前篡改，但真实 10 GB CDN 首次扫描约需 89 秒。用户已经保证官方 CDN 完整且运行期间不变，因此该成本不进入正常启动路径。

### 3.3 不采用：每次请求 spool 与哈希

它能防止启动后原地改写，但会增加首字节等待、双倍输入输出、临时磁盘、限流和清理状态机。该威胁不在正式支持范围内，现有 spool 实现应删除。

## 四、运行时 Catalog manifest

### 4.1 格式

跟踪文件建议位于：

```text
assets/cdn/catalog-cn-1.4.54.json
```

逻辑内容：

```text
schemaVersion
baseline
catalogInput
  installedBytes
  entityListsRelativePath
  archives[]
    kind
    fromVersion
    toVersion
    platform
    layer
    order
    relativePath
    compressedBytes
    sha256
entityLists
  relativePath
  compressedBytes
  sha256
```

manifest 只包含元数据，不包含 APK、ZIP、玩家数据、绝对路径或构建机器信息。数组和 JSON 键使用稳定顺序，重复生成必须得到相同文件。

### 4.2 生成

提供显式工具，从官方 CDN 运行完整扫描和 SHA-256 后生成候选 manifest。工具默认只输出到 stdout 或显式指定路径，不覆盖 active CDN。生成结果必须经过现有 Catalog Builder 和审计测试，不能手工拼接版本边。

本次提交只生成并跟踪官方 1.4.54 基线 manifest。未来补丁和 Mod release 由 Content Builder 生成新的 release manifest，不在当前工具中增加直接激活能力。

## 五、服务器启动流程

```text
解析 ContentPaths
  → 读取受信任的官方 Catalog manifest
  → 校验 manifest schema
  → 调用 buildCdnCatalog 校验层、顺序和版本图
  → 对引用文件执行存在性与大小检查
  → 校验启用补丁必须已经属于 Catalog
  → 固定 ContentSnapshot
  → 注册资源路由
  → 开始监听 HTTP/TCP
```

启动流程不得：

- 读取所有 ZIP 内容计算 SHA-256。
- 创建 digest cache 作为启动前提。
- 写入或修改 CDN。
- 自动发现未进入 manifest 的新 ZIP。
- 因目录中出现额外文件而自动提高目标版本。

引用文件缺失或大小不符时可以拒绝启动。该错误说明输入不属于受支持的官方基线，不触发自动修复。

## 六、资源请求流程

### 6.1 版本请求

- `/load` 返回 snapshot 的 `targetVersion`。
- `version_info.total_size` 返回 manifest 中由 EntityLists 审计得到的 `installedBytes`。
- `get_path` 调用 Planner，只返回目标所需连续链。
- 客户端提供的目标版本不能覆盖 snapshot。

### 6.2 文件请求

```text
解析并规范化相对路径
  → 检查路径位于 CDN root
  → ZIP 检查 Catalog allowlist
  → stat 文件并确认大小
  → 解析 Range
  → 直接流式发送完整文件或指定区间
```

不再执行请求级 SHA-256、spool、并发 spool 字节预约或临时目录清理。

### 6.3 HTTP Range

资源路由支持单区间：

- 无 `Range`：返回 200、完整 `Content-Length` 和 `Accept-Ranges: bytes`。
- `bytes=start-end`：返回 206、正确 `Content-Range` 和区间长度。
- `bytes=start-`：返回从 start 到文件末尾。
- `bytes=-suffix`：返回最后 suffix 字节。
- 越界或非法区间：返回 416 和 `Content-Range: bytes */<size>`。
- 多区间请求不实现 multipart；明确拒绝或按统一策略忽略，测试锁定行为。

Range 必须对官方客户端真实请求进行抓包验收。AS3 只能证明客户端保存已完成归档，无法证明原生 ANE 的区间行为。

## 七、Recovery 边界

当前 CDN 目录只包含归档和 EntityLists，没有 `production/upload/...` 的逐文件对象。第一阶段继续提供 HTTP 200 的零字节 Recovery CSV，明确表示不支持客户端逐文件恢复。

本项目当前保证完整归档下载和版本更新，不保证客户端本地单文件缺失后的 Recovery。若以后需要官方逐文件恢复，应由 Content Builder 从归档生成只读对象库，并验证 `base_url + hash` 可以读取对应文件；不能在本阶段返回无法供给的正式 EntityLists。

## 八、审计职责

`tools/audit_cdn_catalog.cjs` 保留完整 SHA-256 校验能力，用于：

- 首次确认导入的是官方 1.4.54 CDN。
- 重新生成官方 Catalog manifest。
- 用户怀疑文件损坏时独立检查。
- 未来 release 构建前的候选校验。

审计不是启动前置步骤。删除审计缓存不会影响服务器运行，服务器也不会因为没有 digest cache 而拒绝启动。

## 九、兼容与迁移

### 9.1 删除

- `cdnFiles` 中的请求级 verified spool。
- spool limiter、字节预算、临时目录 marker 和清理状态机。
- 运行时对 ZIP 内容的 SHA-256 读取。
- 相关故障注入测试和配置。

### 9.2 保留

- Catalog/Planner/ContentSnapshot。
- Catalog ZIP allowlist。
- 路径规范化、根目录限制和基本符号链接逃逸防护。
- JSON/MsgPack 协议测试。
- 独立审计工具和真实 CDN 结果文档。

### 9.3 新增

- 官方基线 manifest 与确定性生成工具。
- 无 digest cache 的快速启动测试。
- HTTP Range 行为测试。
- 支持矩阵与不支持项文档。

## 十、测试与验收

### 10.1 自动测试

- manifest 确定性生成和 schema 校验。
- runtime loader 不读取 ZIP 内容、不写 state cache。
- 缺少 digest cache 时启动加载成功。
- 文件缺失或大小不符时启动失败。
- `get_path` 的 latest、incremental、initial 行为不变。
- 完整 GET、开放区间、封闭区间、后缀区间和 416。
- 未授权 ZIP、路径逃逸和根外符号链接拒绝。
- Recovery 继续返回零字节 CSV。
- full 测试仍低于阶段 0 的 60 秒门槛。

### 10.2 客户端验收

- 官方 1.4.54 客户端已最新时不重复下载。
- 1.4.53 到 1.4.54 只下载 10,392 字节对应的三份归档。
- 清缓存初装取得 full 和 54 条连续差分。
- 中断单个 ZIP 后，抓包确认是否发送 Range，并确认 206 后可继续。
- 中断多归档更新后，只跳过已完成归档。
- 明确记录逐文件 Recovery 不支持，不把该场景判定为 CDN 源文件错误。

## 十一、后续 Mod 接入

当前运行时不暴露直接修改 CDN 的接口。未来外部补丁工具提交结构化 source/overlay，Content Builder 负责生成客户端归档、EntityLists、服务端 runtime 数据和完整 release manifest。管理 API 只负责认证后的导入 job、校验、差异报告和候选激活；版本由补丁声明，服务端验证并决定是否激活，客户端不能决定目标版本。
