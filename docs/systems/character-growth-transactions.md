# 角色养成事务边界

角色养成接口常同时写玩家货币、材料、角色状态、节点和任务事实。一次请求的业务结果必须同成同败；不能在
最后一步失败后留下已扣资源，也不能先发放信赖证再让领取状态保持未领取。

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
