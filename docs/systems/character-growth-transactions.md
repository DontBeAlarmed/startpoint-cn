# 角色养成事务边界

角色养成接口常同时写玩家货币、材料、角色状态、节点和任务事实。一次请求的业务结果必须同成同败；不能在
最后一步失败后留下已扣资源，也不能先发放信赖证再让领取状态保持未领取。

## Mana 准入权威内容与纯规划边界

Gate Task 29a 新增三项只读权威内容能力，尚未改变 `learn_mana_node` 或 `awake_mana_node` 的生产路由：

- `master/mana_board/level_required_mana_node.orderedmap` 动态生成
  `level_required_mana_node.json`。rarity 1–5 的 `ability_1..6` 与 `skill_evolution` 均按客户端
  `Option` 语义解析，`(None)` 表示无等级要求，其他值必须为正安全整数。
- `character_level.json` 按客户端双分片语义生成：普通 CDN 的
  `master/character/character_level.orderedmap` 提供 rarity 1/2，客户端 bundled master 提供 rarity 3/4/5。
  后者以 `assets/content-seeds/character_level_apk_3_5.json` 保存为紧凑、可审查的 tracked seed，记录 archive
  logical path、源 blob SHA-256、Lv80/90/100 与逐曲线摘要；Content Registry 把它作为 bundled source 传给
  converter，部署和同步不读取 APK 或工作区外的本地资源目录。
- 两个分片必须分别精确包含 1/2 和 3/4/5，跨分片重复 key 即使值相同也失败；合并后必须是 rarity 1–5
  各 1..100 级。每条曲线从累计经验 0 开始并严格递增，运行时用完整阈值二分得到精确等级，不能复用
  `characterExpCaps` 中只列每 5 级上限的兼容数据。缺 rarity、断档、非 canonical key、非安全整数、摘要漂移
  或非单调曲线一律拒绝。
- seed 更新只允许离线、人工提供已提取的 JSON 和源 blob；不读取 `wf-assets-cn`、APK 路径或运行机器上的
  固定绝对路径。校验/规范化命令为：

  ```bash
  node tools/character-level-seed.cjs \
    --input <EXTRACTED_SEED_JSON> \
    --source-blob <EXTRACTED_SOURCE_BLOB> \
    --output assets/content-seeds/character_level_apk_3_5.json
  ```

  工具固定检查 archive logical path 与源 blob SHA-256，再检查 rarity 3/4/5 各 100 个连续等级、累计经验
  单调性、Lv80/90/100 摘要和 canonical per-curve digest；任一来源、摘要或曲线漂移都不生成输出。提交前还要
  用生成后的完整 `assets/character_level.json` 校验固定 full-table digest，防止 seed 与 generated asset 一起被错误修改。
- `master/generated/mana_board.orderedmap` 的原始 bundled/release 形状保持不变。运行时只建立小型
  `character -> board -> multiplied_id -> parent` 索引；parent 必须是 `(None)` 或同角色同板节点，缺失、跨板、
  自引用与重复节点都会 fail closed，不向 19,811 行 bundled 表写入派生字段。

`character-mana-mutation-plan` 只接受上述已解析内容、目标角色/当前板和调用方提供的玩家快照。它不读 Content
全局单例、数据库或 awake 全局资产，也不执行写入。learn/awake 均按请求顺序检查 parent、精确等级、Mana 与材料；
只有请求前已学习或列表中更早学习的 parent 才可满足条件。所有费用使用安全整数逐节点模拟并聚合，输出有序节点
更新、最终 learned/awake 状态、总费用、剩余余额和客户端 node entries。

learn 拒绝重复学习并把新节点规划为 `awake_level=0`。awake 要求节点已学习，费用由调用方按节点传入；达到目标
等级的节点保留为 no-op 响应项，只有真正升级的节点产生费用和更新。全 no-op 计划以
`hasResourceWrites=false` 明确表示无需资源或节点写入。领域错误使用稳定 `ManaNodeMutationValidationError.code`，
不绑定 HTTP 状态或响应文本。

客户端来源合并证据为 `CommonLogicAssetContainer.as:203-225`：读取普通路径后追加 `bundledPaths`，再把全部路径
交给同一 master reader；`RootMasterBinary.as:110-175` 按 slice 合并 map，并在主键重复时抛错。tracked seed
只复刻该 bundled 分片，不改变普通 CDN 分片，也不把 APK 变成生产运行依赖。

29b 接入时必须从同一个 Content snapshot 构造 nodes、parent 与等级要求，并先完整生成 plan，再在单个 SQLite
事务中按 plan 扣费和写节点。路由仍负责 session/ownership、免费与付费 Mana 拆分、awake cost 选择、bond、进化、
任务事实与响应合并；这些职责不进入纯 planner。

## 已覆盖入口

### `learn_mana_node`

请求先只读校验节点、玛纳和材料余额，再在一个 SQLite 事务中完成：

1. 扣除免费/付费玛纳并累计 Active Mission 的玛纳消费事实；
2. 扣除全部节点材料；
3. 插入本次学习的全部节点；
4. 仅在满板时更新 bond token 状态；
5. 用“既有节点 + 本次节点”的最终状态计算并保存精确 `evolution_level`；
6. 按写入后的节点状态校准角色觉醒解锁，并构造响应角色列表。

节点唯一约束、外键、材料写入、角色状态或觉醒校准中的未捕获异常都会回滚上述写入。资源计算仍在事务前完成，
但计算阶段不修改数据库。

事务内的觉醒解锁发布使用 `reconcileAwakeUnlockCharacterListStrict`，数据库异常必须继续抛给外层事务；其他需要兼容
旧响应的路径仍通过 `reconcileAwakeUnlockCharacterList`（best-effort 兼容入口）记录异常并保留原角色列表。两种入口
共享同一调和 core，不会因 strict 路径复制查询或开启额外事务。

## CN 一板进化规则

字段和算法来自 CN 1.8.1 客户端，不从节点 ID 白名单或角色名单推断：

- `pinball/master/generated/ManaNodeValues.as` 把原始列 `field1=0/1` 解为 Ability/Episode；仅 Ability
  继续把 `field5=0/1/2` 解为 Ability/ActionSkillLevel/ActionSkillEvolution，且只有 Ability effect
  使用 `field6` 作为 `skill_slot_index`。
- `GeneralManaNodeLogic.getAbilitySlotIndex()` 只有 Ability effect 返回 slot；
  `isCharacterEvolutionRequisiteNodeForSkillEvolution()` 只有 ActionSkillEvolution effect 返回真。
- `GeneralCharacterLogic.getEvolutionLevelForLearnedAbilities()` 先按 node ID 的 board digit 等于 `1` 过滤，
  再检查每个实际存在的 ability slot 组是否至少学习一枚节点，以及 skill-evolution requisite 组是否至少学习
  一枚节点；不存在 requisite 时第二项自动满足。
- 两项满足时基础进化为 `1`。若存在 requisite，客户端只读取第一枚 requisite node 的 awake level；正数
  `N` 返回 `1 + N`，因此可得到 `2`、`3` 及更高等级。

对应证据位于工作区 `wf-1.8.1-cn-decompiled/scripts/pinball/` 下的
`common/data/character/GeneralCharacterLogic.as:853-981`、
`common/data/ability/GeneralManaNodeLogic.as:110-137,459-485`、`master/generated/ManaNodeValues.as`。
二板节点、普通无关节点、满板状态和 bond token 均不参与进化计算。

`mana_node.json` 继续保留原始 `field1/field5/field6` 形状，不为 19863 个节点复制派生字段。
`src/content/mana-node-semantics.ts` 是 converter 和 runtime 共用的 fail-closed 解析器：Content Sync 会拒绝未知
field，业务计算在读取当前 Content snapshot 时用同一解析器得到 slot 与 requisite 语义。

服务端始终保存精确结果，允许修正过高或过低的历史值；但响应 `evolution` 只在新等级高于请求前持久值时返回
`character_id/level/img_level`。这与 `CharacterLearnManaNodeProcessingFlow.as:90-108`、
`CharacterAwakeManaNodeProcessingFlow.as:147-154` 在应用存档后比较前后等级，以及
`EvolutionScene.as:167-199` 按新等级展示成长内容的客户端时序一致。

### `receive_bond_token`

玩家 `bond_token + 1`、对应玛纳板 token 从可领取变为已领取，以及由该状态触发的角色觉醒解锁校准共享一个
事务。任一步失败时，玩家不会凭空增加信赖证；已经领取的幂等请求仍只返回当前状态。

### `open_mana_board`

角色等级、突破数、前一板 token、板数量和官方开放期全部在任何写入前校验。兼容旧存档时需要补建的 bond
token 行，与角色 `mana_board_index` 更新处于同一个事务；索引更新失败不会留下半修复 token。

成功解放第二枚玛纳板后，服务端立即重算普通成就并将 `mission_info`、任务奖励和称号变化合并到本次角色响应；
不会要求玩家重新进入任务页面或重新登录才能看到“解放第二枚玛纳板”的完成状态。第二板的第一板条件按客户端语义
直接检查第一板全部节点，而不是只依赖信赖之证状态。

### `awake_mana_node`

路由一次批量读取玩家 learned/awake 状态并复用目标角色部分，在内存中叠加本次目标等级；玛纳、材料、Active Mission 玛纳
消费事实、节点 `awake_level` 与精确 `evolution_level` 在同一个 SQLite 事务中提交。事务后不再全量查询节点。

若请求节点都已达到目标等级，路由仍会用当前节点状态重算进化：持久值一致时走只读响应；不一致时开启事务纠正
数据库。`character_list` 立即返回相同的 `evolution_level/evolution_img_level`，等级上升时 `evolution` 返回正确的
`level/img_level`；普通节点觉醒不会提高进化等级。

### `over_limit` 与 `bulk_over_limit`

使用突破材料时，材料扣除和角色突破次数更新共享事务。重复角色自动突破会先为全部角色计算目标
`over_limit_step` 与 stack，再一次提交；任一角色更新失败时，之前的角色不会保留部分突破。

### EX 能力

`first_draw` 的材料扣除与角色 EX 能力写入共享事务，已存在能力时按持久结果响应，不重复扣料。普通 `draw` 的材料扣除与待选择结果持久化同成同败，已有候选时复用持久结果；`select` 确认时，角色能力更新与待选结果删除也处于同一事务。详细恢复与重入语义见[EX 能力抽取状态](./ex-boost.md)。

## 故障注入

`tools/character_growth_transaction.test.cjs` 使用独立 SQLite 数据库和真实 Fastify 路由，分别用 trigger 阻止：

- 学习节点的最终 INSERT；
- 信赖证领取状态 UPDATE；
- 开板索引 UPDATE。
- 道具突破和批量突破中的角色 UPDATE；
- EX 首抽与 EX 选择确认中的角色 UPDATE。

`tools/character_evolution_route.test.cjs` 另用真实 Fastify + SQLite 覆盖未满板进化、节点 awake 后的 2/3 级结果、
no-op 权威纠正、bond token 列表保持，以及在 evolution UPDATE 处注入晚失败后的节点、费用、bond/evolution
整体回滚。

这些请求都必须返回失败，且请求前后的玩家货币、材料、角色、bond token 和节点快照完全一致。该测试验证的是
数据库原子性，不替代客户端对动画、提示、玛纳板显示与觉醒页面切换的人工验收。
