# 任务-关卡映射与严格规则

> 历史审计生成器: `scripts/gen_mission_event_quest_map.js`
> 历史审计资产: `assets/mission_event_quest_map.json`
> 严格规则生成器: `scripts/gen_mission_event_battle_rules.js`
> 运行时资产: `assets/mission_event_battle_rules.json`
> 覆盖范围: cat3 活动任务 2512 条；QuestRange 严格协力规则 805 条、type 23 精确通关规则 257 条，另有 415 条关卡/物品/竞速/阶段安全规则

`mission_event_quest_map.json` 是按 pattern 展开的旧映射，只供 `computer-event.ts` 历史审计。它没有完整表达
QuestRange selector、QuestRank、Host/Guest 和 Attention 来源，不能驱动自动事实。旧 939 条自动规则已从
`event-battle-facts.ts` 移除，但审计资产本身保留。

## 严格 QuestRange 规则

CN 1.8.1 的权威语义如下：

| `row[2]` | 事实 | 严格 role |
|:---:|------|------|
| 16 | 任意协力成功 | `any`，仍要求 `isMulti=true` |
| 17 | 房主协力成功 | `host`，只接受 `isMultiHost=true` |
| 18 | 成员协力成功 | `guest`，只接受 `isMultiHost=false` |
| 20 | Attention/救援 | 禁用，`FinishContext` 没有权威来源 |

`isMultiHost=undefined` 对 Host 和 Guest 都关闭匹配。普通 Guest 不得推断为 Attention。

| QuestRange | quest category | 结构化 quest ID 来源 |
|------|:---:|------|
| BossBattle | 2 | `boss_battle_quest.json` |
| Advent | 7 | `advent_event_quest.json`，绝不扩展到 category 8 |
| WorldStoryEventBossBattle | 19 | `world_story_event_boss_battle_quest.json` |
| `(None)` | `all` | 全 category、全 quest |

`row[10]=""` 解码为 `Within([])`，因此严格无匹配；`row[10]="(None)"` 才解码为 `All`。`row[11]` 是
QuestRank，不是 `clearRank`，当前 805 条启用规则的 `rank` 均为 `null`。生成器用数值复合 ID 分量匹配 event/group/
difficulty，不从文案推断，也不切割 quest ID 字符串。

严格资产按数值 mission ID 排序，覆盖 type 16 的 792 条（692 条有限 `questIds`、100 条全范围）、type 17 Host
的 12 条和 type 18 Guest 的 1 条，共 805 条。运行时只加载 `compatibility=null` 且枚举、selector、rank 均已知的规则；
未知值逐条 fail closed。mission 1400、1811 和 1807 等旧空 selector 任务不在资产中，1807 继续走持久化 fallback。

category 3 的 type 37 不依赖 QuestRange 资产。运行时从 `row[12]` 读取物品 ID，以
`players_collected_items` 的累计获得量结算 40 条交易商人任务；该白名单由 `computer-event-safe.ts` 承载。
同一白名单还承载土俑嘉年华的 54 条单关卡和 18 条聚合任务，以及崩坏域庆贺的 37 条单关卡和 7 条聚合任务。
这些规则只使用 `carnival_event_quest.json`、`challenge_dungeon_event_quest.json` 的精确关卡 ID 和玩家已持久化的
`players_quest_progress.finished`，不重新启用旧映射对所有活动任务的宽泛展开。
此外，188 条 category 11 竞速任务必须同时满足 type 15、QuestRange kind 8、`event_id * 1000 + suffix`
精确关卡、唯一旧映射和官方奖励秒数，并使用历史最佳毫秒值判断。狂热激战 category 24 的 42 条限时任务不使用
会把单关扩展为整期 8 个关卡的旧映射，而是由 QuestRange kind 17、精确 suffix 和 `rush_event_quest` 唯一闭合。
Ranking Phase 的 type 49～52 分别对应 Phase 1～4。服务端只接受 category 11 的成功单人结算，以
`eventId * 1000 + suffix` 精确定位 `ranking_event_single_quest.json` 中的关卡，并要求 `clear_phase` 为 1～4 的整数；
完成 Phase N 会推进同关卡不高于 N 的阶段任务。该字段来自官方 finish 请求，服务端不重算战斗阶段。
其他活动任务继续返回数据库持久化进度，`computer-event.ts` 和旧 quest map 仍只用于离线审计。

## Type 23 精确通关规则

257 条 type 23 任务由运行时直接验证主数据和官方关卡表，不读取旧 quest map：Advent 63 条、StoryEventSingle 7 条、
ChallengeDungeon 60 条、Raid 80 条、Rush 47 条。规则要求 `row[11]=(None)`，并按 `event_id * 1000 + suffix`
验证每个目标关卡真实存在；battle kind 1 只接受单人成功结算，battle kind 3 接受单人或多人成功结算。
错误 category、错误 suffix、失败和任务开放期外结算均不增长。

---

## 一、历史审计映射规则

### 通用原理

```
mission.col[7] → 选择 CDN quest 文件
mission.col[8] or col[9] → 在该文件中查找 stage_group/folder_id
CDN quest 文件的 row[0] = quest_id → 收集所有 difficulty 的 quest_id
```

### CDN 文件结构（通用模式）

```json
{
  "<stage_group或folder_id>": {
    "<difficulty_index>": [
      ["<quest_id>", "<element>", "<name>", ...]
    ]
  }
}
```

### 按 col[7] 分派

| col[7] | CDN 文件 | 映射键 | quest_category |
|:---:|------|:---:|:---:|
| 2 | `boss_battle_quest.json` | col[9]=stage_group | [2] |
| 5 | `advent_event_quest.json` | col[8]=stage_group | [7, 8]（旧审计近似；严格规则仅 7） |
| 7 | `challenge_dungeon_event_quest.json` | 全部 quest | [13] |
| 8 | `ranking_event_single_quest.json` | col[8]=key | [11] |
| 10 | `world_story_event_boss_battle_quest.json` | col[8]=event_id | [19] |
| 15 | `carnival_event_quest.json` | col[8]=folder_id | [22] |
| 16 | `raid_event_quest.json` | col[8]=stage_group | [23] |
| 17 | `rush_event_quest.json` | col[8]=event_id | [24] |

### 输出格式

```json
{
  "pattern_name": {
    "questIds": [1010001, 1010002, ...],
    "categories": [2]
  }
}
```

---

## 二、各类型详细说明

### A — BOSS_BATTLE (col[7]=2, 920 条)

**col[9] = stage_group** → `boss_battle_quest.json` 中该 stage_group 下的所有 difficulty 的 quest_id。

| col[9] | boss 名称 | quest_ids |
|:---:|------|------|
| 3 | 不死王瑞西塔尔 | 1003001~1003004 |
| 5 | 废墟守卫·火 | 1005001~1005004 |
| 6 | 废墟魔像 | 1006001~1006004 |
| 10 | 寄居蟹船长 | 1010001~1010004 |
| 12 | 诅咒弧魔艾基尔 | 1012001~1012004 |
| 14 | 白虎 | 1014001~1014004 |
| 16 | Sec-5200Li | 1016001~1016004 |
| 17 | 管理者 | 1017001~1017004 |
| 19 | 妖狐 | 1019001~1019004 |
| 20 | 八岐大蛇 | 1020001~1020003 |

八岐大蛇只有 3 个难度。col[9] 为空 = 全部 boss 都算。

### B — ADVENT_EVENT (col[7]=5, 481 条)

**col[8] = stage_group** → `advent_event_quest.json`。

含 5 个子类型：常规降临 boss、荒龙/废龙系列、精灵兽系列、机兵系列、联动活动。

荒龙系列 col[8] 对照：6(灼炎复刻), 7(凶暗), 10(雷废龙), 12(水废龙), 13(歼风), 18(凶暗复刻), 3000(灼炎再复刻), 3001(光废龙复刻)。

旧审计 map 使用 quest_category = [7, 8]。这不是 CN 1.8.1 QuestRange 的精确语义；严格自动事实仅使用 category 7。

### C — CHALLENGE_DUNGEON (col[7]=7, ~106 条)

全部指向 challenge_dungeon_event_quest.json folder=1 的 20+ 条 quest：

```
[1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029,
 1030, 1031, 1032, 1033, 1034, 1035, 1036, 1037, 1038, 1039, 1040]
```

category = [13]。

### D — RANKING_EVENT (col[7]=8, 230 条)

**col[8] = key** → `ranking_event_single_quest.json`。

| col[8] | 试炼名 | quest_id |
|:---:|------|------|
| 1 | 云水试炼 v1 | 1001 |
| 2 | 溢光试炼 v1 | 2001 |
| 3 | 旋风试炼 v1 | 3001 |
| 4 | 奔雷试炼 v1 | 4001 |
| 5 | 闪火试炼 v1 | 5001 |
| 1000 | 云水试炼 v2 | 1000001 |
| 1001 | 溢光试炼 v2 | 1001001 |

category = [11]。实测验证 ✅。

### E — WORLD_STORY_BOSS (col[7]=10, 342 条)

**col[8] = event_id** → `world_story_event_boss_battle_quest.json`。

| col[8] | 事件名 |
|:---:|------|
| 100300 | 大海的遗产 |
| 100401 | 幻彩摩天楼 |
| 100406 | HERO:BEGINNING |
| 100409 | 百兽王冠 |
| ... | (共 24 个事件) |

category = [19]。

### F — CARNIVAL (col[7]=15, 54 条)

**col[8] = folder_id** → `carnival_event_quest.json`。

同一套 quest (4001~4009) 被不同 col[8] 值复用。

category = [22]。

### G — RAID (col[7]=16, 96 条)

**col[8] = stage_group** → `raid_event_quest.json`。

category = [23]。

### H — RUSH (col[7]=17, 110 条)

**col[8] = event_id** → `rush_event_quest.json`。

| col[8] | 事件 |
|:---:|------|
| 700001 | 第一次狂热激战 |
| 700002~700007 | 第二~七次 |

category = [24]。

---

## 三、quest_category 速查

| QuestCategory | 编号 | 说明 |
|------|:---:|------|
| BOSS_BATTLE | 2 | 领主战 |
| ADVENT_EVENT_SINGLE | 7 | 降临讨伐 单人 |
| ADVENT_EVENT_MULTI | 8 | 降临讨伐 多人 |
| RANKING_EVENT_SINGLE | 11 | 时间试炼 |
| CHALLENGE_DUNGEON_EVENT | 13 | 深渊之兽 |
| WORLD_STORY_EVENT_BOSS_BATTLE | 19 | 世界故事 BOSS 战 |
| CARNIVAL_EVENT | 22 | 土俑嘉年华 |
| RAID_EVENT | 23 | 战阵之宴 |
| RUSH_EVENT | 24 | 狂热激战 |

---

## 四、追踪层架构

```
lib/quest/finish/trackers:
  character-clear-tracker.ts   — 角色出场/队长/联机计数
  powerflip-tracker.ts         — 弹射/冲刺全局计数
  leader-powerflip-tracker.ts  — 角色弹射 per-char 计数
  party-co-clear-tracker.ts    — 同队 pairwise 计数

DB 源表:
  players_quest_progress           — 关卡通关 (finished + multi_clear_count)
  players_character_quest_clears    — 角色出场 (clear/leader/multi/powerflip)
  players.total_*                   — 全局计数器
  players_party_member_co_clears    — 同队计数
  players_periodic_snapshots        — 每日快照

计算层:
  lib/mission/computer-*.ts        — 8 个 MissionComputer
  lib/mission/registry.ts          — registry dispatch
  assets/mission_event_quest_map.json — cat3 历史审计映射
  assets/mission_event_battle_rules.json — 805 条按 mission ID 的严格自动事实
```
