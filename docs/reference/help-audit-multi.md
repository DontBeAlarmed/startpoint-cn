# 帮助文本对照审计 — 领主战 / 共斗（多人联机）

- 口径：CN 主数据 **1.4.54**（wf-assets-cn）；服务端 **commit c9613534**（worktree starpoint-cn-dev-integration，`feat(tools): add in-game help extractor`）。
- 官方帮助正文：`docs/help/Battle_Boss.md`（来源 rich_text/help_battle_boss，全文 129 行）；辅助参照 `docs/help/Battle_Battle.md`（战斗篇）、`docs/help/Character_Party.md`（队伍编成篇）。
- 实现基准：`src/multi/`（http 端点 / tcp 会话 / room / npc / state / lifecycle）、`src/lib/stamina-cost.ts`、`src/lib/quest-join-gate.ts`；协议口径见 `docs/protocol/multi-battle.md`。
- 客户端对照证据取自 `wf-cn-client-as3-20261014/`（1.8.1 补全版反编译）。
- 判定分级：**一致 / 偏差 / 未实现 / 帮助未覆盖 / 不可对照**（客户端战斗表现或纯内容表驱动）。file:line 均为该 commit 下的真实位置。

## 一、对照表

### 1. 模式选择与菜单（Battle_Boss.md 开篇）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「单人战斗则选择"单人游戏"模式，与朋友一起战斗则选择"多人游戏"模式」(L7) | `src/routes/api/singleBattleQuest.ts:313-360`（`is_multi:"single"` @306/501，`isMulti:false` @407）；多人入口 `src/multi/http/register.ts:12-20` | 一致 | 单人/多人是两套互斥入口：单人 start 无房间、无招募面；多人走房间/铃铛链路 |
| 「推进主线关卡，可解锁菜单中的领主战」(L9) | `src/lib/quest-join-gate.ts:119-135`；开战/建房/加入三处兜底 `src/multi/http/battle.ts:210-219`、`src/multi/http/lobby.ts:146-152`、`src/multi/http/lobby.ts:268-286` | 一致 | 菜单解锁是客户端 viewable 门；服务端以 R-G04 参加门（viewable_need_quest 前置链）在 select/create/start 全路径拦截跳关 |
| 「"领主战斗"界面…主线登场及仅在领主战登场的领主；"降临讨伐"界面…」(L11-13) | — | 不可对照 | 纯客户端菜单组织 |
| 「过去活动中获得的称号将无法在"领主战"中获得」(L15) | — | 不可对照 | 称号随内容表 clearReward 下发；常驻 boss 表是否含称号奖励由内容数据决定 |

### 2. 多人游戏（合作战斗）— 连接/房间/招募

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「输入房间号或直接进入正在招募的房间，或选关卡点"多人游戏"招募」(L21) | 房号：`src/multi/http/lobby.ts:185-229`（search_room）、`231-343`（select_room）；铃铛招募下发：`src/routes/api/attention.ts:40-165`；建房：`src/multi/http/lobby.ts:116-183`；招募（share_room）：`src/multi/http/room.ts:345-463` | 一致 | 三条进房路径（房号/铃铛/自建招募）齐备；加入确认框 `src/multi/http/social.ts:13-81`（verify_access_token） |
| 「房间满员30秒后将自动开始战斗」(L23) | 全员就绪→倒计时通知帧 `[1,[10,2]]`：`src/multi/tcp/lobby.ts:257-278`；铃铛寿命 30s：`src/routes/api/attention.ts:135`（`multi_attention_lifetime_seconds:30`） | 帮助未覆盖（服务端语义）＋一致 | 「满员 30s 自动开始」的倒计时与自动 StartBattle 由**房主客户端**执行（StartBattle 只接受房主 TCP 帧，`docs/protocol/multi-battle.md:301`）；服务端只广播 StartRemainingTime 提示帧（协议表 `docs/protocol/multi-battle.md:316`），不主动开战 |
| 「未选择准备完毕的玩家将以自动模式参战」(L25) | `src/multi/tcp/lobby.ts:954-958`（ChangeAutoplayMode 入队 @1098） | 一致（客户端上报、服务端记录并随 Mates 广播） | 自动模式本身是客户端战斗行为 |
| 「参与者一段时间无操作将自动准备完毕，并切换至自动模式」(L27) | `src/multi/tcp/lobby.ts:966`（Ready 帧 @1095）、NPC 侧自动就绪 `src/multi/tcp/lobby.ts:202-238`（checkHostAutoReady） | 不可对照（真人超时逻辑在客户端）／一致 | 服务端支持 Ready 状态机；NPC 已入座成员的就绪自动化在服务端（npc/rematch + auto-ready） |
| 「房主与参与者互相关注时，参与者的体力消耗为0」(L29) | `src/lib/stamina-cost.ts:33-40`（state===1 → 0 @37）；计费点 `src/multi/http/battle.ts:246-266`；关系解析 `src/multi/follow-policy.ts:27-43`、`src/lib/follow/state.ts:20-35` | 一致 | 互关=LocalFollowState 1。客户端同构：`wf-cn-client-as3-20261014/scripts/pinball/common/data/quest/cost/StaminaCostCalculator.as:62-70`（Some(1)→Zero） |
| 「房主与参与者单向关注时，参与者的体力消耗为原本的1/2」(L31) | `src/lib/stamina-cost.ts:38-39`（非 1 → `floor(base*0.5)` 再套 Campaign）；`src/lib/stamina-cost.ts:24-27`（先减免后折扣） | 一致 | state 2/3（任一方向单向）均折半。客户端同构：StaminaCostCalculator.as:66（Some(≠1)→Halved）＋先折半后 Campaign（as:91-106） |
| 「响应救援请求而加入合作战斗时不消耗体力」(L33) | 计费点无此分支：`src/multi/http/battle.ts:264-266`（guest 只按 follow 计费）；attention_key 只用于新手资格与记账 `src/multi/http/battle.ts:279-304` | **未实现（偏差）** | 官方客户端明确：`StaminaCostCalculator.as:55-59`（attentionKey Some→Zero）。本服铃铛响应者若与房主非互关，仍被扣 1/2（见 P1） |
| （延伸，帮助未覆盖）新手房主救援客机 0 体力 | 官方客户端 `StaminaCostCalculator.as:56`（isNewbie→Zero）、`wf-cn-client-as3-20261014/scripts/pinball/scene/bossBattle/room/MultiBattleRoomScene.as:1041`；本服仅用于任务计数 `src/lib/newbie-host.ts`、`src/multi/http/battle.ts:277-296` | 帮助未覆盖 | 客户端反编译口径存在（isNewbie 旗标→0）；本服未实现体力免费。帮助正文无此条款，不作为偏差计 |
| 「房主开自动连战后，一旦其他成员全部准备完成则将自动开始战斗」(L35) | autoStart 标记 `src/multi/tcp/lobby.ts:961-964`（@1099）；全员就绪广播 `src/multi/tcp/lobby.ts:257-278` | 一致（客户端驱动） | 自动连战的 StartBattle 仍由房主客户端发出；服务端维护 autoStart/ready 状态并广播 |
| 「若战斗通关后体力足够，则将自动建立房间」(L37) | 房间 4→1 由房主返回恢复：`docs/protocol/multi-battle.md:407`；重赛房间重建路径 prepare/select/restore `src/multi/http/room.ts:90-181`、`252-337` | 一致（客户端重开房，服务端支持重赛态） | 自动重建由客户端 create_room；服务端保证当局 Finalize 后座位释放、房间保持 state 4 直至房主返回 |
| 「其他成员开启自动连战并通关后，将以准备完成的状态自动返回房间」(L39) | NPC 同构实现：`src/multi/npc/rematch.ts:19-79`（4→1 后 NPC 以 ready=true 自动回房）；真人成员重连补票 `src/multi/http/room.ts:319-330` | 一致（NPC 侧服务端实现；真人侧客户端） | NPC 与真人同构（先到先得仲裁）；真人"自动返回+就绪"由其客户端执行 |

### 3. 领主加成点数

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「使用领主加成点数后，可增加通关后奖励物品、经验值和玛纳的数量」(L43) | 玛纳 ×(rate+1)：`src/lib/reward-campaign.ts:144-150`、`src/lib/quest/finish/battle-settlement-values.ts:88-95`；分数报酬 useBoostPoint：`src/multi/settlement/orchestrator.ts:384-399`；追加掉落 boostPointUsed：`src/multi/settlement/orchestrator.ts:402-424` | 一致 | use_boost_point 与 use_boss_boost_point 任一即加成（`battle-settlement-values.ts:85`） |
| 「若不使用加成点数，则只会消耗体力」(L45) | 同上（未用点数时无加成路径） | 一致 | — |
| 「消耗的加成点数于每天凌晨5点重置并回复」(L47) | `src/data/domains/player.ts:1362-1363`（daily reset → `bossBoostPoint=3`/`boostPoint=3`）；重置时刻 `src/lib/time-utils.ts:10`（resetHour=5） | 一致 | 口径补充：重置=补满固定值 3（非按已消耗量回复）；帮助未写上限值 |
| 「战斗中途退出或失败后，消耗的点数和体力将被返还」(L49) | 体力：finish 失败路径 `src/multi/settlement/orchestrator.ts:273-291` → `src/lib/quest/entry-lifecycle.ts:279-327`（releaseEntryResources 返还体力+入场券）；abort：`src/multi/http/battle.ts:516-520` → `src/lib/quest/active-quest-service.ts:191-210` → `entry-lifecycle.ts:175-223`。点数：仅胜利结算扣除 `src/lib/quest/finish/battle-settlement-values.ts:134-139`（`questAccomplished && useBoostPoint`） | 一致 | 实现采用"失败即不扣"而非"先扣后退"，净效果与官方条款等价 |

### 4. 领主币 / 领主币碎片

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「领主币在领主出现的主线关卡、高难关卡以及领主战中可以获得」(L53) | 通用掉落管道：`src/multi/settlement/orchestrator.ts:384-424`（score rewards + additional rewards） | 不可对照 | 具体掉哪枚币由内容表（score_reward / additional_reward）驱动 |
| 「响应救援请求而加入合作战斗时，作为任务奖励可获得领主币碎片」(L57) | `src/multi/rescue-fragment-reward.ts:9-43`（胜利时发放，`orchestrator.ts:425-430`）；资格判定 `src/multi/http/battle.ts:272-276` → `resolveLocalRescueFragmentEligibility`（**所有 guest**，房主可由设置放开）；默认全开 `src/data/initializers/wdfpData.ts:46`（DEFAULT 1） | **偏差** | 官方语义=「响应救援请求者」；本服默认向**所有多人客机**（含房号直进者）发放碎片（见 P2-1）。碎片物品种类按降临档位派生 `src/lib/rescue-fragment-content.ts:3-5,19-30`（49000 银/49001 金/49002 紫） |

### 5. 战斗内共斗表现（技能连锁 / Fever / 其他玩家 / 棺柩 / 得分）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「技能连锁：4连锁1.40起，每连锁+0.1；发动后领主虚弱」(L61-75) | 战斗帧透传：`src/multi/tcp/battle.ts:95-119`（Broadcast/Send 中继） | 不可对照 | 连锁判定与伤害全部在客户端战斗 DSL；服务端仅中继 |
| 「协力战斗中的 Fever：一名玩家进入 Fever，其他玩家同时进入」(L77-83) | 同上 | 不可对照 | 客户端战斗表现 |
| 「其他玩家角色半透明；虚弱状态共享；回复等部分效果可跨玩家生效」(L85-89) | 同上 | 不可对照 | 客户端战斗表现 |
| 「棺柩状态（合作战斗）：其他玩家的角色触碰棺柩也可减少计数」(L97-101) | 同上 | 不可对照 | 客户端战斗表现 |
| 「每个玩家独立计算得分；"战斗得分"采用所有参与玩家得分中最高的分数」(L91-95) | finish 分数校验 `src/lib/quest/multi-battle-validation.ts:91-117`；按人 highScore 取 max：`src/lib/quest/finish/battle-quest-progress-plan.ts:59,74-76`；contribution_score 透传 `src/multi/settlement/response.ts:133` | 不可对照（最高分聚合在客户端）＋一致 | 服务端按人独立结算/存档；跨人"取最高"是结算画面客户端聚合 |
| 「MVP：授予贡献最大的玩家」(L117-119) | 客户端上报 `statistics.is_mvp`：`src/lib/mission/battle-facts.ts:136`；服务端用于 MVP 任务计数 `src/lib/mission/degree-battle-facts.ts:104-110` | 不可对照 | MVP 判定在客户端；服务端接受事实并驱动任务 |

### 6. 社交层共斗条款（关注奖励 / 表情 / 回复选项）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「与队友互相关注的情况下，将额外获得"关注奖励"的分数奖励；重复次数越多，分数奖励越高」(L103-107) | start 响应 follow_bonus_info：`src/lib/follow-bonus.ts:46-79`；开战 +10/局：`src/lib/follow-bonus.ts:76-96` → `src/data/domains/social-follow.ts:69-86`；客户端将其计入 FinalScore（1.8.1 反编译，`follow-bonus.ts:14-19` 注释锚定） | **偏差** | 官方=互关才有奖励；本服**任一方向的关注边**（单向也算）即显示并每局 +10 持续增长（见 P2-2） |
| 「被关注对象解除关注后依旧可以获得关注奖励，但不会再逐渐增多」(L109) | 取关删行即清零：`src/data/domains/social-follow.ts:88-94`（「取关同时清除该方向行的关注奖励计数」） | **偏差** | 官方=保留已累积值并冻结增长；本服=取关即清零（且单向边继续增长）。两个方向都与条款不符（见 P2-2） |
| 「在房间或合作战斗中，可以使用"表情"与其他玩家交流」(L111-115) | 房间：`src/multi/tcp/lobby.ts:1108-1114`（Broadcast 中继、排除发送者）；战斗：`src/multi/tcp/battle.ts:95-119` | 一致 | 表情帧透明中继；发送者本地渲染 |
| 「"队友的治疗"选项…该设定将随队伍编成更改而更改」(L121-129) | 服务端不消费该选项；`share_room_options` 实为分享位掩码（`src/multi/room/serializer.ts:21,67`；客户端 `wf-cn-client-as3-20261014/scripts/pinball/dialog/shareDialog/ShareDialog.as:143-147`） | 不可对照 | 接受他人回复效果是客户端队伍级战斗设置；服务端仅透传编队数据 |
| 「通关协力战斗后，可在结算画面收藏一同参加者的队伍编成」（Character_Party.md L63-73） | 结算响应提供 follow_info/mate 数据：`src/multi/settlement/response.ts:135-136`、`src/lib/quest/finish/follow-info.ts:60-90`（只反映真实本地关系） | 不可对照（客户端功能）／一致 | 收藏本体在客户端；服务端供数且不继承房间级 follow=1 兼容投影（F5） |

### 7. 失败/续战/断线（Battle_Battle.md 通用条款 × 共斗）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「无法在规定时间通关或全员棺柩→挑战失败；可用星导石续战」(Battle_Battle L186-213) | `src/multi/http/battle.ts:564-612`（play_continue，幂等、continue_count 递增）；结算侧 `src/multi/settlement/orchestrator.ts:584`（continueCount 入结算校验） | 一致 | 领主战续战效果（恢复其他玩家角色半血）为客户端战斗行为，不可对照 |
| 「放弃战斗将无法获得当前关卡的道具、经验值和玛纳」(Battle_Battle L192) | 失败路径全零：`src/lib/quest/finish/battle-settlement-values.ts:88-141`（questAccomplished=false → 玛纳/经验/点数消耗全 0） | 一致 | — |
| 「放弃后系统将返还战斗开始时消耗的体力，但部分关卡不会返还体力」(Battle_Battle L194) | 一律返还：`src/lib/quest/entry-lifecycle.ts:279-327`（无 no-refund 条件）；被遗弃战局回收同路径 `src/lib/quest/active-quest-service.ts:212-223`、`src/multi/room/disband-listener.ts:33` | **偏差（轻微）** | 「部分关卡不返还」例外未实现：本服所有共斗败退/中止均返还体力（见 P3-1） |
| 断线/离开（帮助正文未写；对照协议文档） | `docs/protocol/multi-battle.md:270,297`（Bye 语义按 raising_state 解释）；§10.3 `docs/protocol/multi-battle.md:423-430`（battle socket 断开不改状态；房主保留房间等待重连或老化清理；显式离席释放座位并同步大厅计数） | 帮助未覆盖 | 帮助正文对断线零描述；实现以协议文档口径为准（客机断线立即释放座位、房主保留房间；state 4 期间 lobby 写入拒绝） |

## 二、差异与问题清单

### P1 — 救援响应加入未免体力（官方条款明文，未实现）

- 条款：帮助 Battle_Boss.md L33「响应救援请求而加入合作战斗时不消耗体力」。
- 实现：客机计费只看关注关系——`src/multi/http/battle.ts:264-266`：`isRoomHost ? 全额 : getLocalGuestStaminaCost(questKey, guestFollowState)`；`src/lib/stamina-cost.ts:33-40` 仅 state===1 免费，其余（0/2/3）折半再 Campaign。铃铛响应（attention_key，`battle.ts:281-288`）不参与计费。
- 证据：官方客户端 `wf-cn-client-as3-20261014/scripts/pinball/common/data/quest/cost/StaminaCostCalculator.as:55-59`——`attentionKey` 为 Some（或 isNewbie）时恒 `TemporaryReducedStaminaCostKind.Zero`；且加成窗口内铃铛响应者在加入确认框看到的就是 0 消耗。本服 UI（search_room/verify_access_token/铃铛横幅）下发真实 follow 关系（`src/multi/http/lobby.ts:211-227`、`src/multi/http/social.ts:46-79`、`src/routes/api/attention.ts:97-103`），互关横幅 + 非互关扣 1/2 的组合会让响应者被扣费——直接违反帮助明文。
- 影响：所有非互关的铃铛响应者被多扣体力；新手救援（is_newbie 横幅）同样被扣（该条帮助未写，但客户端同分支亦为 0）。

### P2-1 — 领主币碎片发放范围大于官方口径

- 条款：帮助 Battle_Boss.md L57「**响应救援请求**而加入合作战斗时，作为任务奖励可获得领主币碎片」。
- 实现：`src/multi/rescue-fragment-reward.ts:20-27`（`resolveLocalRescueFragmentEligibility` = 全部 guest，房主由 `multiRescueHostRewardsEnabled` 放开）+ `src/multi/http/battle.ts:272-276`；默认全开：`src/data/initializers/wdfpData.ts:46`（`multi_rescue_fragment_rewards_enabled INTEGER NOT NULL DEFAULT 1`）。
- 影响：房号直进、好友大厅进入的客机（非救援响应）也拿碎片；属服务方有意放宽（设置开关存在），但与帮助明文不符。若要对齐官方，资格应收敛到「start 携有效 attention_key（T2 持票）」——该判定已存在（`resolveBellRecruitmentForStart`，`battle.ts:97-115`），复用即可。

### P2-2 — 关注奖励的授予/增长/冻结语义偏差

- 条款：帮助 Battle_Boss.md L105-109：互关才有"关注奖励"；重复次数越多奖励越高；**被关注对象解除关注后依旧可以获得，但不会再逐渐增多**。
- 实现：
  - 授予/增长：`src/data/domains/social-follow.ts:69-86`（`incrementCoopBonusCountsSync` 对**任何已存在的方向行** +10/局）+ `src/lib/follow-bonus.ts:87-96` → 单向关注（我→对方）也持续增长，官方要求互关。
  - 冻结：取关删行即清零——`src/data/domains/social-follow.ts:88-94`（「取关同时清除该方向行的关注奖励计数（行即记录）」），官方要求保留已累积值并停止增长。
- 影响：`follow_bonus_info` 计入客户端 FinalScore（`src/lib/follow-bonus.ts:14-19` 反编译锚定），单向关注者持续获得官方拿不到的分数加成；取关者丢失官方应保留的加成。

### P3-1 —「部分关卡不返还体力」例外未实现

- 条款：Battle_Battle.md L194「放弃后系统将返还战斗开始时消耗的体力，**但部分关卡不会返还体力**」。
- 实现：`src/lib/quest/entry-lifecycle.ts:279-327` 无任何按关卡区分的 no-refund 条件；所有共斗败退/中止/遗弃回收均全额返还。
- 影响：轻微——目前共斗内容里若有官方不返还的档位（帮助未列明是哪些），本服会多退体力。

### P3-2 — serializer 中 `establisher_follow:1` 硬编码（当前无调用方的暗雷）

- `src/multi/room/serializer.ts:73`（serializeRoom）将所有房间投影为互关（注释自述「免费体力 + 互关图标」兼容值）。全仓检索（src/tests/tools）当前**无任何调用方**——活路径（lobby.ts:70/211、social.ts:46、attention.ts:97）均按真实关系下发。若未来有人复用 serializeRoom 房间列表投影，会把全服房间标成互关并诱发与 P1 同型的免费体力预期。建议标注或删除。

### 帮助未覆盖（实现自有序，不计偏差）

- 房主体力口径：帮助只写"参与者的体力消耗"（L29/L31），**从未写房主扣多少**。本服房主全额（`battle.ts:261-266`）与"仅参与者享受减免"的措辞自洽，且与客户端 StaminaCostCalculator（无房主减免分支）同构。
- 无关注关系的客机体力：帮助未写。本服折半（state 0 → Halved）与客户端 Some(0)→Halved 显示口径一致（`StaminaCostCalculator.as:66`）；仅当 establisher_follow 字段缺失（Option None）时客户端才显示原价，本服所有响应均携带该字段。
- NPC 联机（is_npc_mode、铃铛 NPC 释放、NPC 续战回房）：`src/multi/npc/*`、`src/multi/http/room.ts:184-249`（summon）。帮助正文完全未提 NPC 替补，属本服扩展。
- 满员口径：真人+已入座 NPC 同权占 3 席（`src/multi/bell-gate.ts:4-18` 注释 D8）。帮助只说"房间满员"，未定义席位构成。

## 三、结论（两个悬案的官方口径判定）

**悬案 1：共斗体力消耗。** 帮助正文**给出了部分官方口径，但没有写全**：
- 已明确（三条）：互关→参与者 0；单向关注→参与者 1/2（L29/L31）；**响应救援请求加入→0（L33）**。
- 未明确：房主扣多少（通篇只提"参与者"）、无任何关注关系时客机扣多少、"1/2"是否再吃 Campaign 折扣。
- 我们现有口径（房主全额 / 客机互关 0 / 其余折半再 Campaign）与帮助的互关 0、单向 1/2 两条一致；房主全额与帮助措辞自洽（帮助未覆盖）；无关系折半帮助未覆盖（但与客户端反编译显示口径一致）。**唯一实打实的差距是"救援响应 0 体力"这条明文条款我们没有实现（P1）**——而它恰恰是帮助已经给出官方口径的那一条。

**悬案 2：单人副本 + 铃铛。** 帮助正文**没有一句明文规定"单人战斗不能被铃铛加入"**，只能算隐含口径：招募动作被完全放进"多人游戏"流程（L21 选关卡→点"多人游戏"→招募；进房方式=房号或正在招募的房间），"单人游戏"侧无任何房间/招募/铃铛表述（L7 单人/多人二选一）。实现与本隐含口径一致：单人领主战 start（`src/routes/api/singleBattleQuest.ts:313`，`isMulti:false`）不建房间、不落招募行；铃铛只可能指向多人房（`share_room` 仅房主可用，`src/multi/http/room.ts:345-370`），投递有房间态门（未开战/房主在线/未满员，`src/multi/bell-gate.ts:11-18`），加入必须携 room_number+attention_key 走多人 start——单人局没有可被加入的面。判定：**帮助未明文覆盖，隐含一致；无实现缺口**。
