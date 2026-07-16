# 任务维度覆盖进度

最后更新：2026-07-16

## 当前结论

任务系统已经有可用的基础框架：按分类构建 `MissionComputer`，按奖励表计算阶段阈值，`mission/get_mission_progress` 能返回进度并发放奖励。每日任务和角色觉醒任务的主流程已经可跑，第一批维度化切片也已经实现；但“所有任务按维度监听并自动统计”还没有完成，成就任务和周常任务仍是后续范围。

如果按维度实现，方向是正确的，但不能只靠一个大维度表直接适配所有任务。原因是同一个维度在不同任务分类下有不同的作用域、过滤条件和重置周期，例如每日任务需要按天归零，角色觉醒任务是角色维度的长期累计，活动任务还需要按 event/stage_group/quest_category 过滤。本轮先把未带过滤条件的 daily battle/stat 行接到服务端 counter evaluator；unsupported 或带过滤条件的行继续保留 DB/client fallback。

## 已完成的管线

| 管线 | 状态 | 说明 |
| --- | --- | --- |
| 阶段阈值解析 | 已对齐主要分类 | regular/daily/event/degree/weekly 读 `target_progress` 第 1 列，collect 读第 2 列，awake 读第 5 列 |
| 奖励解析 | 基本可用 | active/regular/daily/event/degree/collect/weekly/awake 都有分类入口，`Stone(kind=0)` 不再被跳过；Degree/Weekly 暂不自动发放 |
| 每日任务发奖 | 已修复 | 仅评估 `enable_start_time <= now <= enable_end_time` 的任务，并通过 `get_mission_progress` 返回 `user_info/item_list` |
| 奖励安全 | 已加固 | CollectItemEvent 必须匹配请求 `event_id`；`active_mission/receive` 先验证活跃任务、完成阶段并去重，再在事务内发奖 |
| 角色觉醒发奖 | 已修复主要缺口 | 角色觉醒奖励按客户端 4 槽结构解析，仍走进度接口自动完成 |
| 分类计算器 | 第一批已接入 | regular/daily/event/degree/awake 有计算器；daily 的 single/multi/battle clear 与 dash/powerflip/skill 可由服务端 counter evaluator 读取，collect/weekly 仍主要依赖 DB progress |
| 客户端回传进度 | 已保留 | `mission/update_mission_progress` 仍能按 pattern 写入 DB；unsupported 或 filtered 行继续走 DB/client fallback，适合暂时承接未服务端化的维度 |

## 维度覆盖现状

| 维度 | 当前覆盖 | 缺口 |
| --- | --- | --- |
| 完成普通战斗/单人战斗次数 | 第一批已接入 | daily 无过滤 single/battle clear 行可读服务端 counter delta；带 battle kind、quest category、具体 quest filter 的行仍回退到 DB/client progress |
| 通关协力战斗 | 第一批已接入 | daily 无过滤 multi clear 行可读服务端 counter delta；带活动或关卡过滤的多人任务仍回退到 DB/client progress |
| 通关指定活动/降临/讨伐任务 | 部分完成 | event 任务有 `mission_event_quest_map.json`；daily/awake 仍有硬编码或未通用化的指定关卡映射 |
| 使用 X 角色/队长/队伍组合 | 角色觉醒部分完成 | awake 有角色出场、队长、共斗、同队 pair、种族组合追踪；尚未抽象为通用 battle-client-check 维度 |
| 使用冲刺/强化弹射/技能等战斗统计 | 第一批已接入 | daily 无过滤 `use_dash/use_power_flip/use_skill` 行可读服务端 counter delta；filtered 行保留 DB/client fallback |
| 每日 all-clear 依赖任务 | 已完成当前范围 | daily `target_mission_clear` 会按依赖任务完成数量计算，并过滤自依赖 |
| 体力消耗 | 已完成当前范围 | daily/weekly 可基于 snapshot 计算周期差值；weekly 发奖仍未启用 |
| 玩家等级/称号等级 | 部分完成 | degree 计算器可按 rankPoint 计算等级；称号奖励类型 `Degree(kind=6)` 仍未完整落库 |
| 物品、装备、商店、抽卡、社交、UI 行为 | 大多未完成 | 目前主要依赖客户端 `update_mission_progress` 或其他业务接口零散更新，没有统一维度监听 |
| 成就任务/周常任务 | 未纳入本轮 | 周常重置 snapshot 存在，但周常计算和奖励策略仍需要单独实现 |

### 角色觉醒计数迁移保护

battle finish 结算现在会双写角色出场、战斗次数、协力通关、种族组合等计数器，这些计数对后续 awake 迁移有用，但角色觉醒任务的用户可见进度暂时仍以 legacy progress 表为权威来源。原因是这些新计数器只会从部署时间点开始累计，而旧存档已经在 legacy 表里保留了历史觉醒进度；如果直接把用户可见进度切到计数器，会让既有玩家倒退。迁移前需要先做历史回填，或在评估时加入 legacy-floor，把 legacy 历史值作为新计数器的最低进度。

## 是否能靠“维度化”适配所有任务

可以覆盖大多数任务，但不是“只实现维度就自动适配全部”。完整方案至少需要三层：

| 层 | 职责 |
| --- | --- |
| 事件监听层 | 从战斗结算、角色养成、装备、商店、抽卡、邮件、UI 行为等入口发出统一事件 |
| 维度计数层 | 按 scope 写入计数器，例如 lifetime、daily、weekly、event、character、quest |
| 任务评估层 | 读取 CDN 任务定义，把任务参数转换为维度查询条件，再算 progress/stage/reward |

只做维度计数不够，因为任务定义里还有分类语义、重置周期、活动过滤、角色过滤、依赖任务、领取策略、特殊奖励等差异。

## 维度是否需要继续细分

需要继续细分，但不要按“每日任务一套、角色觉醒一套”复制监听器。推荐按数据来源和作用域拆：

| 维度拆分 | 建议 |
| --- | --- |
| 战斗结果维度 | 拆成 battle clear、quest filter、battle mode、host/guest/MVP、elapsed time、rank、party constraint、battle statistics |
| 角色维度 | 拆成 any position、leader only、specific character、specific characters、race composition、mana board/bond state |
| 周期维度 | daily/weekly/event 不要共用同一个裸计数，必须带 scope 和 snapshot/reset 语义 |
| 任务依赖维度 | target_mission_clear 单独做 evaluator，不要伪装成普通计数器 |
| 奖励维度 | reward parser 可复用，但发放 side effect 要按 kind 独立处理，尤其 Degree/PassCardPoint 不能混进 item/mana |

每日任务和角色觉醒任务不需要隔离“监听事件”，但需要隔离“计数作用域”和“评估规则”：

| 分类 | 监听是否复用 | 计数/评估是否隔离 | 原因 |
| --- | --- | --- | --- |
| 每日任务 | 复用战斗/体力/抽卡等监听 | 需要隔离 daily scope | 每日重置，依赖任务和活动日课会频繁变化 |
| 角色觉醒任务 | 复用战斗/角色/队伍监听 | 需要隔离 character/lifetime scope | 角色维度长期累计，还影响 mana board awake 状态 |

## 下一步实现建议

1. 在现有 `MissionProgressEvent`、维度计数和 battle finish 双写基础上，继续补充更细的 scope 与查询条件，避免回到按 missionId 硬编码扩展。
2. 扩展服务端 evaluator，把带 quest/event/filter 的 daily battle/stat 行逐步迁移到更细的维度查询；未覆盖前继续保留 DB progress/client fallback。
3. 后续再处理 weekly 和 achievements 的 scope、重置与发奖策略，它们仍不属于当前第一批覆盖。
4. 最后补 Degree/PassCardPoint 等非物品奖励 side effect。
