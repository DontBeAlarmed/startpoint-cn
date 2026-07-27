# Content Sync 与内容 Release

本文说明 CN 服务的内容同步职责、操作命令、生成布局、回退方式和阶段 B 支持边界。CDN Catalog 与客户端更新计划详见 [`catalog-planner.md`](catalog-planner.md)。

## 职责边界

Content Sync 在服务启动前把一份完整 CDN 输入转换为不可变 Content Release。一次 Release 同时包含：

- 客户端更新和 ZIP allowlist 使用的 Catalog；
- 服务端运行时读取的完整 Repository 表集合；
- 来源、转换器版本和对象摘要；
- 指向当前 Release 的原子 `current.json`。

同步器负责严格解析、引用闭包、稳定输出和文件系统安全，不负责判断 CDN 作者给出的 ID、赔率、奖励、价格或资源内容是否合理。服务端不会替 CDN 作者猜测缺失内容、复制其他活动数据、修复非法主数据或自动生成客户端补丁。

阶段 B 当前把 Registry 的 109 张表分为 `100 CDN + 5 bundled + 4 server`。原阶段 A 的五个动态领域为：

| 领域 | 动态输出 |
|---|---|
| 角色 | `character.json`、两张 `cdndata/character*.json` |
| 角色投票 | `character_election.json`；从选举、排除、图鉴与角色表生成服务端候选白名单和开放期 |
| 卡池 | `gacha.json`、`gacha_campaign.json`、两张 `cdndata/gacha*.json`，并读取全部非空 odds 引用 |
| 商店 | General、Event、Boss、Star Grain、Treasure、Equipment 共 8 张运行时表 |
| 任务技能效果 | `cdndata/active_mission_skill_effects.json`；读取角色、技能 orderedmap 和 Action DSL |

在此基础上，35 张与官方提取 JSON 可机器证明完全相等的表已改用通用递归 OrderedMap 转换器。转换器按 Registry 声明的一至三层嵌套深度还原 CSV 树，不改字段、不补 ID，也不叠加 bundled 数据。范围包括 Active Mission、角色觉醒、收集、普通/每日/每周/称号/活动任务、Pass 任务及奖励表，以及玩家等级、角色剧情 lookup、EX Ability、Mana Board、Raid 总体奖励、奖励属性映射、体力活动和星屑兑换等直接表。

奖励领域另有 6 张派生表从官方 OrderedMap 动态生成：Clear、Score、Rare Score、Score Attack Border、Rush Folder 和 Rush Ranking。转换器保留原始位置、概率、数量和多奖励槽，并修正历史 bundled 的 5 条 Clear Reward 字段误复制及 82 个无意义 `id:null`。早期活动代币中另有 47 行官方 ID 与 bundled 世代 ID 不同；smoke 只在 `item_lookup` 名称一致时视为同一代币族，实际发奖仍由业务层按服务器时间选择开放期 ID。

玩法领域新增 5 张派生表：土俑累计分奖励、装备抽卡动画概率、EX Boost 消耗道具、EX Status 稀有度池和 Raid 活动总击破阈值。它们分别从官方 Carnival、Gacha、EX Boost 和 Raid OrderedMap 严格转换；官方 CN 1.4.54 的 1451、1、21、3、7 条输出逐字段等于 bundled 基线。土俑结算、装备抽卡动画、EX Boost 和 Raid 运行时均从当前 Content snapshot 读取这些表，只有 snapshot 尚未初始化的低级测试环境才使用 bundled fallback。

活动扭蛋箱的 `box_gacha.json`、`box_reward.json` 和 `box_gacha_box_settings.json` 在同一转换批次从官方 Box Gacha、Box Reward 和 Box OrderedMap 生成。每箱总库存由奖励行的 `available` 求和，不维护第二份人工数值；转换器要求 48 个活动的奖励箱与重置规则箱号集合闭合。三张官方 1.4.54 输出均逐字段等于 bundled 基线，抽取与重置运行时从同一个 Content snapshot 读取。

`mana_node.json` 从三层官方 Mana Node OrderedMap 生成 495 个角色、19863 个节点的强化素材和玛纳成本。官方 1.4.54 输出逐字段等于 bundled 基线；运行时的 `mana_node.json`、已经动态化的 `mana_board.json` 与 `mana_node_awake.json` 统一从当前 Content snapshot 读取，避免节点定义、底座尺寸和觉醒成本跨版本拼接。

物品与装备领域从官方 Item、Equipment、Equipment Craft Point Exchange 和 Equipment Dissolve Rate OrderedMap 同批生成 8 张表：`item_data.json`、`item_ids.json`、`item_lookup.json`、`item_sale.json`、`equipment_ids.json`、`equipment_lookup.json`、`equipment_dissolve.json` 和 `equipment_craft.json`。ID、名称、真实稀有度、出售规则、装备分解规则和稀有度成本都随当前 Release 更新，体力道具使用、出售、邮件附件校验、后台道具与装备检索及活动代币世代解析统一读取 Content snapshot。装备 lookup 的 `category` 是后台展示字段，不属于官方装备主数据：转换器只从 bundled 兼容表继承已知 ID 的人工分类，新 CDN 装备没有分类时输出“未分类”，不会阻止搜索、发信或游戏业务。官方 1.4.54 除 `item_data.json` 和 `equipment_lookup.json` 外的 6 张输出逐字段等于 bundled；前者补出旧手工表遗漏的 9 个官方限时体力道具，后者保留 436 个名称和分类并把全部错误星级替换为 CDN 的真实 `1～5`。smoke 分别用已登记差异和固定 canonical 摘要锁定结果。

关卡领域从 20 张官方 Quest OrderedMap 动态生成 20 张运行关卡表，并在同一转换批次生成
`quest_entry_costs.json`、`quest_unlock_costs.json`、`quest_lookup.json`、
`daily_challenge_point_lookup.json` 和 `event_challenge_point_map.json`。运行时的关卡名称、首通/SS
奖励、普通掉落组、推荐属性、体力、Always 门票、Once 解锁道具和挑战点都来自同一 Release，
不会把新版关卡与旧 bundled 索引混用。转换器按 CN 1.8.1 生成类校正了 Advent、Story、
Challenge、Tower、Hard Multi 等历史列偏移；其中 Hard Multi 体力列为 `70`，不是旧脚本猜测的
`69`。官方 1.4.54 基线为 5159 条动态关卡、3045 条入场成本、9 条 Once 解锁成本、5257 条
后台关卡名称（含 98 个 bundled 兼容练习关卡）、282 条每日挑战点和 3 条活动挑战点映射。

任务技能效果索引只记录 CDN 能直接证明的角色技能效果。服务端在同步阶段解压并解析
`*.action.dsl.amf3.deflate`，识别 `CreateNormalHeal`、`CreateRatioHeal`、`ACRegeneration`，以及
负值 `ACToleranceOfElement` 对应的 `ACToleranceOfElement_Down`。无法读取或解码的程序会进入表内
`unresolved`，不会猜测效果，也不会阻止其他角色生成索引。运行时只读取生成表，不读取 DSL 原文件。

仓库内的 `assets/cdndata/active_mission_skill_effects.json` 只是一份空结构兼容 fallback；没有执行
Content Sync 时，20015/20016 会保持 fail closed。使用官方 CDN 执行同步后，当前 Release 才会包含实际
角色效果索引。

Registry 仍要求每个 Release 闭合当前全部注册表。剩余 5 张 bundled 表为 `cdndata/player_rank_full.json`、`encyclopedia.json`、两张任务审计派生表和 `practice_quest.json`。其中玩家 `0..100` 等级数据来自历史实测，练习关卡还保留 7 个官方 1.4.54 OrderedMap 不包含的兼容 ID，因此不能伪装成完整 CDN 转换结果。图鉴官方源与 bundled 的显示集合不一致，在客户端显示和解锁语义审计完成前继续保留 bundled。两张任务派生表由服务端任务规则审计生成，不是可直接复制的 CDN 表。上述表不会因为 CDN OrderedMap 改动而自动变化；不能迁移的表明确搁置，不用猜测规则填满数字。4 张 `server` 表为服务端配置或后台内容，不属于 CDN 转换范围。

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
| `CDN_DIR/cn` | `<PROJECT_ROOT>/.cdn/cn` | 官方 CDN 归档与 `EntityLists/` 或 `entities/`，local 模式只读供给客户端 |
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

这项契约判断本身只使用 manifest 元数据；当前 `ContentObjectStore` 读取 current Release 时仍会先校验并读取该 Release 的对象闭包，因此 `--check` 也会检查对象可读性，但不会执行 orderedmap 转换或重建。转换器内部算法改变但注册元数据不变时，开发者仍必须递增对应 `converterVersion`；影响全部内容生成的规则变化使用 `generatorVersion`。运行时继续执行同一套严格 Registry 校验，作为最后的加载防线。

只检查是否需要同步，不建立 ArchiveIndex、不转换 orderedmap、不写内容：

```bash
npm run content:sync -- --check
```

强制重新读取和转换同版本内容：

```bash
npm run content:sync -- --force
```

CDN 在同一个 `assetVersion` 下被原地修改，且服务端生成契约也没有变化时，normal 不检查原始文件内容差异，必须使用 `--force`。更改客户端资源时仍应优先发布新的资源版本；`--force` 只重建服务端 Release，不会迫使客户端重新下载同版本资源。

## 运行资产审计

`content:sync` 负责生成 Release，不负责证明仓库内历史 bundled 表没有手工遗漏。发布前可显式运行只读审计：

```bash
npm run content:audit -- --source-root <WF_ASSETS_CN_ROOT>
npm run content:audit -- --source-root <WF_ASSETS_CN_ROOT> --format json
```

`--source-root` 可指向 `wf-assets-cn` 根或其 `orderedmap/`。当前只接受 `VERSION=1.4.54`；其他版本必须先更新项目支持契约和审计基线。默认运行表根为项目 `assets/`，需要审计其他 Bundle 时可显式提供 `--runtime-root <ASSETS_ROOT>`。

当前审计分两层：

1. Content Registry 的 109 张运行表必须存在、是普通文件且可解析为 JSON；
2. 普通、每日、每周、称号、活动、角色觉醒、收集、Active Mission 和 Pass 共 25 张关键表与官方提取源按解析后的完整 JSON 深度比较，并校验 11 组任务/奖励 ID、144 条觉醒任务四元组和 Pass 活动奖励引用闭包。

官方 1.4.54 基线为 109 张 Registry 表、25 张深度对比表、13327 个深度对比顶层键、36 个觉醒角色组、19 个 Pass 活动及 1140 条 Pass 等级奖励。格式和对象键顺序不构成差异，数组顺序、ID 集合和嵌套值差异会失败。

该命令不写 CDN、`assets/`、`.content/` 或玩家数据库，不生成修复数据，也不由 `start:cn`、`dev:cn` 或 `content:sync` 自动调用。单个 JSON 通过文件描述符读取并在前后核对身份；109 张运行表各读取一次后作为本次内存快照复用于后续检查。该工具不提供跨 109 个文件的原子文件系统快照，发布者必须在停止内容写入后运行；同 UID 对抗性进程在检查间隙替换并恢复路径不属于保护边界。完整 CDN 归档合法性仍由 `content:smoke` 负责，两项工具不能互相替代。

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

smoke 创建或接受 root 后记录其 `dev`、`ino`、权限和 realpath，并预先建立权限为 `0700` 的 `release/`。Release 是 smoke 唯一可写派生目录，必须是 root 的直接子目录且 identity 不变；阶段 B 尚未迁移的 bundled 表从项目只读 `assets/` 加载，并由下述 Git/seed 来源快照覆盖。在调用同步前和同步结束后都会复核 root、`release/` 及 root 顶层项目集合。root 替换、Release 符号链接或工具外顶层项目在检查时存在，或在后续复核时留下可观察变化时会失败；检查间隙由同 UID 对手完成并恢复的替换不在保护范围内。

smoke 始终执行 force sync，并验证：

- Release、Repository、Catalog 都是 1.4.54；当前 Registry 全部表及所有对象引用闭合；
- 35 张通用递归 OrderedMap 表逐张与 bundled 官方 1.4.54 基线深度相等；
- 8 张物品装备派生表闭合到同一 Release；其中 6 张逐字段等于 bundled，`item_data.json` 只允许登记的 9 个官方限时体力道具补全，`equipment_lookup.json` 必须匹配 436 条固定 canonical 摘要；
- 6 张奖励派生表逐张闭合；按 `differences-1.4.54.json` 的具体键、位置与 ID 元组，只接受 5 条 Clear 字段修正、82 个空 id 清理和 47 个同名活动代币别名；
- 20 张关卡表和 5 张关卡派生表匹配固定 canonical 摘要；名称非空、推荐属性为 `0..5`，Clear/SS 与普通掉落组全部闭合到同一 Release 的奖励表，入场和解锁索引只能引用当前关卡；98 个 bundled 兼容练习关卡必须全部进入名称索引，活动挑战点必须引用同一 Release 的每日挑战点；
- 两张角色 cdndata 各 505 行，运行时 505 个角色；名称、稀有度、属性与 bundled 一致；
- 只允许已记录的 45 个 `skill_count` 从 3 变为 6，12 个 `skill_count=2` 保持不变；
- 卡池 raw row 为 584、campaign 为 145，全部非空 odds 已成功读取；
- 可抽取角色/装备的卡池类型、ID、数量和原始 weight 与 bundled 已验证基线一致，费用不作为失败条件；
- feature content 严格采用官方 543/2866/12236/541 nested 基线及固定 canonical JSON SHA-256，不叠加 bundled 历史修补；
- 8 张商店表的 ID、category、event 嵌套边界按已审计来源锁定：General/Event/Equipment 与 bundled 一致，Boss 与 tracked 官方 6566 行 raw 基线一致，Star Grain 只允许官方额外 ID `9999`，Treasure 只锁定 ID；
- Rush `700011..700017` 官方独立商品保持为空，`eventId-10` 推测映射只留在业务层；
- 调用前后 Git HEAD、相对 HEAD 的 tracked binary diff、staged binary diff、unstaged binary diff 均不变；已有 dirty 内容可以存在，但 smoke 期间不能继续变化；
- `git ls-files --others --exclude-standard` 返回的全部 untracked 文件保持同一稳定路径和内容摘要；若 Git 将未跟踪嵌套仓库或目录作为目录项返回，smoke 直接以来源不安全拒绝，不递归扫描不明目录；
- `assets/gacha-seed-catalog/` 的文件与摘要保持不变；抽卡动画 catalog 不属于 CDN 业务表同步范围；
- `.database/` 内全部普通文件的集合与内容 SHA-256 不变，smoke 不写玩家数据库；
- 每个 `archive-*` 项必须是非符号链接目录，原始 ZIP 的 inode/大小/权限/mtime/ctime 元数据不变；`EntityLists/` 与 `entities/` 两个受支持位置的普通文件集合、内容 SHA-256 和元数据不变。

smoke 不对约 10GB 归档再做一遍全量 SHA-256。同步自身可在临时 state 写摘要缓存；原始归档只读，前后以元数据清单证明未发生可观察修改。两种资源清单目录、seed、untracked 和 database 文件以分块方式读取内容摘要，不写回来源。

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
2. 删除错误 CDN 归档，恢复目标版本对应的正确归档和 `EntityLists/` 或 `entities/` 资源清单；不要只改服务端 JSON。
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
