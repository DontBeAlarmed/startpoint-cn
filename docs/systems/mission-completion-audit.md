# 任务系统完成度审计

## 已完成基础

- 分类任务进度使用 `players_category_missions`，以 `(category, mission_id, player_id)` 唯一标识。
  普通、每日、活动、每周和觉醒任务即使 ID 相同也不会互相覆盖。
- 数据库版本 3 会把已知角色觉醒记录从旧 ActiveMission 表迁出；版本 5 增加累计战斗事实和周期基线；
  版本 6 增加收集任务累计获得量和单人 SS 独立事实；版本 7 增加 Pass 点数和双轨领奖状态。
  无法确定分类的历史行不会猜测迁移。
- 进度写入使用 SQLite UPSERT，不再通过 `INSERT OR REPLACE` 删除已有的阶段领奖子记录。
- `update_mission_progress` 把客户端值作为增量处理，符合 `MissionCounterLogic` 每次静默上报后清空本地批次的行为。
- 每日和每周重置分别删除 category 2/6 与 category 7/10 的任务状态，并记录累计战斗、评级、冲刺、强化弹射、
  体力和登录天数的当前基线。旧存档升级时以升级时状态创建基线，避免把历史累计量误算成本周期进度。
- `get_mission_progress` 会检查任务开放时间、收集任务 `event_id`，并独立处理每个角色觉醒
  `character_id` 请求。
- 主数据由 `master-data.ts` 按分类解释列位置：category 1、2、3、10 的 pattern 位于 `row[0]`，
  category 4 同时读取 `row[0]` 的 event ID 与 `row[2]` 的 pattern，category 5 使用 `row[1]`，
  category 6/7/8 使用 `row[0]` 的 Pass 活动 ID、`row[1]` 的 pattern 和 `row[3]` 的 pattern type，
  category 9 使用 `row[2]`。开放期统一按国服 UTC+8 解释，不再由各计算器分别猜测列号。
- Degree 的四条客户端进度不把 `row[1]` 的内部任务名当请求 pattern；它们按 CN 1.8.1
  `DegreeMissionValues` 对 `row[3]` 的严格 selector `40/41/42/43` 解析客户端字段。其他 token、数值类型和近似字段名均不匹配。
- CN 1.8.1 的 `MissionCounterLogic` 只静默发送五种客户端行为：角色详情插画停留一分钟、角色点阵动作、
  主页点击城镇角色、主页切换语音和主页推特确认。`update_mission_progress` 只接受这五种白名单，
  并只写入服务器时间下已开放的匹配任务；未知、非正整数、历史期和未来期输入均不写库。
- 单人和多人结算统一通过 `recordMissionBattleFacts` 写入独立事实。完成 finish 请求会增加游玩次数；只有成功通关才增加
  单人/协力累计通关、房主/成员通关、评级、角色通关、队长 power flip、队伍组合和种族组合。
  `players_quest_progress` 只表示不同关卡的历史最佳状态，不再冒充累计通关次数。
- 角色觉醒配对按数值 ID 归一化，读取时合并旧反序记录；三角色任务 `2410633` 改为同一次成功 finish 原子匹配，不再拼接三组 pairwise 历史。
  `3310032/3310033` 只在指定单人关卡与指定角色组合同场成功时增加 category 9 持久进度。
  信赖证列表为空时不会完成任务。
- 角色觉醒 144 条任务已按 18 个真实条件族唯一分区；141 条有权威计算路径，55 条纯通用角色通关使用固定
  ID 白名单。强化弹射、单场连击、三角色同队和指定队长+关卡/限时均在一次成功 finish 中原子记录，不读取
  可跨场污染的全局或关卡历史摘要。`2310012` 的种族 selector 包含/精确语义与 `1610022/2610072` 的
  statistics 17 字段映射尚无权威证据，3 条任务 fail closed 并保留旧持久进度。核心解锁与领奖流程已通过客户端，
  144 条条件尚未由客户端逐条验收。
- category 1、2、6、7、8、10 的 `get_mission_progress` 会补结算已完成且未领取的阶段；携带角色 ID 的 category 9 请求仍是
  觉醒第一页的正式领奖入口。
- ActiveMission 领奖会在原子发奖前校验任务存在、阶段定义、完成阈值、既有领奖状态与重复请求。
- ActiveMission 奖励保留 kind 0（星导石），并把物品、装备、角色、玛纳、经验和称号写入正确的响应集合。
- Active Mission 的 96 条任务定义、4 个事件定义和奖励表已从官方 1.4.54 资源纳入运行资产与 Content registry；
  当前 Content snapshot 读取、国服 UTC+8 推进/领奖期、事件关卡、phase、`need/show`、幂等结算核心、领奖和存储链可用，
  但 96 条业务事实生产者仍未接齐，详见[Active Mission](./active-mission.md)。

## 普通、每日与每周自动结算

- category 1 使用终身累计事实：SS/S/A/B 对应 `clear_rank` 5/4/3/2；单人、协力、房主和成员通关均为成功次数；
  玩家等级、累计登录、冲刺、强化弹射和最高连击读取各自权威字段。
- category 2 使用每日快照差值。默认服务器时间下当前开放 11 条每日任务，现已 `11/11` 自动计算：常驻
  `11/13/14/16/17` 共 5 条，活动每日共 6 条。常驻 all-clear `17` 只汇总单人通关、协力通关、冲刺和
  消耗体力四项，不包含活动任务。
- 活动每日 `800115..800117` 使用 Advent selector `200015`，只接受 category 7 范围内匹配活动的协力成功；
  `800124..800126` 使用 BossBattle 全范围，只接受 category 2 的领主战协力成功。每条任务仍按自身开放期和
  奖励阈值独立增长。`mission_daily` 历史总表共有 656 条，本项目不宣称全部支持。
- 后续每日 `10075` 只接受 category 27、event 1 的成功单人无限演武结算；`800392` 按主数据
  `battle_kind=3` 接受任意成功单人或协力结算。两条均在自身开放期内逐场持久化，达到 1 次后通过统一任务结算发奖。
  `10075` 的官方行文为“任意一个关卡”，但本地关卡 selector 是空字符串；服务端仅对该精确任务 ID 使用
  event 1 的官方无限演武关卡表闭合，不把空 selector 扩展为通用规则。
- category 10 直接读取自身主数据：`weekly_mission_1` 使用本周登录天数，`weekly_mission_2` 使用本周协力成功次数，
  不再错误扫描 category 1、2 的同 ID 任务。当前两条均可自动计算，即 `2/2`；仍待官方 CN 客户端完成跨周完整验收。
- 体力事实发生在单人 `/start`，所以体力任务与入场扣除、active quest 持久化共享事务；任务结算失败时全部回滚，
  内存 active quest 不会提前发布。单人和多人 `/finish` 的战斗事实、原关卡奖励、任务阶段与任务奖励也共享外层事务。
- `mission_info`、物品、角色、装备、称号和玩家余额通过统一响应合并器追加；库存和余额使用发奖后的绝对值，
  不与旧响应重复相加。任务、Active Mission、单人开始和单人/多人结束响应动态返回 `mail_arrived`。
- 新存档创建当天计为第一个登录日。周期差值统一限制为非负，历史最佳和已持久进度不会倒退，重复请求不会重复发奖。

## 收集任务与称号任务

- category 4 的 `row[14]` 是目标物品 ID，进度语义为累计获得量，不是当前库存。
  `givePlayerItemSync` 在同一 SQLite 事务中更新库存和 `players_collected_items`；消费物品、后台直接设置库存和存档导入
  不伪造累计历史，事务失败时两项写入一起回滚。
- category 4 任务页必须携带 `event_id`。通用结算只扫描该活动和服务器时间下已开放的任务，跨活动同 pattern 不会写入。
  `/load` 的 `cleared_collect_item_event_mission_list` 按 CN 1.8.1 协议返回 `{ missionId: 已领取阶段 }` 整数映射，
  不再固定为空数组。
- 当前存档导入导出格式尚未包含 `players_collected_items`。替换存档后不能从当前库存反推历史累计值；这是已知边界，
  本轮按需求不扩展完整数据库导入导出。
- category 5 共 1288 条。当前自动计算 1274 条有权威服务端事实的任务：玩家等级 8 条、角色等级 2 条、持有角色数 3 条、
  上限突破总次数 3 条、玛纳板节点数 3 条、信赖之证数 3 条、单人 SS 次数 3 条、累计使用技能 3 条、累计获得锻造石 3 条、单次最高连击 3 条、累计冲刺 3 条、领主战累计通关 3 条、单人最高分 3 条、单人限时通关 3 条、挑战副本累计通关 3 条、第二玛纳板累计节点数 3 条、第二玛纳板指定角色完成 472 条、累计消耗体力 3 条、累计登录 3 条、章节主线与高难全通 12 条、练习关卡 SS 5 条、珍品商店购买次数 3 条、指定 Boss 超级难度 13 条。
  指定 Boss/Advent 累计通关 84 条、ExpertSingle 精确单关 12 条、WorldStory 精确单关 27 条、Advent 精确单关 1 条、Carnival 精确单关 27 条、HardMulti 精确单关 6 条、活动累计物品 2 条、满级装备 3 条，以及 Degree 客户端进度 4 条。另外 484 条 type 44 从主数据 `row[15]` 读取指定角色 ID；该角色已有 `status>=1` 的信赖之证时进度为 1。
  在本项目受支持的官方客户端养成流程中，信赖之证状态是该条件达成后的持久标志，因此这里不使用缺失的 EXP 等级曲线重复推算等级。
  `status=1` 表示待领取，`status=2` 表示已领取，两者都属于已经获得；总数称号和指定角色称号均不会因领取后状态变化而倒退。
  单人 SS 使用独立计数，协力 SS 不会污染；schema 6 升级前混合累计的旧 SS 无法可靠拆分，因此不回填。
- 已接入的简单称号族包括协力成功总数 3 条、作为房主的协力成功总数 3 条、已完成角色剧情数 3 条、挑战副本累计通关 3 条、单人最高分 3 条和单人限时通关 3 条。角色剧情
  使用 SQL `COUNT(*)` 直接统计 category 3 已完成关卡，并由
  `idx_players_quest_progress_player_section_finished` covering index 支持。
- 当前称号覆盖为 `1274/1288`，约 `98.9%`；unsupported 为 14 条。84 条指定 Boss/Advent 累计通关称号按主数据 selector 和官方关卡表精确匹配；46 条称号读取成功 finish 的分 battle kind zone 累计、单场最大战斗统计；珍品商店 Mana 和装备觉醒 6 条从业务事务增长；4 条展示/点击称号读取官方客户端静默请求。MVP 与魂珠设置等缺少权威事实的任务继续 fallback。
- 14 条 fallback 已由 `coverage-audit.ts` 按 ID 固定分类：Lv60 角色等级 1 条、魂珠设置 3 条、主数据不存在的指定 Boss 难度 1 条、Attention 3 条、MVP 3 条、协力新手 3 条。每条均携带机器可读原因；新增事实族必须同时改变 ID 分区测试，不能只改文档数字。
- 其余已实现称号只读取对应的持久化角色、装备、关卡、库存、商店或成功结算事实，并与旧进度取最大值。未知主数据、非法客户端统计和缺少权威生产者的条件继续 fallback，不根据中文描述或相邻任务推算。
- 角色等级称号 `3010/3020` 分别按各稀有度官方 Lv80/Lv100 上限 EXP 阈值计算当前可证明的最高等级，并与持久化进度取最大值。`3000` 仍不自动计算：四、五星角色的现有阈值表从 Lv70/Lv80 开始，不能准时证明 Lv60；在 CDN 转换器补齐完整曲线前不使用近似阈值。

## 活动任务安全边界

- category 3 共 2512 条，旧 `mission_event_quest_map.json` 名义映射 2305 条，缺失 207 条；默认
  `2024-08-14 12:00 UTC` 时没有正在开放的缺失项。映射中 `single/multi/finish` 数量分别为 396/1679/230。
- 旧 map 只展开关卡 ID，未完整保留活动期、难度、评级、房主/成员、救援来源、阶段和客户端战斗检查等维度；
  1034 条已映射任务仍带有未应用的关卡或评级过滤。它只供 `computer-event.ts` 历史审计，不能作为自动事实或安全发奖依据。
- 230 条 `finish` 实为限时通关任务，审计计算器已按奖励表秒数和最佳毫秒记录修正，不再把一次普通通关判定为全部档位完成。
  该计算器只用于审计和后续规则迁移。
- 旧 939 条自动规则都把 `row[10]=""` 错当作通配，现已全部移除；1400、1811 和 1807 等任务不再由该批规则增长。
  `mission_event_quest_map.json` 保留以便复核历史审计结果，不删除、不参与 `event-battle-facts.ts`。
- 新 `mission_event_battle_rules.json` 按 mission ID 保存 805 条严格规则：type 16 共 792 条，其中 692 条有限
  `questIds`、100 条全 QuestRange；type 17 Host 12 条；type 18 Guest 1 条。规则只在成功多人 finish、role、category、
  quest ID 与开放期全部匹配后原子增量。Host 只接受 `isMultiHost=true`，Guest 只接受 `false`，`undefined` 关闭匹配；
  type 16 不要求房主标记。
- type 37 `get_item_count` 的 40 条交易商人任务使用 `row[12]` 的物品 ID 和
  `players_collected_items` 累计获得量计算。当前 40 条均指向官方物品 `80111`；只在任务页请求 category 3 且任务处于
  开放期时结算和发奖。category 3 的运行时计算器只白名单该类型，其他任务保持持久化进度，旧 map 不会被重新启用。
- CN 1.8.1 QuestRange 中 BossBattle、Advent、WorldStoryEventBossBattle 分别只对应 category 2、7、19；Advent 不含
  category 8。`row[10]=""` 是 `Within([])` 且严格无匹配，`(None)` 才是 `All`；`row[11]` 是 QuestRank，当前启用
  规则均为 `null`。type 20 Attention 因 `FinishContext` 没有权威救援来源而保持 0 条，普通 Guest 不冒充 Attention。
- “接取救援请求”保持低优先级，暂不实现；在获得可区分 Attention 的权威来源前，不以普通 Guest 代替。
- 当前 category 3 共启用 1525 条严格事实：805 条 QuestRange 协力规则、257 条 type 23 精确通关规则、445 条关卡、物品、竞速、阶段、当前状态及单人累计规则，以及 18 条 Event 入口/SET/投票事实。
- 1225 只在任务开放期内的真实 `/load` 按统一服务器时间和 CN 自然日增加 1；`players_event_mission_login_days` 仅保存玩家与任务的最后计数日。Active Mission reconcile 与响应构建完成后，load 在 reply 上登记 request-local pending commit；生产 CN MsgPack `onSend` hook 完成实际编码后才执行该 commit，并使用 `BEGIN IMMEDIATE` 处理多连接竞争。同一自然日只有一个连接增长。同一玩家的多设备、同日重复 load 和服务器时间回拨都不重复累计，一次登录也不补造跳过的历史天数。reconcile、响应构建或实际 CN onSend 编码失败均不计数；编码成功后交给网络栈的传输失败不纳入该保证。
- 400053/400071/400089/400093 分别只在活动 4/5/6/7 的 `/event/raid/summary` 请求中幂等完成到 1；事实写入使用嵌套保存点，异常时仅回滚该事实并记录 player/event/mission 告警，既有 summary 奖励、状态和响应继续完成且不增加响应字段。
- 400054～400056、400072～400074、400090～400092、400094～400096 只在 `use_party_group_edit=true` 的 `/party/edit` 事务成功保存 RAID 第 1 组槽位 1/2/3 后，分别幂等完成主队伍、副 1、副 2 的 progress 1。同请求重复槽位去重；普通编辑、非 RAID、其他组、槽位 4～10、无开放活动族或多个活动族重叠开放均 fail closed。任务 SQL 异常向外传播并回滚队伍更新与 Active Mission 计数，成功响应不增加 `mission_info`。这只能证明 SET 编辑器成功保存目标槽位，不能证明用户点击了复制按钮。
- 18 条规则逐 ID 校验官方 pattern、严格十进制 pattern type/奖励 target、可选 QuestRange selector、保留空字段和精确 `YYYY-MM-DD HH:mm:ss` UTC+8 日历开放期；空串、首尾空白、溢出整数、不存在日期和任一主数据漂移均 fail closed。
  其中新增的 7 条战斗结算事实来自官方主数据 pattern 26/27/28：1208/1209/1210 只在 battle_kind=3 的成功 SS 结算中逐场增加；1216 读取成功结算的 `statistics.max_power`，仅接受非负安全整数并以最大值写入；1200/1211/1223 校验官方 row[3]=2 后读取 `zones[].use_dash_count`，三条适用规则以同一批次逐场累加非负安全整数总和，任一 zone 非法、统计求和溢出，或历史持久化 progress 加本次 delta 超过 `Number.MAX_SAFE_INTEGER`，则三条整批不增长。非负统计输入仍是合法格式，但合计为 0 时是 no-op，不写入 progress，也不视为 matched。7 条规则均由精确 mission ID 白名单逐条取主数据，动态校验 pattern、battle kind、statistics code，并受任务开放期限制；battle_kind=3 同时接受单人和多人。另有 29 条 Ranking Phase 任务只接受 category 11 的成功单人结算，按官方关卡表精确匹配 quest ID，并以合法整数 `clear_phase` 完成不高于本次阶段的任务；另有 8 条 type 14 任务按摇曳迷宫、EX 和崩坏域的权威 QuestRange 逐次累计成功单人结算。
  其中包括 40 条 `get_item_count`、54 条土俑单关卡、18 条土俑聚合任务、37 条崩坏域庆贺单关卡
  和 7 条崩坏域庆贺聚合任务。土俑与崩坏域任务均由 CDN 关卡表、活动任务主数据和持久化关卡完成记录闭合，
  不读取客户端自报计数。另有 188 条 category 11 与 42 条 category 24 竞速任务由精确关卡、官方奖励秒数和历史最佳时间闭合。
  其余 987 条（包括 mission 1807）仍使用持久化 fallback。
  任务页不从旧 `mission_event_quest_map.json` 直接推算；只有通过精确事实白名单闭合的规则才会自动计算或持久化。安全计算器当前登记 407 条，其中 6 条目标为 1 的 type 14 任务可从历史完成记录回填；它们同时拥有 finish 生产者，因此不在 1525 条总覆盖中重复计数。生产上下文保留数据库返回的全部关卡 category，不再只装载 Ranking/Rush 两类。
  新增 15 条当前状态任务逐 ID 校验 `mission_event` pattern、章节 selector 和 `mission_event_reward` 全部 target：type 5 的 1305 只按官方 EXP 上限阈值证明 50/60/70 级下界；type 7 的 1205/1206/1207/1217/1218/1219 只统计能在对应角色官方玛纳板确认 multiplied ID 的当前节点；type 9 的 1306 先按角色 rarity 校验官方最大突破步数，再汇总当前突破次数；type 21 的 1204 从 `character_quest_lookup` row[0..2] 建立精确角色归属后统计已完成记录，不使用 quest ID 前缀；type 22 的 1201/1202/1203 要求主线 category 1 对应章节的官方全部关卡完成，不把任意 quest clear 数当章节。type 34 的 1212/1307 只汇总存在官方正整数 `max_level` 且 `1 <= level <= max_level` 的当前装备觉醒级数 `level - 1`，不读取 `enhancement_level` 或 stack；type 35 的 1220 因官方 target 仅为 1，逐个普通 party 独立校验官方 item category 5 和该 party 内使用数不超过玩家持有量，只要存在一个合法非空 party 即证明进度，不把不同 preset 同时占用库存。官方静态索引任一行异常会关闭对应事实族；玩家非法角色、节点、装备或 party 只排除自身贡献，保留其他已验证安全下界。所有合法结果仍与持久化 progress 取最大值。
  官方表派生索引按启动后冻结的 Content repository 对象缓存，不支持也不引入热更新。`buildContext` 只有在 evaluationTime 下至少一条上述任务开放时才读取新增角色、玛纳板、装备、物品和 party 玩家状态；15 条均关闭时不构建索引、不执行新增查询。
  后续仍需补全活动范围、评级、房主/成员、救援、阶段和 client check 等谓词后逐批启用。
- 987 条 fallback 中，948 条 type 16 的 QuestRange 至少一个列表 selector 为 `""`。CN 1.8.1 `EventMissionValues` 将它解析为 `Option.Some([])`，不是 `Option.None`；客户端 QuestRange 匹配测试证明空集合不等于通配。因此这 948 条不得扩成“该活动全部关卡”。另有 27 条 type 20 缺少 Attention 救援来源，其余 12 条按 pattern type 保留明确的权威事实缺口。

## Pass 分类与等级奖励

- 官方 CN 1.4.54 包含 76 条 PassDaily、76 条 PassWeek、115 条 PassEvent、19 期活动和 1140 条等级奖励，
  已由 `content:pass` 生成服务端资产；不再使用“官方主数据缺失”的旧结论。
- category 6 已接入单人、协力、冲刺和体力；category 7 已接入协力和体力，救援与表情仍保留持久化 fallback；
  category 8 已接入活动登录、type 16 指定协力关卡和 6 条按 `battle_kind`/QuestRange 匹配的 type 23 活动关卡。
- Pass 覆盖分区为 `229/267`：category 6 的 76 条、category 7 的协力/体力 38 条和 category 8 的 115 条已有事实；category 7 的救援 19 条及战斗表情 19 条保留 fallback。
- Pass 周常使用活动专属基线，避免月中开放时计入开放前行为。任务阶段结算会按任务定义中的活动 ID 原子增加 Pass 点数。
- `Pass_card/get_pass_card` 和 `receive_all` 已从固定空响应改为真实点数、等级、免费/付费双轨领取和防重复事务。
  当前没有 Pass 购买流程，付费轨保持锁定。详细契约见[修行之道](./pass-card.md)。

## 角色觉醒时序

角色觉醒的“第二页解锁”和“第一页领奖”已经解耦：

- 权威状态变更端点在最终条件成立时幂等写入 `players_character_awake_unlocks`，并仅在状态真正变化时通过
  `character_list` 发布；该步骤不写 category 9 领奖状态，也不发奖。
- 因持久解锁会在场景创建前进入客户端角色状态，全部任务完成的角色首次进入时直接显示第二页。
- 玩家手动切回第一页后，category 9 `get_mission_progress` 才结算所有未领奖励，返回
  `mission_info` 和奖励变更，不重复发布已有解锁。
- 对缺少持久解锁且最终特殊阶段仍未领奖的旧/异常存档，该阶段结算会幂等补写；只有本次 UPSERT
  改变状态时才返回一次角色解锁条目。
- 如果最终特殊阶段已经存在领奖状态但解锁行丢失，结算逻辑不会重放；由 `/load` 校准或数据库升级回填修复。
- 结算逻辑会先按 `mission_id` 聚合最大进度，再统一持久化和领奖，重复输入不会让进度回退。
- 结算涉及的进度、领奖状态、普通奖励、持久解锁和玩家数据处于同一 SQLite 事务，任一步骤失败都会整体回滚。
- 重复进入、重复领奖请求与重复校准都不会重复发奖、重复通知或降低解锁等级。
- `/load` 从持久解锁重建 `mana_board_awake`，并与实际节点觉醒等级按板取最大值。

客户端 `preparation()`、`afterTransition()` 和 `tabChanged(1)` 的详细行为见
[角色觉醒刷新与解锁时序](./character-awake-refresh.md)。

## 尚未完成的分类

`src/lib/mission/coverage-audit.ts` 是覆盖数字和剩余 ID 的唯一机器清单。`tools/mission_coverage_audit.test.cjs` 锁定 category 3 `1525/2512`、Degree `1274/1288`、觉醒条件族 `144/144`（其中 resolved 141、fail closed 3）和 Pass `229/267`，并要求分区无交集且每个 fallback/fail-closed 条目都有原因。该报告证明代码路由和事实生产者覆盖，不等价于 CN 客户端验收。

- category 4 已形成累计获得量、活动隔离、结算、发奖和 load 映射；category 5 已接入上述 1274 条权威事实。
  两类仍需 CN 客户端验证提示、奖励和重启持久化；category 5 的其余任务需逐族补事实。
- category 3 已启用 805 条按 mission ID 的严格协力规则、257 条 type 23 精确通关规则、445 条关卡、物品、竞速、阶段、当前状态及单人累计规则，以及 18 条 Event 登录/Raid summary/RAID SET/角色投票事实；其中 7 条 pattern 26/27/28 已接入官方战斗统计事实，严格拒绝失败、type26 错误 rank、开放期外、非法或溢出统计。其余 987 条复杂规则继续补类型化事实，
  旧 map 只作历史审计，不作为自动事实或发奖依据。Attention 在缺少权威来源前保持禁用。
- Pass 的救援、表情和购买流程尚未完成，三分类、活动关卡累计和等级奖励主链已具备自动测试，仍需 CN 客户端验收。
- 角色觉醒的双角色配对与无队长指定关卡仍依赖已记录的本地计数器/历史；奖励结算与最终特殊奖励触发已按
  CN 1.8.1 主数据实现。statistics 17 与种族 selector 仍待权威证据。

因此，分类隔离存储、主数据列解释、客户端静默上报边界、独立战斗事实、周期重置、普通/每日/每周自动结算、
收集任务、部分称号、Active Mission 内容/可用性/结算核心与领奖安全以及角色觉醒核心时序已经具备，但任务模块整体仍是部分完成。
下一阶段继续扩展活动类型化事实、称号剩余事实、Pass 剩余 pattern 与 Active Mission。
