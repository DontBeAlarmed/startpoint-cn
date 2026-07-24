# Content Sync 与内容 Release

本文说明 CN 服务的内容同步职责、操作命令、生成布局、回退方式和阶段 A 支持边界。CDN Catalog 与客户端更新计划详见 [`catalog-planner.md`](catalog-planner.md)。

## 职责边界

Content Sync 在服务启动前把一份完整 CDN 输入转换为不可变 Content Release。一次 Release 同时包含：

- 客户端更新和 ZIP allowlist 使用的 Catalog；
- 服务端运行时读取的完整 Repository 表集合；
- 来源、转换器版本和对象摘要；
- 指向当前 Release 的原子 `current.json`。

同步器负责严格解析、引用闭包、稳定输出和文件系统安全，不负责判断 CDN 作者给出的 ID、赔率、奖励、价格或资源内容是否合理。服务端不会替 CDN 作者猜测缺失内容、复制其他活动数据、修复非法主数据或自动生成客户端补丁。

阶段 A 只动态转换三个领域：

| 领域 | 动态输出 |
|---|---|
| 角色 | `character.json`、两张 `cdndata/character*.json` |
| 卡池 | `gacha.json`、`gacha_campaign.json`、两张 `cdndata/gacha*.json`，并读取全部非空 odds 引用 |
| 商店 | General、Event、Boss、Star Grain、Treasure、Equipment 共 8 张运行时表 |

Registry 仍要求每个 Release 闭合当前全部注册表。阶段 A 中未迁移领域从仓库内 bundled/server JSON 导入 Release；它们不会因为 CDN orderedmap 改动而自动变化。全表 CDN 转换属于阶段 B，必须在阶段 A 验收后另行实施。

## 受支持输入

当前真实基线只保证以下组合：

- 官方 CN 1.8.1 客户端；
- 停服前官方 CN 1.4.54 CDN dump；
- `CDN_DIR` 指向包含 `cn/` 的父目录，不能直接指向 `cn/`；
- 客户端资源状态与服务端当前 Catalog 版本相符。

没有 `current.json` 时，运行时使用仓库内 bundled JSON 和 tracked 官方 1.4.54 Catalog 作为 fallback。bundled 是兼容旧运行方式的兜底，不是同步 Release 上的 overlay。

官方 1.4.54 feature content 的稳定 nested 基线为：543 个 outer、2866 个 row、排除空字符串和 `(None)` 后 12236 个非空字段，另有 541 个 `(None)`；canonical JSON 摘要为 `sha256:21898330b538f6c60a0c8114a15f8e247934bea46a104ca4711cc72cde761bf4`。bundled `cdndata/gacha_feature_content.json` 的 584 个 outer、2908 个 row 来自历史 fallback 修补；同步 Release 必须同时满足官方计数和摘要，不得把 bundled 修补叠加进去。

商店还有两个已审计的 fallback 历史缺口。bundled Boss runtime 只有 6132 个 ID，因为旧生成器错误丢弃了 434 个奖励类型为经验/玛纳且官方 ID 为空的货币奖励商品；Release 按 tracked 官方 `cdndata/boss_coin_shop.json` 锁定 6566 个 ID 及 category，不为货币奖励伪造 ID。bundled Star Grain 有 74 个 ID，官方还包含单一 ID `9999`，Release 锁定为 75 个。General、Event 和 Equipment 的记录数及 ID 集合与 bundled 精确一致；Treasure 的 ID 集合一致，但官方价格和奖励值可以不同。

## 运行时目录与 Asset Provider

内容层和客户端资源供给使用三个相互独立的根：

| 根 | 默认位置 | 职责 |
|---|---|---|
| `CDN_DIR/cn` | `<PROJECT_ROOT>/.cdn/cn` | 官方 CDN 归档与 `EntityLists`，local 模式只读供给客户端 |
| `CONTENT_RUNTIME_DIR` | `<PROJECT_ROOT>/assets` | Bundle 内只读 bundled 表和官方 1.4.54 Catalog fallback |
| `DATA_DIR/asset-provider` | `<PROJECT_ROOT>/.database/asset-provider` | 可变兼容 payload 和旧 global metadata |

CN Catalog 的版本和版本边只来自当前 Content Release；没有 Release 时只来自 `CONTENT_RUNTIME_DIR/cdn/catalog-cn-1.4.54.json`。`assets/asset-patch/manifest.json` 不再参与 CN 启动、版本选择或后台版本展示，也不是第二份 Catalog 权威。

local 模式保留 `/patch/cn/dummy/download/production/upload/<prefix>/<hash>` 兼容路由，其唯一 payload 根为：

```text
<DATA_DIR>/asset-provider/production/upload/<prefix>/<hash>
```

解析配置和启动服务不会创建该目录。目录或文件缺失时请求返回 404，不会回退读取 Bundle 内的 `assets/asset-patch`。remote 和 client-owned 模式不会解析、探测或创建 Asset Provider payload 根。

旧部署若仍需保留兼容 payload，必须在停服后手工复制到上述 Data Volume 路径并核对文件集合；服务端不执行自动迁移、复制、版本分配或回滚。旧 global 资产路由的可变 metadata 位于 `<DATA_DIR>/asset-provider/legacy-metadata.json`，首次迁移前可只读使用旧 CDN 根的 `metadata.json`，后续写入只发生在 Data Volume。

## 自动启动同步

受支持入口为：

```bash
npm run start:cn
npm run dev:cn
bash scripts/start-cn.sh
```

这些入口在游戏服务尚未启动时先运行 normal content sync：

```text
加载可选 .env
  -> 扫描目标资源版本
  -> 比较 current Release
  -> 必要时取得同步锁并生成 Release
  -> 同步成功后启动游戏服务
```

同步失败时入口以非零状态退出，游戏服务不会启动。失败不会把半成品提升为 current，也不会自动带着旧指针继续启动。

`node out/cn-server.js` 是低级调试入口，不执行自动同步。它只读取当时已有的 current Release；没有 current 时使用 bundled fallback。直接入口不会检查 CDN 是否刚被修改，因此操作者必须事先完成同步和验证。

## 手动命令

normal 模式：

```bash
npm run content:sync
```

normal 依次检查 current Release 是否存在、CDN `assetVersion`、全局 `generatorVersion`，以及 Release 表集合与当前 Registry 是否兼容。注册表新增、移除，或任一表的 `scope`、`converterId`、`converterVersion`、`sources` 变化时，normal 返回 `table-registry` 并自动重建；完全兼容时才快速跳过。

这项判断只读取 manifest 元数据，不读取表对象，也不会在每次启动时执行完整转换。转换器内部算法改变但注册元数据不变时，开发者仍必须递增对应 `converterVersion`；影响全部内容生成的规则变化使用 `generatorVersion`。运行时继续执行同一套严格 Registry 校验，作为最后的加载防线。

只检查是否需要同步，不建立 ArchiveIndex、不转换 orderedmap、不写内容：

```bash
npm run content:sync -- --check
```

强制重新读取和转换同版本内容：

```bash
npm run content:sync -- --force
```

CDN 在同一个 `assetVersion` 下被原地修改，且服务端生成契约也没有变化时，normal 不检查原始文件内容差异，必须使用 `--force`。更改客户端资源时仍应优先发布新的资源版本；`--force` 只重建服务端 Release，不会迫使客户端重新下载同版本资源。

## 真实 CDN smoke

`integration:content` 自动组包含离线 fixture，用小型临时数据覆盖参数、路径、基线和失败摘要，不读取真实 CDN。真实 CDN smoke 仍必须手动运行，并显式提供 CDN 父目录和隔离的临时 content root：

```bash
SMOKE_ROOT="$(mktemp -d /tmp/starpoint-cn-content-smoke.XXXXXX)"

npm run content:smoke -- \
  --cdn-root <CDN_PARENT> \
  --content-root "$SMOKE_ROOT"
```

`--cdn-root` 使用 `CDN_DIR` 的父目录语义；`--content-root` 必须是绝对路径，并且只能指向不存在的专用目录，或已存在、为空且权限为 `0700` 的普通目录。它不能是符号链接、普通文件或非空目录，也不得与项目、`.database` 或 CDN 相等、互为祖先/后代；不存在目录的直接父目录必须已存在且不是符号链接。不要直接传入 `/tmp`，每次 smoke 应使用新的 `mktemp -d` 结果。

`content:smoke` 是同 UID 开发者手动离线工具，不是面向不受信任本地用户的安全边界。运行期间调用者必须保证没有同 UID 进程故意替换 content root、派生目录或祖先路径。现有 identity、symlink 和空目录检查用于防止误传，并发现检查时存在或留下可观察变化的并发修改；它们不构成同 UID 对抗性 TOCTOU 防护。本工具不使用轮询、文件系统 watch、额外锁文件或平台专用 API 尝试对抗同 UID 进程。

smoke 创建或接受 root 后记录其 `dev`、`ino`、权限和 realpath，并预先建立权限为 `0700` 的 `release/`。Release 是 smoke 唯一可写派生目录，必须是 root 的直接子目录且 identity 不变；阶段 A 尚未迁移的 bundled 表从项目只读 `assets/` 加载，并由下述 Git/seed 来源快照覆盖。在调用同步前和同步结束后都会复核 root、`release/` 及 root 顶层项目集合。root 替换、Release 符号链接或工具外顶层项目在检查时存在，或在后续复核时留下可观察变化时会失败；检查间隙由同 UID 对手完成并恢复的替换不在保护范围内。

smoke 始终执行 force sync，并验证：

- Release、Repository、Catalog 都是 1.4.54；当前 Registry 全部表及所有对象引用闭合；
- 两张角色 cdndata 各 505 行，运行时 505 个角色；名称、稀有度、属性与 bundled 一致；
- 只允许已记录的 45 个 `skill_count` 从 3 变为 6，12 个 `skill_count=2` 保持不变；
- 卡池 raw row 为 584、campaign 为 145，全部非空 odds 已成功读取；
- 可抽取角色/装备的卡池类型、ID、数量和原始 weight 与 bundled 已验证基线一致，费用不作为失败条件；
- feature content 严格采用官方 543/2866/12236/541 nested 基线及固定 canonical JSON SHA-256，不叠加 bundled 历史修补；
- 8 张商店表的 ID、category、event 嵌套边界按已审计来源锁定：General/Event/Equipment 与 bundled 一致，Boss 与 tracked 官方 6566 行 raw 基线一致，Star Grain 只允许官方额外 ID `9999`，Treasure 只锁定 ID；
- Rush `700011..700017` 官方独立商品保持为空，`eventId-10` 推测映射只留在业务层；
- 调用前后 Git HEAD、相对 HEAD 的 tracked binary diff、staged binary diff、unstaged binary diff 均不变；已有 dirty 内容可以存在，但 smoke 期间不能继续变化；
- `git ls-files --others --exclude-standard` 返回的全部 untracked 文件保持同一稳定路径和内容摘要；若 Git 将未跟踪嵌套仓库或目录作为目录项返回，smoke 直接以来源不安全拒绝，不递归扫描不明目录；
- `assets/` 下所有实际 seed 状态文件以及 `confirmed_seeds.json`、`pending_seeds.json` 的存在/缺失状态不变；
- `.database/` 内全部普通文件的集合与内容 SHA-256 不变，smoke 不写玩家数据库；
- 每个 `archive-*` 项必须是非符号链接目录，原始 ZIP 的 inode/大小/权限/mtime/ctime 元数据不变；`EntityLists/` 普通文件的集合、内容 SHA-256 和元数据不变。

smoke 不对约 10GB 归档再做一遍全量 SHA-256。同步自身可在临时 state 写摘要缓存；原始归档只读，前后以元数据清单证明未发生可观察修改。EntityLists、seed、untracked 和 database 文件以分块方式读取内容摘要，不写回来源。

Git binary diff 快照设置 64 MiB 输出上限；包含更大 dirty binary diff 的工作树不受本工具支持，会以 `CONTENT_SYNC_SMOKE_GIT_TOO_LARGE` 明确失败，需先在可信位置保存或清理该临时改动再运行。成功输出 `DONE [CONTENT_SYNC_SMOKE_OK]`；参数错误退出码为 2，其他同步、基线或来源变化错误输出稳定的 `BLOCKED [错误码]` 并以退出码 1 结束。公开摘要只报告变化类别，不打印绝对路径或具体文件名；未知异常只输出固定的“内容 smoke 失败”。

## Release 布局

默认生成状态位于 gitignored 的 `.content/`：

```text
.content/
|-- current.json
|-- objects/
|   `-- <sha256>.json
|-- releases/
|   `-- <assetVersion>-<releaseDigest>/manifest.json
|-- state/
|   `-- cdn-digest-cache.json
|-- store/
`-- runtime/
```

`manifest.json` 完整列出当前 Registry 的全部表、Catalog 和 summary 对象。多个 Release 可以引用同一个内容寻址对象；相同对象不会重复保存。`current.json` 只保存当前资源版本和 Release manifest 相对路径，使用原子替换激活。

服务进程初始化时只读取一次 current snapshot，并用同一 snapshot 构造 Catalog 与 Repository。运行期间修改 `current.json` 不会热切换，必须重启才会加载新 Release。

### 生产角色数据读取

生产服务中的角色名称、称号、稀有度、元素和种族统一从启动时固定的 `ContentRepository` 读取。角色 lookup 使用同一 snapshot 内的 `character.json`、`cdndata/character.json` 和 `cdndata/character_text.json` 构造；任务结算使用的种族也直接读取该 Repository 的 `cdndata/character.json`。模块加载阶段不会读取角色表，后台请求或任务结算实际调用时才访问已初始化 snapshot。

开发期角色表生成脚本及其生成文件只用于离线核对和数据维护，不属于 Bundle 或生产运行时依赖。部署产物不需要开发期生成目录，也不需要仓库外的 orderedmap 源目录；Release 与 bundled fallback 都必须通过 `ContentRepository` 提供运行时角色数据。

### 删除 `.content` 的影响

删除 `.content` 会删除 current 指针、全部本地 Release/对象和摘要缓存，但不会删除 CDN、bundled JSON 或玩家数据库。

- 下一次受支持启动发现 current 缺失，会从 CDN 重新执行 normal 同步，成功后再启动；
- 在重新同步前直接运行 `out/cn-server.js`，会使用 bundled 1.4.54 fallback；
- 只删除部分对象或损坏 current/manifest 时，运行时明确失败，不会静默回退。

`.content` 不是玩家备份，也不是 CDN 备份。清理前仍应确认 CDN 输入完整可重建。

## 回退步骤

错误 CDN 不由服务端自动修复。回退必须由 CDN 作者或部署者完成：

1. 停止使用受支持启动入口继续尝试启动，确认没有同步进程持锁。
2. 删除错误 CDN 归档，恢复目标版本对应的正确归档和 EntityLists；不要只改服务端 JSON。
3. 执行 `npm run content:sync -- --force`，从恢复后的 CDN 重建并激活 Release。
4. 运行真实 smoke 或对应离线审计，确认 Catalog、Repository 和来源不变检查通过。
5. 再使用受支持入口启动服务。

如果客户端已经下载错误资源，服务端回退并不能恢复客户端文件。必须清除客户端资源缓存，或恢复与目标版本匹配的客户端资源状态后重新下载。错误内容已广泛下发时，CDN 作者也可以发布更高的修复版本，让客户端继续向前更新。

同步器不会把非法归档改写成合法归档，不会推测缺失版本边，也不会为错误数据生成历史兼容 overlay。修复 CDN 是 CDN 作者责任；Content Sync 只在输入恢复后重新生成一致的 Release。

## 常见失败判断

| 现象 | 处理 |
|---|---|
| normal 显示 `up-to-date`，但同版本 CDN 已修改 | 使用 `--force` |
| 必需 orderedmap 或 odds 缺失/不可读 | 恢复对应官方归档，不要复制其他表代替 |
| current、manifest 或对象损坏 | 恢复完整 `.content` 备份，或删除整套 `.content` 后从正确 CDN 重建 |
| smoke 报来源变化 | 停止使用该结果，检查工作树、seeds 和 CDN 是否被并发修改 |
| 服务端已回退但客户端仍异常 | 清理客户端资源缓存或恢复匹配的客户端资源状态 |
