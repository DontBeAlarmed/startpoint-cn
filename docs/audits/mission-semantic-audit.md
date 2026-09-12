# 任务系统全量语义转代码审查报告

> 审查分支:`review/mission-semantic-audit`(基于 `relay/post-feature` @ 763d754d,审查期间零代码改动)
> 审查日期:2026-09-12。方式:主审 + 6 路并行子审计(CDN 目录解析 / 结算与奖励管线 / 战斗事实与 finish 挂接 / load 与登录操作事实 / Active Mission(主审代行) / 觉醒与四类 computer),全部结论经主审逐条对照源码、CDN 数据(`assets/mission_*.json`、上游 `wf-assets-cn/orderedmap/`)与 CN 1.8.1 反编译客户端复核;每条发现标注主审核验状态。
> 用户报告的四类症状:①奖励发放时点不确定;②部分任务不能完成;③奖励错配;④完成行为后进度不增长、需 /load 兜底。

## 状态:定稿(6 路子审计全部合入,关键发现均经主审二次核验;§十一 为按任务 ID 的人类审查表,中文描述逐字取自 CDN 表)

### 2026-09-12 修复关闭表(Mission Semantic Closure + H4 Gate)

| Finding | 状态 | 修复 |
|---|---|---|
| B-F1 mission 9 读玩家 rank | 已关闭 | `character_level` 改按持有角色最高等级(`RegularStateFacts.maxCharacterLevel`,degree 同款 proven 语义),requirement 声明 `characters` |
| B-F2 daily all-clear 硬编码核心集 / weekevent 无 producer | 已关闭 | `daily-completion.ts` 严格解析每条 all-clear 自己的 `row[17]`;weekevent 2/7/12 接入战斗 producer(type 14 + range kind 12 + category 6/13/14/20 + 单人),四代 `timeOffset` 回放有测试锁定 |
| AM-F1 多人 finish 不 reconcile、响应无增量 | 已关闭 | 多人 finish 在结算事务内调用 H4 owner 并投影 `active_mission_list` |
| AM-F2 操作类计数不触发 reconcile | 已关闭 | 编队/抽卡/经验注入/玛纳板学习+觉醒/装备觉醒+批量/商店/信赖之证 8 入口在业务事务尾统一调用 H4 owner |
| AM-F3 pattern 57 事实声明为空 | 已关闭 | `factKindsForPattern` 显式声明 `questProgress`(runner 预加载保留) |
| AW-F1 觉醒奖励 finish 即发 | 已关闭 | 战斗 finish/成长入口只写进度+即时发布解锁;category 9 第一页 `get_mission_progress` 是唯一领取入口 |
| AW-F2 页面路径不发布三板解锁 | 已关闭 | 第一页领取后同事务调用 Character Growth owner 发布解锁与角色 patch |
| D-F06 contents_guide/start 不跑依赖固定点 | 已关闭 | start 后同事务运行固定点,一个请求返回全部依赖变化 |
| C-F3 死代码 `settleSingleBattleMissionCategories` | 已删除 | `src/lib/quest/finish/single-mission-settlement.ts`(零调用方);`BATTLE_SETTLEMENT_CATEGORIES` 为测试 oracle 保留 |

未实施项维持 §一/§九 原状:Pass type 85/16/23 活动匹配、Attention/救援/回归资格 fail-closed、表情失败计数、未知奖励 kind/年份守卫、`row[19]` 校验、PERF-07(DEFERRED,恢复条件见 `task-C7-perf07.md`)。

---

## 一、四类症状的根因结论(先给答案)

### 症状④「完成后进度不增长,要 /load 兜底」——已定位两个确切机制,并已由 H4 Gate 关闭

标准任务(category 1~10)**不存在**该问题:战斗 finish 的结算 scope 覆盖全部有事实写入的类别,单人/多人 finish、/start、故事 finish 均在业务事务内即时结算(证据见 §四 V-C1/V-C2)。真正只靠 /load 推进的是 **Active Mission(活跃任务/成长任务)**:

- **[AM-F1][已关闭]** 原先多人 finish 只写战斗事实、不执行 Active Mission reconcile，且响应不带 `active_mission_list`。当前多人 finish 在 `src/multi/settlement/orchestrator.ts:502` 的业务事务尾调用 H4 owner，并由 `src/multi/settlement/response.ts:97` 投影增量；协力战斗后的 Active Mission 进度已经在同一响应和事务中推进。
- **[AM-F2][已关闭]** 原先 `party/edit`、`gacha/exec`、装备觉醒、商店购买、玛纳板学习/觉醒、`expod/inject_exp` 等入口只累计计数器。当前这些业务 owner 在最后一个权威写入后统一调用 H4 owner，并返回 `active_mission_list`。
- **客户端放大器仍是成立的背景证据**：客户端没有独立的 Active Mission 页面刷新请求，依赖 `/load` 的 `all_active_mission_list` 和通用响应的 `active_mission_list` 增量；因此本 Gate 将增量投影作为同事务修复的一部分，而不是依赖下次 `/load`。

### 症状②「有些任务不能完成」——三层原因,前两层是设计内 fail-closed,第三层是数据+冻结时间

- **[A-F6/C-F2/AM-F4][P1·设计内] 无事实生产者的任务永不完成**:`coverage-audit.ts` 机器清单——category 3 共 27 条 type 20 Attention(救援来源不可得)、category 5 共 6 条(25000/25010/25020 Attention、70004/70005/70006 协力新手)、category 1 救援族 62/63/64/87/88/89/100、Pass category 7 救援 19 条(pattern 20)。这些 ID 在当前代码中没有任何进度生产者。
- **[AM-F4][设计内] Active Mission 96 条中 35 条按设计锁死**:event 3(2022 限定,10 条)窗口已过;event 150 回归活动(25 条)时间窗虽开(2024-05-23 起、无结束),但 `isEventEligible` 无生产者恒 fail-closed(`active-reconciliation-runner.ts:74-87`);另有 10 条 `UNSUPPORTED_ACTIVE_MISSION_IDS`(21030 + 25009~25022 子集)evaluator 为 null(`active-plan.ts:20-31`)。
- **[冻结时间数据事实] 服务器固定时间 2024-08-14 12:00 UTC 下,活动类任务整体不可用**(主审 python 全量统计):category 3 启用 0/2512、category 4 启用 0/997、category 5 启用 1078/1288、category 9 启用 72/144;category 1 107/120、category 2 11/656、category 10 2/2、Pass 4/4/3。若运维把活动期任务也纳入运营目标,必须调整全局 timeOffset 至活动窗口内,否则 category 3/4 全部任务在协议上就是「未开放」,客户端与服务端行为一致(客户端同样按主数据窗口过滤),属数据+时间语义,不是代码错误。
- 其余「不能完成」候选(如具体 mission ID)需玩家报告 ID 对照 §四 C-F2 的 fail-closed 清单。

### 症状①「奖励发放时点不确定」——多种 owner 时点并存,但觉醒时序已按决策收口

标准任务阶段完成即自动发奖,首个到达的结算点发奖(幂等,重复调用不重复发,`settlement-write.ts:62-106` + `settlement-evaluate.ts:205` 单调合并)。标准任务仍可能在战斗 finish、业务操作、任务页或 `/load` 兼容结算点完成；Active Mission 推进到 `received=false` 后由 `/active_mission/receive` 手动领取；觉醒普通奖励则固定由 category 9 的第一页 `get_mission_progress` 领取。三类任务的 owner 语义不同，但当前实现与用户冻结决策一致。

- **[AW-F1][已关闭]** 战斗 finish/成长入口通过 `claimStageRewards: false` 只写觉醒进度并即时发布三板解锁；普通觉醒奖励由第一页统一领取。
- **[D-F04][P2·保留说明]** `/load` 登录任务仍在 onSend 编码事务内完成兼容性结算；该时点说明不是本 Gate 的运行时缺陷。

### 症状③「奖励错配」——mission 9 的现行错配已由 C1 关闭,其余解析/发放层未发现错配

- **[B-F1 = AW-F3][已关闭]** mission 9「初次达成角色等级 ::target_value::」原先错误读取玩家 rank；C1 已改为读取 `RegularStateFacts.maxCharacterLevel`，复用角色 EXP→等级曲线。mission 22 仍读取玩家 rank，两者现已按 CDN 文案分离。
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

**结论:内容解析/可用性/领奖/单调性核心正确;症状④的两个根因(F1/F2)已由 H4 owner 关闭;事件窗口与 evaluator 覆盖已全量核对。**

- [V-AM1] 数据列索引逐列验证(96 任务 row 长全为 73):eventId `row[0]`、phase `row[1]`、stringId `row[3]`、pattern `row[29]`、target `row[55]`、need `row[56..57]`、show `row[58..59]`、enable `row[60..61]`、show 期 `row[62..63]`;event 表 kind `row[2]`、maxPhase `row[3]`、start/end `row[14..15]`、needQuest `row[22]`;reward 表每 mission 恰 1 stage、target `row[3]`、clearSeconds `row[4]`(仅 25022 有值)、奖励槽 base 7+6*slot。
- [V-AM2] evaluator 覆盖:event 1 全 44 条有 evaluator(pattern 分布 4/5/8/9/13×4/21/23×13/34/35/36/45/57×8/58/59/61×2/62/63/64/65/66×2);event 2 全 17 条闭环(20001 pattern 74 由 `/contents_guide/start` 幂等写绝对进度 1,不经 evaluator);event 3/150 之外的 86 条与 docs 声明一致。
- [V-AM3] pattern 57(quest_clear,event 1 的 8 条)在 `factKindsForPattern` 声明为空事实集,但 evaluator 读 `finishedQuestIds`——由 reconciliation runner 的固定前加载补偿(`active-reconciliation-runner.ts:161` 无条件 `loadKinds(["activeProgress","questProgress"])`),当前无运行时缺陷;属脆弱耦合,若未来出现绕过 runner 的定向求值路径会恒算 0,建议补 `"questProgress"` 事实声明。
- [V-AM4] phase 释放语义与客户端逐行等价(`ActiveMissionRepository.getActiveMissionEventReleasePhase`:上一阶段全部任务当前阶段完成才释放;server `active-core.ts:80-103` 同义)。
- [V-AM5] `/active_mission/receive` 校验链完整(任务存在/阶段存在/阈值/重复/show 期可用性),`received=false`→手动领取,限时阶段(`targetClearSeconds`)缺权威秒数时拒绝完成与领取(`claims.ts:89-93`);事务内 `updateStage(true)→grant`,失败整体回滚;响应形状 `{mission_id,progress_value,stages:[{stage,received}]}` 与客户端 `applyCommonResponseActiveMission` 解析字段一致;客户端 receive remote 对 data 仅要求 Object。
- [V-AM6] `settleActiveMissionProgress` 单调(`Math.max`),stages 记账 `false`(待领取)/`true`(已领),限时阶段无秒数不关闭;evaluator 异常 fail closed 返回 null 不写进度。
- [AM-F4] 仍按设计保持 fail-closed，见 §一/§五。
- [AM-F5][P2·脆弱] `computeCandidate` 捕获全部求值异常静默跳过(fail closed 符合设计,但坏行只会表现为「永不完成」,无日志锚点,排障时建议至少留观察器计数)。

---

## 七、标准结算/奖励发放管线(子审计 B,主审已核验)

**结论:奖励 kind 映射、列偏移、mission_reward_id、幂等、单调性、响应合并全部正确;原先发现的 mission 9 错配与每日 all-clear 历史窗口问题已分别由 C1/C2 关闭。**

- **[B-F1][已关闭]** mission 9 原先读取玩家 rank 而非角色等级；C1 已改为读取 `RegularStateFacts.maxCharacterLevel`，并保留 mission 22 的玩家 rank 语义。
- **[B-F2][已关闭]** daily all-clear 现按每条 CDN 定义的 `row[17]` 依赖集计算，`weekevent_battle_play*` 已接入成功单人战斗 producer；C2 的四代 `timeOffset` 历史回放测试锁定该语义。
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

**结论:144 条觉醒条件族分区、原子事实、specialReward 解析与解锁写入、幂等与单调性全部与文档/主数据一致;原先两处 P1 时序问题 AW-F1/AW-F2 已由 C3 关闭，mission 9 错配已由 C1 关闭。**

- **[AW-F1][已关闭]** 战斗 finish/成长入口使用 `claimStageRewards: false` 只写觉醒进度并即时发布三板解锁；category 9 第一页 `get_mission_progress` 统一领取普通奖励。
- **[AW-F2][已关闭]** category 9 第一页领取路径在同一事务内调用 Character Growth owner，能够补写缺失的 `players_character_awake_unlocks` 并返回角色 patch；无需依赖下一次 `/load`。
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

## 九、修复优先级与剩余事项

**本 Gate 已关闭的原 P1**

1. B-F1：mission 9 已改读持有角色最高等级，mission 22 继续读取玩家 rank。
2. AM-F1：多人 finish 已在结算事务内执行 Active Mission reconcile，并返回 `active_mission_list`。
3. AM-F2：操作类计数入口已在各自业务事务尾执行 H4 owner，并返回增量。
4. AW-F1/AW-F2：觉醒 finish/成长入口只写进度并即时发布三板解锁；第一页统一领取普通觉醒奖励，并在同一事务内补写缺失解锁。
5. B-F2：daily all-clear 已消费各任务 `row[17]` 依赖，`weekevent_battle_play*` 已接入成功单人战斗 producer。
6. AM-F3：pattern 57 已显式声明 `questProgress` 事实。
7. C-F3：无调用者的 `settleSingleBattleMissionCategories` 已删除；测试 oracle 保留项不属于生产死代码。

**仍保留的 P2 / DEFERRED 项**

1. Pass type 85/16/23 事实是否需要 eventId 匹配，等待官方语义证据。
2. all-complete 子任务集合是否应校验 `row[19]`，当前 CDN 已全量核对无偏差，暂不改变运行时。
3. kind 7 Pass event 定义缺失时继续 fail-closed；只有取得明确产品/官方策略后再讨论降级。
4. 信赖之证任务 `status>=1/2` 的官方语义仍待取证；当前冻结策略为已领取状态 `status>=2`。
5. PERF-07 继续 DEFERRED，恢复条件见 `task-C7-perf07.md`。
6. Attention、救援、回归资格和其他无权威事实来源的任务继续 fail-closed。

**运营/产品决策**

7. 活动期任务开放：category 3/4 及 category 5/9 的历史任务在冻结时间 2024-08-14 下可能未进入窗口；若运营需要回放，应调整全局 `timeOffset`，而不是绕过 CDN 时间窗。

---

## 十、审查方法与证据可信度声明

- 全部 P1 发现(B-F1、AM-F1、AM-F2、AW-F1、AW-F2)由主审在不依赖子审计报告的情况下,直接重读源码文件并交叉验证主数据/反编译/测试后确认;P2 发现均附 file:line 与数据证据,子审计与主审结论不一致处已按亲核结果修正后收录。
- 「确认无误」条目(V-A/V-C/V-D/V-B/V-AM/V-AW 系列)同样要求子审计给出 file:line 或数据校验证据,未满足者不收录。
- 本审查为只读语义审查:未修改任何生产代码、未运行写库路径;`tsc --noEmit` 与 `tools/mission_coverage_audit.test.cjs` 在审查分支基线通过。代码与文档、代码与测试之间的每处背离均标注「哪边是应然需产品定夺」,不擅自归类为回归或文档过期。

---

## 十一、人类审查表(按任务 ID 对照)

> 用法:每行给出任务 ID、CDN 表内中文原文(`mission_*.json` 文本列逐字提取,`::xxx::` 为官方占位符)、当前实现链路(实现条件 → 奖励时点)、审查判定、应调整方向。人类复核时只需对照「中文描述 ↔ 实现链路」是否语义一致即可判断审查结论对错。
> **默认奖励时点(除非行内另述)**:标准任务(分类 1~10)阶段完成即自动发奖,战斗 finish / 任务页 / /load / 操作事务四个结算点先到先发,幂等不重复;Active Mission(活跃任务)进度推进到「待领取」,由玩家 `/active_mission/receive` 手动领取;觉醒(分类 9)由战斗 finish/成长入口只写进度并即时发布三板解锁,普通奖励统一由觉醒第一页 `get_mission_progress` 领取。
> 「冻结时间」指全局服务器时间默认 2024-08-14 12:00 UTC(国服 UTC+8)。

### 表 A:原 P1 发现（已由 C1–C6 关闭）

| 任务 ID | CDN 中文描述 | 当前实现链路(实现条件 → 奖励时点) | 判定 | 应调整方向 |
|---|---|---|---|---|
| 9 | 初次达成角色等级 ::target_value:: | C1 前：误读玩家 rank；C1 后：读取持有角色最高等级，mission 22 仍读取玩家 rank | 已关闭（B-F1） | 无 |
| 20004 / 20010 / 20012 / 20002 / 20003 / 20005 / 20007 / 12080 / 12090 / 13080 / 14040 | 协力或任意战斗类 Active Mission | C6 前：多人 finish 不即时 reconcile；C6 后：多人 finish 事务尾执行 H4 owner，并返回 `active_mission_list` | 已关闭（AM-F1） | 无 |
| 11020 / 11030 / 11040 / 11070 / 11090 / 12010 / 12040 / 13020 / 13100 / 14010 / 14050 / 14060 | 操作类 Active Mission | C5 前：计数只在操作事务写入；C5 后：各业务 owner 在事务尾执行 H4 owner，并返回增量 | 已关闭（AM-F2） | 无 |
| 1410032 / 2630022 | 历史通关或累计玛纳触发的觉醒条件 | C3 前：第一页领奖后可能缺失三板解锁；C3 后：第一页在同一事务内调用 Character Growth owner 并补写解锁 | 已关闭（AW-F2） | 无 |
| 全部 144 条觉醒任务(category 9) | 各条件见 `mission_char_awake.json` | C3 后：finish/成长入口只写进度并即时发布三板解锁；第一页一次领取全部已完成且未领取的普通奖励 | 已关闭（AW-F1） | 无 |

### 表 B:永不能完成(设计内 fail-closed——除非补生产者,否则永远锁死)

| 任务 ID | CDN 中文描述 | 当前实现链路(实现条件 → 奖励时点) | 判定 | 应调整方向 |
|---|---|---|---|---|
| 62 / 63 / 64 / 87 / 100 | 接受救援请求通关::quest_rank::领主战(常驻 5 条) | 无事实生产者(服务端无权威「救援来源」),进度恒为持久化值,永不推进 | 设计内 fail-closed | 补 Attention/救援事实源后接入 |
| 88 / 89 | 接受【降临讨伐】救援请求并通关通关协力战斗(常驻 2 条) | 同上 | 同上 | 同上 |
| 25000 / 25010 / 25020 | 累计完成 100/500/3000 次救援(称号) | 同上(coverage-audit 机器锁定的延期集合) | 同上 | 同上 |
| 70004 / 70005 / 70006 | 完成10次新手组队战斗(协力新手称号 3 条) | 无新手分类事实来源 | 同上 | 补新手判定事实 |
| event 任务 27 条:1402 / 1403 / 1404 / 1405 / 1408 / 1409 / … / 8149 / 8150 | 【多人领主】接受救援请求通关::quest_rank::领主战、【降临讨伐】接受中级协力战斗救援请求并通关::x_count:: 等 | type 20(Attention)无生产者;进度恒为持久化值 | 同上 | 同上 |
| pass_week 任务 19 条:4 / 8 / 12 / 16 / … | 接取救援请求 ::x_count::次 | type 20 救援保留持久化 fallback,不推进 | 同上 | 同上 |
| 21030 | 参加「大家一起选」(活跃任务) | UNSUPPORTED_ACTIVE_MISSION_IDS 硬编码无 evaluator;且其事件(「大家一起选」交互)无入口 | 同上 | 外部活动入口实现后再接 |
| 21010 / 21020 / 21040 / 21050 / 21060 / 21070 / 21080 / 21090 / 21100 | 编成角色 / 通关主线关卡第1章 / 在「玛纳板」上解锁角色的能力 / 通关协力战斗 / 在领主币兑换所兑换道具 / 通关主线关卡第2章 / 参加2次10连免费扭蛋 / 通关「摇曳的迷宫 养成道具」 / 阅读指定剧情(活跃任务) | 所属 event 3 窗口 2022-11-28~2022-12-12 已过 → 可用性核心直接关闭(21030 同窗口且另在 UNSUPPORTED) | 双重:窗口外 + 部分无 evaluator | 窗口属官方历史数据,不可完成是正确行为 |
| event 150 的 25 条:25000~25024(活跃任务,注意与称号 25000 重号但不同表) | 回归活动「白的砥砺长阶」各条件 | 时间窗 2024-05-23 起、无结束(时间上开着),但回归资格(`isEventEligible`)无生产者 → 恒 fail-closed;其中 25009~25014 / 25017 / 25018 / 25022 同时无 evaluator | 设计内 fail-closed(资格层) | 回归资格协议明确后逐项接入 |

### 表 C:冻结时间不可用(数据×时间语义,非代码错误)

| 任务 ID | CDN 中文描述 | 当前实现链路(实现条件 → 奖励时点) | 判定 | 应调整方向 |
|---|---|---|---|---|
| category 3 全部 2512 条活动任务 | (各类活动任务,文本随活动期各异) | `isEnabledAt` 按主数据 UTC+8 开放窗过滤;2024-08-14 下启用 **0 条**;客户端同规则过滤,两端一致 | 冻结时间下整体不可用(数据事实) | 若运营需开放活动:调整全局 timeOffset 至目标活动窗口 |
| category 4 全部 997 条收集任务 | 收集指定活动道具获得量(需 event scope) | 同上,启用 **0 条**,且强制 event 匹配 | 同上 | 同上 |
| category 5 其中 210 条、category 9 其中 72 条 | 各历史期称号/觉醒任务 | 同一窗口过滤(1078/1288、72/144 启用) | 历史窗口外不可用(预期) | 同上 |
| 1225 | 【活动期间内】登录游戏 ::x_count:: | `startdash_login` 窗口 2019-11-27~2019-12-16;`getEventLoginMissionId` 恒返回 null → /load 的事件登录分支为**永久空转**(不产生事实也不出错) | 窗口外 + 死分支 | 无需修代码;若未来开同类任务,分支自动启用 |
| 400053~400056 / 400071~400074 / 400089~400092 | 【战阵之宴】参加活动 / 在SET编辑中复制替换主队伍·副1·副2 队伍(已结束的 4 期战阵之宴) | 条件:`/event/raid/summary` 或 RAID SET 保存,幂等完成到 1 | 窗口外不可用(预期) | 无 |
| 400093~400096 | 【战阵之宴】参加活动 / 复制替换主·副1·副2 队伍(2025-06-26 开始的未来期) | 同上,窗口未到 | 窗口前不可用(预期) | 无 |
| 107 | 确认主页的推特 | `update_mission_progress` 白名单增量(twitter_check 前缀全库唯一命中);窗口 2099-12-30~2099-12-31 | 未来窗口,当前不启用(数据如此) | 窗口到即自动生效,无需处理 |

### 表 D:窗口性/潜伏风险(P2,当前时间窗内未表现)

| 任务 ID | CDN 中文描述 | 当前实现链路(实现条件 → 奖励时点) | 判定 | 应调整方向 |
|---|---|---|---|---|
| pass_week 11(+ category 8 的 16/23 族) | 在战斗中累计发送个性表情 ::x_count::次 | 条件:multi 战斗上报 send_emotion_count>0 即对**全部开放期内**同 patternType 任务累加;不匹配战斗所属活动、失败战斗也计数;当前开放 Pass 任务全部属 event 3 且每 patternType 仅 1 条 → 未触发 | 潜在:两期 Pass 重叠时跨期双计 | 事实写入补 eventId 匹配 |
| 1410033 / 2210043 / 2510043 / 2610073 | 获得丛云/爱丽丝/芬/赛吉尔的全部信赖之证(觉醒) | 条件:四枚信赖之证 `status>=2`(**已领取**);官方文案为「获得」(≥1?)且主数据 pattern 名(48=二板完成计数)与文案自相矛盾 | 语义存疑(偏严) | 向官方语义取证后定 ≥1 或 ≥2;现状可玩但可能多一步 |
| 觉醒 all-complete 36 条:1510064 / 2510034 / 1410034 / … | 完成全部觉醒任务 | 条件:三个子任务(ID-3/-2/-1 位减推导)全部达到完成阶段;当前 36 条与主数据 `row[19]` 全量核对 0 偏差,但启动期 schema 校验未纳管 row[19] | 潜在:主数据漂移时静默评估错集合 | 把 row[19] 纳入 `validateResolvedFamilySchemas` 守卫 |
| 各 Pass 任务的 Pass 点奖励(kind 7) | (奖励内容为 Pass 点的任务) | 发放时要求 `pass_card_event.json` 定义存在且合法,缺失即 throw → 整个结算事务回滚;当前 19 期数据完全对齐 | 潜在:内容漂移放大为整请求失败 | 降级为跳过该奖励 + 告警,不放大 |
| (间接完成任务 B) | 任务 A 的奖励使任务 B 达标(如获得道具→收集任务) | 同一次结算的阶段 B 只用新事实**刷新响应显示**,不写库不发奖(文档明示);DB 进度与 B 的奖励推迟到下一次覆盖 B 的结算 | 设计内显示/DB 短暂不一致(症状①观感来源之一) | 保持文档口径,或产品定夺是否允许同请求二次发奖 |

### 表 E:确认无误抽查锚点(用于验证「没有问题」的结论)

| 任务 ID | CDN 中文描述 | 当前实现链路(实现条件 → 奖励时点) | 判定 | 应调整方向 |
|---|---|---|---|---|
| 22 | 玩家级别达到 ::target_value:: | 玩家 rank 事实——**与文案一致**(与任务 9 形成正误对照) | 确认无误 | 无 |
| 108 | 【特别】累计登陆天数 ::x_count::(18 段) | /load 登录事实(UTC+8 自然日,同日幂等),阈值取自 reward 表,自动发奖 | 确认无误 | 无 |
| 16 | 消耗 50 体力 | 体力周期快照差值;体力累计实际在 finish 提交(文档称 /start,属文档漂移 C-F1,进度本身正确) | 确认无误(附文档修正) | 修文档 |
| 800115 / 800124 | 【圣夜的淘气鬼】通关协力战斗::x_count:: / 【荒龙特选】通关领主战协力战斗::x_count:: | 每日快照差值 + 活动selector 严格匹配(窗口已关,机制验证无误) | 确认无误 | 无 |
| 10075 | 【无限演武】通关任意一个关卡 | 空 selector 官方异常行的白名单兼容(category 27 + event 1),成功单人结算计 1 | 确认无误 | 无 |
| 1208 / 1209 / 1210 | 【第2天】达成评价 SS ::x_count::(族) | 仅成功结算、SS(=5)逐场 +1 | 确认无误 | 无 |
| 1216 | 【第4天】以 ::target_value:: 以上战力通关关卡 | `statistics.max_power` 非负安全整数校验后 MAX 写入 | 确认无误 | 无 |
| 600002 / 900812 | 在战斗开始180秒内,自身没有棺柩次数的情况下,以SS评价通关 | 多人 SS + `clearTime<=180000` + 全 zone `encoffinment_count=0`,任一缺失 fail closed | 确认无误 | 无 |
| 600001 / 900809 | 在战斗中一次也没有受到来自敌人抗性下降的效果,以SS评价通关 | 多人 SS + 每 zone 非空成员 `debuff_r=0` 全员校验 | 确认无误 | 无 |
| 3000 / 3010 / 3020 | 角色达到 Lv 60 / 80 / 100(称号) | 按 rarity 的官方 EXP 上限阈值证明等级下界——**正确的角色等级实现**,与任务 9 对照 | 确认无误 | 无 |
| 47000 | 在角色详细中查看 1 分钟放大后的插画(称号) | 客户端静默上报白名单(`update_mission_progress` 增量,五 pattern 对齐 `MissionCounterLogic`) | 确认无误 | 无 |
| 14000 / 15000 | 单人战斗获得 10000000 以上的分数 / 单人战斗 60 秒以内通关(称号) | `single_score_max` MAX / `single_clear_time_min` MIN(方向正确),仅成功单人 | 确认无误 | 无 |
| 2310012 | 以拉姆斯作为队长,队伍中编有人、龙、魔通关任意关卡(觉醒) | 同一场成功 finish 内主位+Sub 种族去重包含三种族且队长位匹配(原子,不拼历史) | 确认无误 | 无 |
| 1610022 | 以威隆作为队长通关任意关卡::x_count::次,且不能有队友阵亡(觉醒) | 全 zone `encoffinment_count=0`,缺失/非法 fail closed | 确认无误 | 无 |
| 3310032 | 队伍中编有泰加、阿尔克通关结实假人·风(觉醒) | 指定单人关卡 + 指定角色组合同场成功,原子判定 | 确认无误 | 无 |
| 11010 | 阅读角色故事(活跃任务) | `/story_quest/finish` 事务内即时 reconcile,响应带增量——**单人/故事路径的即时性是成立的**(与多人路径对照) | 确认无误 | 无 |
| 20001 | 开始内容指南(活跃任务) | `/contents_guide/start` 按 event kind 2 + stringId 唯一定位,幂等写进度 1;后续任务解锁要等下次 reconcile(D-F06,轻度延迟) | 确认无误(附已知延迟) | 可选:该入口顺带跑固定点 |
| 20017 | 使用"开局3个技能槽充满的队伍"通关一次战斗(活跃任务) | `skill_point_over_on_start` 各战区合计=3,超界 fail closed | 确认无误 | 无 |
| 1201 | 【第1天】通关 ::chapter_number::(活跃任务) | 主线章节全部官方关卡 `finished` 才算,非任意关卡通关数 | 确认无误 | 无 |
| 1305 | 【崩坏域准备】角色等级提升 ::target_value:: 以上(活跃任务) | 按 rarity 官方 EXP 阈值证明等级下界,不用中文文案猜测 | 确认无误 | 无 |
