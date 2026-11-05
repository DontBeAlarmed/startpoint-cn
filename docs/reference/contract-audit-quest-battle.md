# 客户端解析契约审计 — 单人战斗链 4 端点（single_battle_quest start / finish / abort / play_continue）

- 审计基线 commit：`dcaace599ae5718f70bc5ee8c559af5196cb2d60`（2026-11-05，docs(reference): client-parse contract audits — economy 14 + session 10 endpoints；`git log -1` 于 worktree starpoint-cn-dev-integration 读取）
- 客户端权威源：`wf-cn-client-as3-20261014/scripts/`（下文以 `client:` 缩写）；服务端源：本仓库（下文以 `server:` 缩写，路径相对仓库根）
- 方法：公共字段基线直接引用《contract-audit-economy.md》§0（`earlySuccessHandler` 公共字段管线 + `data_headers` 契约，本篇不重复计），逐端点读 `pinball/remote/quest/<动作>/<Xxx>RealRemote.as` 的 successHandler 解析代码列出客户端增量字段全集（类名+行号），对照服务端响应构造器（file:line）求差集。所有行号均为反编译 `.as` / TS 源文件真实行号。
- 判定口径：**缺口** = 客户端会读但服务端未发（P1 状态推进/经济可见错误、P2 UI/记录显示缺陷、P3 冗余/无害）；**冗余** = 服务端发但客户端完全不读（一律 P3 记录）。Optional 字段缺失时客户端走 `Option.None` 分支不抛错；标 `[必]` 的字段缺失即抛 ClientError（8700-8707）。
- 范围注记：`story_quest/finish` / `finish_with_skip`（story 链）与 `quest/unlock` 不在本批 4 端点范围；多人 `multi_battle_quest/*` 不在（另有链路）。**中断恢复没有独立服务端端点**（见 §5 恢复链说明），续关即 `play_continue`。

---

## 0. 端点定位与请求侧

| 端点 | client 请求构造 | server 路由 |
|---|---|---|
| `single_battle_quest/start` | client:`pinball/remote/quest/start/QuestStartRealRemote.as:64`（请求体 :42-58：category/quest_id/party_id/play_id/use_boost_point/use_boss_boost_point/combat_power/is_auto_start_mode/auto_start_times?） | server:`src/routes/api/singleBattleQuest.ts:313`（注册前缀 `server:src/server.ts:117`、`src/cn-server.ts:364-365`） |
| `single_battle_quest/finish` | client:`pinball/remote/quest/finish/BattleQuestFinishRealRemote.as:79`（resolvePath）+ `BattleQuestFinishRemoteUtil.createRequest:118-244`（:188-198 category/quest_id/play_id/add_mana/score/continue_count/elapsed_time_ms/is_accomplished/is_restored/statistics/equipment_element；:205 sub_statistics?；:247-263 多人增量；:266-268 is_lose?） | server:`src/routes/api/singleBattleQuest.ts:149`（校验 `src/lib/quest/single-finish-validation.ts:56-72`） |
| `single_battle_quest/abort` | client:`pinball/remote/quest/abort/QuestAbortRealRemote.as:93,101`（请求体 :70-91：play_id/reproduce_log_data/finish_kind/category?/quest_id?/statistics?/sub_statistics?） | server:`src/routes/api/singleBattleQuest.ts:263` |
| `single_battle_quest/play_continue` | client:`pinball/remote/quest/playContinue/QuestPlayContinueRealRemote.as:22-40`（payment_type **硬编码 1**=有偿续关，:38） | server:`src/routes/api/singleBattleQuest.ts:515`（校验 `payment_type === 1` :533） |

**恢复链说明（对应范围第 4 项）**：客户端没有 quest/resume 类服务端调用。中断恢复全部走客户端本地存档：`SingleBattleStartFlow.finish` → `restore.saveBattleRestore(BattleRestoreHeaderValues...)`（client:`pinball/loading/battle/SingleBattleStartFlow.as:200-205`）；服务端仅在 **abort / finish 响应给出 `unfinished_play_id`** 时触发 `restore.readBattleHead`（abort:`QuestAbortRealRemote.as:403-412`；finish:`BattleQuestFinishRealRemote.as:2531-2545`），用于"未完局恢复选择"（多人未完局场景；单人本地恢复不依赖它）。续关星导石回执 = `play_continue` 响应经公共层 `user_info.free_vmoney/vmoney` 同步（§4）。

---

## 1. single_battle_quest/start

**客户端解析** — client:`pinball/remote/quest/start/QuestStartRealRemote.as` successHandler:126-278，端点级只读 2 个字段 + 1 个 header：

| 字段 | 类型 | 必需 | 行号 | 客户端去向 |
|---|---|---|---|---|
| `data.client_checks` | Option&lt;Array&lt;String&gt;&gt;（客户端 `MissionClientCheckTable` 主数据键） | 可选 | :155-183 | `QuestStartRemoteInput.Finished` :258,272 → `BattleClearParameter.clientChecks`（`pinball/common/data/quest/battle/BattleClearParameter.as:122`）→ 战斗内 `MissionClientCheckManagerImpl`（`pinball/scene/battle/battle/Battle.as:1249`）→ 结算 echo 进请求 `statistics.client_checks`（`BattleClearParameter.as:268`，取自 `missionClientCheckManager.getClearedIds()`，`Battle.as:2620`） |
| `data.follow_bonus_info` | Option&lt;Array&lt;{follow_bonus_list StringMap[String→Float][必], total_follow_bonus Float[必], viewer_id Float[必]}&gt;&gt; | 可选 | :184-257 | 多人 follow 加成（单人无关） |
| `header.servertime` | Float | **必需**（None→ClientError 5000） | :261-271 | `applyQuestStart` 入局时间（`pinball/loading/battle/SingleBattleStartFlow.as:272`） |

错误路径：`data_headers.result_code == 4050` → `OutOfPeriodError`（`QuestStartRealRemote.as:283-297` defaultErrorHandler）。
`client_checks` 缺失时的客户端行为：`SingleBattleStartFlow.applyQuestStart:256-268` None→空数组 → `MissionClientCheckInfo.resolve([])`（`pinball/scene/battle/battle/mission/MissionClientCheckInfo.as:26-37`）→ 战斗内客户端检查清单为空（不崩溃）。

**服务端发送** — server:`src/routes/api/singleBattleQuest.ts:486-512`：
- `data`：`user_info{last_main_quest_id, stamina, stamina_heal_time}`(:493-497)、`item_list`(:498)、mission fragment（:505-507，mission_info/active_mission_list 等）、`mail_arrived`(:508)、`category_id`(:500)、`is_multi:"single"`(:501)、`start_time`(:502)、`quest_name:""`(:503)；公共层会再合并（mergeCommonResponseFragments）。
- `data_headers.servertime`：`generateDataHeaders`（:486-488）。
- 错误路径：out-of-period `data:{}` + `result_code:4050`（:368-378）；连抽体力中止 `result_code:4050`（:467-477，`AUTO_START_STOP_RESULT_CODE` 同值）。

**差集判定**：
| 判定 | 字段 | 说明 |
|---|---|---|
| 缺口 | `client_checks` | 服务端从不发送（全文件无该键）→ 客户端检查通道空转，见 G-1（P3） |
| 正确缺席 | `follow_bonus_info` | 多人专用；单人无 follow，缺席即官方语义 |
| 冗余 | `category_id` / `is_multi` / `start_time` / `quest_name` | start 解析器不读（只读 client_checks/follow_bonus_info），公共层也无这 4 键 |
| 冗余 | `user_info.last_main_quest_id` | 客户端只在 initialize 响应读该键（client:`pinball/remote/initialize/InitializeRealRemote.as:3761-3772`），start 的 user_info 消费方 `applyCommonResponseUserInfo`（`pinball/common/data/player/PlayerLogic.as:2708`）不读 |

---

## 2. single_battle_quest/finish（重点）

**客户端解析** — client:`pinball/remote/quest/finish/BattleQuestFinishRealRemote.as` successHandler:135-2545，结果对象组装 :2490-2517。29 个字段：

`[必]`（缺失即抛 8700-8707）：

| 字段 | 结构 | 行号 |
|---|---|---|
| `data.before_rank_point` | Int | :323-329 |
| `data.bond_token_status_list` | Object map（角色id → {before[], after[]}，元素 {mana_board_index Int[必], status Int[必]}） | :334-430 |
| `data.drop_additional_reward_ids` | Array {group_id Int[必], index Int[必], number Int[必]} | :597-639 |
| `data.drop_periodic_reward_ids` | 同上 | :641-683 |
| `data.drop_rare_reward_ids` | 同上 | :685-727 |
| `data.drop_score_reward_ids` | 同上 | :729-771 |
| `data.joined_character_id_list` | Array&lt;Int&gt; | :929-945 |
| `data.presigned_quest_category` | Array（战斗日志上传的类别白名单） | :1153-1169 |
| `data.rewards` | Object，4 子字段全 Int[必]：field_mana / overflow_pool_exp / reward_mana / reward_pool_exp | :1373-1408 |
| `data.old_high_score` | Float（&lt;`Score._MIN` 抛 2375，`pinball/common/data/quest/score/_Score/Score_Impl_.as:26-29`） | :975-980 |

`[Option]`（null→None 安全）：

| 字段 | 结构 | 行号 | 消费点 |
|---|---|---|---|
| `data.aborted_play_id` | String | :254-266 | `logicStatus.addAbortedQuest`（`pinball/loading/quest/BattleQuestFinishLoadingTask.as:321-330`，复现日志） |
| `data.add_exp_list` | Array {add_exp Int[必], after_exp Int[必], character_id Int[必]} | :268-321 | `createExperienceVariation`（BattleQuestFinishLoadingTask.as:434） |
| `data.carnival_event` | {is_record_valid Bool[必], leader_character_id Int[必], new_degree_ids Array[Int][必], previous_total_best_score Float[必], reward_ids Array[Int][必], score{difficulty_bonus Float[必], time_bonus Float[必]}} | :434-540 | `SingleOrMultiBattleQuestFinishProcess.as:152-168` → carnivalEventContext + `setCarnivalEventUpdateScoreData` |
| `data.clear_rank` | Int | :542-554 | BattleQuestFinishLoadingTask.as:346,386,403（SS 判定 :348 `==5`） |
| `data.drawn_quest` | {category_id Int[必], odds_id Int[必], quest_id Int[必]} | :556-595 | `QuestRepository.updateDrawnQuest`（BattleQuestFinishLoadingTask.as:412；`pinball/common/data/quest/repository/QuestRepository.as:210-236`） |
| `data.follow_info` | Array（多人 follow 名单 11 子字段） | :773-913 | 多人专用 |
| `data.host_finished` | Bool | :915-927 | applyQuestProgress `is_host_cleared`（BattleQuestFinishLoadingTask.as:384,401） |
| `data.mission_tips` | Bool | :947-959 | `devConfig.missionTips`（BattleQuestFinishRealRemote.as:2493，调试用） |
| `data.need_feedback` | Bool | :961-973 | 结果页 `needFeedback`（BattleQuestFinishLoadingTask.as:494，问卷入口） |
| `data.party_info` | {ability_soul_ids[], character_ids[], equipment_ids[], options{allow_other_players_to_heal_me}, party_edited, party_id, party_name, unison_character_ids[]}（8 子字段，Some 时子字段全[必]） | :982-1151 | `PlayerLogic.updatePartyInfo`（BattleQuestFinishLoadingTask.as:369；`pinball/common/data/player/PlayerLogic.as:178-188`） |
| `data.presigned_url` | String | :1171-1183 | 非空→`sendToLogFile` 战斗日志上传（:2519-2530） |
| `data.raid_event` | {auto_start_point, is_out_of_period, quest_boss{kill_count}, raid_boss{hp_percentage, total_kill_count}} | :1185-1260 | 事件结算 |
| `data.ranking_event` | {is_record_valid, best_record{elapsed_time_ms,is_accomplished,score}, previous{同}} | :1262-1371 | `SingleOrMultiBattleQuestFinishProcess.as:102,153-236` getRankingEventRecordHistory → applyQuestProgress :404 |
| `data.rush_event` | {best_elapsed_time_ms, endless_battle_max_round, endless_battle_next_round, endless_battle_played_party_list, high_score, is_out_of_period, old_best_elapsed_time_ms, old_endless_battle_max_round, rush_battle_played_party_list, rush_battle_reward_list{kind,kind_id,number}}；子字段全 Option 化；**两个 played_party_list 是 round 键 IntMap**（Reflect.fields+Std.parseInt，:1487-1496） | :1413-2194 | 结算页 rush 面板 |
| `data.score_attack_event` | {main_character_ids, reward_ids} | :2196-2255 | `SingleOrMultiBattleQuestFinishProcess.as:339+` scoreAttackEventContext |
| `data.solo_time_attack_event` | {elapsed_time_ms Float[必], main_character_ids, new_degree_ids, previous_best_elapsed_score Option, previous_best_elapsed_time_ms Option, reward_ids} | :2257-2373 | `SingleOrMultiBattleQuestFinishProcess.as:260-318` soloTimeAttackEventContext + `setSoloTimeAttackEventUpdateRecordData` |
| `data.unfinished_play_id` | String | :2375-2387 | Some→`restore.readBattleHead`（:2531-2545） |
| `data.user_notice_list` | Array {kind Int[必], status Int[必]} | :2389-2434 | `PlayerLogic.updateUserNoticeList`（BattleQuestFinishLoadingTask.as:370；PlayerLogic.as:137-166；商店等 badge 消费） |
| `data.user_periodic_reward_point_list` | Array {id Int[必], point Int[必]} | :2436-2486 | `PlayerLogic.applyPeriodicRewardPointList`（BattleQuestFinishLoadingTask.as:371；PlayerLogic.as:2482-2490） |

公共增量（character_list / item_list / equipment_list / user_info / mission_info / active_mission_list / user_daily_challenge_point_list / over_max / mail_arrived）经 `earlySuccessHandler` 基线（client:`pinball/context/remote/real/RealRemoteService.as:1960-1976`）→ 见《contract-audit-economy.md》§0，不重复计。

**服务端发送** — server:`src/lib/quest/finish/single-response-projector.ts`：
- 正常结算 `buildSingleFinishResponse:103-243`：user_info(10 子字段 :141-152)、character_list(:153,174)、equipment_list(:156-163,175)、item_list(:164,176)、mission_info(:165,177)、over_max(:138,167,178)、mail_arrived(:166,179)、`add_exp_list`(:180，条目 {character_id, add_exp, after_exp, add_exp_pool}，`src/lib/character-growth/commands/grant-character-exp.ts:154-162`)、`bond_token_status_list`(:181，条目 {before,after}×{mana_board_index,status}，`src/lib/character-growth/invariants.ts:122-129`)、`rewards`(:182-188)、`old_high_score`(:189)、`joined_character_id_list`(:190-195)、`before_rank_point`(:196)、`clear_rank`(:197，null→5)、`drop_score_reward_ids`/`drop_rare_reward_ids`(:198-199，条目 {group_id,index,number}，`src/lib/quest/score-reward-projection.ts:43-45`)、`drop_additional_reward_ids`(:200)、`drop_periodic_reward_ids`(:201，恒 [])、`category_id`(:202)、`start_time`(:203)、`is_multi`(:204)、`quest_name`(:205)、`raid_event`(:206)、`rush_event`(:207)、`carnival_event`(:208)、`score_attack_event`(:209)、`user_daily_challenge_point_list`(:210)、`presigned_quest_category`(:211，恒 [])、`active_mission_list`(:212)、`degree_list`(:213，恒 [])、mission/awake fragment(:218-237)。
- 旧局迟到终态 `buildStaleSingleFinishResponse:257-315`：同形全字段零奖励（[必] 字段齐备，clear_rank=0）。
- 事件增量构造：rush `src/lib/quest/finish/rush-handler.ts:152-163`（10 键与客户端一一对应；played party 条目 18 子字段 `src/data/domains/rushEvent.ts:368-391`，round 键对象 `src/lib/rush.ts:34-56`）；raid `src/lib/quest/finish/raid-handler.ts:109-115`；carnival `src/lib/quest/finish/carnival-handler.ts:99-105`；score_attack `src/lib/quest/finish/score-attack-handler.ts:200-203`；事件分发仅 rush/raid/carnival/scoreAttack 四类 `src/lib/quest/finish/event-settlement-descriptor.ts:36-50`。

**差集判定**：
| 判定 | 字段 | 说明 |
|---|---|---|
| 缺口 | `solo_time_attack_event` | 恒 null（projector :209；descriptor 无该类别）→ G-2（P2） |
| 缺口 | `drawn_quest` | 服务端单人 finish 不发（仅 multi 路径显式 null，`src/multi/http/battle.ts:556`）→ G-3（P3，条件升级） |
| 缺口 | `user_notice_list` | 不发 → G-4（P3） |
| 缺口 | `party_info` | 不发 → G-5（P3） |
| 缺口 | `need_feedback` / `mission_tips` | 不发 → G-6（P3） |
| 缺口 | `host_finished` | 不发 → G-7（P3） |
| 缺口 | `aborted_play_id` / `unfinished_play_id` / `presigned_url` / `follow_info` | 不发 → G-8（P3） |
| 匹配 | 全部 `[必]` 字段 + rush/raid/carnival/score_attack 增量 | 正常与 stale 两条路径均齐备，无 P1 |
| 冗余 | `rewards.converted_pool_exp` | 客户端 rewards 只读 4 子字段（:1399-1408），第 5 键被忽略 |
| 冗余 | `add_exp_list[].add_exp_pool` | 客户端条目只读 3 键（:293-315） |
| 冗余 | `category_id` / `is_multi` / `start_time` / `quest_name` | finish 解析器与公共层均不读 |
| 冗余 | `degree_list` | 客户端 finish 流不读；同名结构仅 `pinball/remote/profile/getDegreeList/ProfileGetDegreeListRealRemote.as` 消费 |

---

## 3. single_battle_quest/abort

**客户端解析** — client:`pinball/remote/quest/abort/QuestAbortRealRemote.as` successHandler:109-420，**5 个字段全部 Option**：

| 字段 | 行号 | Some 时行为 |
|---|---|---|
| `data.aborted_play_id` | :143-155 | `logicStatus.addAbortedQuest`（复现日志） |
| `data.drawn_quest` | :157-196 | 同 finish |
| `data.party_info` | :198-366 | `updatePartyInfo`（结构同 finish） |
| `data.presigned_url` | :368-380 | 战斗日志上传 |
| `data.unfinished_play_id` | :382-401 | Some→`restore.readBattleHead`（:403-412，"有未完局"提示/恢复选择） |

**服务端发送** — server:`src/routes/api/singleBattleQuest.ts:289-311`：`user_info`（撤退退还后的真实体力/ mana / vmoney，:297-302）、`item_list`（:303，退还后入场道具）、`category_id`(:305)、`is_multi`(:306)、`start_time`(:307)、`quest_name`(:308)。

**差集判定**：5 个端点级字段全部未发 —— 全为 Option，客户端走 None 分支不抛错；`unfinished_play_id` 缺席意味着撤退后不触发恢复头读取，对单人战斗是正确语义（单人恢复走本地存档，见 §0）。`user_info/item_list` 经公共层正常生效（体力退还回显）。`category_id/is_multi/start_time/quest_name` 4 键为冗余（abort 解析器与公共层均不读）。无 P1/P2。

---

## 4. single_battle_quest/play_continue（续关星导石回执）

**客户端解析** — client:`pinball/remote/quest/playContinue/QuestPlayContinueRealRemote.as` successHandler:43-56：仅校验 `data` 为 Object（空对象即可），**端点级零字段**，组装 `QuestPlayContinueRemoteInput.Finished({})`（:54）。续关花费的实际回执经公共层：`user_info.free_vmoney` / `user_info.vmoney`（`pinball/common/data/player/PlayerLogic.as:2708-2725` applyCommonResponseUserInfo）+ `mail_arrived`。

**服务端发送** — server:`src/routes/api/singleBattleQuest.ts:574-586`：`user_info{free_vmoney, vmoney}`(:580-583) + `mail_arrived`(:584)。

**差集判定**：完全匹配，无缺口、无冗余。（注：客户端 `payment_type:1` 硬编码有偿续关，服务端 :533 同步强校验，一致。）

---

## 5. 缺口清单

| 编号 | 端点 | 缺失字段 | 级别 | 影响 |
|---|---|---|---|---|
| G-1 | start | `client_checks`（Array&lt;String&gt;，MissionClientCheckTable 键） | **P3** | 客户端战斗内检查清单为空（`Battle.as:1249` → 空表不崩溃），结算请求 `statistics.client_checks` 恒 `[]`（`BattleClearParameter.as:268`）。服务端无消费者（仅多人 category 26 诊断日志打印，`src/multi/settlement/orchestrator.ts:206` + `src/lib/mission/client-check-diagnostics.ts:31`）；本服任务引擎自评条件（`src/lib/mission/battle-facts.ts` 体系）。检查种类全为 Debuff*/Coffin 类（client:`pinball/master/generated/MissionClientCheckValues.as:22+`），**若复刻"击杀时敌方处于指定弱化状态"类官方条件，必须先补此字段**。CN 主数据（wf-assets-cn）无 mission_client_check 表，键表内嵌客户端。 |
| G-2 | finish | `solo_time_attack_event`（SOLO_TIME_ATTACK_EVENT=25） | **P2** | 服务端事件描述符只支持 rush/raid/carnival/scoreAttack（`event-settlement-descriptor.ts:36-50`），响应恒 null。客户端解析 Option 安全，但该类关卡结算时 `SingleOrMultiBattleQuestFinishProcess.as:260-318` 的 record 上下文（isNewRecord / previous_best / reward_ids / new_degree_ids → `setSoloTimeAttackEventUpdateRecordData`）整段跳过：结算页无时间记录展示、客户端本地 soloTA 记录与奖章进度不更新。内容管线已收录该类别（`src/content/converters/quest.ts:146` category 25），一旦 CN 活动窗口启用即玩家可见。 |
| G-3 | finish | `drawn_quest`（{category_id, odds_id, quest_id}） | **P3**（条件升级 P1） | 日替/週替类（DAILY_WEEK_EVENT=6、DAILY_EXP_MANA_EVENT=14）关卡官方在 finish 后下发 odds 抽选回执，客户端记入 `drawnQuestList`（`QuestRepository.as:210-236`）；`DailyWeekEventQuestLogic.as:72-99` 在抽中关卡的 oddsId 解析依赖该记录（无记录抛 2760）。服务端不实现 odds 抽选 → 客户端永不标记抽中，流程退化为"无追加抽选"而非报错；**若启用该类活动的抽选玩法则需先补**。 |
| G-4 | finish | `user_notice_list`（{kind,status}[]） | P3 | 客户端 badge 状态不再被响应推进（`PlayerLogic.as:137-166` None 早退；商店等场景消费 noticeList），本服从不发 → badge 停留在本地默认值，无功能性破坏。 |
| G-5 | finish | `party_info`（8 子字段） | P3 | `updatePartyInfo` None 早退（`PlayerLogic.as:178-188`）。本服单局不改服务端队伍，无漂移源；仅当引入服务端改队逻辑（如官方 fixed-party 恢复）时需要。 |
| G-6 | finish | `need_feedback` / `mission_tips`（Bool） | P3 | 结算页问卷入口不出现、`devConfig.missionTips` 不更新（调试开关）。语义上私服可有意保持缺席。 |
| G-7 | finish | `host_finished`（Bool） | P3 | applyQuestProgress `is_host_cleared=None`（BattleQuestFinishLoadingTask.as:384,401）；单人本机即 host，进度语义不依赖。 |
| G-8 | finish / abort | `aborted_play_id` / `unfinished_play_id` / `presigned_url`（+`follow_info`） | P3 | 复现日志追加、未完局服务端信号、战斗日志上传、follow 名单均不触发；前两者缺席对单人是正确语义，`presigned_url` 是官方诊断通道。 |

**冗余记录（服务端发、客户端单人战斗链完全不读，均 P3）**：
- start/finish/abort 三响应共有的 `category_id`、`is_multi`、`start_time`、`quest_name`（start:491-504 / finish:projector:202-205 / abort:305-308；三处解析器与公共层均无读取）。
- start `user_info.last_main_quest_id`（仅 initialize 读，InitializeRealRemote.as:3761）。
- finish `rewards.converted_pool_exp`（projector:184）、`add_exp_list[].add_exp_pool`（grant-character-exp.ts:159）、`degree_list`（projector:213）。

**P1 缺口：无。** 全部客户端 `[必]` 字段（finish 10 项、start/abort/play_continue 0 项）在正常与 stale 两条响应路径均发送且类型正确；事件增量 rush/raid/carnival/score_attack 的子字段结构与客户端逐键吻合（含 round 键 IntMap 形态）。

---

## 6. 结论

单人战斗链 4 端点的响应契约整体扎实：公共字段基线（economy 线 §0）+ finish 的全部硬性字段与四类内建事件增量均已按客户端解析器逐键对齐，无会导致解析异常（8700 系 / 2375 / 5000）的缺失。剩余差距集中在三类：(1) **G-2 solo_time_attack_event** 是唯一具备明确玩家可见影响的缺口（活动启用即结算页记录/奖章链路断裂），建议在 event-settlement-descriptor 增补第五类事件；(2) **G-1 client_checks / G-3 drawn_quest** 是官方反作弊/抽选通道，当前服务端无消费者、缺席安全，但分别是"击杀时弱化状态"类任务条件与日替/週替 odds 抽选的前置依赖，复刻对应玩法时必须先补；(3) G-4~G-8 与冗余清单均为无害偏差，记录备查即可。恢复链确认无独立端点：中断恢复为客户端本地存档 + abort/finish 的 `unfinished_play_id` 信号（本服不发，单人语义正确），续关回执 `play_continue` 契约完全匹配。
