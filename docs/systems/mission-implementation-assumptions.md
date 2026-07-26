# 任务模块待审阅实现记录

本文只记录当前实现中尚未被客户端流程或完整协议闭环证明的边界。它不把推测写成官方行为；遇到下列情况，服务端优先保持 fail closed。

## Active Mission 20015/20016

- Action DSL 中无法读取或解码的技能程序不会生成角色效果索引。当前已知 `alk_1`、`alk_2`、`alk_3` 属于此类，影响角色 `1`、`700009`、`700010`；它们写入 `unresolved`，不影响其他角色索引。
- `action_effects` 按逗号分隔的 OR 条件匹配；`effects_ignore_character` 只排除指定候选角色，不排除整支队伍。这一解释有主数据和客户端枚举支持，但仍应由客户端任务流程复核。
- 结算请求中的队伍是客户端提交值，当前服务端未保存 Active Quest 开始时的队伍快照。20015/20016 因此沿用现有 finish 请求事实边界；如果以后需要防止客户端伪造，必须先增加开局队伍持久化或服务端一致性校验。
- 当前事实生产器会在成功结算时记录已识别的 mission-specific 事实，再由前置任务和开放期决定展示与领取。客户端反编译资料不能证明“任务尚未开放时是否允许预累计”；如果实测要求严格按开放时刻计数，应在同一事务中增加可用性过滤。

## Content fallback

`assets/cdndata/active_mission_skill_effects.json` 是空结构兼容 fallback，不包含推测角色效果。未执行 Content Sync 或当前 Release 不含该表时，20015/20016 不推进；官方 CDN 同步成功后才使用动态生成的索引。

## 称号 type 48：第二玛纳板

- 角色称号的目标角色使用 `mission_degree` 的 `row[15]`，不根据 mission ID 或中文名称推测。重复角色、不同版本角色和联动角色因此各自按主数据指定的角色 ID 判断。
- “第二枚玛纳板全部强化完成”被解释为：该角色在 `mana_board.json` 的 `board_index=2` 中定义的全部节点 ID，都出现在玩家的 `players_characters_mana_nodes` 中。这里统计的是节点已强化/解锁状态，不把 bond token、觉醒等级或 `mana_board_index` 字段当作替代证据。
- 全局 `degree_manaboard_all_growth_*` 只统计能在同一份 `mana_board.json` 中确认属于第二板的已强化节点；未知角色、缺失第二板、空表和格式异常均不计入。已有数据库进度仍取最大值，避免旧存档因内容缺失倒退。
- 运行时优先读取启动时固定的 Content snapshot；直接调用且 snapshot 尚未初始化时才回退到仓库内 bundled `assets/mana_board.json`。这只是兼容旧调用路径，不会在已初始化的 Release 上叠加两份表。
- 当前未有客户端逐条验证“强化”的中文显示是否还包含其他状态，也没有证明出售角色后服务端应重新计算还是只保留历史完成；实现按已持久化进度取最大值处理，相关边界留待审阅。

## category 3：关卡目标任务

- 土俑嘉年华单关卡使用 `mission_event.json` 的 `event_id + quest suffix` 与 `carnival_event_quest.json` 的精确关卡 ID
  对齐；聚合任务只引用同一活动的子任务 ID。当前实现不使用旧 `mission_event_quest_map.json` 对土俑关卡的宽泛集合。
- 崩坏域庆贺单关卡使用 `challenge_dungeon_event_quest.json` 中的真实关卡键；`row[10]` 为空时表示该挑战事件表的全部关卡，
  非空时按 `event_id * 1000 + suffix` 精确定位。聚合任务只在所有子任务都有可证明关卡来源时启用。
- 这批规则仍依赖 `players_quest_progress.finished` 的历史最佳记录。数据库没有单次战斗时间线，因此没有把“必须在活动开放期内完成”
  作为额外条件；关卡 ID 本身必须由官方 CDN 表确认存在。客户端战斗检查、评级、Attention 救援和无法从表闭合的活动任务继续 fallback。
- 188 条 category 11 竞速任务只在 type 15、QuestRange kind 8、`event_id * 1000 + quest suffix`、
  `ranking_event_single_quest.json` 和唯一旧映射全部指向同一关卡时启用。目标时间取官方 `mission_event_reward.json`
  的奖励阶段秒数，玩家必须已有成功通关且历史最佳毫秒值不超过该阈值。
- category 24 的 42 条狂热激战限时任务不再使用旧映射。旧映射会把“第 N 战”扩展为同一期全部 8 个关卡，例如
  mission `700012` 的映射包含 `700002001` 至 `700002008`；当前改为按 QuestRange kind 17、`event_id * 1000 + suffix` 和
  `rush_event_quest.rushEventId` 精确闭合，只读取 category 24 对应单关的历史最佳时间。
- 历史最佳时间来自客户端 finish 请求并由服务端保存；服务端不模拟战斗或重算计时。这一事实链保证协议闭合，
  不提供反作弊证明，也不能证明活动开放前完成的历史记录是否应计入。
- 257 条 type 23 累计通关任务只覆盖 Advent、StoryEventSingle、ChallengeDungeon、Raid 和 Rush 五种可由官方表闭合的 QuestRange。battle kind 1 只累计单人成功，battle kind 3 同时累计单人和多人成功；每次合法 finish 增加 1，历史唯一完成记录不用于反推重复次数。
- Ranking Phase 29 条任务以成功单人 finish 的 `statistics.clear_phase` 为事实。当前反编译协议能确认字段与主数据 pattern 的阶段语义，但服务端不会重演战斗来验证客户端提交值；多人、非整数、0、5 及错误关卡均不推进。该协议边界需后续 CN 客户端样本验收。

## 称号指定 Boss 超级难度

- 13 条 `degree_boss_battle_ex_clear_single_*` 可以由主数据的 stage group + difficulty 与 `boss_battle_quest.json` 精确闭合，服务端只接受对应 category 2 关卡的 `finished=1` 记录。
- `11080`（大蛇）主数据要求 difficulty `4`，但官方表中该 stage group 只有 difficulty `1..3`。当前不把现有最高难度 3 推测为目标 4，保持持久化 fallback；如果后续 CDN 补齐 difficulty 4，才会自动进入计算路径。

## 称号 ExpertSingle 精确单关

- `57010` 至 `57120` 共 12 条只在 type 14、QuestRange kind 14、event ID 1 和 suffix 1 至 12 精确闭合时启用；目标关卡 `1001` 至 `1012` 必须存在于当前 Content snapshot 的 `expert_single_event_quest.json`。
- 玩家事实只读取 category 21 的 `players_quest_progress.finished=1`。其他 category 中相同 quest ID、未完成记录和缺失关卡均不计入，已有持久化进度仍取最大值。
- 该族奖励目标均为 1，因此历史唯一通关记录足够证明完成；没有用它推算重复通关次数或活动开放期内的时间线。
- 同一精确闭合规则也用于 27 条 QuestRange kind 9 的 WorldStory 任务和 1 条 QuestRange kind 5 的 Advent 任务；它们分别只读取 category 18 与 category 7 的完成记录，并要求目标存在于对应官方关卡表。
- 27 条 Carnival 与 6 条 HardMulti 的 type 23 称号奖励目标均为 1；服务端分别按 QuestRange kind 15/19、官方关卡表和 category 22/26 的唯一完成记录判断。它们不用于推算同类累计通关称号。
- `70000/70010` 两条 type 37 称号从主数据 `row[13]` 读取物品 `70014/70048`，并使用 `players_collected_items.total_obtained`。消费物品不会降低进度；累计事实表出现前的历史和存档导入缺失仍不猜测回填。
- `43000/43010/43020` 三条 type 36 称号只统计能在当前 `equipment_dissolve.json` 取得正整数 `max_level`、且玩家 `level >= max_level` 的装备记录。缺失主数据的装备不使用默认等级猜测，装备 stack 也不展开为多件。

## 称号挑战副本累计通关

- `10000/10010/10020` 的 pattern 分别要求 100、500、3000 次挑战副本成功通关。服务端按 CN 关卡类别枚举将挑战副本识别为 category 13，并在成功 finish 事务中增加独立的 `challenge_dungeon_clear_count`。
- 该计数不从 `players_quest_progress` 的唯一关卡行数反推，因此重复挑战同一关会正确累计；失败、普通关卡和事务回滚不会增加。
- 当前数据库迁移会为旧的 `players_mission_battle_counters` 表补列，但既有存档替换/导入格式没有该事实表。由于本项目暂不扩展数据库导入导出，替换后无法恢复这项新增历史事实；服务端不会根据库存或关卡快照猜测回填。

## 称号单人最高分

- `14000/14010/14020` 的阈值来自官方 `mission_degree` 描述，分别为 10000000、50000000、99999999；没有从相邻称号或客户端动画推测阈值。
- 服务端仅保存成功单人 finish 请求中的 `score` 最大值。协力战斗、失败结算、负数、非安全整数和缺失字段均不更新 `single_score_max`。
- `score` 是 CN 客户端提交的战斗统计字段，当前服务端没有战斗模拟或独立伤害/分数重算。该实现可支持官方客户端的协议流程，但数值真实性仍依赖客户端，不能当作反作弊校验。
- 旧数据库启动会补充 `single_score_max` 列；现有存档替换/导入不包含这张事实表，本任务不扩展数据库导入导出，也不会用关卡历史最佳分数猜测回填。

## 称号单人限时通关

- `15000/15010/15020` 的阈值来自官方 `mission_degree` 描述，分别为 60、10、5 秒；服务端换算为毫秒并保存成功单人 finish 的最短有效 `elapsed_time_ms`。
- 缺失、零值、负数、非安全整数、失败结算和协力结算均不更新 `single_clear_time_min`。已保存的最短时间只用于达成 0/1 称号，不从每关历史最佳记录猜测未记录的全局最快时间。
- `elapsed_time_ms` 来自官方客户端 finish 请求，当前服务端不重放战斗或独立校验计时；该事实链适用于协议兼容，不等价于反作弊验证。
- 旧数据库启动会补充 `single_clear_time_min` 列；现有存档替换/导入不包含这张事实表，本任务不扩展数据库导入导出。

## 称号领主战累计通关

- `30000/30010/30020` 的阈值来自官方 `mission_degree` 描述，分别为 10、500、5000 次。服务端按 `questCategory=2` 识别 CN 领主战，并在单人或协力成功 finish 中增加 `boss_battle_clear_count`。
- 该计数不依赖某个领主关卡的唯一 `players_quest_progress` 记录，因此重复挑战同一关仍会累计；失败、其他 category 和事务回滚不会增加。
- 该规则不区分单人/协力，因为主数据没有附加 battle kind 条件；若客户端实际只展示其中一种模式，需要以协议验收结果再缩小范围。

## 称号累计获得锻造石

- `41000/41010/41020` 使用当前配置的 `craft_point_item_id`，官方 CN 1.4.54 值为 `100000`。服务端读取 `players_collected_items.total_obtained`，不把当前库存当作累计获得量。
- 正常出售装备等发放路径通过 `givePlayerItemSync` 同步写入库存和累计获得事实，消费锻造石不会降低称号进度；其他物品 ID 不计入。
- schema 引入累计物品表之前的历史获得量无法回填，存档替换/导入也不包含该事实表。本任务继续保留这项既有边界，不根据当前库存猜测历史。

## 称号累计使用技能

- `33000/33010/33020` 的奖励阶段目标为 100、1000、10000 次。服务端在成功 finish 中汇总 `statistics.zones[].use_skill_count` 并累加到独立事实；单人和协力均计入，符合主数据 battle kind `3`。
- zone 缺失该字段按 0 处理；任一值为负数、非整数或累计溢出时，整场技能使用事实按 0 处理。失败结算不计入。
- 该统计来自官方客户端 finish 请求，服务端没有独立战斗模拟来重算技能使用次数；实现保证协议字段和事务边界，不提供反作弊证明。
- 旧数据库启动会补充 `skill_use_count` 列；既有存档替换/导入不携带该事实表，本任务不扩展数据库导入导出。

## 审阅方式

审阅时优先检查：

1. 官方 CDN 生成表中的 `unresolved` 是否只包含确实缺少或无法解码的程序；
2. 主位、连携角色、排除角色同时存在时的客户端进度；
3. 在任务前置完成前进行符合条件的战斗，随后进入任务页时是否应计入历史事实。
