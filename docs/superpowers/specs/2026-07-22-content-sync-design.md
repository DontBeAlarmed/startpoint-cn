# CDN 主数据同步层设计

> 日期：2026-07-22
> 状态：已获用户批准，进入阶段 A 实施
> 范围：从 CDN 提取服务端主数据、按 CDN 版本生成完整逻辑快照、服务端只读加载
> 实施约束：架构文档进入 Git；实施计划保留在仓库外；按模块本地提交，禁止 push

## 一、目标

在保持游戏服务端职责纯粹的前提下，增加一个 `content:sync` 离线同步器，并由受支持的服务启动脚本在监听端口前自动执行版本预检查：

1. 扫描 CDN 作者放入 `.cdn/cn` 的可识别文件。
2. 根据 CDN 作者定义的 full/diff 归档和 EntityLists 得到目标资源版本。
3. 从 CDN 归档提取 orderedmap，生成该资源版本对应的服务端主数据表。
4. 使用内容去重对象保存完整逻辑快照，避免多个小补丁物理复制全部表。
5. 服务端重启后只读加载同步结果；没有同步结果时保持旧服务端体验。

该同步层只转换数据，不判断 CDN 内容的业务正确性。新角色、新卡池、新商店、Mod、删除和 ID 复用的安全边界由 CDN 作者负责。

## 二、用户体验

### 2.1 旧 CDN

没有本地同步结果时，服务端继续使用仓库内现有 `assets/*.json` 和官方 1.4.54 Catalog manifest：

```text
下载服务端
  -> 放入官方 1.4.54 CDN
  -> build
  -> 启动服务
```

因此直接拉取代码后的默认数据体验不变。受支持的启动脚本会先执行快速同步预检查；官方 1.4.54 与 bundled fallback 一致时允许直接启动。

### 2.2 新 CDN

CDN 作者完成版本和补丁配置并将文件放入 `.cdn/cn` 后，操作者按原方式启动服务：

```text
把 CDN 文件放入 .cdn/cn
  -> 执行受支持的服务启动脚本
  -> 启动脚本比较 CDN 版本和本地同步版本
  -> 需要时自动运行 content:sync
  -> 同步成功后启动游戏服务
```

运行中的服务不监视 CDN 目录，也不会在请求期间扫描 ZIP、提取 orderedmap 或写入主数据。自动同步只发生在启动脚本的预启动阶段，不进入 Fastify 游戏请求进程。

### 2.3 启动入口

以下受支持入口必须执行自动同步预检查：

- `npm run dev:cn`
- `scripts/start-cn.sh`
- 项目提供的正式 CN 启动脚本

直接运行 `node out/cn-server.js` 只加载已经生成的内容，不执行同步。这样游戏服务进程可以在同步完成后保持只读。

### 2.4 同步命令

```bash
npm run content:sync
```

- 没有同步记录时生成当前版本。
- CDN 目标版本与 `current.json` 不同时生成或复用对应 Release，并更新指针。
- `generatorVersion` 与当前 Release 不同时重新生成，以避免服务代码升级后继续加载旧格式表。
- 资源版本和生成器版本都相同时输出 `already synchronized`，不重新提取。

```bash
npm run content:sync -- --check
```

- 只显示 CDN 目标版本、当前同步版本和是否需要同步。
- 不生成对象、不写 Release、不更新指针。

```bash
npm run content:sync -- --force
```

- 即使资源版本和生成器版本相同，也重新提取并运行转换器。
- 生成内容相同时复用既有对象和 Release。

命令允许沿用现有 `CDN_DIR` 路径解析规则，但不修改原始 CDN。

## 三、职责边界

### 3.1 CDN 作者负责

- 分配和维护客户端资源版本。
- 生成 full/diff ZIP。
- 维护 EntityLists。
- 决定新角色、卡池、商店和 Mod 使用的 ID。
- 保证删除、复用、赔率、奖励、价格和跨表引用符合其内容设计。
- 决定错误版本采用回退还是发布更高修复版本。

### 3.2 Content Sync 负责

- 识别 CDN 目录中的归档和版本边。
- 建立 ZIP entry 索引。
- 定位 Registry 声明的 orderedmap。
- 解析 orderedmap 并运行表转换器。
- 生成规范 JSON、表对象和完整 Release manifest。
- 完整写入成功后更新本地 `current.json`。

### 3.3 游戏服务端负责

- 启动时选择旧 bundled 数据或同步后的 Release。
- 通过 `ContentRepository` 只读访问已生成表。
- 通过 Catalog/Planner 返回 CDN 作者定义的更新路径。
- 安全发送 CDN 文件，包括 Range、路径边界和句柄生命周期。
- 继续执行库存、奖励、交易、防重复、权限和防作弊等游戏业务校验。

### 3.4 明确不负责

- 不生成客户端补丁。
- 不分配或提升 CDN 版本。
- 不监视 CDN 目录。
- 不建立 candidate、审批、configured/previous 或自动回滚状态机。
- 不校验业务 ID 的新增、删除、复用或语义变化。
- 不校验卡池赔率、商品成本、奖励和关卡流程是否合理。
- 不修改玩家 SQLite。
- 不为错误 CDN 提供修复、降级或客户端缓存处理。
- 不在正常同步或启动流程中完整哈希 10GB CDN。
- 不在 Fastify 游戏服务进程中执行同步或写 `.content`。

## 四、整体架构

```text
.cdn/cn
  |-- EntityLists
  |-- archive-*-full
  `-- archive-*-diff
          |
          v
      CdnScanner
  识别归档、版本边和目标版本
          |
          v
      ArchiveIndex
  建立 production/upload/<hash> 到最后归档位置的索引
          |
          v
      TableSourceRegistry
  声明输出表、orderedmap 来源和转换器
          |
          v
      OrderedMapExtractor
  只读取 Registry 使用的 ZIP entry
          |
          v
      TableConverters
  首轮角色/卡池/商店，验收后迁移全部表
          |
          v
      ContentObjectWriter
  规范 JSON、按表摘要去重、写 Release manifest
          |
          v
      .content/current.json
          |
          v
      StartupBootstrap
  比较 CDN 版本和 generatorVersion，必要时运行同步
          |
          v
      ContentRepository
  服务启动时只读加载
```

同步组件不得依赖 Fastify、玩家数据库或游戏服务运行状态。StartupBootstrap 只负责在服务启动前编排同步命令，不把转换器导入 Fastify 进程。

## 五、CDN 扫描与提取

### 5.1 CdnScanner

CdnScanner 复用现有归档命名解析和内容路径解析，扫描：

- `archive-common-full`
- `archive-medium-full`
- `archive-android-full`
- `archive-common-diff`
- `archive-medium-diff`
- `archive-android-diff`
- `EntityLists`

CDN 作者通过文件名中的 `fromVersion`、`toVersion`、层和顺序定义版本。同步层不更改版本，也不读取 `asset-patch/manifest.json` 作为第二份权威配置。

“可识别文件”仅表示：

- 路径位于解析后的 CDN root 内。
- 文件类型和归档名称符合支持格式。
- ZIP 可以打开并读取中央目录。
- 被 Registry 使用的 orderedmap 可以解析。

这不是业务内容校验。

### 5.2 ArchiveIndex

归档内资源使用以下形式：

```text
production/upload/<prefix>/<hash>
```

ArchiveIndex 按目标版本路径和归档层顺序读取 ZIP 中央目录。相同物理路径在后续 diff 中再次出现时，后者覆盖前者。索引只记录：

- 物理资源路径。
- 所在归档相对路径。
- ZIP entry 名称。
- 解压后字节数等读取所需元数据。

它不完整读取或哈希每个 ZIP 正文。

### 5.3 TableSourceRegistry

Registry 是机器可读的服务端表来源清单。每项至少声明：

```text
tableName
scope
sourceOrderedMaps[]
converterId
converterVersion
outputShapeVersion
```

`scope` 分为：

- `cdn`：由 CDN orderedmap 生成。
- `bundled`：第一阶段暂时从当前 `assets` 基线导入。
- `server`：本质属于服务端配置，不随 CDN 变化。

运行期种子状态、玩家数据、日志和其他部署状态不得进入 Registry 或 Release，例如 `confirmed_seeds.json`、`pending_seeds.json` 和玩家 SQLite。

### 5.4 OrderedMapExtractor

Extractor 使用现有 SHA1+salt 规则，把 Registry 中的 orderedmap 逻辑路径转换为物理哈希路径，再从 ArchiveIndex 读取最后版本的 entry。

Extractor 只处理转换器需要的资源，不解压整个 CDN。解析结果先转换为统一中间表示，转换器不直接操作 ZIP。

## 六、表转换器

### 6.1 第一阶段

第一阶段建立完整 Release 闭包，但只实现以下领域的 CDN 转换器：

- 角色及首轮接口所需文本、查找索引和相关定义。
- 卡池、赔率、campaign、feature content 和首轮接口所需索引。
- 通用商店、活动商店、Boss 币商店及首轮接口所需映射。

其他已声明运行时表从当前 bundled 基线导入对象库。游戏服务端先把角色、卡池和商店读取迁移到 `ContentRepository`，其余模块仍按兼容路径运行。

### 6.2 第一阶段验收后

用户测试第一阶段通过后，按领域逐批实现全部转换器：

- 装备、物品、制作、强化和分解。
- 主线、活动、特殊关卡、体力、掉落和通关奖励。
- 常规、每日、活动、觉醒等任务及奖励。
- 活动配置、挑战点、排名、百科和文本。
- 其他由 CDN 主数据决定的运行时表。

每个领域独立提交、审查和测试。转换器迁移完成后，将对应静态 JSON import 改为通过 `ContentRepository` 读取。

最终目标是所有 CDN 主数据都由 Registry 声明；服务端专有配置继续由代码或 `server` scope 管理。

### 6.3 转换原则

- 输出使用稳定键顺序和稳定 JSON 编码。
- 转换器只转换字段，不判断内容是否合理。
- 同一输入和同一 `converterVersion` 必须产生相同输出字节。
- 转换器规则变化时增加 `converterVersion`。
- 第一版允许每次运行全部转换器，不预先实现脏表依赖分析。

## 七、完整逻辑快照与物理去重

### 7.1 选择完整快照

每个 Release manifest 必须完整列出服务端本次启动需要的全部表。服务端不在运行时叠加：

- 基线表差分。
- 多个 CDN patch 差分。
- Mod 表差分。
- tombstone 或历史迁移链。

因此任意 Release manifest 都能独立描述完整表集合。

### 7.2 对象布局

```text
.content/
|-- objects/
|   `-- <sha256>.json
|-- releases/
|   |-- 1.4.54-<releaseDigest>/manifest.json
|   `-- 1.4.55-<releaseDigest>/manifest.json
`-- current.json
```

`.content/` 是本地生成状态，必须 gitignore。

每张规范 JSON 表按其输出字节计算 SHA-256。相同表只在 `objects` 中保存一次，不同 Release 可以引用同一对象。该 SHA-256 只用于几十 MB 级生成表的寻址和去重，不代表对 CDN 归档做完整校验。

### 7.3 Release manifest

Release manifest 至少包含：

```json
{
  "schemaVersion": 1,
  "assetVersion": "1.4.55",
  "runtimeSchemaVersion": 1,
  "generatorVersion": 1,
  "releaseDigest": "sha256:...",
  "tables": {
    "character.json": {
      "object": "sha256:...",
      "scope": "cdn",
      "converterId": "character",
      "converterVersion": 1,
      "sources": ["orderedmap/character/character.json"]
    }
  },
  "catalog": {
    "object": "sha256:..."
  },
  "summary": {
    "object": "sha256:..."
  }
}
```

`releaseDigest` 由不含自身的规范 manifest 内容计算。构建时间、绝对路径和操作人不进入摘要。

同一 `assetVersion` 可以因为 `--force` 或转换器版本变化产生不同 `releaseDigest`。普通同步比较 `assetVersion` 和顶层 `generatorVersion`；任一变化都会运行同步。

### 7.4 current.json

`current.json` 只保存当前 Release manifest 的相对路径和资源版本。写入使用临时文件加原子替换。

- 不存在 `current.json`：使用 bundled 旧数据和官方 1.4.54 manifest。
- 存在且有效：服务端加载同步 Release。
- 存在但损坏、manifest 缺失或对象缺失：服务启动失败，不静默回退。

## 八、同步流程

### 8.1 启动自动同步

受支持的启动脚本执行：

```text
获取 .content/sync.lock
  -> 扫描 CDN 得到 targetVersion
  -> 读取 current.json
  -> 比较 assetVersion 和 generatorVersion
  -> 相同则释放锁并启动服务
  -> 不同或 current 不存在则执行普通同步
  -> 同步成功后释放锁并启动服务
  -> 同步失败则释放锁并以非零状态退出，不启动服务
```

同步锁用于防止两个启动流程同时写对象、Release 和 `current.json`。锁只保护本机同步写入，不是 Release 状态机。

启动脚本不会在失败后自动切换到旧 `current.json` 启动。旧指针虽然保持未变，但本次启动直接失败，等待操作者修复 CDN 或显式回退。

### 8.2 普通同步

```text
扫描 CDN 得到 targetVersion
  -> 读取 current.json
  -> assetVersion 和 generatorVersion 都相同则跳过
  -> 建立 ArchiveIndex
  -> 提取 Registry 来源
  -> 运行转换器和 bundled 导入
  -> 写缺失的表对象
  -> 写完整 Release manifest
  -> 原子更新 current.json
```

手动同步完成后当前服务进程不会热切换。下一次重启后，新 Catalog 和主数据同时生效。启动脚本自动同步发生在游戏服务尚未启动时，因此同步成功后可以直接启动新内容。

### 8.3 check

`--check` 只执行得到目标版本所需的最低扫描，并与 `current.json` 中的 `assetVersion`、`generatorVersion` 比较，不建立 ArchiveIndex 或读取 orderedmap。

### 8.4 force

`--force` 跳过资源版本和生成器版本相同的快速退出，重新提取并运行转换器。对象和 Release 内容相同时不会重复占用磁盘。

### 8.5 同步失败

下列失败会让命令退出非零，且不更新 `current.json`：

- 识别到的 ZIP 无法打开。
- Registry 必需 orderedmap 无法定位。
- orderedmap 无法解析。
- 对象或 manifest 无法完整写入。
- CDN 文件名无法提供同步所需的目标版本。

这只是生成完整文件所需的最低失败处理，不是内容正确性校验。可解析但业务内容错误的数据照常生成。

无法识别且不属于支持目录/格式的文件不阻止同步，只记录在 source summary。

### 8.6 CDN 文件准备约束

启动自动同步的主要风险是 CDN 文件仍在复制。CDN 作者或部署者必须先在临时目录准备完整文件，再移动到 `.cdn/cn` 的正式位置，或者确保复制完成后才启动服务。

同步器不实现目录监视、上传完成协议或 CDN 发布审批。启动时读到半写 ZIP 会导致同步失败和本次服务启动失败。

## 九、CDN 更新与回退

### 9.1 向前更新

例如 CDN 作者加入 1.4.54 到 1.4.55 的合法归档并更新 EntityLists：

```text
content:sync
  -> 识别 targetVersion 1.4.55
  -> 生成或复用表对象
  -> 写 1.4.55 Release
  -> current.json 切换到 1.4.55
  -> 重启后生效
```

版本号和补丁边完全由 CDN 作者决定。

### 9.2 同版本修改

普通同步比较资源版本和生成器版本。同版本、同生成器版本下的 CDN 原地修改不会自动重建，CDN 作者必须执行：

```bash
npm run content:sync -- --force
```

客户端是否能重新下载同版本资源不由同步层处理。客户端资源发生变化时，CDN 作者应自行决定是否增加版本号。

### 9.3 回退

CDN 作者删除错误版本文件并恢复旧 EntityLists 后，再次运行普通同步：

- 扫描目标版本低于当前版本时，视为显式回退。
- 已有对应旧 Release 时直接切换 `current.json`。
- 没有旧 Release 时重新提取。
- 重启后服务端使用旧 Catalog 和旧主数据。

已经下载较高错误版本的官方客户端通常需要清空资源缓存，或由未来启动器重置资源版本。服务端不提供客户端自动降级。

错误版本已广泛发布时，CDN 作者也可以发布更高修复版本，使客户端继续向前更新。

### 9.4 删除影响

- 删除未被最新主数据使用的归档：新 Catalog 不再包含它，部分客户端更新路径可能失败。
- 删除最新 orderedmap 所在归档：同步无法定位必需来源并失败。
- 删除 EntityLists：同步无法确定资源集合并失败。
- 删除版本边：Planner 可能无法为部分客户端找到更新路径。

同步层不修复上述问题。

## 十、服务端加载

### 10.1 ContentRepository

`ContentRepository` 是服务端主数据唯一的运行时接口方向。第一阶段至少提供：

- 读取当前 Release 元数据。
- 按表名读取和缓存规范 JSON 对象。
- 角色、卡池、商店领域的类型化访问器。
- bundled fallback 适配器。

Repository 在服务启动时固定数据来源。运行中修改 `current.json` 不影响已启动进程，必须重启。

受支持的启动脚本在 Repository 初始化前完成自动同步。直接运行 `out/cn-server.js` 时，Repository 只读加载现有指针或 bundled fallback。

### 10.2 Catalog

同步 Release 的 Catalog 取代固定 1.4.54 runtime manifest，成为该次启动的 Planner 和 CDN 文件 allowlist 来源。

没有 `current.json` 时继续使用仓库跟踪的官方 1.4.54 manifest。动态 Catalog 接入稳定后：

- 固定 manifest 保留为测试 fixture 和 bundled fallback。
- `asset-patch/manifest.json` 不再参与 CN 运行时版本选择。
- 完整 SHA-256 审计继续作为显式诊断工具保留。

## 十一、性能与存储

### 11.1 不读取全部 CDN 正文

普通同步可以读取归档中央目录并只解压 Registry 需要的主数据 entry。它不对全部归档计算 SHA-256。

资源版本和生成器版本均未变化时，启动预检查不建立完整 ArchiveIndex，也不读取 orderedmap，因此日常重启只增加一次轻量版本扫描。

### 11.2 首版转换策略

第一版每次需要同步时运行全部已实现转换器。先保持转换逻辑直接，避免预先引入输入依赖缓存。

如果后续转换耗时成为问题，可以在不改变 Release 语义的情况下增加：

- orderedmap 提取缓存。
- `sourceDigest + converterVersion` 命中时复用表对象。
- 并行运行互不依赖的转换器。

### 11.3 去重效果

完整快照不会物理复制所有表。假设 bundled 基线表共 82MB，后续九个版本各只改变约 1MB，理想存储量约为：

```text
82MB 初始唯一对象
+ 9MB 后续变化对象
+ 少量 manifest 和 summary
```

只有每个版本的全部表字节都不同，存储才会接近十份完整数据。

## 十二、安全边界

即使 CDN 作者负责内容，服务端和同步器仍保留自身文件系统边界：

- 路径不能逃逸配置根目录。
- ZIP entry 不能使用绝对路径或 `..` 写入任意位置。
- 生成对象不能通过符号链接写出 `.content`。
- CDN HTTP 路由继续使用 Catalog allowlist、Range 和句柄释放防护。
- 生成产物不能包含绝对主目录、玩家数据或运行期种子状态。

这些属于文件和网络安全，不属于 CDN 业务内容校验。

## 十三、测试与验收

### 13.1 自动测试保证

- 同一输入和转换器版本产生相同对象摘要和 Release manifest。
- 相同表只保存一个物理对象。
- 版本变化触发同步，版本相同跳过，`--force` 重建。
- `generatorVersion` 变化时，即使 CDN 版本相同也自动重建。
- `--check` 不写文件。
- 两个并发启动只能有一个同步写入者，另一个遵守同步锁结果。
- 受支持启动入口在版本变化时先同步再启动，版本未变化时快速启动。
- 同步失败时受支持启动入口不启动游戏服务。
- 同步失败不更新 `current.json`，不留下可加载的半成品 Release。
- 没有 `current.json` 时旧服务端正常运行。
- current 指针或对象损坏时服务启动明确失败。
- Repository 的角色、卡池、商店数据与转换器输出一致。
- 官方 1.4.54 真实 CDN 同步后，首轮接口行为与 bundled 基线一致。
- 同步和测试不修改原始 CDN、玩家 SQLite 或运行期种子文件。
- 动态 Catalog 仍满足现有 latest、incremental、initial 和 Range 协议测试。

### 13.2 不保证

- CDN 作者的 ID、赔率、商品、奖励和引用正确。
- 新 CDN 与官方客户端兼容。
- 同版本修改能让已下载客户端重新取得资源。
- 错误 CDN 的客户端自动降级。
- 未迁移领域在第一阶段自动跟随 CDN 更新。

### 13.3 用户验收顺序

第一阶段：

1. 使用当前官方 1.4.54 CDN 运行同步。
2. 启动服务，验证角色、卡池和商店行为与 bundled 基线一致。
3. 使用包含小范围角色、卡池或商店变更的测试 CDN 再次同步。
4. 重启并确认服务端表和客户端内容同时变化。
5. 验证版本相同跳过、`--force` 重建和回退流程。

第一阶段通过后，再开始全表转换器迁移和第二轮验收。

## 十四、实施阶段

### 阶段 A：首轮可测试版本

- Content Sync CLI、版本判断和路径解析。
- StartupBootstrap、支持入口接线和同步锁。
- CdnScanner、ArchiveIndex、OrderedMapExtractor。
- TableSourceRegistry。
- 规范 JSON 对象库、Release manifest 和 current 指针。
- ContentRepository 和 bundled fallback。
- 角色、卡池、商店转换器与服务端接入。
- 动态 Catalog 接入。
- 中文使用和架构文档。

### 阶段 B：全表转换

用户确认阶段 A 后：

- 按领域补全所有 CDN 主数据转换器。
- 每个领域独立提交和审查。
- 静态 JSON import 逐批迁移到 ContentRepository。
- Registry 最终覆盖全部 CDN 主数据。

### 阶段 C：清理兼容路径

- 固定官方 manifest 降为 fixture 和 fallback。
- `asset-patch/manifest.json` 退出 CN runtime。
- 删除已经完全由 Repository 替代的旧主数据加载路径。
- 保留独立 CDN 审计工具，不接入正常启动和同步。

## 十五、取代的旧设计

本设计取代 `2026-07-20-content-release-and-dev-speed-design.md` 中以下尚未实现的复杂方案：

- Content Builder Overlay 作为权威输入。
- 大型 CDN 对象库和完整归档摘要闭包。
- 业务 ID 与玩家数据库兼容校验。
- candidate/configured/loaded/previous 状态机。
- Runtime Supervisor 自动回滚。
- 后台审批、激活 job 和撤销修复路径。

旧设计中已经完成且继续保留的内容包括：开发提速、Catalog、Planner、ContentSnapshot、CDN 文件安全路由和独立审计工具。
