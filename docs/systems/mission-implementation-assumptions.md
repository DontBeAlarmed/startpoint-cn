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

## 称号指定 Boss 超级难度

- 13 条 `degree_boss_battle_ex_clear_single_*` 可以由主数据的 stage group + difficulty 与 `boss_battle_quest.json` 精确闭合，服务端只接受对应 category 2 关卡的 `finished=1` 记录。
- `11080`（大蛇）主数据要求 difficulty `4`，但官方表中该 stage group 只有 difficulty `1..3`。当前不把现有最高难度 3 推测为目标 4，保持持久化 fallback；如果后续 CDN 补齐 difficulty 4，才会自动进入计算路径。

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

## 审阅方式

审阅时优先检查：

1. 官方 CDN 生成表中的 `unresolved` 是否只包含确实缺少或无法解码的程序；
2. 主位、连携角色、排除角色同时存在时的客户端进度；
3. 在任务前置完成前进行符合条件的战斗，随后进入任务页时是否应计入历史事实。
