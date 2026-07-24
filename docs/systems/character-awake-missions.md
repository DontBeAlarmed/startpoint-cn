# 角色觉醒任务覆盖文档

> 状态：部分完成。核心解锁与领奖时序已经通过官方 CN 客户端验收，服务端 144 条任务均可计算；144 条任务条件仍未由客户端逐条验收，自动测试通过不能替代该验收。

## 概览

- **144 条任务**（36 个角色 × 4 个槽位）
- **Category 9**，请求格式 `{"character_id": N, "category": 9}`
- `get_mission_progress` 中按 `lastDigit` 分发计算

### 槽位含义

| lastDigit | 含义 | 计算方式 |
|-----------|------|---------|
| 1 | 阅读个人剧情 / 队伍中编有X通关 | 故事计数 或 `clears.clear_count`（fallback） |
| 2 | 累计阅读故事（Alk）/ 累计玛纳（拉芙）/ 队长或队伍通关 | Alk=`totalStories`，拉芙=`totalManaObtained`，其他=`clears.clear_count` |
| 3 | 强化弹射（Alk）/ 信赖证 / 共斗/限时 | Alk=`totalPowerflips`，信赖证要求列表非空且 `every(status>=2)`，其他=`clears.clear_count` |
| 4 | 完成全部觉醒任务 | 按各槽位 CDN `target_progress` 统计已完成任务数 |

### 总任务完成判定

槽位 4 的 `target_progress=3`，其进度表示已经达到完成阶段的子任务数量，不是已有正数进度的子任务数量。

例如缪（`341005`）的三个子任务目标分别为通关 `1`、`3`、`5` 次。通关一次时三个任务的原始进度都可能是 1，但只有第一个任务达到目标，因此总任务进度必须为 1，不能为 3。服务端使用 `mission_char_awake_reward` 中各子任务的 `target_progress` 判定完成状态。

### 当前审计口径

下文记录已经接入的数据源和实现路径，不等于每条任务条件都已逐项完成客户端验证。配对计数排序、
`2310012` 种族组合、`3310032/3310033` 指定关卡同场条件、空信赖证列表和失败战斗写入等已知错误
已经由自动测试固定。新增显式特殊条件覆盖 `3210132/3210133/3410012/3410013/1610022/2610072`，
并补齐 `1510062` 的队长与拉芙同场条件。其余纯通用角色通关回退已按 CN 主数据逐条审计，当前为 55 条，
客户端仍需按条件矩阵验收全部 144 条任务。

完整 P0 清单见[当前已知问题](../status/known-issues.md)。在这些问题修复并完成条件级测试前，不再维护“0 条错误”或“全部完成”的统计。

---

## 已实现特性

### 强化弹射计数器（2026-06-26）✅

- Alk type_3 使用 `player.totalPowerflips`
- 来源：`/finish` 的 `statistics.zones[].use_power_flip_count`
- 累计到 `players.total_powerflips`
- SELECT 需包含 `total_stamina_used, total_powerflips, total_dashes`

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
  - 关卡结算：`singleBattleQuest.ts` + `multi/http/battle.ts`
  - 掉落奖励：`lib/quest.ts`（`givePlayerRewardsSync` + `givePlayerScoreRewardsSync`）
  - 邮件领取：`mail.ts`
  - 活跃任务：`activeMission.ts`
  - 觉醒任务自奖励：`src/routes/api/mission.ts`
  - 物品出售：`item-sell.ts`

### 特定关卡通关（2026-06-28）✅

普通指定关卡任务通过 `ctx.questProgress[category]` 检测关卡完成状态：

| mission_id | 角色 | 关卡 | quest_id | category |
|------------|------|------|----------|:---:|
| 1110013 | 瓦格纳 | 伊尔格拉乌 超级 | 1028004 | 2 |
| 1310052 | 巴拉克 | 结实假人·水 | 96 | 15 |
| 1410032 | 丛云 | 八岐大蛇(最高) | 1020003 | 2 |
| 2110013 | 阿赛尔 | 伊尔格拉乌 超级 | 1028004 | 2 |
| 2510032 | 艾莉亚 | 临境域 深渊之兽 | 1020 等多周期 | 13 |
| 2630023 | 贝瑞塔 | 女王拉芙 超级+ | 100100004/100401004 | 19 |

映射常量 `QUEST_CLEAR_MAP` 在 `src/lib/mission/computer-awake.ts` 中定义，
`AwakeComputer.compute` 在 `lastDigit` 分支之前优先检测。

`3310032` 与 `3310033` 还要求指定角色组合和指定关卡在同一场成功战斗中同时成立，不能把不同场次的
配对累计与关卡进度拼接：

| mission_id | 角色组合 | category | quest_id | 联机限制 |
|---:|---|---:|---:|---|
| 3310032 | 泰加、阿尔克 | 15 | 5 | 单人 |
| 3310033 | 泰加、白 | 2 | 1010004 | 单人 |

成功结算通过 `awake-battle-rules.ts` 匹配后直接增加对应 category 9 持久进度；失败战斗、错误关卡、
缺少角色或联机结算均不写入。计算器读取该持久事实，不再从跨场累计配对推测完成状态。

### 配对与种族组合（2026-07-24）✅

- 配对写入前按角色数值 ID 排序，`2110012` 不再受队伍位置影响。
- 读取旧存档时把 `a,b` 与 `b,a` 归一为同一个键并累加，兼容历史反序记录。
- `2310012` 使用 CN 主数据的 `Human`、`Dragon`、`Devil`，不再把“魔”映射为 `Beast`；同时要求拉姆斯位于队长位。队长与三种族必须在同一场成功战斗中成立，才增加 category 9 持久进度。
- 信赖证任务要求 `bondTokenList` 至少有一项且全部达到已领取状态，空列表不会完成任务。

### 显式特殊战斗条件（2026-07-24）

以下任务不再落入通用角色通关回退：

| mission_id | 条件 | 服务端判定 |
|---:|---|---|
| 3210132 | 莉塔通关任意摇曳迷宫 | QuestRange kind 12，category `6/13/14/20` 的成功单人关卡 |
| 3210133 | 莉塔通关摇曳迷宫宝物域 | QuestRange kind 7，category 13，quest ID `2001..2006` |
| 3410012 | 伊凡通关任意摇曳迷宫 | QuestRange kind 12，category `6/13/14/20` 的成功单人关卡 |
| 3410013 | 伊凡通关临境域深渊之兽·极 | QuestRange kind 7，category 13，quest ID `1040` |
| 1610022 | 威隆作为队长且全场无阵亡 | pattern 95、statistics 17，所有 `zones[].encoffin_count` 总和为 0 |
| 2610072 | 赛吉尔作为队长且全场无阵亡 | pattern 95、statistics 17，所有 `zones[].encoffin_count` 总和为 0 |
| 1510062 | 以贝瑞塔为队长并编入拉芙通关 | 队长 `151006` 与拉芙 `263002` 必须在同一场成功战斗中出现 |

无阵亡规则对异常输入 fail closed：`statistics.zones` 缺失、空数组，或任一
`encoffin_count` 为缺失、负数、非整数、非有限值时均不增加进度。失败战斗、错误角色、错误队长和
QuestRange 不匹配同样不写入持久事实。

### 通用角色通关回退审计（2026-07-24）

CN 主数据逐条审计确认 55 条任务可以使用“队伍中编有指定角色并成功通关”的通用累计值。这些任务的
pattern、目标角色和附加条件均由测试固定；不符合纯通用语义的任务必须进入显式规则，不能沉默落入回退。

### 队长追踪（2026-06-28）✅

`players_character_quest_clears` 新增 `leader_clear_count` 列，`/finish` 中 `characters[0]` 传 `isLeader=true`。

- `LEADER_REQUIRED_IDS` 集合：`{1510062, 1610022, 1610023, 2610072}`
- 需要指定队长的通用计算路径使用 `leader_clear_count`（纯队长出场），其他通用任务使用 `clear_count`（任意位置）
- `1510062` 另由显式战斗事实同时校验贝瑞塔队长与拉芙同场；`1610022/2610072` 另校验全场无阵亡，不能只凭队长累计完成
- `2310012` 不使用通用 `leader_clear_count`；它由战斗事实规则同时校验拉姆斯队长和 Human、Dragon、Devil 组合。
- 1610023（威隆队长通关）⚠️→✅

### 时间追踪（2026-06-28）✅

`QUEST_CLEAR_MAP` 扩展 `timeLimitMs` 字段，检查 `bestElapsedTimeMs <= timeLimitMs`：

| mission | 关卡 | quest_id | timeLimitMs |
|---------|------|----------|-------------|
| 2310013 | 寄居蟹船长 地狱级 | 1010004 | 90000 (1分30秒) |
| 2510033 | 临境域 深渊之兽 | 1020 等多周期 | 180000 (3分钟) |

### 共斗追踪（2026-06-28）✅

- `multi/http/battle.ts` `/finish` 新增 leader + party 的 `incrementPlayerCharacterClearSync(isMulti=true)`
- `AwakeContext.multiClears` 预缓存 `multi_count`
- `COOP_MISSION_IDS` 使用 `leader_multi_count`，要求指定角色作为联机队长完成。

### 连击追踪（2026-06-28）✅

1210013（索妮雅队长达成连击）通过 `players.max_combo_achieved` 追踪。
`statistics.max_combo_count` 来自客户端 `ComboCalculatorImpl.getMaxCombo()`，
`/finish` 时 `maxComboAchieved = max(old, body.statistics.max_combo_count)`。

### 关卡队长校验（2026-06-28）✅

`players_quest_progress` 新增 `leader_character_id` 列，
`/finish` 写入 `characters[0].id`。
`QUEST_CLEAR_MAP` 扩展 `leaderCharId` 字段；关卡通关映射共 8 条任务，其中配置了队长的任务会精确校验：

| mission | quest | leaderCharId |
|---------|-------|:---:|
| 1110013 | 伊尔格拉乌 超级 | 111001 |
| 2110013 | 伊尔格拉乌 超级 | 211001 |
| 2410032 | 八岐大蛇 | — |
| 2510032 | 深渊之兽 | 251003 |
| 2510033 | 深渊之兽(限时) | 251003 |
| 2310013 | 寄居蟹船长(限时) | 231001 |
| 2630023 | 女王拉芙 | 151006 |
| 1310052 | 结实假人·水 | 131005 |

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
- cat9 预缓存：`getPlayerCharactersSync` + `getPlayerCharacterClearSync` 批量预取，消除 144 次 per-mission DB 查询

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
