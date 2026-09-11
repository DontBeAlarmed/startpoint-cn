# 任务系统全量语义转代码审查报告

> 审查分支:`review/mission-semantic-audit`(基于 `relay/post-feature` @ 763d754d,审查期间零代码改动)
> 审查日期:2026-09-12。方式:主审 + 6 路并行子审计(CDN 目录解析 / 结算与奖励管线 / 战斗事实与 finish 挂接 / load 与登录操作事实 / Active Mission(主审代行) / 觉醒与四类 computer),全部结论经主审逐条对照源码、CDN 数据(`assets/mission_*.json`、上游 `wf-assets-cn/orderedmap/`)与 CN 1.8.1 反编译客户端复核;每条发现标注主审核验状态。
> 用户报告的四类症状:①奖励发放时点不确定;②部分任务不能完成;③奖励错配;④完成行为后进度不增长、需 /load 兜底。

## 状态:定稿(6 路子审计全部合入,关键发现均经主审二次核验)

---

## 一、四类症状的根因结论(先给答案)

### 症状④「完成后进度不增长,要 /load 兜底」——已定位两个确切机制,均在 Active Mission 链路

标准任务(category 1~10)**不存在**该问题:战斗 finish 的结算 scope 覆盖全部有事实写入的类别,单人/多人 finish、/start、故事 finish 均在业务事务内即时结算(证据见 §四 V-C1/V-C2)。真正只靠 /load 推进的是 **Active Mission(活跃任务/成长任务)**:

- **[AM-F1][P1] Active Mission reconcile 全库只有 3 个调用点**:`src/routes/cn/load.ts:398`、`src/lib/quest/finish/single-mission-publication.ts:57`(单人 finish)、`src/routes/api/storyQuest.ts:116`(角色故事 finish)。多人 finish(`src/multi/settlement/orchestrator.ts:409-430`)只写战斗事实并结算标准任务,**不触发 reconcile**,且多人响应无 `active_mission_list` 字段(`src/multi/settlement/response.ts` 全文无该字段)。协力战斗后,Contents Guide 协力链(20012~20016)、pattern 23 battleKind 2/3、pattern 26 协力 SS 等 Active Mission 进度在本次响应与数据库中均不推进。
- **[AM-F2][P1] 操作类计数同样只写计数器不触发 reconcile**:`party/edit`(pattern 58/59/60/35,`party.ts:565-621`)、`gacha/exec`(78/83,`gacha-owner/execute.ts:304-309`)、装备觉醒(34)、商店购买(45/46)、玛纳板学习/觉醒(46)、`expod/inject_exp`(63)都只在业务事务内累计计数器,进度换算要等下一次 /load 或单人/故事 finish。
- **用户侧放大器(反编译证据)**:客户端只有 `active_mission/receive` 与 `receive_incentive` 两个请求,**没有页面刷新请求**;页面渲染完全依赖 /load 的 `all_active_mission_list` + 任意响应通用层的 `active_mission_list` 增量(`GlobalLogic.applyToastFromCommonResponse`,GlobalLogic.as:1401-1447)。因此多人战斗或操作之后,客户端与服务端两侧的 Active Mission 进度同步停摆,直到下次 /load——与症状④的描述精确吻合。
- 修复方向(供后续决策,本审查不改代码):多人 finish 事务内补一次 reconcile 并在响应携带 `active_mission_list`;或在操作类计数事务内对受影响 pattern 定向结算。

### 症状②「有些任务不能完成」——三层原因,前两层是设计内 fail-closed,第三层是数据+冻结时间

- **[A-F6/C-F2/AM-F4][P1·设计内] 无事实生产者的任务永不完成**:`coverage-audit.ts` 机器清单——category 3 共 27 条 type 20 Attention(救援来源不可得)、category 5 共 6 条(25000/25010/25020 Attention、70004/70005/70006 协力新手)、category 1 救援族 62/63/64/87/88/89/100、Pass category 7 救援 19 条(pattern 20)。这些 ID 在当前代码中没有任何进度生产者。
- **[AM-F4][设计内] Active Mission 96 条中 35 条按设计锁死**:event 3(2022 限定,10 条)窗口已过;event 150 回归活动(25 条)时间窗虽开(2024-05-23 起、无结束),但 `isEventEligible` 无生产者恒 fail-closed(`active-reconciliation-runner.ts:74-87`);另有 10 条 `UNSUPPORTED_ACTIVE_MISSION_IDS`(21030 + 25009~25022 子集)evaluator 为 null(`active-plan.ts:20-31`)。
- **[冻结时间数据事实] 服务器固定时间 2024-08-14 12:00 UTC 下,活动类任务整体不可用**(主审 python 全量统计):category 3 启用 0/2512、category 4 启用 0/997、category 5 启用 1078/1288、category 9 启用 72/144;category 1 107/120、category 2 11/656、category 10 2/2、Pass 4/4/3。若运维把活动期任务也纳入运营目标,必须调整全局 timeOffset 至活动窗口内,否则 category 3/4 全部任务在协议上就是「未开放」,客户端与服务端行为一致(客户端同样按主数据窗口过滤),属数据+时间语义,不是代码错误。
- 其余「不能完成」候选(如具体 mission ID)需玩家报告 ID 对照 §四 C-F2 的 fail-closed 清单。

### 症状①「奖励发放时点不确定」——机制确认为「多时点幂等先到先发」+ 两处与文档承诺背离的时点,非 bug 但时点分散

标准任务阶段完成即自动发奖,首个到达的结算点发奖(幂等,重复调用不重复发,`settlement-write.ts:62-106` + `settlement-evaluate.ts:205` 单调合并)。同一任务的奖励实际可能落在四个时点之一:战斗 finish 事务、/load onSend 编码短事务、打开任务页(`get_mission_progress` 自动结算,`routes/api/mission.ts:71-76`)、或业务操作事务。`docs/systems/mission-completion-audit.md:12`「打开任务页不是该事实的正常发奖时点」与实现存在张力(D-F05)。Active Mission 为手动领取(`received=false` → `/active_mission/receive`),觉醒为页面时序——三类任务三种时点并存,是「不确定」观感的完整解释。

两处与文档承诺背离的时点(代码与测试锁定现状,文档过期或回归,需产品定夺):

- **[AW-F1][P1] 觉醒(category 9)普通奖励在战斗 finish 即发放**,而 `docs/systems/character-awake-refresh.md` 与 `mission-completion-audit.md` 声明「玩家手动切回第一页后 get_mission_progress 才结算所有未领奖励」。`single-mission-publication.ts:37-45` 在 questAccomplished 时对队伍角色觉醒任务立即结算,`awake-evaluation-settlement.ts:56-82` 对每个完成未领 stage 立即 `grant + status=true + missionInfo`;`tools/character_awake_route.test.cjs:308-335` 锁定了该现状。玩家在战斗结果弹窗即收到觉醒奖励与 `mission_info`,「一次进页领全部」的官方 UX 消失;功能不回退、不重复发。
- **[D-F04][P2]** /load 登录任务发奖在 onSend 编码事务内,「发放时点」语义上等于「响应被成功编码的时刻」。

### 症状③「奖励错配」——发现一个现行 P1 语义错配(mission 9),解析/发放层其余未发现错配

- **[B-F1 = AW-F3][P1·现行] mission 9「初次达成角色等级 ::target_value::」的进度取的是玩家级别(rank),不是角色等级**——详见 §七。任务无时间窗、恒开放,10 段星导石(target 10..100)全部悬在与本义无关的玩家 rank 事实上;rank 低则进度锁死(同现症状②),rank 高则提前发完(错配)。
- 目录解析层与奖励 kind 枚举逐列核对客户端反编译**完全一致**(§三 V-A1~V-A7):kind 0=星导石/1=物品/2=装备/3=玛纳/4=角色/5=经验/6=称号/7=Pass 点,`grants.ts:87-133` 的发放映射与之一一对应;bundled 表与上游 wf-assets-cn 全表相等;当前数据 0 条任务被解析层丢弃、0 个脏奖励槽;`mission_reward_id` 编码与客户端 `MissionRewardIdKindTools` 互证一致。
- **[C-F4][P2·潜在] Pass type 85 表情事实不匹配活动且失败战斗也计数**(`pass-battle-facts.ts:60-79`):只要本场 multiplayer 上报 `send_emotion_count>0`,就对全部开放期内 patternType 85 任务累加,不校验战斗所属活动(16/23 循环同样无 eventId 校验,`pass-battle-facts.ts:81-95`)。当前冻结时间下开放 Pass 任务全部属 event 3、每 patternType 仅 1 条,**未实际触发**;两期 Pass 重叠开放时会跨期双计。
- 觉醒特殊奖励(specialReward)解析与解锁写入与主数据全量核对 0 偏差(§八 V-AW7)。

---

## 二、审查范围与基线证据

- 代码:`src/lib/mission/`(100 文件,~15k 行)、`src/lib/quest/finish/`、`src/routes/api/{mission,activeMission,singleBattleQuest,storyQuest,raidEvent,party,equipment}.ts`、`src/routes/cn/load.ts`、`src/multi/settlement/`、`src/data/domains/{mission,mission_battle_facts,active_mission_*,event_mission_entry_facts}.ts`。
- 数据:`assets/mission_{regular,daily,event,collect_item,degree,pass_*,char_awake,weekly_def,active*}*.json` 与上游 `wf-assets-cn/orderedmap/` 全量比对。
- 客户端参照:`wf-1.8.1-cn-decompiled`(MissionValues/RewardValues 系列、MissionRewardKind、MissionLogicImpl、ActiveMissionRepository、GlobalLogic、ParseTools、boot_ffc6)。
- 基线:`npx tsc --noEmit` 通过(exit 0);`tools/mission_coverage_audit.test.cjs` 3/3 通过,锁定 category 3 `2485/2512`、Degree `1282/1288`、觉醒 `144/144 resolved`、Pass `248/267`——覆盖数字与 docs 声明一致。任务/觉醒/活跃相关测试文件 124 个,全部未在本次审查中修改。

---

## 三、目录/CDN 语义解析层(子审计 A,主审已核验)

**结论:解析层逐列正确,不是任何症状的根因。**

- [V-A1] bundled 10 对 def+reward 表与上游 wf-assets-cn 全 JSON 相等(regular 120 / daily 656 / event 2512 / collect 997 / degree 1288 / pass 76+76+115 / char_awake 144 / weekly 2)。
- [V-A2] 列索引逐类与客户端 `*Values.as` 一致:pattern cat1/2/3/10=`row[0]`、cat5=`row[1]`、cat4/9=`row[2]`、cat6/7/8=`row[1]`;patternType(cat6/7/8)=`row[3]`;enable/show 双时间列位置逐类吻合且数据中两对日期 100% 恒等;cat9 `row[1]` 为角色 ID(与客户端 `leader_character_id` 同列同值)。
- [V-A3] 奖励槽 6 列布局与 kind 枚举一致(客户端 `MissionRewardKind`:Stone=0/Item=1/Equipment=2/Mana=3/Character=4/Exp=5/Degree=6/PassCardPoint=7);cat1 首槽 `[5..10]`、cat4 首槽 `[6]`(target `row[2]`)、cat9 首槽 `[9]`(target `row[5]`,specialReward `row[1..4]`,clearSeconds `row[6]`)与客户端逐字段一致;kind 与配对 id 的校验(1→item、2→equipment、4→character、6→degree)同客户端。
- [V-A4] UTC+8 解释与客户端一致(`JAPAN_STANDARD_OFFSET_MILLISECONDS=28800000`);`(None)`=无界;非法日期两侧同为 fail-closed。
- [V-A5] 当前数据下模拟完整解析管道 dropped=0(无 rawRows≠1、无缺 reward 行、无解析失败);stage 键升序、targetProgress 单调。
- [V-A6] `getCurrentStage`/`getCompletedStageNumbers` 与客户端 `MissionLogicImpl`/`MissionStageLogicImpl` 语义一致。
- [V-A7] `mission_reward_id` 透传正确,mission 内无重复。
- [A-F1][P2] `parseRewards` 跳过 amount=0 且 kind≠6 的奖励,客户端不跳过——当前数据 0 例,死代码偏差。
- [A-F2][P2] 未知 kind(>7)服务端放行、客户端抛错——当前数据 kind 全在 0..7。
- [A-F3][P2] 年份范围校验(1970~2200)缺失——全部日期列格式合法,无实际影响。
- [A-F5][P2] `normalizeEntries` 重复 ID fail-closed 分支对 JSON 输入不可达(JSON.parse 键唯一)。

---

## 四、战斗事实与 finish 挂接(子审计 C,主审已核验)

**结论:标准任务在 finish 链路上不存在「事实已记录但 scope 未结算」;症状④与标准任务无关。**

- [V-C1] `buildBattleMissionSettlementScopes` 返回 `[1,2,3,{5,missionIds},6,7,8,10]`,category 9 由 awake 结算单独覆盖;对 1288 条 Degree 主数据全量核对,所有战斗驱动 condition type 均在 `BATTLE_DEGREE_CONDITION_TYPES` 内;type 19/23-exact 从宽集剔除后由 contextual `degreeMissionIds` 精确补回(`single-mission-publication.ts:27-36`、`multi/settlement/orchestrator.ts:423-430`)。
- [V-C2] 先写事实后建 Session(单人 `single-settlement-writes.ts:182→224`;多人 `orchestrator.ts:409→423`);单事务边界与失败回滚正确;失败战斗排除正确(不写 questProgress、奖励 0、仅记游玩次数与 Pass 表情)。
- [V-C3] 竞速/限时毫秒比较方向全部正确(`<=` 通过;MIN/MAX 写入方向正确);type 87 的 `clearTime<=180000`、type 86 的 `debuff_r===0`、type 16/17/18 host/guest 严格区分,均与文档一致。
- [V-C4] 每日任务主数据与生产者逐条匹配(800115-117/800124-126/10075/800392)。
- [C-F1][P1·文档漂移+无效时点] 文档称「体力事实发生在单人 /start」,实际 `totalStaminaUsed` 在 finish 的 `commitEntryResources` 提交(`entry-lifecycle.ts:239-256`,仅 questAccomplished);单人 `/start` 的 `[1,2,10]` 结算所依赖的体力/冲刺事实尚未变化,基本空转(对 pattern 65 练习挑战计数仍有效);多人 /start 无等价结算。进度正确性不受损(finish scope 含 2/7 且事实先行),但事务边界描述已失真。
- [C-F3][P2] `settleSingleBattleMissionCategories` 与 `BATTLE_SETTLEMENT_CATEGORIES` 为无调用者的死代码,且使用与生产不同的宽 scope。
- [C-F5][P2] 非法战斗统计拒绝口径不一:degree/event 统计族整场拒绝,powerflip/dash 族非法值归 0 后照常累计(单调性不受损)。
- [C-F4] 见 §一症状③。
- [C-F6][文档漂移] type 37 收集任务实际在 finish 也结算(文档称仅任务页);Pass type 85 表情已实现(文档称 fallback)。

---

## 五、load / 登录 / 操作事实层(子审计 D,主审已核验)

- [V-D1] /load 步骤顺序:每日重置(UTC+8 05:00 桶,totalLoginDays+1、周期基线、删 cat2/6 与跨周 cat7/10)→ 登录奖励 → Active Mission reconcile → 序列化 → onSend 编码短事务(登录事实+定向结算+合并+编码,任一步失败整体回滚)。
- [V-D2] 登录自然日 UTC+8 计算、同日/回拨幂等、不补历史天数;`time_offset` 存档字段在任务/登录/重置路径零读取(符合规范)。
- [V-D3] story finish 即时结算(cat 1 `clear_episode` + cat 5 角色剧情称号 + Active reconcile,同事务,响应带 `active_mission_list`+`mission_info`);`/episode_trial_reading/finish` 为空 stub,不产生任务事实。
- [V-D4] 操作计数(party/edit 魂珠、装备觉醒、玛纳消费、gacha、expod)均在业务事务内、失败回滚、不回退。
- [V-D5] production-fact-loaders 全部只读;Active Mission `target_mission_clear`/`quest_clear` 经 `Math.max` 单调只增;固定点收敛保证(超 definitions.length 轮抛错)。
- [V-D6] 每日/每周重置只删对应类别两表,基线只在跨天/跨周重建,不会清零进度;周常基线以当前值为基线,月中开放不误计。
- [D-F03][P2] 「不能完成」完整清单(见 §一):1225(2019 窗口,`getEventLoginMissionId` 恒 null,/load 事件登录分支为永久 no-op)、raid 入口 16 条(4 期已过、1 期未开)、27 条 Attention、6 条 Degree fallback、Active Mission 35 条。
- [D-F04][P2] 登录任务发奖在 onSend 编码事务内:编码失败则发奖回滚(设计取舍,非回滚风险);每日重置先提交、不随其回滚。
- [D-F05][P2] 打开任务页即自动结算+发奖;category 2 无视请求子集恒全量结算(`settlement-prepare.ts:56`)。
- [D-F06][P2] `contents_guide/start` 只推进首任务自身,不跑依赖固定点,后续任务解锁延迟到下次 reconcile。

---

## 六、Active Mission 子系统(主审代行,原子审计 agent 因限速失败)

**结论:内容解析/可用性/领奖/单调性核心正确;症状④的两个根因(F1/F2)落在本子系统;事件窗口与 evaluator 覆盖已全量核对。**

- [V-AM1] 数据列索引逐列验证(96 任务 row 长全为 73):eventId `row[0]`、phase `row[1]`、stringId `row[3]`、pattern `row[29]`、target `row[55]`、need `row[56..57]`、show `row[58..59]`、enable `row[60..61]`、show 期 `row[62..63]`;event 表 kind `row[2]`、maxPhase `row[3]`、start/end `row[14..15]`、needQuest `row[22]`;reward 表每 mission 恰 1 stage、target `row[3]`、clearSeconds `row[4]`(仅 25022 有值)、奖励槽 base 7+6*slot。
- [V-AM2] evaluator 覆盖:event 1 全 44 条有 evaluator(pattern 分布 4/5/8/9/13×4/21/23×13/34/35/36/45/57×8/58/59/61×2/62/63/64/65/66×2);event 2 全 17 条闭环(20001 pattern 74 由 `/contents_guide/start` 幂等写绝对进度 1,不经 evaluator);event 3/150 之外的 86 条与 docs 声明一致。
- [V-AM3] pattern 57(quest_clear,event 1 的 8 条)在 `factKindsForPattern` 声明为空事实集,但 evaluator 读 `finishedQuestIds`——由 reconciliation runner 的固定前加载补偿(`active-reconciliation-runner.ts:161` 无条件 `loadKinds(["activeProgress","questProgress"])`),当前无运行时缺陷;属脆弱耦合,若未来出现绕过 runner 的定向求值路径会恒算 0,建议补 `"questProgress"` 事实声明。
- [V-AM4] phase 释放语义与客户端逐行等价(`ActiveMissionRepository.getActiveMissionEventReleasePhase`:上一阶段全部任务当前阶段完成才释放;server `active-core.ts:80-103` 同义)。
- [V-AM5] `/active_mission/receive` 校验链完整(任务存在/阶段存在/阈值/重复/show 期可用性),`received=false`→手动领取,限时阶段(`targetClearSeconds`)缺权威秒数时拒绝完成与领取(`claims.ts:89-93`);事务内 `updateStage(true)→grant`,失败整体回滚;响应形状 `{mission_id,progress_value,stages:[{stage,received}]}` 与客户端 `applyCommonResponseActiveMission` 解析字段一致;客户端 receive remote 对 data 仅要求 Object。
- [V-AM6] `settleActiveMissionProgress` 单调(`Math.max`),stages 记账 `false`(待领取)/`true`(已领),限时阶段无秒数不关闭;evaluator 异常 fail closed 返回 null 不写进度。
- [AM-F1/AM-F2/AM-F4] 见 §一/§五。
- [AM-F5][P2·脆弱] `computeCandidate` 捕获全部求值异常静默跳过(fail closed 符合设计,但坏行只会表现为「永不完成」,无日志锚点,排障时建议至少留观察器计数)。

---

## 七、标准结算/奖励发放管线(子审计 B,主审已核验)

**结论:奖励 kind 映射、列偏移、mission_reward_id、幂等、单调性、响应合并全部正确;但发现一个现行 P1 语义错配(mission 9)与一个窗口性 P2(每日 all-clear 依赖集)。**

- **[B-F1][P1·奖励错配/进度错配·现行] mission 9「首次达成角色等级」的进度取的是玩家 rank,不是角色等级**
  - 证据:`src/lib/mission/computer-regular.ts:55` `if (pattern === "character_level") return Math.max(dbProgress, ctx.playerRankDegree ?? dbProgress)`;`regular-session-context.ts:125-131` 对 `user_rank` 与 `character_level` 声明同一事实(玩家 rankPoint → `player_rank_full.json` rank degree)。
  - 主数据:`assets/mission_regular.json` mission 9 pattern=`character_level`、row[2]=5(客户端 `MissionPatternKind` index 5 = `character_level_achievement`,与 `player_rank_achievement` 是两个 pattern)、**无时间窗(恒开放)**;奖励 10 段星导石(target 10..100,数量 10×7+50×2+100)。
  - 同库正确参照:category 5 角色等级称号按角色 EXP→等级上限计算(`degree-state-derivation.ts:192-201`);Active Mission 同语义(`active-fact-evaluator.ts:197-209`)。
  - 影响:任务 9 与任务 22(玩家级别)在同一事实源上,玩家 rank 与角色等级背离时双向错配——rank 低则进度锁死(症状②),rank 高则提前发完 10 段星导石(症状③)。**冻结时间下任务开放,任何玩家可触发。**
  - 修复方向:`character_level` 改读角色等级事实(可复用 category 5 的 EXP 阈值路径),并从 `needsPlayerRank` 中拆出。
- **[B-F2][P2·不能完成/错配·窗口性] 每日 all-clear 不按各任务自己的 `row[17]` 依赖集计算,`weekevent_battle_play*` 无 producer**
  - 证据:`settlement-evaluate.ts:33-51` `isDailyCoreMission` 硬编码 8 个核心 pattern(不含 `weekevent_battle_play(_2/_3)`),把同一 `completedCoreCount` 写给所有 `daily_quest_all_clear*`;主数据 mission 5/10/15 的依赖集分别含 weekevent(mission 2/7/12),mission 17 依赖 `11,13,16,14`;`computeDaily` 对 `weekevent_battle_play*` 返回 `dbProgress`(unsupported,进度冻结);`requirements/providers.ts:103-128` 已按 `row[17]` 声明依赖但计算未消费。
  - 现状:冻结时间下开放核心恰为 11/13/14/16,与 mission 17 依赖集重合——**当前窗口结果巧合正确**;5/10/15 已关窗。若时间窗回到历史批次,all-clear 会用「当前开放核心完成数」顶替「本批 4 项」,且 weekevent 任务本身永不完成。
- **[B-F3][P2·时序(设计内)] 奖励副作用引发的进度只在同请求「阶段 B」刷新响应显示,不写库不发奖**(`progress-stage-b.ts:76-106`、`mission-engine-architecture.md:60/228`)。任务 A 的奖励使收集任务 B 达标时,本次任务页响应显示 B 完成,但 DB 进度与 B 的奖励要等下一次覆盖 B 的结算(finish/load/任务页)。是「奖励时点不确定」观感的结构性来源之一,文档已声明为预期语义。
- **[B-F4][P2·健壮性·潜伏] kind 7 Pass 点发奖在 `pass_card_event.json` 定义缺失/非法时 throw**(`grants.ts:113-121`),处于结算事务内会把整个 finish/任务页请求整体回滚。当前 19 期 eventId 与 `pass_card_event.json` 完全对齐,不触发;内容漂移时放大为请求失败。
- [V-B1] 奖励 kind→发放映射与客户端 `MissionRewardKind` 枚举(Stone/Item/Equipment/Mana/Character/Exp/Degree/PassCardPoint)完全一致;星导石→freeVmoney、玛纳→freeMana+totalManaObtained。
- [V-B2] 奖励槽列偏移、kind6 amount=0 保留、`mission_reward_id` = missionId×1000+stage(awake ×10+stage)与客户端 `MissionRewardIdKindTools` 解码互证一致。
- [V-B3] 全部 computer 的 finalProgress 经 `Math.max(0, db, computed)` 单调合并,进度不可能倒退;`updatePlayerCategoryMissionStagesSync` 仅以 status:true 调用,stage 状态不会被结算重置。
- [V-B4] 幂等成立:receivedStages 过滤 + 单连接同步 SQLite + 事务/savepoint,不存在「stage 已写、奖励未发」的可见中间态;「definition 为 null continue」发生在写库之前,不构成漏发。
- [V-B5] 阶段 B 全程只读、不发奖、不扩大候选范围;失效 FactKey 映射与文档表一致(重复角色补偿道具经 assets 聚合同样触发 items/collectedItems 失效)。
- [V-B6] `update_mission_progress` 白名单与客户端 `MissionCounterLogic` 五个 pattern 完全对齐,twitter 前缀匹配全库唯一命中 regular 107;增量语义含溢出检查。
- [V-B7] 响应合并:item_list 绝对值覆盖、mission_info 追加后显式重赋值、degree_list 去重;客户端多读字段已对照(`stage` 字段客户端暂无消费方,无错配)。
- [V-B8] `cleared_collect_item_event_mission_list` 按 category 4 + status=1 取 MAX(id),与领奖状态序列化一致;Active claims 对已领/待领/未记录三分支语义正确。

## 八、觉醒与 Degree/Regular/Event/Pass computer(子审计 F,主审已核验)

**结论:144 条觉醒条件族分区、原子事实、specialReward 解析与解锁写入、幂等与单调性全部与文档/主数据一致;两处 P1 时序背离(领奖时点、解锁补写)与 mission 9 错配(B-F1 同一发现)为主。**

- **[AW-F1][P1] 觉醒普通奖励在 finish 即发放**,与文档页面时序声明矛盾——见 §一症状①。主审核验:`single-mission-publication.ts:37-45` + `awake-evaluation-settlement.ts:56-82` + 测试 `character_awake_route.test.cjs:308-335` 三方证实。
- **[AW-F2][P1] `get_mission_progress` 的觉醒路径不补写/不发布 `players_character_awake_unlocks`**,违反 `character-awake-refresh.md` 恢复矩阵「缺失|未领奖 → category 9 结算可在同一事务内补写解锁」。证据:`awake-evaluation-settlement.ts:76-80` 特殊奖励只置 `awakeEligibilityChanged` 注释称"由 Character Growth 在外层 owner 之后发布",但该路由(`routes/api/mission.ts:110-192`)无任何 owner 发布调用(`publishCharacterGrowthOwnerStateBestEffort` 只在同文件 `update_mission_progress:282` 出现;finish 路径有,`single-growth-publication.ts:52-70`)。影响:最终条件在「该角色不在队伍」时成立(如 `1410032` 八岐大蛇历史通关、`2630022` 累计玛纳跨阈值),第一页可领奖但第二页锁定,需重新 /load 才恢复。
- [AW-F4][P2·低置信] 信赖证任务(1410033/2210043/2510043/2610073)要求 `bondToken.status>=2`(已领取)而文案为「获得……的全部信赖之证」(≥1?);主数据 pattern 48 枚举名(第二玛纳板)与文案自相矛盾,服务端按文案实现,官方语义无法从反编译确证。
- [AW-F5][P2·潜伏] all-complete 子任务集合按 `missionId-3/-2/-1` 位减推导,未校验主数据 `row[19]`(客户端权威 selector);当前 36 条全量核对 0 mismatch,主数据漂移时无守卫。
- [V-AW1] 18 条件族与 docs 逐族一致,144 条唯一分区在模块加载时强制(`validateRulePartition`),fail-closed=0 与覆盖率测试锁定一致。
- [V-AW2] 55 条纯通用角色通关白名单与主数据逐条吻合(battle_kind 3、全空 selector、`row[24]==row[1]`)。
- [V-AW3] `2310012` 种族合集(主位+Sub 去重包含三种族+队长位)、`1610022/2610072` 棺柩全 zone 为 0、`3310032/3310033` 指定关卡+角色同场原子,均与主数据 selector 一致。
- [V-AW4] all-complete 槽位 4 进度=已达完成阶段的子任务数,子任务按各自 reward target 判定,父进度只作下限。
- [V-AW5] specialReward:36 条全部 board=1、awakeLevel=1、target=3、characterId==任务角色(0 mismatch);解锁 UPSERT 仅升不降、`changes>0` 才发布;节点级觉醒等级在 `players_characters_mana_nodes.awake_level`,无独立 mana_node_awake 表。
- [V-AW6] 幂等:重复结算跳过已领 stage,同请求重复 mission 去重,重复请求零发放(测试锁定);/load 校准链(补写缺失解锁、按板取最大、进化等级 guarded 修复)与文档一致。
- [V-AW7] eligibility 三态 fail-closed(unknown/not-ready 阻止显示、结算与新解锁);不要求第二块玛纳板。
- [V-AW8] computer-degree 1282/1288 抽查映射方向正确(角色等级 EXP 阈值、selector 40-43、type 44 信赖证、超级难度难度 4→等级区间);computer-regular SS/S/A/B=5/4/3/2 仅成功、weekly 周基线差值非负;computer-event-safe type 分布与文档一致、type 37 全部 80111、948 条空 selector 兼容标记存在、15 条 current-state 逐 ID 锁定;pass 三分类+活动基线差值正确、248/267 锁定。
- [V-AW9] evaluation-session fact 记忆化、重入防护、computer 纯度(查库只在 loader)成立;主数据与上游全等。

---

## 九、修复优先级建议(按症状影响排序)

**P1(建议优先处理)**

1. **mission 9 `character_level` 改读角色等级事实**(B-F1/AW-F3,症状③+②的现行实例):从 `needsPlayerRank` 拆出,复用 category 5 的 EXP→等级路径;同时是全审计唯一「恒开放+错误事实源+大额奖励」三要素齐备的现行缺陷。
2. **多人 finish 补 Active Mission reconcile + 响应 `active_mission_list`**(AM-F1,症状④主根因)。
3. **操作类计数事务内定向结算或纳入 reconcile 触发面**(AM-F2,症状④次根因)。
4. **`get_mission_progress` 觉醒路径补 owner 发布/解锁补写**(AW-F2,症状①/④):第一页领奖后第二页锁定到下次 /load。
5. **觉醒领奖时点定夺**(AW-F1,症状①):文档与代码二选一——恢复「页面领奖」则 finish 侧跳过 stage 发放,或修订文档承认 finish 即发。

**P2(窗口性/健壮性/文档)**

6. `factKindsForPattern` 补 pattern 57 的 `questProgress` 事实声明(AM-F3,消除脆弱耦合)。
7. Pass type 85/16/23 事实补 eventId 匹配(C-F4,防跨期双计)。
8. 每日 all-clear 按 `row[17]` 依赖集计算 + 接入 `weekevent_battle_play*` producer(B-F2,历史窗口回用前必须修)。
9. all-complete 子任务集合校验 `row[19]`(AW-F5)、kind 7 Pass event 缺失时降级为跳过而非 throw(B-F4)、信赖证 `status>=1/2` 语义向官方取证(AW-F4)。
10. 文档漂移修正:体力事实时点(C-F1)、type 37 结算时点、Pass 表情实现状态、任务页发奖时点表述、觉醒领奖时序(AW-F1/F2)。
11. 死代码清理:`settleSingleBattleMissionCategories`、`BATTLE_SETTLEMENT_CATEGORIES`(C-F3)。

**运营/产品决策**

12. 活动期任务开放:category 3/4 及 category 5/9 的历史任务在冻结时间 2024-08-14 下窗口未开(§一症状②数据),若需开放须调整全局 timeOffset;fail-closed 集合(Attention 27+5 条、救援 24+7 条、回归 25 条、Active 10 条)需逐族补生产者才能完成。

---

## 十、审查方法与证据可信度声明

- 全部 P1 发现(B-F1、AM-F1、AM-F2、AW-F1、AW-F2)由主审在不依赖子审计报告的情况下,直接重读源码文件并交叉验证主数据/反编译/测试后确认;P2 发现均附 file:line 与数据证据,子审计与主审结论不一致处已按亲核结果修正后收录。
- 「确认无误」条目(V-A/V-C/V-D/V-B/V-AM/V-AW 系列)同样要求子审计给出 file:line 或数据校验证据,未满足者不收录。
- 本审查为只读语义审查:未修改任何生产代码、未运行写库路径;`tsc --noEmit` 与 `tools/mission_coverage_audit.test.cjs` 在审查分支基线通过。代码与文档、代码与测试之间的每处背离均标注「哪边是应然需产品定夺」,不擅自归类为回归或文档过期。
