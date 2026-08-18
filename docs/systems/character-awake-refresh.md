# 角色觉醒页面刷新与解锁时序

## 客户端行为

CN 1.8.1 客户端在 `CharacterAwakeScene.preparation()` 中读取并缓存
`mana_board_awake[1]`：

- 缓存值为 `0` 时，场景默认进入第一页并禁用第二页；
- 缓存值大于 `0` 时，场景默认进入第二页，并将该值作为目标觉醒等级。

这里的键 `1` 指第一块玛纳板。`mana_board_awake[1] > 0` 会让客户端把一板切换为 Awake 状态，从而进入
三板（觉醒板）流程；它不表示第二块玛纳板必须先学习或完成。

`afterTransition()` 会根据初始页签决定是否请求任务。未解锁角色进入第一页后，客户端自动通过
`MissionGetProgressProcessingFlow` 请求 category 9 的
`mission/get_mission_progress`；已经解锁、直接进入第二页时不会自动请求任务。

玩家之后手动切回第一页时，`tabChanged(1)` 会在当前场景尚未请求过任务列表的前提下发起同一请求。
该处理流只刷新任务列表，不会重新计算场景已缓存的 `boardAwakeLevel`，也不会在当前场景内动态启用第二页。

所有 API 响应都可以携带公共字段 `character_list`。`RealRemoteService` 会先处理公共响应，
`PlayerLogic.applyCommonResponseCharacterList()` 再把 `mana_board_awake` 写入客户端持有的角色状态，
之后才进入端点自己的处理流。

## 服务端最终流程

觉醒板解锁与任务奖励领取是两份独立的持久状态：

- `players_character_awake_unlocks` 保存第二页的持久解锁；
- `players_category_mission_stages.status` 保存 category 9 各阶段是否已经领奖。

官方入口资格必须同时满足：category 9 对应活动开放、玩家持有角色、角色达到当前稀有度的基础等级上限、
第一块玛纳板的全部节点已经学习；不要求第二块玛纳板。

基础资格使用 `ready / not-ready / unknown` 三态：角色主数据缺失，或第一块玛纳板主数据缺失、为空时为
`unknown`；角色未持有、基础等级不足或已知的一板未全学时为 `not-ready`。`unknown` 与 `not-ready` 都会
fail closed，阻止显示任务、结算奖励或创建新解锁。

每个 player 请求创建一次 eligibility resolver。resolver 一次批量读取 `getPlayerCharactersSync`、
`getPlayerCharactersManaNodesSync` 与节点觉醒等级，按角色缓存基础资格和 asset 读取。任务摘要、category 9
请求过滤、领奖结算、显式进度恢复和所有业务端点解锁校准复用同一 resolver。单角色 category 9 请求会先按
`requestEntry.character_id` 缩小任务 ID，再执行 eligibility，不评估其他角色任务。

### 任务尚未全部完成

1. 角色没有持久解锁，首次进入默认显示第一页，第二页保持禁用。
2. `afterTransition()` 自动请求 category 9 的 `get_mission_progress`。
3. 服务端结算当前已经完成且尚未领取的阶段，返回 `mission_info`、奖励变更集合和任务进度。
4. 因最终特殊阶段尚未完成，响应不会解锁第二页。

### 任务已经全部完成

1. 使最终条件成立的权威状态变更端点会先计算觉醒任务，并幂等写入持久解锁。
2. 只有该次写入确实新建或提高了解锁等级时，端点才通过
   `character_list.mana_board_awake` 发布角色变化。
3. 此过程不写领奖状态，也不发放普通奖励；category 9 的奖励仍全部保持未领取。
4. 客户端第一次进入觉醒场景时已经持有正数解锁等级，因此直接显示第二页。
5. 玩家手动切回第一页后，`tabChanged(1)` 发起 `get_mission_progress`，服务端一次结算全部未领奖励并返回
   `mission_info`，但不会再次发布已经存在的解锁条目。
6. 重复切换页签、重复请求或再次进入都不会重复发奖，也不会重复返回 `mission_info`。

四条任务全部完成时，普通奖励可以仍未领取；持久三板解锁与 `character_list.mana_board_awake` 的发布不等待
普通奖励领取。若最后一个入口条件是学习一板最后节点，`learn_mana_node` 会先写入节点，再在同一响应内校准
解锁；合并逻辑保留该角色条目已有的进化、信赖证等字段，同时加入 `mana_board_awake`。

`mission/update_mission_progress` 只累计客户端上报的任务增量，不执行奖励结算，也不调用
`computeAwakeSummary`。写入进度后它会调用 `reconcileAwakeUnlockCharacterList`，因此若该权威增量刚好完成最终条件，
可以在同一响应中发布新的持久解锁。

当前所有调用 `reconcileAwakeUnlockCharacterList` 的业务入口都会在状态落库后执行校准，覆盖：单人和多人战斗结算、剧情结算、普通与兑换抽卡、BoxGacha、星粒 exchange、商店购买、城镇或角色获得、教程步骤 15/16、邮件领取、物品出售、信赖证领取、任务进度更新和 Active Mission 领奖。新增角色来源或新增觉醒条件时必须重新反向审计调用点，不能假定未来端点会自动覆盖。
`/load` 会对持有角色执行同样的持久化校准，并把持久解锁与已经觉醒的节点等级按每块板的最大值合并序列化。

底层共享战斗事实、终身统计等可以在满足官方入口资格之前累计，并在资格满足后参与计算。这是服务端兼容旧
存档和历史行为的策略，不应写成已经由客户端反编译或实机证明的官方行为。`update_mission_progress` 可以先写入
兼容事实，但同一响应中的新解锁校准仍使用资格 helper；任务显示和领奖同样不会绕过资格。

## 异常恢复边界

解锁状态和领取记录可能因旧版本迁移、异常中断或人工修改出现不一致。恢复只补齐可从权威进度推导出的解锁状态，不反向重放已经登记的奖励。

校准还会清理旧版本错误创建的解锁，但边界严格限定为：基础资格可确认是 `not-ready`，且该角色不存在任何
`awake_level > 0` 的节点。`unknown` 主数据状态只阻止新解锁，不触发清理。活动关闭也不是删除条件；仅因
活动过期不得移除已经存在的解锁。只要存在正数节点觉醒进度，即使角色等级或一板状态异常，也保留解锁，
避免把已经进入实际觉醒流程的存档降级。

清理产生的业务响应必须返回对应角色，并以 `mana_board_awake: {}` 权威覆盖客户端旧解锁，不能与旧值做
最大值合并。既有角色条目的进化、信赖证等字段保持不变；没有既有条目时返回最小角色更新。`/load` 则继续
读取调和后的 `all`，与真实节点觉醒等级按板取最大值后发布完整状态。

| 解锁行 | 最终特殊阶段 | 处理方式 |
|---|---|---|
| 存在 | 未领奖 | 第二页保持解锁；玩家手动回第一页后正常结算一次 |
| 存在 | 已领奖 | 正常完成状态；重复请求不发奖、不返回重复提示 |
| 缺失 | 未领奖 | category 9 结算可在同一事务内补写解锁，再完成首次领奖 |
| 缺失 | 已领奖 | `/load` 根据权威进度补写解锁；不得删除领取记录或重放奖励 |

数据库升级可以根据历史已领取的 `AwakeManaBoard` 阶段回填解锁行，但迁移不重新计算全部任务、不发奖。运行时 `/load` 会重新计算已持有角色的觉醒任务进度并校准解锁行，只序列化校准后的完整状态，不写领取记录、不生成 `mission_info`、不发放奖励。

普通业务端点在权威状态落库后调用增量校准。若增量响应协调失败，服务端记录错误并保留已经成功的主业务结果；这只可能延迟当前响应中的解锁提示，后续 `/load` 可以恢复。`/load` 自身的校准失败不得静默吞掉，否则客户端会收到看似完整但已经过期的玩家状态。

### 最终特殊阶段未领奖

旧存档或异常存档可能已经完成最终特殊阶段、该阶段仍未领奖，却缺少
`players_character_awake_unlocks` 行。category 9 结算在首次处理这个未领奖的
`AwakeManaBoard` 特殊阶段时，会在同一事务内执行幂等 UPSERT：

- UPSERT 本次改变状态时，写入持久解锁，并在 `character_list` 中发布一次；
- 持久解锁已存在且等级不低时，只处理领奖状态、普通奖励和 `mission_info`，不重复发布角色条目；
- 领奖状态已存在时，重复结算不再发奖、不再返回 `mission_info`，也不再发布解锁。

如果最终特殊阶段已经存在领奖状态，但持久解锁行后来丢失，结算逻辑会按幂等规则跳过该阶段，
不会再次执行特殊奖励或重发角色条目。此类存档由 `/load` 的觉醒任务校准修复；数据库版本升级时，
也会通过已领取的 `AwakeManaBoard` 阶段执行回填。

任何恢复路径都必须遵守以下不变量：解锁等级只升不降；领取记录只由真实领奖事务写入；重复完成动作、重复 `/load`、重复第一页请求和重复节点觉醒请求都不能复制奖励。

正常流程不再要求玩家退出后重进才能解锁第二页：最终权威端点会在场景创建前把解锁发送给客户端。
只有最终端点响应丢失、客户端仍持有旧缓存这类异常情况，当前已创建场景才无法原地启用第二页。
可靠的客户端恢复方式是重新执行 `/load`，通常通过重新登录触发；单纯再次进入觉醒场景不保证刷新角色缓存。

## 服务端校验

`/character/awake_mana_node` 使用持久解锁校验请求，不依赖 category 9 是否已经领奖。
请求还必须满足目标等级一致、基础板全部学习、请求节点均属于板 1、节点列表非空且无重复等条件。
玛纳、物品、节点觉醒等级与由最终节点 awake map 计算出的角色进化等级在同一个 SQLite 事务中提交；事务后
不重新查询全量节点。请求节点已全部达到目标等级时仍重算进化，只有持久值已经一致才走纯只读 fast path；需要
纠正时会写回，并在等级上升时通过 `character_list` 与 `evolution` 立即触发客户端 `EvolutionScene`。

## 数据库存储与存档兼容

核心状态分布在五类表/字段：`players_characters.exp` 表示基础等级，
`players_characters_mana_nodes(value, awake_level)` 表示已学习节点及节点觉醒等级，
`players_character_awake_unlocks(character_id, board_index, awake_level)` 表示持久三板解锁，
`players_category_missions(category, id, progress)` 表示 category 9 任务进度，
`players_category_mission_stages(category, mission_id, id, status)` 表示奖励阶段领取状态。

服务器 `MergedPlayerData` JSON 使用可选字段 `characterAwakeUnlocks` 和
`characterManaNodeAwakeLevels` 保存后两类觉醒状态。新存档导出/导入 roundtrip 会完整保留；旧存档缺少任一
字段时仍可载入，缺失解锁按空集合处理，已学习节点的缺失觉醒等级按 `0` 处理。导入节点觉醒等级只更新
`characterManaNodeList` 已创建的节点；未知角色或节点 ID 会明确拒绝导入并回滚整个 replace transaction，
不会静默忽略或部分替换原存档。两类字段都要求 plain object，ID 与等级必须是对应范围内的 safe integer。
