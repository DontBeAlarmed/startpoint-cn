# 任务模块优先补全完成情况

本文记录角色觉醒、每日、每周与首批简单称号的补全结果和后续验收边界。实现坚持“只有权威事实才能自动完成任务”，不根据文案或相邻任务猜测。

## 当前基线

| 分类 | 主数据定义 | 当前自动计算 | 当前状态 |
|---|---:|---:|---|
| 角色觉醒（category 9） | 144 | 144/144；其中 55 条使用经主数据审计的通用角色通关回退 | 核心流程已通过客户端；144 条条件待逐条客户端验收 |
| 每日（category 2） | 历史总表 656 | 默认服务器时间下开放 11 条，当前 11/11 | 常驻 5 条与活动 6 条均已自动计算，不宣称支持全部历史定义 |
| 每周（category 10） | 2 | 2/2 | 服务端已实现，待 CN 客户端跨周完整验收 |
| 称号（category 5） | 1288 | 1042，约 80.9% | 新增领主战累计通关、单人最高分、单人限时通关、挑战副本累计通关、第二玛纳板、累计体力、累计登录、章节全通、练习关卡 SS、珍品商店购买和指定 Boss 超级难度条件族；unsupported 246 条继续持久化 fallback |

历史活动每日不作为当前体验的完成率分母。本轮只处理默认服务器时间 `2024-08-14` 下客户端会显示的任务，不把 656 条历史定义一次性全部启用或宣称全部支持。

## 角色觉醒

### QuestRange 语义

以下四条任务已改为显式 QuestRange，不再回退为“携带角色通关任意关卡”：

| mission_id | 条件 | 权威范围 |
|---:|---|---|
| 3210132 | 莉塔通关任意摇曳迷宫 | QuestRange kind 12，对应 category `6/13/14/20` 的任意成功单人关卡 |
| 3210133 | 莉塔通关摇曳迷宫宝物域 | QuestRange kind 7，category 13，quest ID `2001..2006` |
| 3410012 | 伊凡通关任意摇曳迷宫 | QuestRange kind 12，对应 category `6/13/14/20` 的任意成功单人关卡 |
| 3410013 | 伊凡通关临境域深渊之兽·极 | QuestRange kind 7，category 13，quest ID `1040` |

kind 12 的四个 category 来自 CN 1.8.1 `QuestCategory_Impl_`：DailyWeekEvent=`6`、ChallengeDungeonEvent=`13`、DailyExpManaEvent=`14`、TowerDungeonEvent=`20`。具体任务只在成功结算且目标角色确实位于本次队伍时增加持久进度。

### 无阵亡条件

`1610022` 与 `2610072` 的主数据 pattern type 为 `95`，不是普通队长通关。其 `statistics=17` 对应战斗区统计 `encoffin_count`，官方语义为全场总和不大于 0。

服务端只在同时满足以下条件时增加进度：

1. 战斗成功；
2. 指定角色位于队长位；
3. `statistics.zones` 存在，且每个 zone 的 `encoffin_count` 都是有限非负整数；
4. 所有 zone 的 `encoffin_count` 总和为 0。

缺失、负数、非整数或非有限值均关闭匹配，不用 `continue_count`、最终存活角色数或成功通关替代。该事实与关卡结算处于同一 SQLite 事务，失败请求和事务回滚不得留下进度。

### 通用回退审计

纯通用回退经 CN 主数据逐条审计后为 55 条。这些文案明确为“队伍中编有指定角色通关任意关卡”，可以继续使用角色成功通关累计值。审计测试逐条固定：

- 任务描述没有 QuestRange、队长、共斗、角色组合、种族、限时、连击、强化弹射、信赖证或其他附加条件；
- 目标角色 ID 与主数据 `character_ids` 一致；
- 只有成功结算增加次数；
- 槽位 4 按三个子任务的奖励阈值统计完成数，不按“进度大于零”统计。

审计未通过的任务必须显式加入规则表，不能继续沉默落入通用回退。本轮新增显式特殊条件为
`3210132/3210133/3410012/3410013/1610022/2610072`；另补 `1510062`，要求贝瑞塔位于队长位且拉芙在同一场成功战斗的队伍中。

## 每日与每周

### 常驻每日

常驻 `11/13/14/16/17` 保持现有语义：单人成功、协力成功、冲刺、消耗体力，以及前四项全部完成。活动任务不参与 `17` 的汇总，避免活动开放时抬高常驻“全部完成”门槛。

### 当前活动每日

当前 6 条活动每日已接入严格规则：

| mission_id | QuestRange | 成功条件 |
|---:|---|---|
| 800115～800117 | AdventEvent，event selector `200015` | category 7 的协力成功，且关卡属于 selector `200015` |
| 800124～800126 | BossBattle，全范围 | category 2 的领主战协力成功 |

每条任务仍按自身开放时间过滤。三个同条件任务分别保存进度并按各自奖励阈值结算；不得只更新第一条，也不得跨开放期累计。活动规则使用逐场持久事实，不从当前关卡最佳记录反推累计次数。

### 每周

每周只保留两条官方定义：本周登录天数和本周协力成功次数，当前已 `2/2` 自动计算。周一 05:00 的快照重置、首次登录基线、重复结算幂等和跨周不串数据已由自动测试固定；仍待官方 CN 客户端跨周完整验收，不新增第三条任务。

## 首批简单称号

第一批已增加 18 条：

| 条件族 | 数量 | 权威来源 |
|---|---:|---|
| `degree_multi_battle_clear_*` | 3 | `players_mission_battle_counters.multi_clear_count` |
| `degree_multi_battle_by_host_clear_*` | 3 | `players_mission_battle_counters.multi_host_clear_count` |
| `degree_character_episode_read_*` | 3 | category 3 已成功角色剧情关卡的数量 |
| `degree_challenge_dungeon_clear_*` | 3 | `players_mission_battle_counters.challenge_dungeon_clear_count` |
| `degree_score_clear_single_*` | 3 | `players_mission_battle_counters.single_score_max` 与官方 finish `score` |
| `degree_time_clear_single_*` | 3 | `players_mission_battle_counters.single_clear_time_min` 与官方 finish `elapsed_time_ms` |
| `degree_boss_battle_clear_*` | 3 | `players_mission_battle_counters.boss_battle_clear_count` 与 category 2 成功结算 |

称号自动计算覆盖现为 `1042/1288`，约 `80.9%`，unsupported 为 246 条。计算结果与已有持久进度取最大值，避免旧存档倒退；角色剧情使用 SQL `COUNT(*)` 统计 category 3 已完成关卡，并由 `idx_players_quest_progress_player_section_finished` covering index 支持。领主战称号 `degree_boss_battle_clear_*` 使用 category 2 成功结算的独立累计次数，单人和协力均计入；失败及其他 category 不计入。单人分数称号 `degree_score_clear_single_*` 使用成功单人 finish 请求中的 `score`，只保留最高分并按主数据描述中的阈值返回 0/1；协力、失败、负数、非安全整数不会计入。该值来自官方客户端提交的战斗统计，服务端不重算战斗分数，故仍需客户端协议验收。单人限时称号 `degree_time_clear_single_*` 使用成功单人 finish 请求中的 `elapsed_time_ms`，只保留最短有效耗时并按主数据描述的 60/10/5 秒阈值返回 0/1；缺失、零值、非法值、协力和失败结算不会计入，同样不做战斗时间重算。挑战副本累计通关称号 `degree_challenge_dungeon_clear_*` 使用独立的 `challenge_dungeon_clear_count` 事实，只在 category 13 成功结算时增加，重复通关同一关也会累计；失败、普通关卡和事务回滚不会增加。该计数属于数据库运行事实，当前存档替换/导入格式不在本任务扩展范围内。第二玛纳板使用 `mana_board.json` 的第二板节点集合与玩家节点记录求交集；无法确认节点归属时不计入。累计消耗体力和累计登录直接读取玩家主表的权威累计字段。练习关卡 SS 使用主数据列出的 category 15 目标集合及持久化 `clear_rank=5`。珍品商店购买只累计 `treasure_shop.json` 中商品 ID 的持久化购买次数，不把其他商店或当前库存当作事实。指定 Boss 超级难度只接受主数据和 CDN 关卡表的精确映射。其余复杂条件继续保留持久化 fallback。

### 挑战副本累计通关称号

`10000/10010/10020` 的主数据 pattern 分别要求通关 100、500、3000 次摇曳的迷宫。服务端使用 `players_mission_battle_counters.challenge_dungeon_clear_count` 记录成功结算次数，按 `questCategory=13` 严格隔离；它不依赖 `players_quest_progress` 的唯一关卡记录，也不把普通 category 1 或其他活动关卡混入。旧数据库启动时通过 schema migration 补列，旧存档没有可证明的历史次数时不会回填猜测值。

### 单人最高分称号

`14000/14010/14020` 的主数据描述分别要求单人战斗分数达到 10000000、50000000、99999999。服务端在原 finish 事务中保存单人成功请求的最高 `score`，称号进度为达到阈值后的 1。该字段是官方客户端提交的战斗统计，未接入独立战斗模拟或反作弊重算；缺失、非法或失败数据保持未完成，相关可信度留在[待审阅实现记录](mission-implementation-assumptions.md)。

### 单人限时通关称号

`15000/15010/15020` 的主数据描述分别要求单人战斗在 60、10、5 秒内通关。服务端在原 finish 事务中保存成功单人结算的最短有效 `elapsed_time_ms`，达到对应阈值后返回 1。该值来自客户端 finish 请求，服务端不重放战斗或重算计时；缺失、零值、非法、协力和失败结算不会更新。

### 领主战累计通关称号

`30000/30010/30020` 的主数据描述分别要求通关 10、500、5000 次领主战。服务端按 category 2 在单人/多人成功 finish 时增加 `boss_battle_clear_count`，不依赖某一关的唯一历史记录；旧数据库启动会补列，导入导出边界不变。

### 第二玛纳板称号

`pattern=48` 的 475 条定义已接入：3 条全局累计称号统计所有已确认第二板的已强化节点，472 条角色称号按 `mission_degree.row[15]` 指定角色，并要求该角色第二板的全部 CDN 节点都已出现在玩家存档中。重复角色任务不会按 mission ID 猜角色；同一角色的不同称号定义分别读取各自主数据目标。

当前实现不把 bond token、角色当前 `mana_board_index`、觉醒等级或当前角色持有数量当作第二板完成的替代证据。角色不存在、第二板表缺失或节点行异常时保持未完成；已有持久进度仍保留，避免存档回退。客户端尚未逐条确认“强化”的显示语义和出售角色后的历史规则，详见[待审阅实现记录](mission-implementation-assumptions.md)。

### 章节主线与高难全通称号

12 条 `degree_all_episode_quest_clear_*` 读取主数据中的章节号，并按 `floor(quest_id / 1,000,000)` 从 `main_quest.json` 与 `ex_quest.json` 构造完整关卡集合。只有两类集合都非空且每个关卡均有玩家 `finished=1` 记录时才完成；缺任意一关、只有主线记录或内容集合为空都保持未完成。该逻辑不使用最后主线关卡字段替代全量证明。

### 练习关卡 SS 称号

5 条 `degree_practice_rank_ss_clear_*` 从 `mission_degree.row[11]` 读取目标关卡 ID，查询 category 15 已完成记录，要求每个目标的 `clear_rank=5`。目标集合缺失、记录未完成或评级低于 SS 时都保持未完成。

### 珍品商店购买称号

3 条 `degree_treasure_shop_buy_count_*` 汇总 `players_shop_purchases` 中属于 `treasure_shop.json` 的商品 ID 购买次数。非珍品商店商品、当前库存和商店刷新状态不计入；珍品商店消耗玛纳仍因缺少累计消费记录保持 fallback。

### 指定 Boss 超级难度称号

14 条定义中有 13 条能解析出主数据 stage group + difficulty 对应的 category 2 关卡，完成对应关卡即可完成称号。大蛇定义 `11080` 的 difficulty 4 在当前 CDN 中缺失，因此保持 fallback，详见[待审阅实现记录](mission-implementation-assumptions.md)。

以下条件暂不纳入第一批：

- 能力魂珠使用次数：当前没有累计使用事实；
- 摇曳迷宫累计通关次数：不同关卡的历史最佳记录不能代替累计次数；
- MVP、救援、复杂战斗状态：缺少完整权威来源；
- “接取救援请求”保持低优先级，暂不实现。

## 数据流与事务

战斗类任务统一遵循：

```text
start 保存 active quest
  -> finish 校验 active quest 与结果
  -> 在外层 SQLite 事务内记录本场任务事实
  -> 计算已开放任务进度
  -> 写入阶段状态并发奖
  -> 提交事务后清理内存 active quest
```

任务事实生产者只负责记录本场已验证事实，`MissionComputer` 只读取持久状态并计算进度。同一场单人或多人战斗在事务开始时固定一个 `evaluationTime`，事实记录与任务结算必须复用该时间快照，避免跨过活动开始或截止秒时出现开放期判断分裂。失败战斗、字段缺失、关卡范围不匹配、身份不匹配和开放期不匹配均不得增加进度。

## 验证与客户端边界

- 角色觉醒：四条 QuestRange 正反例、两条无阵亡正反例、失败战斗、错误队长、错误角色、异常统计与事务回滚。
- 每日：六条活动任务的正确关卡、错误活动、单人/协力差异、开放期、重复 finish、三档并行增长、事务时间快照复用和常驻全部完成隔离。
- 每周：周一 05:00 边界、首次登录、跨周重置、重复读取和重新 load。
- 称号：协力/房主计数区分、成员通关不污染房主计数、角色剧情只计算完成关卡、挑战副本重复通关累计、旧持久进度不回退。
- 上述自动测试已覆盖服务端规则，但自动测试通过不等于官方客户端已验收。角色觉醒 144 条条件仍待逐条验收，每周任务仍待跨周完整验收。
