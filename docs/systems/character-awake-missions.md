# 角色觉醒任务覆盖文档

> 状态：部分完成。核心解锁与领奖时序已经通过官方 CN 客户端验收；144 条任务已按真实条件族唯一分区并进入权威计算路径。自动测试通过不能替代逐条客户端验收。

## 概览

- **144 条任务**（36 个角色 × 4 个槽位）
- **Category 9**，请求格式 `{"character_id": N, "category": 9}`
- `get_mission_progress` 由主数据校验后的显式条件族分发，不再用 mission ID suffix 证明规则覆盖

### 槽位含义

`lastDigit` 仅保留为最终三子任务汇总等旧计算结构的输入，不再作为条件正确性的 coverage 依据。规则目录
`awake-rule-catalog.ts` 按 18 个条件族覆盖全部 144 条主数据定义，并在模块加载时检查唯一分区和关键字段。
其中 55 条“指定角色通关任意关卡”使用固定 mission ID 白名单，不再通过排除所有特殊任务后得到。

### 总任务完成判定

槽位 4 的 `target_progress=3`，其进度表示已经达到完成阶段的子任务数量，不是已有正数进度的子任务数量。

例如缪（`341005`）的三个子任务目标分别为通关 `1`、`3`、`5` 次。通关一次时三个任务的原始进度都可能是 1，但只有第一个任务达到目标，因此总任务进度必须为 1，不能为 3。服务端使用 `mission_char_awake_reward` 中各子任务的 `target_progress` 判定完成状态。

汇总时每个子任务必须读取自身 mission ID 的 category 9 持久进度，再与该子任务的实时计算值取最大；父任务
持久进度只能作为父结果的下限，不能传入子任务或替代 fail-closed/同场事实。这样既阻止父进度补齐缺失子条件，
也保证旧父进度不会因当前事实不足而回退。

JSON 存档导入会恢复 `categoryMissionList`，但不保证同时恢复角色通关、队长通关、共斗等衍生事实表。因此
`AwakeComputer.compute` 的所有条件族都必须以当前任务 `dbProgress` 为下限；缺失衍生事实只能阻止新增进度，
不得让后续 `awake-settlement` 把已经导入的 category 9 进度覆盖为更小值。

### 当前审计口径

下文记录已经接入的数据源和实现路径，不等于每条任务条件都已逐项完成客户端验证。已确认的同场条件直接从
一次成功 finish 产生 category 9 持久事实；计算器不再把不同战斗的历史摘要拼接为同一场。`2310012` 按已确认
语义统计主位与 Sub 的种族合集，要求包含 Human、Dragon、Devil，允许额外种族和多种族角色同时贡献多个条件。
`1610022/2610072` 将 statistics 17 映射为本次 finish 各 zone 的 `encoffinment_count`，要求总和为 0。

### 条件族分区（2026-07-27）

| 状态 | 条件族 | 数量 |
|---|---|---:|
| 已闭合 | 全部完成、剧情阅读、通用指定角色通关 | 36 + 18 + 55 |
| 已闭合 | 指定队长强化弹射、指定队长单场连击 | 2 + 1 |
| 已闭合 | 指定关卡原子匹配、无队长指定关卡历史 | 7 + 1 |
| 已闭合 | 双角色同队、三角色同队、指定队伍+关卡 | 4 + 1 + 3 |
| 已闭合 | 指定队长共斗、指定队长通关、QuestRange | 2 + 1 + 4 |
| 已闭合 | 信赖证、累计玛纳、累计角色剧情 | 4 + 1 + 1 |
| 已闭合 | 种族合集、指定队长且全场无棺柩 | 1 + 2 |

测试要求 144 个 mission ID 在这些条件族中出现且只出现一次。任何主数据 pattern、battle kind、队长、
`character_ids` 或 QuestRange selector 漂移都会使启动期 schema 校验失败，不能静默落入其他规则。

完整 P0 清单见[当前已知问题](../status/known-issues.md)。在这些问题修复并完成条件级测试前，不再维护“0 条错误”或“全部完成”的统计。

### 官方入口资格与服务端门控（2026-07-26）

角色觉醒任务的官方入口资格必须同时满足：玩家持有角色、对应 category 9 活动在服务器时间开放、角色达到
当前稀有度的基础等级上限、第一块玛纳板的全部节点已经学习。**不要求第二块玛纳板已学习或完成。**
基础资格区分 `ready / not-ready / unknown`。角色 asset 缺失，或第一块玛纳板主数据缺失、为空时为
`unknown`；新任务显示、奖励结算和解锁创建均 fail closed。

服务端为每个 player 请求创建一次 eligibility resolver，批量读取角色、已学习节点与节点觉醒等级，按角色缓存
基础资格和 asset 读取；角色/任务对应关系与活动开放时间也由 resolver 统一判断。以下所有会显示任务、结算
奖励或新建解锁的路径均复用同一请求级 resolver：

- `/load` 的 `computeAwakeSummary` 与解锁校准；
- `mission/get_mission_progress` 的摘要、任务阶段结算和特殊奖励；
- `mission/update_mission_progress` 写入事实后的新解锁校准与响应发布；
- 各权威业务端点状态落库后的 `reconcileAwakeUnlockCharacterList`；
- 根据显式进度恢复解锁的 `reconcileAwakeUnlocksFromProgress`。

单角色 `mission/get_mission_progress` 在 eligibility 前先按 `requestEntry.character_id` 缩小 category 9 mission
ID，避免遍历其他角色任务。旧 unlock cleanup 只在基础资格可确认是 `not-ready` 且没有正数节点觉醒等级时
删除；`unknown` 只阻止新解锁，不触发清理，活动关闭也始终不是 cleanup 条件。调和结果分别返回当前全量
`all`、本次新增或提高的 `changed`，以及按角色和板记录的 `removed`。业务增量响应仅在 `changed` 与
`removed` 同时为空时原样返回；清理事件会保留既有角色条目的进化、信赖证等字段，并用权威空对象
`mana_board_awake: {}` 覆盖客户端旧值。若响应中原本没有该角色，则追加只含角色 ID 和空对象的最小更新。
`/load` 不发布增删事件，继续使用 `all` 重建完整状态。

底层战斗事实、终身统计或其他共享权威事实可以在角色满足入口资格之前累计，资格满足后计算器可以读取这些
既有事实；这是服务端为兼容旧存档和避免丢失历史行为采用的策略。它不表示已经从 CN 客户端证明“官方客户端
一定允许资格前累计”。`update_mission_progress` 的事实写入也沿用该策略；写入后只有满足 helper 的角色才能
显示任务、结算奖励或发布新解锁。

---

## 已实现特性

### 旧存档进化等级校准（2026-08-30）

- 新的 `awake_mana_node` 路由会在同一事务内持久化节点觉醒等级和官方技能进化要求的角色 `evolution_level`。
- `/load` 会读取同一觉醒请求上下文中的角色、已学习节点和节点觉醒等级快照，按第一块玛纳板官方主数据重新推导进化等级；旧存档落后时只做单调提升，绝不降级。
- evolution 更新使用 `evolution_level < derived` 的 guarded UPDATE。并发升高、行已删除或派生值不高于当前值时都是合法 no-op；只有本次 SQLite `changes=1` 才计入 repaired ID。多角色 repair 保持同一事务，任一失败整体回滚。
- 校准不扣除资源，不修改物品、category 9 任务、Awake unlock、节点觉醒等级、角色经验或其他角色字段；第二次 `/load` 不再重复写入。
- 角色未持有、第一板主数据缺失/为空，或玛纳节点进化语义无法解析时跳过该角色，不猜测进化结果，也不让加载失败。
- 自动测试无法覆盖全部旧存档形态，实机验收仍需由用户用旧存档登录确认觉醒进化生效。

### 指定队长强化弹射（2026-07-27）

- `13` 只在阿尔克位于本场队长位时累计本场 `statistics.zones[].use_power_flip_count`。
- `1210012` 同样要求索妮雅位于本场队长位；两条主数据均为 `battle_kind=3`，接受成功单人或协力结算。
- 任一负数、非安全整数或求和溢出均令本场该事实 fail closed；失败战斗不写入。
- 计算器只读 category 9 持久进度，不读全局 `players.total_powerflips`，错误队长的历史强化弹射不能补齐任务。

### 弹射/冲刺数据源（2026-06-26）

- `use_power_flip_count`：弹射总次数
- `use_power_flip_lv1/2/3_count`：各级弹射
- `use_dash_count`：冲刺次数
- `ball_flip_count`：弹珠翻转
- 累计到 `players.total_powerflips` / `players.total_dashes`

### 信赖证进度（2026-06-28）✅

- 4 个任务（丛云/爱丽丝/芬/赛吉尔）的 type_3
- `getPlayerCharacterSync().bondTokenList.every(bt => bt.status >= 2)`
- status: 0=未解锁, 1=可领取, 2=已领取

### 终身玛纳追踪（2026-06-28）✅

- 拉芙(2630022) type_2 使用 `player.totalManaObtained`
- DB 列 `total_mana_obtained`，所有玛纳发放点累加：
  - 单人固定结算与协力基础结算：`single-settlement-writes.ts` + `multi/http/battle.ts`
  - 标准奖励计划：`reward-grant/owner-currency.ts`（单人奖励、生产抽卡、普通/bulk shop、邮件标准附件）
  - 兼容或独立奖励路径：`lib/quest.ts`（协力、Raid summary 与 standalone gacha fallback）
  - 普通、觉醒与 Active Mission：`mission/grants.ts`
  - 物品出售：`item-sell.ts`

### 特定关卡通关（2026-08-31）

7 条带指定队长的任务由本次成功 finish 原子匹配；只有无队长条件的 `1410032` 通过
`ctx.questProgress[category]` 检测既有完成状态：

| mission_id | 角色 | 关卡 | quest_id | category |
|------------|------|------|----------|:---:|
| 1110013 | 瓦格纳 | 伊尔格拉乌 超级 | 1028004 | 2 |
| 1310052 | 巴拉克 | Practice 25 | 25 | 15 |
| 1410032 | 丛云 | 八岐大蛇(最高) | 1020003 | 2 |
| 2110013 | 阿赛尔 | 伊尔格拉乌 超级 | 1028004 | 2 |
| 2310013 | 拉姆斯 | 寄居蟹船长 地狱级 | 1010004 | 2 |
| 2510032 | 艾莉亚 | 临境域 深渊之兽 | 1020 等多周期 | 13 |
| 2510033 | 艾莉亚 | 临境域 深渊之兽(限时) | 1020 等多周期 | 13 |

原子规则定义在 `awake-battle-rules.ts`；`QUEST_CLEAR_MAP` 只保留 `1410032`。计算器在通用分支前读取对应
category 9 持久事实，旧持久进度始终为下限。

`1310052` 的目标来源于 CN 1.8.1 客户端 `CharacterAwakeMissionValues`：`quest_kind=11` 分支使用 `row[12]`
构造 Practice quest ID，因此该任务目标为 Practice 25。

`2630023` 是拉芙挑战的 exact-quest 例外，不在上表的多 quest ID 或 category 19 规则内。进度只会在一次
成功单人 finish 同时满足 category `18`、quest `400001104`、贝瑞塔 `151006` 位于
`statistics.party.characters[0]` 主位 0 时增加；unison、非主位 0、玩家全局 leader、联机或失败结算都不算。
该修复只闭合这一任务事实，不声明玛纳板/觉醒路径独立性和两种完成顺序；它们属于后续独立 Gate。

`3310032` 与 `3310033` 还要求指定角色组合和指定关卡在同一场成功战斗中同时成立，不能把不同场次的
配对累计与关卡进度拼接：

| mission_id | 角色组合 | category | quest_id | 联机限制 |
|---:|---|---:|---:|---|
| 3310032 | 泰加、阿尔克 | 15 | 5 | 单人 |
| 3310033 | 泰加、白 | 2 | 1010004 | 单人 |

成功结算通过 `awake-battle-rules.ts` 匹配后直接增加对应 category 9 持久进度；失败战斗、错误关卡、
缺少角色或联机结算均不写入。计算器读取该持久事实，不再从跨场累计配对推测完成状态。

### 配对与三角色同场（2026-07-27）

- 配对写入前按角色数值 ID 排序，`2110012` 不再受队伍位置影响。
- 读取旧存档时把 `a,b` 与 `b,a` 归一为同一个键并累加，兼容历史反序记录。
- `2410633` 不再取三组 pairwise 历史次数的最小值。凉月、鹄、梅利露必须在同一次成功 finish 的实际主位或合击位队伍中共存，才增加一次持久进度。
- `2310012` 要求拉姆斯位于队长位；主位与 Sub 的种族合集必须包含 Human、Dragon、Devil，允许额外种族，多种族角色可同时满足多个所需种族。
- 信赖证任务要求 `bondTokenList` 至少有一项且全部达到已领取状态，空列表不会完成任务。

### 显式特殊战斗条件（2026-07-24）

以下任务不再落入通用角色通关回退：

| mission_id | 条件 | 服务端判定 |
|---:|---|---|
| 3210132 | 莉塔通关任意摇曳迷宫 | QuestRange kind 12，category `6/13/14/20` 的成功单人关卡 |
| 3210133 | 莉塔通关摇曳迷宫宝物域 | QuestRange kind 7，category 13，quest ID `2001..2006` |
| 3410012 | 伊凡通关任意摇曳迷宫 | QuestRange kind 12，category `6/13/14/20` 的成功单人关卡 |
| 3410013 | 伊凡通关临境域深渊之兽·极 | QuestRange kind 7，category 13，quest ID `1040` |
| 1510062 | 以贝瑞塔为队长并编入拉芙通关 | 队长 `151006` 与拉芙 `263002` 必须在同一场成功战斗中出现 |

`1610022/2610072` 要求威隆/赛吉尔位于队长位并成功通关，单人和协力均接受。statistics 17 由 pattern
`battle_zone_statistics_no_more_than_zero`、任务文案、finish 的 zone 聚合棺柩字段和客户端统计总计器共同闭合到
`statistics.zones[].encoffinment_count`。客户端在己方成员进入棺柩时增加 zone 统计槽 41，并以该字段输出；
`members[].encoffin_count` 是另一层成员统计，不能替代。`zones` 必须是非空数组，每个 zone 都必须提供非负安全整数；所有 zone
总和为 0 才增加一次进度，任一场景发生过棺柩后即使复活也不计。字段缺失、非法数值、失败战斗或错误队长
均不写入；`continue_count`、最终存活人数和 phase 统计不参与判断。

### 通用角色通关白名单（2026-07-27）

CN 主数据逐条审计确认 55 条任务可以使用“队伍中编有指定角色并成功通关”的通用累计值。固定白名单逐条
要求 pattern 93、battle kind 3、无附加 selector，且 `character_ids` 等于所属角色。单人和协力成功均可累计；
失败 finish 不累计。不在白名单且没有显式规则的任务只保留旧持久进度，不能沉默落入通用回退。

### 队长追踪（2026-06-28）✅

`players_character_quest_clears` 新增 `leader_clear_count` 列，`/finish` 中 `characters[0]` 传 `isLeader=true`。

- `LEADER_REQUIRED_IDS` 仅保留无附加条件的 `1610023`。
- 需要指定队长的通用计算路径使用 `leader_clear_count`（纯队长出场），其他通用任务使用 `clear_count`（任意位置）
- `1510062` 由显式战斗事实同时校验贝瑞塔队长与拉芙同场。
- `1610022/2610072` 与 `2310012` 不使用通用 `leader_clear_count`，均由本次成功 finish 原子校验附加条件。
- 1610023（威隆队长通关）⚠️→✅

### 时间追踪（2026-06-28）✅

限时任务在本次成功 finish 内检查 `clearTime <= timeLimitMs`，不再读取 `players_quest_progress.bestElapsedTimeMs`：

| mission | 关卡 | quest_id | timeLimitMs |
|---------|------|----------|-------------|
| 2310013 | 寄居蟹船长 地狱级 | 1010004 | 90000 (1分30秒) |
| 2510033 | 临境域 深渊之兽 | 1020 等多周期 | 180000 (3分钟) |

### 共斗追踪（2026-06-28）✅

- `multi/http/battle.ts` `/finish` 新增 leader + party 的 `incrementPlayerCharacterClearSync(isMulti=true)`
- `AwakeContext.multiClears` 预缓存 `multi_count`
- `COOP_MISSION_IDS` 使用 `leader_multi_count`，要求指定角色作为联机队长完成。

### 指定队长单场连击（2026-07-27）

`1210013` 只在索妮雅位于本场队长位且战斗成功时读取本场 `statistics.max_combo_count`，以 category 9 任务进度
保存历史最大值。错误队长、失败战斗和非法统计不写入；后续较低或不匹配的战斗不会回退。计算器不读取全局
`players.max_combo_achieved`。

### 关卡队长校验（2026-06-28）✅

带指定队长的 7 条关卡/限时任务改为本次成功 finish 原子匹配队长、关卡、模式与用时。历史
`players_quest_progress.leader_character_id` 和 `best_elapsed_time_ms` 不再参与这些任务计算，避免把不同战斗拼接。
无队长要求的 `1410032` 仍可读取已完成关卡历史：

| mission | quest | leaderCharId |
|---------|-------|:---:|
| 1110013 | 伊尔格拉乌 超级 | 111001 |
| 2110013 | 伊尔格拉乌 超级 | 211001 |
| 1410032 | 八岐大蛇 | — |
| 2510032 | 深渊之兽 | 251003 |
| 2510033 | 深渊之兽(限时) | 251003 |
| 2310013 | 寄居蟹船长(限时) | 231001 |
| 2630023 | 女王拉芙 | 151006 |
| 1310052 | Practice 25 | 131005 |

### 共斗队长追踪（2026-06-28）✅

`players_character_quest_clears` 新增 `leader_multi_count` 列。
`incrementPlayerCharacterClearSync(isMulti=true, isLeader=true)` 同步累加。
`COOP_MISSION_IDS` 使用 `leaderMultiClears` 替代 `multiClears`。

### 架构重构（2026-06-28）✅

`lib/mission.ts` 重构为 `lib/mission/` 模块目录：

```
lib/mission/
├── index.ts           barrel export
├── types.ts           MissionComputer + CategoryContext 接口
├── registry.ts        分类→MissionComputer 分发表
├── stages.ts          阶段阈值 (getCurrentStage, getCompletedStageNumbers)
├── rewards.ts         奖励、奖励 ID 和 AwakeManaBoard 特殊奖励解析
├── awake-eligibility.ts  官方入口基础资格与新解锁统一门控
├── awake-settlement.ts  category 9 进入页面时的幂等奖励结算
├── patterns.ts        pattern→mission 索引 (getMissionsByPattern)
├── character-queries.ts  角色→任务映射
├── computer-regular.ts   category 1/2 (pattern 分发)
├── computer-degree.ts    category 5 (等级任务)
├── computer-awake.ts     category 9 (角色觉醒，预缓存 DB)
└── computer-fallback.ts  默认回退 DB progress
```

- `MissionComputer` 接口：`buildContext()` 一次预取 DB → `compute()` 纯计算
- 新分类只需实现接口 + 注册到 `registry.ts` 一行
- cat9 请求级预缓存：eligibility resolver 一次读取 `getPlayerCharactersSync` 与
  `getPlayerCharactersManaNodesSync`，角色通关事实由 `getPlayerCharacterClearsSync` 批量读取；单角色请求先缩小
  mission ID，再按角色缓存资格与 asset，消除 per-mission DB 查询

- **队长**（characters[0]）：单独追踪，"以X为队长"任务
- **队员**（characters[1+], unison）：批量追踪，"队伍中编有X"任务

### 进入页面时结算奖励（2026-07-17）✅

- `update_mission_progress` 只累计任务进度，不在该端点发奖；进度落库后会校准持久解锁。
- 客户端进入觉醒任务页面时请求 category 9 的 `get_mission_progress`；
  服务端在此结算已完成且尚未领取的阶段。
- `received` 来自 `players_category_mission_stages.status`，不再由完成进度推导。
- `mission_info` 使用奖励表第 0 列的 `mission_reward_id`，触发客户端官方任务奖励提示。
- 普通奖励从第 9 列开始解析；第 1-4 列的
  `AwakeManaBoard(character_id, board_index, awake_level)` 作为特殊奖励处理。
- 奖励发放、阶段领取状态和玩家货币更新在同一个 SQLite 事务中提交；重复进入页面不会重复发奖。

### 解锁与领奖时序（2026-07-17）✅

第二页解锁与第一页领奖使用独立的持久状态：前者保存在
`players_character_awake_unlocks`，后者保存在
`players_category_mission_stages.status`。

- 任务未全部完成时，客户端进入第一页；`get_mission_progress` 自动结算当前已完成且未领取的奖励，
  第二页继续锁定。
- 最终条件由权威端点写入后，服务端立即校准并幂等保存持久解锁，通过
  `character_list.mana_board_awake` 发布，但不领取 category 9 奖励，也不改变物品。
- 全部完成的角色首次进入场景时直接显示第二页。玩家手动切回第一页后，
  `tabChanged(1)` 才请求 `get_mission_progress`，一次领取全部未领奖励并显示对应 `mission_info`。
- 因持久解锁已经存在，正常领奖不会再次返回解锁角色条目；重复请求不会重复发奖或重复通知。
- 旧/异常存档若缺少持久解锁，且最终 `AwakeManaBoard` 特殊阶段仍未领奖，该阶段首次结算会幂等补写。
  只有 UPSERT 本次确实改变状态时，`character_list` 才发布一次解锁；第二次结算不再发布。
- 如果最终特殊阶段已经存在领奖状态但解锁行丢失，结算逻辑不会重放该阶段；恢复由 `/load` 校准或
  数据库升级回填负责，客户端需要重新执行 `/load`（通常为重新登录）。
- 同一次结算收到重复 `mission_id` 时，会先按任务取最大进度，再统一持久化与领奖，避免低值覆盖高值。
- 真实 MsgPack+Base64 Fastify 回归从普通单人 `/finish` 开始：最后一次成功通关会立即在战斗响应的
  `character_list` 发布 `mana_board_awake`，但不领取第一页奖励；随后手动进入第一页一次返回四条
  `mission_info` 和奖励，重复请求不再发奖，也不会重复返回角色解锁。

四条觉醒任务全部完成后，即使普通任务奖励仍全部处于未领取状态，权威状态变更端点也可以先持久化并发布
三板（觉醒板）解锁。客户端收到 `mana_board_awake[1] > 0` 后，会把第一块玛纳板切换为 Awake 状态；这不是
要求玩家先完成第二块玛纳板。若最后一个入口条件来自 `learn_mana_node`，服务端会先写入该节点，再在同一响应
的既有角色条目上合并 `mana_board_awake`，保留进化等级、信赖证等原有响应字段并即时发布解锁。

### 持久表与 JSON 存档（2026-07-26）

角色觉醒核心状态由以下五类表/字段共同表达：

| 表 | 关键字段 | 用途 |
|---|---|---|
| `players_characters` | `id`、`exp`、`mana_board_index` | 角色所有权、基础等级与当前板索引 |
| `players_characters_mana_nodes` | `value`、`awake_level` | 已学习节点及每个既有节点的觉醒等级 |
| `players_character_awake_unlocks` | `character_id`、`board_index`、`awake_level` | 与领奖独立的持久三板解锁 |
| `players_category_missions` | `category`、`id`、`progress` | category 9 任务权威进度 |
| `players_category_mission_stages` | `category`、`mission_id`、`id`、`status` | 各奖励阶段是否已领取 |

战斗组合、通关计数和终身统计仍保存在各自事实表/玩家字段中，由觉醒计算器汇总；它们不替代上述解锁与领奖
状态。服务器侧 `MergedPlayerData` 的 JSON 存档额外包含可选字段 `characterAwakeUnlocks` 与
`characterManaNodeAwakeLevels`。导出后 JSON roundtrip 会保留两者；旧存档缺少字段时按“无持久解锁、已存在
节点的 `awake_level=0`”载入，不会报错。恢复节点觉醒等级只执行 `UPDATE`，只作用于已经由
`characterManaNodeList` 创建的节点。`characterAwakeUnlocks` 必须是 plain object，角色 ID、板索引和等级必须为
正 safe integer；`characterManaNodeAwakeLevels` 的角色/节点 ID 必须为正 safe integer，等级必须为非负 safe
integer。未知角色、未知节点或 `UPDATE changes=0` 会明确拒绝导入，并由 replace transaction 回滚，不能静默
忽略或部分替换原存档。
