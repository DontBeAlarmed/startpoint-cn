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

## 审阅方式

审阅时优先检查：

1. 官方 CDN 生成表中的 `unresolved` 是否只包含确实缺少或无法解码的程序；
2. 主位、连携角色、排除角色同时存在时的客户端进度；
3. 在任务前置完成前进行符合条件的战斗，随后进入任务页时是否应计入历史事实。
