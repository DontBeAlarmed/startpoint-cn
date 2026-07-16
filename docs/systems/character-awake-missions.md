# 角色觉醒任务覆盖文档

> 状态: 基本完成   最后更新: 2026-07-17

## 概览

- **144 条任务**（36 个角色 × 4 个槽位）
- **Category 9**，请求格式 `{"character_id": N, "category": 9}`
- `get_mission_progress` 中按 `lastDigit` 分发计算

### 槽位含义

| lastDigit | 含义 | 计算方式 |
|-----------|------|---------|
| 1 | 阅读个人剧情 / 队伍中编有X通关 | 故事计数 或 `clears.clear_count`（fallback） |
| 2 | 累计阅读故事（Alk）/ 累计玛纳（拉芙）/ 队长或队伍通关 | Alk=`totalStories`，拉芙=`totalManaObtained`，其他=`clears.clear_count` |
| 3 | 强化弹射（Alk）/ 信赖证 / 共斗/限时 | Alk=`totalPowerflips`，信赖证=`bondTokenList.every(status>=2)`，其他=`clears.clear_count` |
| 4 | 完成全部觉醒任务 | 按各槽位 CDN `target_progress` 统计已完成任务数 |

### 总任务完成判定

槽位 4 的 `target_progress=3`，其进度表示已经达到完成阶段的子任务数量，不是已有正数进度的子任务数量。

例如缪（`341005`）的三个子任务目标分别为通关 `1`、`3`、`5` 次。通关一次时三个任务的原始进度都可能是 1，但只有第一个任务达到目标，因此总任务进度必须为 1，不能为 3。服务端使用 `mission_char_awake_reward` 中各子任务的 `target_progress` 判定完成状态。

### 统计

| 正确度 | 数量 |
|:---:|------|
| ✅ | 90 条（63%） |
| ⚠️ | 54 条（37%） |
| ❌ | 0 条（0%）

### ❌ 已全部清零！

最后 1 个 ❌（1210013 连击）通过 `max_combo_achieved` 追踪解决。

### 后续完善路径

| 顺序 | 功能 | 工作量 | 影响 |
|------|------|--------|------|
| 1 | 时间追踪 + 联机 | 大 | 解锁 5 个 ❌→✅ |

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
  - 觉醒任务自奖励：`mission.ts`
  - 物品出售：`item-sell.ts`

### 特定关卡通关（2026-06-28）✅

5 个任务通过 `ctx.questProgress[category]` 检测 quest 完成状态：

| mission_id | 角色 | 关卡 | quest_id | category |
|------------|------|------|----------|:---:|
| 1110013 | 瓦格纳 | 伊尔格拉乌 超级 | 1028004 | 2 |
| 1310052 | 巴拉克 | 结实假人·水 | 96 | 15 |
| 1410032 | 丛云 | 八岐大蛇(最高) | 1020003 | 2 |
| 2110013 | 阿赛尔 | 伊尔格拉乌 超级 | 1028004 | 2 |
| 2510032 | 艾莉亚 | 临境域 深渊之兽 | 1020 等多周期 | 13 |
| 2630023 | 贝瑞塔 | 女王拉芙 超级+ | 100100004/100401004 | 19 |

映射常量 `QUEST_CLEAR_MISSIONS` 在 `mission.ts` 中定义，
`computeProgress` 在 lastDigit 分支之前优先检测。

### 队长追踪（2026-06-28）✅

`players_character_quest_clears` 新增 `leader_clear_count` 列，`/finish` 中 `characters[0]` 传 `isLeader=true`。

- `LEADER_REQUIRED_IDS` 集合：`{1510062, 1610022, 1610023, 2310012, 2610072}`
- leader-required 任务使用 `leader_clear_count`（纯队长出场），非 leader 任务使用 `clear_count`（任意位置）
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
- `COOP_MISSION_IDS` 集合 → `multi_count`

### 连击追踪（2026-06-28）✅

1210013（索妮雅队长达成连击）通过 `players.max_combo_achieved` 追踪。
`statistics.max_combo_count` 来自客户端 `ComboCalculatorImpl.getMaxCombo()`，
`/finish` 时 `maxComboAchieved = max(old, body.statistics.max_combo_count)`。

### Quest 队长校验（2026-06-28）✅

`players_quest_progress` 新增 `leader_character_id` 列，
`/finish` 写入 `characters[0].id`。
`QUEST_CLEAR_MAP` 扩展 `leaderCharId` 字段，9 条 quest-clear 任务精确校验队长：

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

- `update_mission_progress` 只累计任务进度，不发奖、不解锁觉醒板。
- 客户端进入觉醒任务页面时请求 category 9 的 `get_mission_progress`；
  服务端在此结算已完成且尚未领取的阶段。
- `received` 来自 `players_category_mission_stages.status`，不再由完成进度推导。
- `mission_info` 使用奖励表第 0 列的 `mission_reward_id`，触发客户端官方任务奖励提示。
- 普通奖励从第 9 列开始解析；第 1-4 列的
  `AwakeManaBoard(character_id, board_index, awake_level)` 作为特殊奖励处理。
- 奖励发放、阶段领取状态和玩家货币更新在同一个 SQLite 事务中提交；重复进入页面不会重复发奖。


(End of file - total 85 lines)
