# 任务维度覆盖进度

最后更新：2026-07-05

## 当前结论

任务系统已经有可用的基础框架：按分类构建 `MissionComputer`，按奖励表计算阶段阈值，`mission/get_mission_progress` 能返回进度并发放奖励。每日任务和角色觉醒任务的主流程已经可跑，但“所有任务按维度监听并自动统计”还没有完成。

如果按维度实现，方向是正确的，但不能只靠一个大维度表直接适配所有任务。原因是同一个维度在不同任务分类下有不同的作用域、过滤条件和重置周期，例如每日任务需要按天归零，角色觉醒任务是角色维度的长期累计，活动任务还需要按 event/stage_group/quest_category 过滤。

## 已完成的管线

| 管线 | 状态 | 说明 |
| --- | --- | --- |
| 阶段阈值解析 | 已对齐主要分类 | regular/daily/event/degree/weekly 读 `target_progress` 第 1 列，collect 读第 2 列，awake 读第 5 列 |
| 奖励解析 | 基本可用 | active/regular/daily/event/degree/collect/weekly/awake 都有分类入口，`Stone(kind=0)` 不再被跳过 |
| 每日任务发奖 | 已修复 | 每日任务通过 `get_mission_progress` 自动标记阶段并返回 `user_info/item_list` |
| 角色觉醒发奖 | 已修复主要缺口 | 角色觉醒奖励按客户端 4 槽结构解析，仍走进度接口自动完成 |
| 分类计算器 | 部分完成 | regular/daily/event/degree/awake 有计算器，collect/weekly 仍主要依赖 DB progress |
| 客户端回传进度 | 已保留 | `mission/update_mission_progress` 仍能按 pattern 写入 DB，适合暂时承接未服务端化的维度 |

## 维度覆盖现状

| 维度 | 当前覆盖 | 缺口 |
| --- | --- | --- |
| 完成普通战斗/单人战斗次数 | 部分完成 | daily/regular 使用总通关差值，未完整使用 battle kind、quest category、具体 quest filter |
| 通关协力战斗 | 部分完成 | multi finish 会累加 `multi_clear_count`，event 任务可读；daily 多人任务多数仍依赖客户端 pattern 回传或 DB progress |
| 通关指定活动/降临/讨伐任务 | 部分完成 | event 任务有 `mission_event_quest_map.json`；daily/awake 仍有硬编码或未通用化的指定关卡映射 |
| 使用 X 角色/队长/队伍组合 | 角色觉醒部分完成 | awake 有角色出场、队长、共斗、同队 pair、种族组合追踪；尚未抽象为通用 battle-client-check 维度 |
| 使用冲刺/强化弹射/技能等战斗统计 | 部分完成 | powerflip/dash 全局计数存在，awake 使用部分 powerflip；daily `use_dash/use_skill` 尚未完全服务端计算 |
| 每日 all-clear 依赖任务 | 已完成当前范围 | daily `target_mission_clear` 会按依赖任务完成数量计算，并过滤自依赖 |
| 体力消耗 | 已完成当前范围 | daily/weekly 可基于 snapshot 计算周期差值；weekly 发奖仍未启用 |
| 玩家等级/称号等级 | 部分完成 | degree 计算器可按 rankPoint 计算等级；称号奖励类型 `Degree(kind=6)` 仍未完整落库 |
| 物品、装备、商店、抽卡、社交、UI 行为 | 大多未完成 | 目前主要依赖客户端 `update_mission_progress` 或其他业务接口零散更新，没有统一维度监听 |
| 成就任务/周常任务 | 未纳入本轮 | 周常重置 snapshot 存在，但周常计算和奖励策略仍需要单独实现 |

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

1. 先做统一 `MissionProgressEvent` 和维度计数表，不直接扩展更多硬编码 missionId。
2. 把 battle finish 事件拆出维度：quest clear、multi clear、host/guest、party character、leader character、battle statistics。
3. 把 daily 的 `use_dash/use_skill/multi_battle_play` 从 DB progress/client 回传迁移到服务端维度计数。
4. 再处理 weekly 和 achievements，因为它们主要是 scope 和覆盖面问题，不是奖励管线问题。
5. 最后补 Degree/PassCardPoint 等非物品奖励 side effect。
