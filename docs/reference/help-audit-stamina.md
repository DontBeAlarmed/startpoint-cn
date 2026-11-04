# 帮助文本对照审计 — 体力 / 关卡（单人任务链）

- 口径：CN 主数据 **1.4.54**（wf-assets-cn）；服务端 **commit c9613534**（worktree starpoint-cn-dev-integration，`feat(tools): add in-game help extractor`）。
- 官方帮助正文：`docs/help/Quest.md`（来源 rich_text/help_quest，全文 58 行）；辅助参照 `docs/help/Menu.md`（练习关不耗体力、星导石优先使用免费、练习战斗记录）。
- 实现基准：体力链 `src/lib/stamina.ts`、`src/lib/stamina-cost.ts`、`src/lib/stamina-campaign.ts`；关卡链 `src/lib/quest-content.ts`、`src/lib/quest-entry-content.ts`、`src/lib/quest-join-gate.ts`、`src/lib/quest/finish/*`、`src/lib/mission/regular-quest-facts.ts`；路由 `src/routes/api/singleBattleQuest.ts`、`src/routes/api/questUnlock.ts`、`src/routes/cn/load.ts`。
- 客户端对照证据取自 `wf-cn-client-as3-20261014/`（1.8.1 补全版反编译）：端点映射 `scripts/pinball/remote/quest/{start,finish,abort,playContinue,unlock}/`，评价枚举 `scripts/boot_ffc6.as`，时限 `scripts/pinball/scene/battle/battle/{Battle,ElapsedTimeCalculatorImpl}.as`，体力公式 `scripts/pinball/common/data/quest/cost/StaminaCostCalculator.as` + `scripts/pinball/common/data/campaign/CampaignTools.as`。
- 判定分级：**一致 / 偏差 / 未实现 / 不可对照**（纯客户端行为或无服务端面）。file:line 均为该 commit 下真实可查位置。

## 一、对照表

### 1. 通关奖励（Quest.md L5）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「通关关卡后，可以获得级别经验、角色经验值，玛纳、装备道具、角色培育道具等」(L5) | 级别经验：`src/lib/quest/finish/battle-settlement-values.ts:112-116`（rankPointReward 入 rank_point）；角色经验：同文件 104-109 → `src/lib/quest/finish/single-settlement-writes.ts:229-237`（givePlayerCharactersExpSync）；玛纳：`battle-settlement-values.ts:88-96,110-111` → `single-settlement-writes.ts:145-173`（容量口径+溢出邮件）；装备/培育道具：首通 clearReward 与 S+ 奖励 `single-settlement-writes.ts:180-183`、分数奖励 `196-208`、追加奖励 `209-223` | 一致 | 五类奖励全部落地且仅通关（questAccomplished）发放：失败时全部归零（`battle-settlement-values.ts:88-115` 的 questAccomplished 门）并退还入场资源（`src/lib/quest/finish/single-entry-resource-settlement.ts:61-78`） |

### 2. 主线关卡（Quest.md L7-9）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「可从主城的“探索”进入并开始冒险」(L9) | — | 不可对照 | 主城菜单入口为纯客户端 UI；服务端面是 `single_battle_quest/start`（客户端 `QuestStartRealRemote.as:64`），已实现 |
| 「通关后可解锁新的关卡和新的世界」(L9) | `src/routes/api/singleBattleQuest.ts:350-366`（start 校验前置，未通关即拒）；前置数据 `src/lib/quest-entry-content.ts:75-80`；stage-node 派生 `src/content/converters/quest.ts:982-1078`（ex 可依赖 main 节点） | 一致 | 客户端节点口径 = 节点内**全部**关卡通关才算清（`wf-cn-client-as3-20261014/scripts/pinball/common/data/quest/common/QuestFolderLogicBase.as:114-116` isCleared = insufficient 为空）；服务端 352-358 行过滤全部未通关前置，语义同构。新世界（章节）解锁由服务端存储的 finished 进度驱动客户端 viewable |

### 3. 高难关卡（Quest.md L11-17）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「通关主线关卡各章节后解锁的高难度关卡」(L13) | 多人加入有门：`src/lib/quest-join-gate.ts:83-93,119-135`（viewable_need_quest 前置链），用于 `src/multi/http/battle.ts:210`、`src/multi/http/lobby.ts:146,271`；单人 start 只校验 main/ex 前置：`singleBattleQuest.ts:350-366`，而 `quest_prerequisites.json` 仅派生自 main/ex 两表（`src/content/converters/quest.ts:983`） | 偏差 | 官方 boss 战解锁是客户端 stage-node viewable（`scripts/pinball/common/data/quest/normal/bossBattle/BossBattleStageNodeLogic.as:126-141`）；本服多人路径已堵跳关（R-G04），**单人 start 对 category 2 不做档位前置校验**——改机客户端可越档开 boss 战（见 P3-1） |
| 「可以获得与主线关卡不同的奖励」(L15) | `src/content/converters/quest.ts:179-201`（boss_battle 独立 clearReward/storyClearReward/sPlusReward 列位）→ `src/lib/quest-content.ts:329-333` 读取 → 结算发放同第 1 条 | 一致 | boss 战奖励列独立于 main，随内容表配置下发 |
| 「可在章节选择页面中切换并进行挑战」(L17) | — | 不可对照 | 章节选择页为纯客户端 UI；服务端按 category+questId 无差别受理 |

### 4. 时限（Quest.md L19-25）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「若无法在各关卡的规定时间内通关，将视作超时并自动放弃挑战」(L21) | — | 不可对照 | 超时计时与强制退出是客户端行为：`wf-cn-client-as3-20261014/scripts/pinball/scene/battle/battle/Battle.as:1510-1523`（gotoTimeOverStateIfPossible ← ElapsedTimeCalculatorImpl.isTimeOver:193）。时限数据随主数据 timeLimit 列下发（派生 `src/content/converters/quest.ts:705,737`） |
| 「若未能在时限内通关，则视为超时并被强行退出关卡」(L25) | 服务端对失败局退还体力/入场道具并删活跃局：`single-entry-resource-settlement.ts:61-78` → `src/lib/quest/entry-lifecycle.ts` releaseEntryResources | 一致（服务端面） | 客户端超时以 `exitBattleSceneAsQuestFailure → QuestAbort` 退出（`scripts/pinball/scene/battle/BattleScene.as:1530-1541`，端点 `QuestAbortRealRemote.as:101`）；本服 abort 返还体力，与官方撤退默认返还一致（`BattleScenePlayingStateImpl.as:1698` BattleRetireDialog 显示 staminaReturnIfRetired）。服务端不复核 elapsed_time_ms 上限，见 P3-2 |
| 「通关时间越短，则通关评价将越高」(L23) | `src/lib/quest/finish/quest-calc.ts:3-11`（clearTime 与 sPlus/s/a/b 阈值比较；阈值列位 rankTimes [84,85,86,87]，`src/content/converters/quest.ts:161`） | 一致 | 评价严格单调于通关时长；score attack 类改用分数阈值（`single-orchestrator.ts:111-127`） |

### 5. 关卡结算与评价（Quest.md L27-31）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「通关关卡花费的时间以及通关评价都将显示在此画面中」(L29) | 响应回传 `clear_rank`、`old_high_score`：`src/lib/quest/finish/single-response-projector.ts:189,197` | 不可对照（显示）/一致（数据面） | 结算画面渲染在客户端；服务端回传评价与历史最高分 |
| 「通关评价从C~SS不等，评价越高则能获得的奖励也越多」(L31) | 评价：`src/lib/quest/finish/quest-calc.ts:3-11`（sPlus/s/a/b 阈值，超 b 记 C）；数量随评价：`src/lib/score-reward-lottery.ts:44-63`（commonRewardCounts[clearRank-1]，派生自 88-92 列 `src/content/converters/quest.ts:529-533`）；S+ 一次性奖励：`src/lib/quest/first-clear-reward.ts:12-23` + `single-settlement-writes.ts:182-183` | 一致 | 客户端枚举 C=1,B=2,A=3,S=4,SS=5（`wf-cn-client-as3-20261014/scripts/boot_ffc6.as:1659-1666`），与服务端 1..5 同构；评价越高 commonRewardCounts 档位越高 |

### 6. NEW RECORD / SCORE BONUS / BEST RECORD（Quest.md L33-49）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「NEW RECORD 本次通关花费的时间即通关评分」(L35-37) | 通关耗时/评分由客户端上报并落库：`single-settlement-writes.ts:118-132` → `src/lib/quest/finish/battle-quest-progress-plan.ts:47-85`；响应 `old_high_score` 供客户端判定 NEW RECORD（`single-response-projector.ts:189`） | 不可对照（判定显示）/一致（存储面） | NEW RECORD 弹出与否是客户端对比逻辑；服务端提供对比基线（旧最高分）并持久化新值 |
| 「SCORE BONUS 完成各种条件后获得的奖励评分」(L39-43) | — | 不可对照（计分） | 评分与 SCORE BONUS 条件判定全在客户端（`BattleContinuationData.scoreBonuses`，`scripts/pinball/common/data/battle/restore/BattleContinuationData.as`）；服务端收取 `score` 用于 score attack 评价与最高分。奖励评分对应的分数奖励落地一致（score_reward/rare_score_reward 抽选 `src/lib/quest/score-reward-selection.ts:41-69` → `single-settlement-writes.ts:196-208`） |
| 「BEST RECORD 通关本关卡的最佳记录与最佳分数。最佳记录与最佳分数将分别记录」(L45-49) | `battle-quest-progress-plan.ts:71-76`（bestElapsedTimeMs 取 min、highScore 取 max，独立字段独立比较） | 一致 | 时间与分数分别记录、互不覆盖；clearRank 也单独取历史最优（77-81） |

### 7. 中断战斗保留时间（Quest.md L51-57）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「中断战斗后若90天内都未再次登录游戏，则中断中的战斗将被删除」(L53) | 活跃局持久化：`src/data/domains/quest_active.ts:36-82`（无任何时间戳/TTL 列）；登录恢复：`src/routes/cn/load.ts:343-398`（无条件 restore，仅多人不可恢复房态才取消）；删除仅发生在 finish/abort/结算（`deletePlayerActiveQuestSync` 调用点仅 `single-settlement-writes.ts:303`、`single-entry-resource-settlement.ts:70`、`single-event-settlement.ts:195`、`active-quest-service.ts:162,206`） | **未实现** | 中断局（`players_active_quests` 行 + 已扣体力）无限期保留，无 90 天过期清理；官方“90 天未登录删除”语义缺失（见 P2-1） |
| 「若中断中的战斗遭到删除，则登录后不会提示是否回归战斗，并将直接跳转至主城画面」(L55) | — | 不可对照 | “提示回归战斗/直接回主城”是客户端登录流程行为（恢复选择对话框 `scripts/pinball/loading/battle/SingleBattleRestoreSelectLoadingTask.as`）；其前置（服务端过期删除）未实现，随 P2-1 |
| 「在被删除的战斗中使用的体力及续关使用的星导石都不会返还」(L57) | 星导石：续关即时扣款且无任何退款路径：`src/lib/quest/single-continue-lifecycle.ts:128-139`（免费优先→付费），abort/失败/删除均不退 vmoney；体力：主动撤退返还（`entry-lifecycle.ts` releaseEntryResources）与官方默认一致，但“删除不返还”对应的 90 天删除路径不存在 | 一致（星导石）/不可对照（体力，随 P2-1） | 官方删除场景的“不返还”以删除路径存在为前提；本服唯一删除路径（abort/失败）返还体力，方向与官方撤退一致（`BattleRetireDialog` 显示返还体力）。注意 P3-3：主数据 battle_no_stamina_return 有一关例外未消费 |

### 8. Menu.md 参照条款

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「在本关卡中玩家不仅能不消耗体力尝试挑战」(Menu.md L9) | `src/lib/stamina-cost.ts:6-18`：无入场费行 → cost 0。练习表（category 15）不在入场费派生范围：`QUEST_DERIVATION_LAYOUTS` 无 practice（`src/content/converters/quest.ts:128-150`），`assets/quest_entry_costs.json` 无任何 `15_` 键；扣费点 `src/lib/quest/start-entry.ts:145-151,161-164`（staminaCost=0 不更新体力） | 一致 | 练习关经同一 `/start`（`getQuestFromCategorySync` case PRACTICE，`quest-content.ts:430-431`），服务端按数据自然 0 扣费，无特判旁路 |
| 「战斗记录中将只保存最新的10场战斗」(Menu.md L17) | `src/data/domains/practice-battle-history.ts:14-15`（RETAIN_LIMIT=100 / RETURN_LIMIT=30）；读取 `src/routes/api/history.ts:65`（默认取 30） | 偏差 | 帮助承诺“只保存最新 10 场”；本服保留 100、单次返回 30。展示数量由客户端裁剪则玩家无感，但服务端保留面大于规格（P3-4） |
| 「※中断战斗并未继续挑战则该场战斗不会被记录」(Menu.md L19) | 战斗记录仅在 finish 落库：`single-settlement-writes.ts:265-270`；abort 路径无写入 | 一致 | 中断（abort）不产生练习记录；finishKind 0/1 区分完成与否 |
| 「同时拥有免费和付费星导石/玛纳时会优先使用免费星导石/玛纳」(Menu.md L49) | 续关扣款免费优先：`single-continue-lifecycle.ts:128-135`（freeSpent = min(free, cost)） | 一致 | 续关（星导石）走免费优先；与 Quest.md L57“续关使用的星导石”直接相关 |

## 二、差异与问题清单

### P1（玩家可见错误或资产损失）

无。本线未发现会造成奖励多发/资源错扣的玩家可见错误。

### P2（应补）

- **P2-1 中断战斗无“90 天未登录删除”过期机制**。官方：中断局保留，90 天未登录删除，删除后登录不提示直接回主城，体力与续关星导石不返还（Quest.md L53-57）。本服 `players_active_quests` 无时间列、登录恢复无条件（`src/routes/cn/load.ts:343-398`），删除仅由 finish/abort 触发。影响：中断局与其占用的体力无限期保留、客户端回归提示永不消失；官方的“过期删除+不返还”终态无法发生。玩家正常操作下无资产损失（我们不删，故无错删），属规格缺口。补法：load 时对 `players_active_quests` 行按“最后登录时间 + 90 天”静默删除（不返体力/道具），多人不可恢复房的取消路径（load.ts:370-391）已是现成样板。

### P3（建议）

- **P3-1 高难关卡单人 start 无档位前置校验**。`quest_prerequisites.json` 只派生 main/ex（`src/content/converters/quest.ts:983`），`/start` 对 category 2 的前置过滤形同虚设；多人加入已有 R-G04 参加门（`src/lib/quest-join-gate.ts:119-135`），单人路径仍信任客户端 viewable。改机客户端可越档直接开 boss 战。建议把 join gate 表同样用于 single /start。
- **P3-2 finish 不复核 elapsed_time_ms 上限**。`src/lib/quest/single-finish-validation.ts:178` 只要求正整数；`quest-calc.ts:3-11` 直接以上报时长定评价。上报 1ms 即得 SS 与 BEST RECORD（单机无可比对对手，风险有限，但污染 BEST/排行类数据）。建议按 `timeLimitMs`（已派生，`quest-content.ts:263`）+ 合理余量做上限校验，超限按失败/拒绝处理。
- **P3-3 主数据 battle_no_stamina_return 未消费**。CN 主数据 `wf-assets-cn/orderedmap/quest/battle_no_stamina_return.json` 恰 1 行（kind 6=降临 → quest 200001）：该关撤退**不返还体力**（客户端据此隐藏返还提示，`BattleQuestBaseImpl.as` `_staminaReturnIfRetired` ← BattleNoStaminaReturnTable）。本服 abort 一律返还（`src/lib/quest/entry-lifecycle.ts` releaseEntryResources 无条件按 staminaCost 退还），对该关多发 1 次体力（玩家有利方向，量级极小）。
- **P3-4 练习战斗记录保留面大于帮助口径**（对照表第 8 节已述）：保留 100 / 返回 30 vs 帮助“只保存最新的10场”。建议保留/返回收紧到 10，或确认客户端只展示 10 后在文档备案。
- **P3-5（潜在）getStaminaCost 对 rate=0 的体力活动会收 1 点体力**。`src/lib/stamina-cost.ts:15` `Math.max(1, Math.floor(entry.stamina * rate))`；客户端公式 rate=0 或成本=0 → 0（`wf-cn-client-as3-20261014/scripts/pinball/common/data/campaign/CampaignTools.as:38-42`），且本服自己的 `applyStaminaConsumptionRate`（stamina-cost.ts:24-27，guest/多人路径用）也是 0。当前 CN 主数据 453 条活动倍率只有 0.25/0.5，不触发；若未来配“0 耗活动”将出现单人路径扣 1 点的偏差。建议与 applyStaminaConsumptionRate 对齐（rate=0 → 0）。

### 已核对无偏差（备案）

- 多个体力活动叠加同一关时取最小倍率：客户端 `CampaignLogicBase.setStaminaCostRate` 仅在新倍率更小时覆盖（CampaignLogicBase.as:33-45）= 服务端 `Math.min`（`src/lib/stamina-campaign.ts:142`），一致。
- 撤退返还体力+入场道具、返还后真实状态投影（R-07）：`src/routes/api/singleBattleQuest.ts:263-311`，与客户端撤退对话框（BattleRetireDialog 显示 staminaReturnIfRetired / challengePointReturnIfRetired）一致；挑战点仅在通关 commit 时扣（`entry-lifecycle.ts` commitEntryResources），撤退不扣即“返还”。
- 章级里程碑（新世界解锁旁证）：`single-settlement-writes.ts:130` recordCompletedMainChapterMilestoneSync。

## 三、结论

Quest.md 可对照条款 17 条 + Menu.md 参照 4 条，共 21 条：**一致 11、偏差 2（boss 单人前置、练习记录保留面）、未实现 1（中断局 90 天过期删除）、不可对照 7**（均为纯客户端行为：探索入口、章节切换页、超时强制退出、结算/NEW RECORD 显示、SCORE BONUS 计分、删除后跳转主城、删除场景体力不返还）。奖励发放（五类）、评价 C~SS 与“评价越高奖励越多”、BEST/NEW RECORD 存储口径、练习 0 耗、续关星导石不返还且免费优先，均与官方文本及 1.8.1 客户端反编译语义逐项吻合；体力活动选择器/倍率聚合/先减免后折扣公式与客户端 StaminaCostCalculator 同构。核心缺口集中一处：**中断战斗生命周期缺“90 天未登录删除”终态（P2-1）**，其余为防改机与数据卫生层面的建议项（P3-1~P3-5），无 P1。
