# 帮助文本审计 —— 活动框架线（第三批）

- **口径**：帮助正文 = 国服客户端 1.4.54 主数据 `wf-assets-cn/`（`rich_text/help_*`），只审"常青活动类型框架"，不审逐活动实例
- **服务端**：worktree `starpoint-cn-dev-integration` @ `a2e110b148836803eaebaef9b7360e7f87e8e3a3`（2026-11-05 07:29 +0800，docs(reference): help-text audits batch 2）
- **审计日期**：2026-11-05
- **方法**：帮助条款短引 ↔ 服务端 file:line（含 `wf-assets-cn/orderedmap/` 主数据交叉验证）；file:line 均已实地核对
- **判定词**：一致 / 偏差 / 未实现 / 不可对照 / 帮助未覆盖 / 已实现但语义待比 / 帮助有但我们无此活动类型

---

## 1. 框架映射总表

服务端活动族名（`src/content/converters/event-family.ts:31-152`，共 13 族）+ `QuestCategory`（`src/lib/types/quest.ts:5-34`）为映射锚点。CN 名称依据服务端自己的运营别名表（`src/lib/admin-activity.ts:16-30`），与帮助篇命名互证。

| 帮助篇（活动类型） | 服务端活动族 / QuestCategory | 核心实现 | 判定 |
|---|---|---|---|
| Event_Event.md（活动总述 + 迷宫加成点数） | 横切：迷宫加成点数=boostPoint、领主加成点数=bossBoostPoint | `src/data/domains/player.ts:1305-1306`；`src/lib/quest/entry-lifecycle.ts:279-330` | 已实现，语义基本一致（2 条待比，见 §2.1） |
| Event_Challenge.md（崩坏域） | challenge_dungeon_event / `CHALLENGE_DUNGEON_EVENT(13)` | `src/lib/quest-content.ts:426-427`；`assets/challenge_dungeon_event_quest.json` | 已实现，框架一致（兑换月更待比，见 §2.2） |
| ├ 深渊之兽（阿尔戈罗盘） | 同上（关卡 13_1038~1040） | `assets/quest_entry_costs.json`（itemId 30029=阿尔戈罗盘×1） | 已实现且语义一致 |
| Event_Advent_Thunder.md 等降临篇（降临讨伐） | advent_event / `ADVENT_EVENT_SINGLE(7)`、`ADVENT_EVENT_MULTI(8)` | `src/lib/quest-content.ts:419-421`；多协路 `src/multi/quest-availability.ts:13-14` | 已实现，语义一致（兑换一周窗口有实现，见 §2.3） |
| time_attack_event_water_01.md（竞速活动/试炼） | **ranking_event** / `RANKING_EVENT_SINGLE(11)`（CN 主数据 `ranking_event.json` 即 time_attack_event_*） | `src/lib/ranking-reward.ts`；`src/routes/api/rankingEvent.ts:27-127` | 已实现，语义基本一致（并列 tie-break 待比，见 §2.4） |
| Event_solo_time_attack.md（极时试炼） | solo_time_attack_event / `SOLO_TIME_ATTACK_EVENT(25)` | `src/lib/quest/daily-challenge.ts:73-75`；`assets/event_challenge_point_map.json`（solo_1→5001） | 已实现，但"时间线奖励"未实现（见 P2-3） |
| event_score_attack_event.md（无限演武） | score_attack_event / `SCORE_ATTACK_EVENT(27)` | `src/lib/quest/finish/score-attack-handler.ts:156-205` | 已实现（本文顺带核对，非本批指定篇） |
| Event_treasure_hunt_quest.md（宝藏猎人/摇曳水滴） | additional_reward collect_item_event 规则 | `src/lib/additional-reward.ts:128-157`；结算入口 `src/lib/quest/finish/single-settlement-writes.ts:209-222` | 已实现，但加成点数互斥条款**偏差**（P2-1） |
| treasure_cave_quest.md（宝物域） | challenge_dungeon_event（关卡 13_2001~2006，示宝金钥匙） | `assets/quest_entry_costs.json`（itemId 500000=示宝金钥匙×1）；门 `assets/quest_join_gates.json`（13_2001→主线 1008004） | 已实现且语义一致（见 §2.5） |
| Tower_Dungeon.md（幽玄域） | tower_dungeon_event / `TOWER_DUNGEON_EVENT(20)` | `src/lib/quest-content.ts:434-435`；480 关表 `assets/tower_dungeon_event_quest.json` | 已实现，但月度重置/跳层补发未实现（P2-4） |
| Event_Side_Story.md（外传） | （无 side_story 族） | `event-family.ts` 13 族中无；主数据 `side_story_config.json` 仅 1 行占位 `["9999"]` | **帮助有但我们无此活动类型**（数据本身未启用，见 §2.6） |
| help_campaign_battle.md（土用丑之日 battle 关卡） | 无专属类别：作为普通单人活动关卡 + stamina_campaign 折扣承载 | `src/lib/stamina-campaign.ts`（questType 0/2/7 等 453 条） | 已实现（承载方式泛化），语义一致（见 §2.7） |
| help_battle_support_campaign.md（超战斗支援） | stamina_campaign + daily challenge point | `src/lib/stamina-campaign.ts:129-145`；`src/lib/quest/finish/challenge-point.ts:24-37` | 体力减半一致；"次数变为 1 日 3 次"未实现（P2-2） |
| help_cheering_mainquest_campaign.md（主线关卡支援） | stamina_campaign（questType 0=主线） | `src/lib/stamina-campaign.ts:69-90`（category→questType 映射） | 已实现且语义一致 |
| help_reward_campaign.md（素材/育成助力） | reward_campaign（item/exp/mana 三通道） | `src/lib/reward-campaign.ts:80-158` | 已实现且语义一致（与迷宫加成点数分别计算，公式逐条吻合） |
| help_ushi_campaign.md（土用丑之日体力减半） | stamina_campaign | 同上 | 已实现且语义一致 |
| help_reward_100manyen_campaign.md（100 万円） | （无） | — | **帮助有但我们无此活动类型**（日服限定现金抽奖，CN 主数据无对应活动，合理缺失） |
| （参考）event_raid_event.md（团本/战阵之宴） | raid_event / `RAID_EVENT(23)` | `src/lib/quest/finish/raid-handler.ts:42-117`；`src/routes/api/raidEvent.ts:101-256` | 已实现（见 §3.1，为 handler 归属证据） |
| （参考）Help_haniwa_carnival_*.md（竞分/土俑嘉年华） | carnival_event / `CARNIVAL_EVENT(22)` | `src/lib/quest/finish/carnival-handler.ts:29-109` | 已实现（见 §3.2，为 handler 归属证据） |
| （无帮助篇）狂热激战 | rush_event / `RUSH_EVENT(24)` | `src/lib/quest/finish/rush-handler.ts:53-170`；`src/routes/api/rushEvent.ts:131-741` | **帮助未覆盖**（help 目录无 rush 篇；实现存在） |

注：`src/lib/quest/finish/race-utils.ts` 的 "race" 指**角色种族**（`getCharacterRaces`），与竞速活动无关，勿混淆。

---

## 2. 逐框架对照

### 2.1 Event_Event.md（活动总述 + 迷宫加成点数）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| "迷宫加成点数…每天可以使用3次，每天凌晨5点重置并回复到最大值" | `src/data/domains/player.ts:1305-1306`（跨日重置 `bossBoostPoint:3, boostPoint:3`）；`single-orchestrator.ts:65`（`dailyResetHour = 5`） | 一致 | 每日跨日重置为 3，重置时刻取 dailyResetHour=5 |
| "仅可用于每日关卡" | `src/routes/api/singleBattleQuest.ts:320,404`（`use_boost_point` 直通 ActiveQuest，无类别白名单） | 偏差(轻) | 服务端不校验类别，依赖客户端只在每日关卡提供开关；见 P3-2 |
| "战斗中途退出或失败后，消耗的点数和体力将被返还" | `src/lib/quest/entry-lifecycle.ts:279-330`（releaseEntryResources 退体力+入场道具）、abort 路径 `src/routes/api/singleBattleQuest.ts:263-307`（/abort 端点 + 退还后真实状态投影） | 一致 | abort 退还体力/入场道具；失败 finish（is_accomplished=false）不发放奖励即等同"未消耗点数"（点数在通关时才扣，见 challenge-point.ts:24-37） |
| "期间限定…每日刷新的游戏内容"（限时） | `src/lib/quest/open-period.ts:14-26`（availableFrom/Until）；`src/multi/quest-availability.ts:12-28` | 一致 | 起止窗口统一判定，结果码 4050 |

### 2.2 Event_Challenge.md（崩坏域）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| "可连续挑战强大领主的高难度关卡…推进主线关卡至一定程度后可挑战" | `src/lib/quest-content.ts:426-427`（challenge_dungeon_event_quest 表）；`assets/quest_join_gates.json`（13 族关卡有 viewable 前置） | 一致 | 入场前置由主数据 join gate 派生（`src/lib/quest-join-gate.ts:87`） |
| "仅可续战1次" / 多区域连续战 | 战斗内规则（客户端 Battle DSL）；服务端续战次数由 finish 请求 `continue_count` 传递（`src/lib/quest/finish/single-orchestrator.ts:172-174`，identity 校验 `single-finish-settlement.ts:80-98`） | 已实现但语义待比 | 服务端只做 playId/continueCount 一致性防伪，不做"≤1 次"上限校验（客户端权威） |
| "深渊之兽…挑战任意难度都必须消耗1个阿尔戈罗盘" | `assets/quest_entry_costs.json`：13_1038/1039/1040 → itemId 30029(阿尔戈罗盘)×1, stamina 0；扣点 `src/lib/quest/start-entry.ts:107-143` | 一致 | 通关时消耗（未通关不扣，见下条） |
| "在通关关卡前将不会消耗阿尔戈罗盘" | `src/lib/quest/finish/challenge-point.ts`（挑战点在 finish 结算扣）+ `src/lib/quest/entry-lifecycle.ts:310-320`（中断 restore 入场道具） | 一致 | 入场预扣、中断回滚、通关落账 |
| "通关对应属性区域后，会得到梦境纹章和强力装备" | 标准通关奖励（score_reward/clear_reward，`single-settlement-writes.ts:195-206`） | 已实现但语义待比 | 奖励内容由主数据掉落表决定，未逐活动核对 |
| "道具库存将在每月1日早上5点更新（崩坏域兑换）" | `src/lib/shop/catalog.ts:270-273`（shop_cost_item_schedule 按 月 建索引） | 已实现但语义待比 | 月度排程表已同步；"崩坏域兑换=活动道具兑换页"的库存刷新语义未逐条验证 |
| "可兑换的奖励组别会随游戏版本更新而追加" | 内容同步管线 `src/content/sync/table-registry.ts` | 一致 | 主数据版本化，随 sync 更新 |

### 2.3 Event_Advent_Thunder.md（降临讨伐框架，以黑雷荒龙篇为框架样本）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| "单人战斗和协力战斗…限时活动" | 类别 7/8（`src/lib/types/quest.ts:13-14`）；多人加入校验 `src/multi/quest-availability.ts:13-14`、加入门 `src/lib/quest-join-gate.ts:85`（7/8 共用 advent_event_quest） | 一致 | 单人/协力同表，限时窗口 `open-period.ts` |
| "击败强敌获得活动限定道具（金币与银币）" | 标准掉落（score_reward 组）+ 活动货币识别 `src/lib/event-currency.ts:60-70`（同族异代兑换道具按时间窗归一） | 一致 | 掉落物为普通 ITEM 奖励，活动期窗口内映射到当期代币 |
| "活动道具兑换…或商店中的活动物品兑换" | `src/lib/shop/catalog.ts:303-322`（event_item_shop → ShopType.EVENT_ITEM） | 一致 | 两个入口同一目录 |
| "活动物品兑换结束时间为活动结束后一周" | `src/lib/event-trade-expiry-settlement.ts:65-149`（load 时过期代币→玛纳，含溢出邮件）+ `src/lib/inventory/event-trade-expiry-plan.ts:34` | 一致 | 代币持有期由 item_inventory_policy 定义，过期折算玛纳并触发入账任务 |
| 体力/活动入场 | `src/content/converters/quest.ts:134`（advent 表 stamina 列 75）；campaign 折扣 questType 5 映射 `stamina-campaign.ts:75-76` | 一致 | CN 主数据中 questType 5 无 campaign 行（见 §4 数据观察） |

### 2.4 time_attack_event_water_01.md（竞速活动框架）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| "根据「通关时间」和「分数」与其他玩家争夺排名" | `src/lib/ranking-reward.ts:85-100`（placement：bestElapsedTimeMs + highScore + rankPercentage）；榜首参考线 `:107-135` | 一致 | 有完成耗时者按耗时升序、未完成按分数降序（与帮助"排名将根据讨伐时间计算，未能讨伐成功时则根据得分计算"同构） |
| "超时或全灭时也会保留成绩""讨伐时间将不计入战绩" | `src/lib/quest/finish/single-orchestrator.ts:129-157`（is_accomplished 照收、clearRank 照算）；进度写入 `score-attack-handler.ts:175-192`（仅 accomplished 才写 finished/highScore） | 已实现但语义待比 | ranking_event 族 finish 走标准结算，成绩落 players_quest_progress；"超时全灭保留分数、不记讨伐时间"的边界由客户端上报值决定，服务端未主动区分 |
| "超时或全灭后将不会返还消耗的体力"（对照：退出返还） | 中断返还 `src/lib/quest/entry-lifecycle.ts:287-302`；超时全灭=正常 finish 请求，不触发返还 | 一致 | finish（含超时/全灭）≠ abort，只有 abort 走 releaseEntryResources |
| "不可续战" | 无服务端续战接口（`continue_count` 仅作一致性字段） | 一致 | 竞速族无 continue 语义 |
| "退出关卡将视为未挑战成功，不会保留成绩。消耗的体力会被返还" | abort 路径：`src/routes/api/singleBattleQuest.ts:263-307` + `entry-lifecycle.ts:279-330` | 一致 | abort 不产生任何进度/成绩写入 |
| "排名将根据讨伐时间计算…战绩相同时，先计入排名的玩家将位列在前" | `ranking-reward.ts:85-103`（placement）与 `:107-135`（榜首排序 `best_elapsed_time_ms ASC, high_score DESC`，无先到先得 tie-break） | 偏差(轻) | 本服无真实对手榜（rank_percentage 为本服百分位），并列 tie-break 未实现；见 P3-3 |
| "完成各种条件通关后可获得任务奖励" | 活动任务域 `src/lib/mission/event-rule-catalog.ts:8-27`（timeClear/questMapping/challengeClear 等规则族） | 一致 | timeClear 规则即"指定时间通关"任务 |
| "活动结束后可获得排名奖励…排名发表后进入活动界面即可获得" | `src/routes/api/rankingEvent.ts:75-127`（receive_reward：首次发档位奖 status 1、重复领 status 2、无记录 status 3）；档位 `src/lib/ranking-reward.ts:150-166` | 一致 | 档位判定与客户端 getRankRating 同源注释 |
| "若排名发表期间中未领取排名奖励，奖励将通过邮件发送" | 未见自动补发邮件逻辑（`src/routes/api/rankingEvent.ts` 无 mail 分支） | 未实现 | 依赖玩家手动领取；过期未领无邮件兜底，见 P3-4 |
| "试炼复刻活动不会获得称号" | 档位奖励由 `ranking_event_ranking_reward.json` 数据决定（`ranking-reward.ts:150-157`），复刻期数据不含 degree 行即无称号 | 一致(数据驱动) | 复刻实例数据未逐条核对，框架上成立 |
| "活动战斗中无法收到救援请求" | `src/multi/quest-availability.ts`（活动族不进入多人可救池） | 一致 | |

### 2.5 treasure_cave_quest.md（宝物域）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| "通关主线关卡第1章8-4后才可挑战宝物域" | `assets/quest_join_gates.json`：13_2001/13_2002 → `[{category:1, questId:1008004}]`（1 章层 8 关 4）；加载 `src/lib/quest-join-gate.ts:87` | 一致 | 主数据直接锚定 1008004 |
| "每次挑战宝物域中的关卡都需要使用1个示宝金钥匙""通关关卡时会消耗" | `assets/quest_entry_costs.json`：13_2001~2006 → itemId 500000(示宝金钥匙)×1 + stamina 10；扣/退 `src/lib/quest/start-entry.ts:107-143`、`entry-lifecycle.ts:310-320` | 一致 | 与"通关前不消耗"同深渊之兽机制 |
| "只能进行单人挑战，无法进行共斗" | 多人可用性表不含宝物域实例（`src/multi/quest-availability.ts:12-28` 仅按类别+窗口；宝物域关卡无多人入口） | 一致 | 单人入口 singleBattleQuest/start；多人 create 路径无 13_2001 档位 |
| "宝物域内各关卡具有不同属性，掉落的培育道具也各不相同" | `assets/challenge_dungeon_event_quest.json`（属性/掉落列）+ `assets/quest_entry_costs.json` 逐关 stamina | 一致 | 数据驱动 |
| "示宝金钥匙能通过在兑换所兑换等方法获取" | `treasure_shop.json` 已同步（`src/content/sync/table-registry.ts:680`）；`campaign/treasure_vault_exchange` 未同步 | 已实现但语义待比 | 宝物域兑换所主表未接入，钥匙获取渠道覆盖不全，见 P3-5 |

### 2.6 Event_Side_Story.md（外传）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| "现在随时可以游玩过去举办的剧情活动" | 无 side_story 族：`src/content/converters/event-family.ts:31-152` 13 族无 side_story；主数据 `quest/event/side_story_config.json` 仅占位 `["9999"]`、`side_story_event_list.json` 16 行未同步 | 帮助有但我们无此活动类型 | CN 1.4.54 主数据中该系统未启用（config 为空占位）；过去活动复刻走 story_event 复刻实例（`*_re01`），非常驻外传 |
| "通关剧情后能获得在活动中登场的角色"（称号同理） | story_event 标准结算含角色/称号（`src/lib/story-join-character.ts`、degree 域） | 不可对照 | 前提（外传常驻入口）不存在 |
| "部分关卡需要消耗熟练证书以解锁" | 熟练证书=itemId 60001（`assets/item_lookup.json`），但 `assets/quest_entry_costs.json` 3045 条中无任何 60001 入场项 | 未实现 | 数据侧即无消费路径 |

### 2.7 Campaign 系（体力折扣与掉落加成）

**通用机制**：`stamina_campaign.json`（453 行，questType 分布 0:17 / 1:11 / 2:145 / 3:29 / 4:29 / 7:222）由 `src/lib/stamina-campaign.ts:32-56` 解析，`getActiveCampaignRate`（`:129-145`）取窗口内最小 rate；`src/lib/stamina-cost.ts:6-18` 应用为 `max(1, floor(base×rate))`；选择器语义按客户端 QuestRangeReferenceIdKindTools 三级/两级路径实现（`stamina-campaign.ts:92-127` 注释）。

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| help_ushi_campaign："部分特定关卡所需的体力将减少" | `stamina-campaign.ts:129-145` + `stamina-cost.ts:14-16` | 一致 | 按关卡选择器减体力，下限 1 |
| help_cheering_mainquest_campaign：同上（主线） | `stamina-campaign.ts:69-90`（MAIN→questType 0；CN 主数据 questType 0 有 17 行） | 一致 | |
| help_battle_support_campaign："部分对象关卡所需的体力将减少" | 同上（questType 2=领主战 145 行、7=崩坏域 222 行为主力） | 一致 | |
| help_battle_support_campaign："单人挑战讨伐战斗的挑战次数将变为1日3次" | `src/lib/quest/daily-challenge.ts:33-45`（lookup 静态 maxPoint）；`assets/daily_challenge_point_lookup.json` id1=9999；**`campaign/daily_challenge_point_campaign.json`（28 行活动期覆盖表）服务端零引用** | 未实现 | 见 P2-2；且 CN 主数据本身把 expert 次数设为 9999（见 §4 数据观察 A） |
| help_reward_campaign："特定关卡的掉落量将会增加" | `src/lib/reward-campaign.ts:80-98`（item/exp/mana 三通道，取最大 rate） | 一致 | |
| help_reward_campaign："增加的奖励将与迷宫加成点数的加成分别计算" + 例（2 倍活动 + 点数 → 4×3=12；仅活动 → 4×2=8；仅点数 → 4+4=8） | `reward-campaign.ts:124-135`：`floor(base×(campaignRate+(boost?1:0)))+serverDropMultiplier`；exp/mana 同构 `:137-158` | 一致 | 公式与帮助三例逐条吻合（4,rate2,boost0→8；4,rate2,boost1→12；4,rate0,boost1→8） |
| help_campaign_battle："期间限定的特别关卡。通关后能获得奖励。单人限定，不存在协力战斗" | 无专属"campaign battle"类别；此类关卡以普通活动关卡（boss/活动表）+ stamina_campaign 折扣承载；限时窗口 `open-period.ts`；单人=不进多人可救池（`multi/quest-availability.ts`） | 已实现(承载泛化) | 帮助是通用弹窗文本，无关卡级语义可逐条对照；判定"一致"按承载语义 |

---

## 3. finish handler ↔ 帮助活动类型归属证据（专项）

调度中枢：`src/lib/quest/finish/single-event-settlement.ts:114-198` —— `dispatchBuiltInEventSettlement(descriptor, {rush|raid|carnival|scoreAttack})`，descriptor 由 `event-settlement-descriptor.ts:56-100` 按 QuestCategory 生成。**四个 built-in handler 只服务四个类别，其余活动族走标准结算。**

### 3.1 raid-handler ↔ event_raid_event.md（团本/战阵之宴）

- 归属：`single-event-settlement.ts:116-131`（`QuestCategory.RAID_EVENT` → handleRaidEventFinish）；gate `raid-handler.ts:76`。
- "难易度越高，通关后能削减的世界领主的生命值也越多" → `killCountWeight` 权重推进：`raid-handler.ts:18-33`（advanceRaidBossState，weightedKillCount≥requiredKillCount 才 totalKillCount+1）；HP% = `raid-handler.ts:35-40`。
- "所有玩家将一同讨伐世界领主" → 领主状态为**全局共享**（`upsertRaidEventBossStateSync`，`single-event-settlement.ts:128-130`），非 per-player。
- "根据讨伐数量获得奖励（讨伐奖励）" → `src/lib/quest/finish/raid-overall-rewards.ts:15-27`（total 阈值 / each 间隔两种 requirement）；结算入口 `src/routes/api/raidEvent.ts:101-160`（summary 内 settleRaidEventSummary + receivedUpTo 游标）。
- "退出关卡将被视为未进行挑战，世界领主的生命值也不会减少。退出时体力返还" → handler 仅在 `questAccomplished` 时推进（`raid-handler.ts:76`）；退出走 abort 返还（`entry-lifecycle.ts:279-330`）。
- "奖励…任务奖励/讨伐奖励/排名奖励" → 讨伐奖励如上；任务奖励走 mission 域（raid summary 内 `settleMissionCategories`，`raidEvent.ts:160-166`）；排名奖励 `quest/event/raid_event_ranking_reward.json` 在 CN 主数据存在但**未同步进 assets、`src/` 零引用、无发放端点** → 未实现（见 P3-6）。
- "使用银森护石抽取代币扭蛋（抽空可重置）" → box gacha 域（`src/lib/box-gacha-*.ts`，reset 语义 `box-gacha-reset.ts`） | 已实现但语义待比（未逐条对帮助）。

### 3.2 carnival-handler ↔ Help_haniwa_carnival_*.md（竞分/土俑嘉年华）

- 归属：`single-event-settlement.ts:132-157`（`QuestCategory.CARNIVAL_EVENT` → handleCarnivalEventFinish）；gate `carnival-handler.ts:48`。
- "专用得分将根据「时间奖励」与「难度奖励」合计计算而得" → `carnival-handler.ts:65-67`：`difficultyBonus = difficultyScore`、`timeBonus = max(0, timeLimitMs - clearTime)`。
- "通关不同难度后，将记录最高的关卡分数作为挑战该领主的得分"（每领主取最高） → `carnival-handler.ts:68-72`：`totalBestScore = previous - previousFolderBest + max(previousFolderBest, totalScore)`，upsert 到 folder 维度记录。
- "合计分数奖励将在达到一定分数后直接发放""已获得的奖励无法重复获取" → `carnival-handler.ts:74-95`（getEligibleCarnivalRewards 按 totalBestScore 过滤已领）+ `src/lib/carnival-rewards.ts:77+`（threshold 语义，表 `carnival_event_total_score_reward.json`）+ claim 记录 `insertPlayerClaimedCarnivalRewardIdsSync`。
- "必须使用不同的队伍讨伐各领主（角色不重复）" → 专用编组：`src/routes/api/carnivalEvent.ts:19-57`（PartyCategory.CARNIVAL/RUSH 专用 SET，首参自动复制常规 1~3），重复编队仅记一分由客户端限制 | 已实现(入口)/客户端权威。
- "土俑嘉年华中的所有关卡都无法进行续关。退出关卡将被视为未进行挑战，也不记录分数。退出时体力返还" → 同 §2.4 机制（abort 返还；abort 不写分数；carnival handler 仅 accomplished 落账） | 一致。
- "追加3个专用编成SET…常规编成SET1~3自动复制" → `carnivalEvent.ts:20-29`（ensureSpecialEventPartyGroupsSync） | 一致。
- 活动任务 "carnivalClear" 规则 → `src/lib/mission/event-rule-catalog.ts:23`（`CARNIVAL_BATTLE_PATTERN_TYPE = 23`）。

### 3.3 rush-handler ↔（帮助无对应篇）

- 归属：`single-event-settlement.ts:115`（`QuestCategory.RUSH_EVENT` → handleRushEventFinish）；gate `rush-handler.ts:66`。
- 功能：folder 制（按关卡组推进，最终轮发放 folder 通关奖励 `rush-handler.ts:130-138`）+ endless 无限轮（最高轮/最短用时记录 `:92-117`）；排名奖励端点 `src/routes/api/rushEvent.ts:651-701`（endless 排名 × `rush_event_ranking_reward.json` 档位）。
- 判定：**帮助未覆盖**——`docs/help/` 无 rush 活动篇（ls+manifest 核对）；CN 别名"狂热激战"（`admin-activity.ts:27`）。实现完整度无法用帮助条款标尺衡量。

### 3.4 score-attack-handler ↔ event_score_attack_event.md（无限演武）

- 归属：`single-event-settlement.ts:158-197`（`SCORE_ATTACK_EVENT` → handleScoreAttackEventFinish）；档次奖励 `score_attack_border_reward.json`（`single-orchestrator.ts:144-157`）。
- 评级 B/A/S/SS 阈值 → `score-attack-handler.ts:91-100`；"分数超过历史最高才发档次奖励" → `:102-111`（newScore ≤ oldHighScore 不发）。
- 战绩历史（score_attack_history 域）→ `single-event-settlement.ts:159-173`。

---

## 4. 差异与问题清单

> P1=阻塞/错误发放或安全；P2=框架条款缺口/语义偏差；P3=轻偏差、待比或依赖客户端。

### P2

- **P2-1 宝藏猎人道具被加成点数放大（与帮助明文相反）**
  - 帮助：Event_treasure_hunt_quest.md L27 "活动道具将不会受领主加成点数与迷宫加成点数的影响而增加"。
  - 实现：collect_item_event（摇曳水滴 80001 等）走 `settleAdditionalRewardsSync`，数量经 `calculateScoreRewardAmount(..., boostPointUsed, ...)` 计算 → `src/lib/additional-reward.ts:174-181`；调用点传 `boostPointUsed: useBoostPoint` → `src/lib/quest/finish/single-settlement-writes.ts:209-222`。
  - 影响：使用迷宫/领主加成点通关掉水滴关卡时，水滴数量 = 基数×(campaignRate+1)，与官方"不受加成点数影响"不符，活动代币产出被放大（`rewardCampaignRates` 对 ITEM 默认 1，故日常偏差来源是 boost 的 +1 与运营 dropMultiplier）。
  - 建议：对 additional_reward 通道跳过 boost 加成（保留 campaign 率与 serverDropMultiplier 是否保留需裁决）。

- **P2-2 超战斗支援"挑战次数变为1日3次"未实现**
  - 帮助：help_battle_support_campaign.md L11。
  - 实现：`daily_challenge_point_campaign.json`（CN 主数据 28 行 expert_campaign_* 活动期覆盖）服务端零引用（全仓 grep 无命中）；服务端只读静态 `daily_challenge_point_lookup.json`（`src/lib/quest/daily-challenge.ts:25-31`）。
  - 缓释：CN 主数据 expert 次数本身=9999（见数据观察 A），"3 次"上限在 CN 语境已无意义；但若将来把 expert 次数改回官方值（2 次），活动期 +1 的覆盖表即缺失。
  - 建议：接入该表或在文档明示"CN 数据=无限次，覆盖表按死数据处理"的裁决。

- **P2-3 极时试炼"时间线奖励"未实现**
  - 帮助：Event_solo_time_attack.md L41-43 "以指定时间通关关卡后即可领取时间线更新奖励"。
  - 实现：CN 主数据 `quest/event/solo_time_attack_clear_time_reward.json` 存在，但未进 `assets/`（ls 无此文件），`src/` 全仓零引用。
  - 影响：极时试炼框架缺一条奖励通道（挑战次数限制本体已实现：`assets/event_challenge_point_map.json` solo_1→5001，`daily-challenge.ts:73-75`）。

- **P2-4 幽玄域月度重置/跳层补发未实现**
  - 帮助：Tower_Dungeon.md L15-17（每关卡每月 1 次、续战 1 次）、L27（每月 12 号 05:00 重置）、L29-31（上期通 18 层自动跳过前 15 层，跳过层报酬邮件补发）。
  - 实现：`tower_dungeon_event_quest.json`（480 关）+ join gate + 入场消耗/返还均可用（`quest-content.ts:434-435`、`quest-join-gate.ts:89`），但 `src/` 无任何 tower 月度重置/跳层/补发邮件逻辑（全仓 grep towerDungeon 仅 5 文件，均为表加载/门/别名）。
  - 影响：若运营上架幽玄域，"每月重置再刷"与"跳层邮件"两条框架条款无服务端支撑；一次性开放则影响有限。

### P3

- **P3-1 崩坏域兑换"每月1日早上5点更新"语义待比**：帮助 Event_Challenge.md L50；实现仅有 `shop_cost_item_schedule.json` 月度索引（`shop/catalog.ts:270-273`），崩坏域兑换页（活动道具兑换）库存刷新与"已达上限不可兑换"未逐条验证。
- **P3-2 "迷宫加成点数仅可用于每日关卡"无服务端类别闸**：`singleBattleQuest.ts:320,404` 对 `use_boost_point` 无类别白名单，依赖客户端入口；理论上可构造请求对任意类别使用（影响：点数池本就 3/日，放大上限有限）。
- **P3-3 竞速排名并列 tie-break（先计入者列前）未实现**：帮助 time_attack_event_water_01.md L58；本服排名为 rank_percentage 百分位模型（`ranking-reward.ts:85-166`），无真实并发榜，tie-break 语义自然弱化。
- **P3-4 排名奖励过期邮件补发未实现**：帮助 time_attack L78 / event_raid_event L70-72（"未领取将通过邮件发送"）；`rankingEvent.ts` receive_reward 仅手动领取，无过期补发。
- **P3-5 宝物域兑换所（treasure_vault_exchange）未同步**：帮助 treasure_cave_quest.md L21（钥匙获取渠道）；`campaign/treasure_vault_exchange` 在主数据存在、table-registry 无此表（仅 `treasure_shop.json`，`table-registry.ts:680`），钥匙获取链路覆盖不全。
- **P3-6 团本排名奖励未同步、无发放端点**：CN 主数据 `quest/event/raid_event_ranking_reward.json`（+ `raid_event_ranking_aggregation_schedule.json`）存在；`assets/` 未生成该表，`src/` 全仓零引用（对比：rush 的 `rush_event_ranking_reward.json` 已同步且有 `/reward` 端点 `rushEvent.ts:651-701`）；`raidEvent.ts` 端点仅 summary/get_boss/party/battle/start（`raidEvent.ts:101,258,290,373`）。帮助 event_raid_event.md L62/L70-72 的"排名奖励（过期邮件补发）"两条均无支撑。
- **P3-7 帮助文本命名撞车（记录性）**：help_campaign_battle.md CN 文自称"竞速活动"，与 time_attack/ranking 族的"竞速活动"重名；按任务口径该篇归"土用丑之日 battle 关卡"。实现无歧义（campaign battle 无专属类别），仅提醒后续审计按 rich_text key（help_campaign_battle）定位，勿按标题。

### 数据观察（帮助 ↔ CN 主数据本身不一致，服务端忠实于数据）

- **观察 A：单人挑战讨伐战斗次数**。帮助 Event_Expert_single.md L17 "上限为2次"；CN 主数据 `quest/event/daily_challenge_point.json` id1 = `["9999","999","true",...]` → 服务端 `daily_challenge_point_lookup.json` id1 maxPoint=9999。极时试炼同理（帮助"上限10次" vs 数据 9999）；追忆试炼=999。**判定：服务端与 CN 主数据一致，与帮助文字偏差属数据源差异，非实现错误。**
- **观察 B：stamina_campaign questType 覆盖**。CN 1.4.54 共 453 行，集中在 questType 2/7/3/4/0/1；降临(5)、剧情(6)、竞速(8)等族无折扣活动行——帮助中降临篇也未宣传体力折扣，互证一致。

---

## 5. 结论

- **覆盖面**：帮助所列 8 大活动框架 + 6 篇 Campaign 中，服务端已实现 **13 个活动族**（含本批重点的崩坏域/降临/竞速/宝物域/幽玄域 + raid/rush/carnival/score-attack 四 handler），Campaign 侧体力折扣（stamina_campaign）与掉落加成（reward_campaign）公式与帮助条款**逐条吻合**（含 help_reward_campaign 的三例算术）。
- **handler 归属铁证**：rush→RUSH_EVENT(24)、raid→RAID_EVENT(23)、carnival→CARNIVAL_EVENT(22)、score-attack→SCORE_ATTACK_EVENT(27)，调度点 `single-event-settlement.ts:114-198`；团本 handler 服务帮助《战阵之宴》型团本、carnival handler 服务帮助《土俑嘉年华》型竞分，语义（时间+难度得分、全局领主血量、讨伐奖励游标）与帮助一致。
- **真偏差集中在 4 个 P2**：宝藏猎人道具被加成点数放大（唯一"反向"语义偏差，建议修）；超战斗支援次数覆盖表未接入（CN 数据下暂无实害）；极时试炼时间线奖励未同步；幽玄域月度重置/跳层邮件未实现。
- **结构性缺失 2 项**：外传（side story）与 100 万円特别活动为"帮助有但我们无"，前者 CN 主数据即未启用（占位行）、后者为日服限定现金抽奖，均属合理缺失，但外传若要运营需补 side_story 族 + 熟练证书入场链路。
- **对照条数**：框架映射 20 行；逐框架对照 43 条（§2.1×4、§2.2×7、§2.3×5、§2.4×11、§2.5×5、§2.6×3、§2.7×7、§3 专项 15 条内嵌于归属证据）；问题清单 2+5+7=11 条（P2×4 + P3×7，另 2 条数据观察）。
