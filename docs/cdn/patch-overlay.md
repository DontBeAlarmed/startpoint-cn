# CDN 多根补丁 Overlay 设计

> 状态：服务端原生 `cn + patches` Overlay 已实现并通过自动化验证；未修改 CN 1.8.1 客户端的真机验收尚未完成。当前保证边界以 [`runtime-support.md`](./runtime-support.md) 为准。

## 目标与边界

服务端在不修改官方 CDN 的前提下，从两个并列物理根构造统一 CDN 视图：

```text
CDN_DIR/
|-- cn/                         # 官方基线，保持旧布局且只读
`-- patches/
    |-- worldflipper-*.zip      # 可保留的外层分发 ZIP，忽略
    `-- 1.4.55/
        |-- worldflipper-*.zip  # 可保留的外层分发 ZIP，忽略
        |-- patch-manifest.json
        |-- README.md
        |-- archive-common-diff/
        |   `-- *.zip
        |-- archive-medium-diff/
        |   `-- *.zip
        `-- archive-android-diff/
            `-- *.zip
```

`CDN_DIR/cn` 的路径、目录格式和旧读取行为不变。旧服务端和旧 Mod 工具可以继续只使用 `cn`，但不会识别或加载 `patches`。支持 Overlay 的服务端把两根内容合并到同一 Catalog、Content Release 和下载路由中，客户端 URL 仍为 `/patch/cn/<logical-path>`，不暴露物理补丁目录。

该实现不修改官方 CN 1.4.54 CDN，不修改 CN 1.8.1 客户端，也不允许服务端生成、改写、重打包或自动修复 CDN 补丁。CDN 作者负责发布内容正确、版本边完整且摘要有效的包；服务端只负责合法发现、验证、构图、同步和只读供给。仓库不附带自制补丁包、补丁配方或专用生成工具。

## 安装目录契约

外层分发 ZIP 的内容直接以 `patch-manifest.json`、`README.md` 和 `archive-*-diff/` 开始，不包含额外的版本目录包装层。部署者使用图形界面安装：

1. 可以先把外层 ZIP 复制到 `CDN_DIR/patches`；
2. 创建与 ZIP 内 `targetVersion` 一致的目录，例如 `CDN_DIR/patches/1.4.55`；
3. 进入该版本目录并把外层 ZIP 内容解压到当前目录；
4. 使用受支持入口重启服务，由启动前 Content Sync 完成发现和校验。

外层 ZIP 可以留在 `patches/` 根或版本目录根。服务端不按扩展名递归发现补丁，只读取 `patches/<version>/patch-manifest.json` 明确列出的 inner ZIP，因此外层 ZIP 和其他未知 ZIP 自动忽略。`archive-*-diff/` 内被 manifest 声明的 inner ZIP 是实际 CDN 内容，不能忽略。

版本目录没有 manifest 时视为尚未安装完成并忽略。manifest 一旦出现就表示部署者明确要求激活该包；从此目录名、依赖、路径、文件、摘要或升级图任一校验失败都必须阻止受支持入口启动。

## Patch Manifest 契约

现有 `schema: 1` manifest 作为 Overlay 的运行时权威补丁清单。核心结构为：

```json
{
  "schema": 1,
  "baseVersion": "1.4.54",
  "targetVersion": "1.4.55",
  "compatibleClient": "CN 1.8.1",
  "archives": [
    {
      "relativePath": "archive-common-diff/<inner-zip>.zip",
      "layer": "common",
      "order": 1,
      "bytes": 86144,
      "sha256": "<64 位小写十六进制>"
    }
  ]
}
```

`schema`、`targetVersion`、`compatibleClient` 和 `archives` 是运行时字段。顶层额外的作者元数据不会进入运行时对象，也不改变版本图。目录名必须等于 `targetVersion`；manifest 目标版本必须等于该包 inner ZIP 计算出的目标版本。

每个 `archives` 条目必须满足：

- 相对路径位于当前版本目录内，不含绝对路径、反斜线、空段、`.` 或 `..`；
- 路径、目录和文件不是符号链接，最终解析结果不能逃逸版本根；
- 文件存在且为普通文件；
- `layer`、`order` 和 inner ZIP 文件名一致；
- 文件大小和完整 SHA-256 与 manifest 一致；
- common、medium 和 android 三层为同一版本边并具有从 1 开始的连续顺序。

同一逻辑归档路径不得指向不同字节。Catalog、Content Release 和运行时快照只接受 manifest 声明的 inner ZIP；未知文件不进入 allowlist。

## 安装依赖与客户端升级图

### `baseVersion` 只表示内容依赖

`baseVersion` 可以省略。省略表示该包没有额外的安装前置条件；填写后，要求该版本由官方基线或另一个已安装包提供。依赖必须能从官方基线或无依赖包开始解析，缺失依赖和依赖循环都阻止启动。

`baseVersion` 不参与客户端升级边计算，也不要求等于 inner ZIP 的起始版本。例如两个包都可以声明只依赖官方 `1.4.54`，而其 inner ZIP 分别提供 `1.4.54 -> 1.4.55` 和 `1.4.55 -> 1.4.58`。

### inner ZIP 是升级图的唯一来源

客户端升级边只从 inner ZIP 文件名和三层归档组合推导。版本号允许跳号：

```text
1.4.54 -> 1.4.55 -> 1.4.58
```

这是一条合法链，不要求存在 1.4.56 和 1.4.57。最终资源版本是有效升级图的唯一末端，不通过目录最大值或服务端合成版本猜测。

启动前必须证明：

- 官方基线版本和每个已安装包的目标版本都能到达最终版本；
- 每个受支持起点到最终版本恰好只有一条路径；
- 图中没有断路、分叉、循环、重复边或相互冲突的边；
- Catalog 三层在每条边上保持一致。

例如原链为 `1.4.54 -> 1.4.55 -> 1.4.58`，后来加入只提供 `1.4.55 -> 1.4.56` 的包，会产生无法到达 1.4.58 的第二末端并阻止启动。服务端可以重新扫描并重算已有版本图，但不能把 `1.4.55 -> 1.4.58` 的差分字节改写成 `1.4.56 -> 1.4.58`。

要激活中间版本，CDN 作者必须重建后续差分，使图成为：

```text
1.4.54 -> 1.4.55 -> 1.4.56 -> 1.4.58
```

或者发布一个更高的、基于 1.4.56 构建的最终版本。旧直连边若造成多路径歧义必须从部署集合中移除。未发布且没有客户端停留的实验版本无需激活。

## 服务端组件边界

实现限定在 CDN 内容层，不改卡池、抽卡或其他游戏业务接口。Overlay 的主要实现位于 `src/content/cdn/`、`src/content/sync/`、`src/content/runtime/` 和 CN CDN 文件路由。补丁构建不属于服务端职责，由 CDN 作者在仓库外完成。

### 路径解析

`src/content/paths.ts` 保留 `cdnRoot = CDN_DIR/cn`，增加 `patchesRoot = CDN_DIR/patches`。缺少 `patches` 时必须与现有单根行为一致。

### Patch Overlay Loader

独立 Loader 负责枚举版本目录、解析 manifest、验证安装依赖和归档字节，并返回确定性的归档来源集合。它不读取目录内未声明 ZIP，也不修改任何输入。

### Scanner 与 Catalog Builder

官方 `cn` 继续按现有受信任基线流程扫描。补丁只从 Loader 输出进入 Catalog。Builder 合并两类归档、生成 inner ZIP 版本边、验证唯一升级图并确定最终版本。

### Archive Locator 与 ArchiveIndex

Content Release summary 保存可移植来源描述：

```json
{ "kind": "baseline" }
```

或：

```json
{ "kind": "patch", "targetVersion": "1.4.55" }
```

Content Release 不保存部署机器绝对路径。启动时 Locator 把来源描述重新解析为 `cn` 或 `patches/<targetVersion>` 下的安全物理路径。`ArchiveIndex` 在构建时固定来源根和文件身份，并按有效升级路径顺序应用 inner ZIP entry；后续边中的同名 entry 覆盖先前内容。generator 3 及更高版本的 Release 缺少来源清单时失败关闭；只有无 Release 的官方 1.4.54 fallback 或明确的旧 generator Release 可以解释为全 baseline。

### Content Sync 与固定 Snapshot

受支持入口按以下顺序运行：

```text
解析路径
  -> 扫描官方 cn
  -> 发现并验证 patch manifests
  -> 解析安装依赖
  -> 构造归档来源索引
  -> 构造并验证客户端升级图
  -> Content Sync
  -> 原子发布固定 Snapshot
  -> 启动游戏服务
```

最终版本、补丁集合、manifest 或归档摘要变化时生成新的 Content Release。同步失败不得发布半成品 Release；即使旧 Release 仍完整，受支持入口也必须停止，不能让部署者误以为新补丁已经生效。

### CDN 文件路由

`src/routes/cn/cdnFiles.ts` 的 Catalog ZIP allowlist 从“逻辑路径到大小”扩展为“逻辑路径到来源定位器、大小和摘要”。GET、HEAD、单区间 Range、文件身份和防符号链接检查继续保留。客户端 URL 仍使用旧逻辑路径；外层 ZIP和未声明 ZIP不在 allowlist 中，返回 404。

服务启动后使用固定 Snapshot，不热加载新补丁。部署者安装、删除或替换补丁后必须重启。文件在启动后被删除、替换或改成符号链接时，固定来源和文件身份检查必须拒绝继续提供该文件。

## 失败策略

以下状态正常：

- `patches/` 不存在；
- 根部只有外层 ZIP；
- 版本目录没有 manifest；
- 合法升级链跳过某些数字版本。

manifest 出现后，schema、兼容客户端、目录版本、安装依赖、相对路径、文件类型、字节数、SHA-256、三层归档或版本图任一不合法都失败关闭并阻止启动。错误必须包含稳定分类、补丁版本和相对路径，不得只输出模糊的加载失败信息。

请求阶段不重复计算完整 SHA-256，也不生成 spool 或合并副本。完整摘要在启动前 Content Sync 中校验，可使用现有稳定文件元数据约束下的 digest cache；请求阶段复核固定来源、文件身份和大小。

## 存储与兼容性

Overlay 不复制约 10 GB 的官方基线，也不生成永久合并 CDN。新增部署占用主要为补丁 ZIP、少量摘要缓存和 Content Release 元数据。真实 CDN 镜像、staging、提取缓存、报告、测试数据库和分发产物继续只写入明确配置的外部存储。

旧服务端可以在同一 `CDN_DIR` 下继续使用 `cn`，但不会加载 `patches`。补丁 README 必须声明所需 Overlay schema，是否兼容当前服务端由服主在安装前确认。服务端不提供动态合包、合成版本、自动下载、自动回滚或补丁修复功能。

## 测试与验收

自动化测试覆盖：

- 无 `patches` 时与现有官方 1.4.54 行为一致；
- 外层 ZIP、未知 ZIP和无 manifest 目录被忽略；
- 可选 `baseVersion`、缺失依赖和依赖循环；
- 目录名、包内目标版本和 manifest 目标版本一致性；
- 路径逃逸、符号链接、文件类型、大小和 SHA-256；
- 三层归档缺失、顺序错误和版本边冲突；
- 跳号链 `1.4.54 -> 1.4.55 -> 1.4.58` 通过；
- 加入断路的 `1.4.55 -> 1.4.56` 后阻止启动；
- Content Sync 从 `cn` 与 `patches` 共同读取并发布无绝对路径的 Release；
- `/patch/cn/*` 从两个根提供 GET、HEAD 和 Range，外层或未声明 ZIP 返回 404；
- 运行期文件替换不会被固定 Snapshot 静默接受；
- 官方 1.4.54 基线清单和 CN 1.8.1 客户端不被 Overlay 流程修改；
- 补丁包、生成物和缓存不进入仓库。

仍需由 CDN 作者使用实际补丁和未修改的 CN 1.8.1 客户端验证从官方 1.4.54 下载到补丁目标版本，以及已处于目标版本时不重复下载。服务端自动测试不能替代真机验收。
