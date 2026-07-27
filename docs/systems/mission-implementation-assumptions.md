# 任务模块待审阅实现记录

本文只记录当前实现中尚未被客户端流程或完整协议闭环证明的边界。它不把推测写成官方行为；遇到下列情况，服务端优先保持 fail closed。

## Active Mission 20015/20016

- Action DSL 中无法读取或解码的技能程序不会生成角色效果索引。当前已知 `alk_1`、`alk_2`、`alk_3` 属于此类，影响角色 `1`、`700009`、`700010`；它们写入 `unresolved`，不影响其他角色索引。
- `action_effects` 按逗号分隔的 OR 条件匹配；`effects_ignore_character` 只排除指定候选角色，不排除整支队伍。这一解释有主数据和客户端枚举支持，但仍应由客户端任务流程复核。
- 结算请求中的队伍是客户端提交值，当前服务端未保存 Active Quest 开始时的队伍快照。20015/20016 因此沿用现有 finish 请求事实边界；如果以后需要防止客户端伪造，必须先增加开局队伍持久化或服务端一致性校验。
- 当前事实生产器会在成功结算时记录已识别的 mission-specific 事实，再由前置任务和开放期决定展示与领取。客户端反编译资料不能证明“任务尚未开放时是否允许预累计”；如果实测要求严格按开放时刻计数，应在同一事务中增加可用性过滤。

## Content fallback

`assets/cdndata/active_mission_skill_effects.json` 是空结构兼容 fallback，不包含推测角色效果。未执行 Content Sync 或当前 Release 不含该表时，20015/20016 不推进；官方 CDN 同步成功后才使用动态生成的索引。

## 称号 type 48：第二玛纳板

- 角色称号的目标角色使用 `mission_degree` 的 `row[15]`，不根据 mission ID 或中文名称推测。重复角色、不同版本角色和联动角色因此各自按主数据指定的角色 ID 判断。
- “第二枚玛纳板全部强化完成”被解释为：该角色在 `mana_board.json` 的 `board_index=2` 中定义的全部节点 ID，都出现在玩家的 `players_characters_mana_nodes` 中。这里统计的是节点已强化/解锁状态，不把 bond token、觉醒等级或 `mana_board_index` 字段当作替代证据。
- 全局 `degree_manaboard_all_growth_*` 只统计能在同一份 `mana_board.json` 中确认属于第二板的已强化节点；未知角色、缺失第二板、空表和格式异常均不计入。已有数据库进度仍取最大值，避免旧存档因内容缺失倒退。
- 运行时优先读取启动时固定的 Content snapshot；直接调用且 snapshot 尚未初始化时才回退到仓库内 bundled `assets/mana_board.json`。这只是兼容旧调用路径，不会在已初始化的 Release 上叠加两份表。
- 当前未有客户端逐条验证“强化”的中文显示是否还包含其他状态，也没有证明出售角色后服务端应重新计算还是只保留历史完成；实现按已持久化进度取最大值处理，相关边界留待审阅。

## 称号：角色等级

- `3010/3020` 的官方奖励目标分别为 80 和 100。服务端按角色官方 rarity 选择现有 `characterExpCaps`，只在累计 EXP 达到对应上限阈值时证明该档等级，并返回所有当前角色中可证明的最高等级；非法 EXP、未知角色或未知 rarity 不参与计算。
- 该计算与旧 category 5 进度取最大值，因此角色数据变化不会让已保存进度倒退。Lv80/Lv100 阈值对五种 rarity 都存在，可精确判断这两条称号是否完成。
- `3000` 的目标为 Lv60，但四星和五星阈值表分别从 Lv70、Lv80 开始；达到更高等级只能提供保守下界，无法在实际 Lv60 时准时完成。该任务继续持久化 fallback，不能用相邻 rarity 或中文描述插值。

## category 3：关卡目标任务

- 948 条 type 16 使用空 QuestRange selector。CN 1.8.1 `EventMissionValues` 把 `""` 解析为 `Option.Some([])`，而 `(None)` 才解析为 `Option.None`；客户端通用匹配仍区分空集合与无约束。但 GL 可交叉任务中 612 条保留相同空字段，任务文案与外层 event/group 也持续表达范围内任意协力战，说明它更可能依赖官方后端约定，而不是 CN 提取损坏。
- 服务端经需求确认只对白名单形状采用 `type16-empty-selector-wildcard`：579 条全 BossBattle、9 条指定 Boss group、342 条指定 WorldStory event、18 条指定 Advent event。生成器从当前关卡表展开明确 quest ID；运行时重新校验原始行、兼容标记和完整 ID 集。该实现属于高可信兼容，不宣称复原了官方后端源码；其他 pattern、其他空字段形状和未知兼容标记仍 fail closed。

- 土俑嘉年华单关卡使用 `mission_event.json` 的 `event_id + quest suffix` 与 `carnival_event_quest.json` 的精确关卡 ID
  对齐；聚合任务只引用同一活动的子任务 ID。当前实现不使用旧 `mission_event_quest_map.json` 对土俑关卡的宽泛集合。
- 崩坏域庆贺单关卡使用 `challenge_dungeon_event_quest.json` 中的真实关卡键；`row[10]` 为空时表示该挑战事件表的全部关卡，
  非空时按 `event_id * 1000 + suffix` 精确定位。聚合任务只在所有子任务都有可证明关卡来源时启用。
- 这批规则仍依赖 `players_quest_progress.finished` 的历史最佳记录。数据库没有单次战斗时间线，因此没有把“必须在活动开放期内完成”
  作为额外条件；关卡 ID 本身必须由官方 CDN 表确认存在。客户端战斗检查、评级、Attention 救援和无法从表闭合的活动任务继续 fallback。
- 188 条 category 11 竞速任务只在 type 15、QuestRange kind 8、`event_id * 1000 + quest suffix`、
  `ranking_event_single_quest.json` 和唯一旧映射全部指向同一关卡时启用。目标时间取官方 `mission_event_reward.json`
  的奖励阶段秒数，玩家必须已有成功通关且历史最佳毫秒值不超过该阈值。
- category 24 的 42 条狂热激战限时任务不再使用旧映射。旧映射会把“第 N 战”扩展为同一期全部 8 个关卡，例如
  mission `700012` 的映射包含 `700002001` 至 `700002008`；当前改为按 QuestRange kind 17、`event_id * 1000 + suffix` 和
  `rush_event_quest.rushEventId` 精确闭合，只读取 category 24 对应单关的历史最佳时间。
- 历史最佳时间来自客户端 finish 请求并由服务端保存；服务端不模拟战斗或重算计时。这一事实链保证协议闭合，
  不提供反作弊证明，也不能证明活动开放前完成的历史记录是否应计入。
- 257 条 type 23 累计通关任务只覆盖 Advent、StoryEventSingle、ChallengeDungeon、Raid 和 Rush 五种可由官方表闭合的 QuestRange。battle kind 1 只累计单人成功，battle kind 3 同时累计单人和多人成功；每次合法 finish 增加 1，历史唯一完成记录不用于反推重复次数。
- Ranking Phase 29 条任务以成功单人 finish 的 `statistics.clear_phase` 为事实。当前反编译协议能确认字段与主数据 pattern 的阶段语义，但服务端不会重演战斗来验证客户端提交值；多人、非整数、0、5 及错误关卡均不推进。该协议边界需后续 CN 客户端样本验收。

## category 3：Event 登录、Raid summary 与 RAID SET 保存

- mission 1225 的 CN 1.8.1 pattern type 0 解析为 `total_login_days`，客户端没有独立任务上报请求。服务端把认证会话后的 `/load` 作为登录事实，只使用全局 `getServerDate()` 的 CN UTC+8 自然日，不读取玩家 `time_offset`，也不沿用每日任务 05:00 reset bucket。
- 1225 只在自身 `enable_start_time..enable_end_time` 内计数。事实表仅保存最后计数日；当前日不晚于已保存日时不增长，因此多设备、重复请求和服务器时间回拨保持幂等。跳过多日后一次 load 只增加 1，升级前和活动期内未记录的历史登录无法可靠重建，不做补算。
- CN 1.8.1 将 type 79 解析为 `raid_event_top_check`。`RaidEventLoadingTask` 在进入 Raid top、quest select 等 Raid 场景前先请求 `event/raid/summary(event_id)`，成功后才请求 party 并进入页面；因此 400053/400071/400089/400093 只由对应 eventId 4/5/6/7 的真实 summary 请求完成。普通 load、战斗 finish、错误 event 和其他 Raid API 不产生该事实。
- 17 条规则同时校验官方 mission ID、string pattern、严格十进制 pattern type/奖励 target、QuestRange selector/eventId token、保留空字段，以及精确 `YYYY-MM-DD HH:mm:ss` UTC+8 日历开放期。空串不能表示 type 0，整数 token 不接受空白、符号、小数或溢出，日期会逐字段校验闰年与每月天数；结构不一致时保持既有 progress，不猜测替代映射。type 79 与 type 80/81/82 均只幂等确保 progress 至少为 1，不在业务响应中加入 `mission_info`；任务奖励仍由既有 mission 页面结算协议发放。
- 1225 在 Active Mission reconcile 与响应构建成功后，才在 reply 上登记 request-local pending commit；生产 CN MsgPack `onSend` 完成实际编码后执行独立的 `BEGIN IMMEDIATE` 记录事务。reconcile、响应构建或实际 onSend 编码失败不计数，多连接竞争同日 marker 只有一个连接成功；编码成功后交给网络栈的传输错误不属于该事务边界，也不声称能够回滚已提交事实。
- type 79 使用嵌套 SQLite 保存点参与 Raid summary：成功时随 summary 外层事务提交；任务事实写入异常时保存点先完整回滚，再记录包含 player/event/mission 的告警并继续原有 summary。该可选事实不得把既有 summary 变成错误响应，也不得留下部分任务写入；其他 summary 奖励或状态异常仍按原外层事务整体回滚。

## category 3：角色总选举投票

- mission `2389` 的 type 68 由客户端 `character_election/vote` 请求产生，成功响应不读取业务字段；`get_vote_status` 只读取严格布尔值 `is_voted`。两个接口在选举开放期外都使用客户端已知的 `result_code=11003`。
- `character_election.json` 由 Content Sync 从选举、排除、图鉴和角色 orderedmap 生成。候选过滤照 CN 1.8.1 `CharacterElectionLogic`：接受非隐藏的 NPC，以及非隐藏、身份角色自身的普通 Character；其他 kind 不进入候选，并移除该期 exclude 表中的 keyword ID。路由不接受任意正整数，也不把候选表硬编码在 TypeScript 中。
- 首次投票写入 `players_character_election_votes`，并在同一个 `BEGIN IMMEDIATE` 事务内把 mission 2389 幂等完成到 1；任务写入异常会回滚投票。状态查询按玩家与 election ID 隔离，数据库 schema 10 保存首次 keyword ID 和投票时刻。
- Event mission 600001 与 900809 的 type 86 只在多人 category 26 的 `1001`、`1001001` 成功取得 SS 时判断。两条官方 selector 的关卡后缀均为 `""`，客户端会解析成不可达的 `Within([])`；这里按 mission ID 和官方 1.4.54 中各自唯一存在的关卡做显式兼容闭合，不建立“空 selector 等于活动任意关卡”的通用规则。`debuff_r` 来自客户端结算的 `statistics.zones[].members[]`，表示该本地成员收到的敌方元素抗性下降次数；每个 zone 至少要有一个非空成员，空成员槽位跳过，所有非空成员都必须携带非负整数 0。缺字段、空数组、非法数字或任一正数均 fail closed。服务端不使用当前玩家的本地统计推断其他真人队友，也不把这项安全策略描述成已知官方后端实现。
- 重复请求当前采用传输重试兼容语义：返回成功、保留第一次选择、不重复增长任务。客户端正常流程会先查询 `is_voted`，反编译源码没有提供重复投票专用业务错误码；因此这里不把幂等成功描述为官方重复投票行为。若后续脱敏抓包证明官方返回其他错误，应只调整重复分支，不改变首次投票事务。
- 选举表的 string ID、开放期与 mission 2389 的 pattern、开放期、type 68 和唯一奖励 target 1 必须同时吻合；任一来源漂移时投票任务 fail closed。当前自动测试与真实 1.4.54 CDN smoke 证明服务端链路闭合，但尚未记为 CN 客户端人工验收通过。

## 每日任务：无限演武空 selector

- `10075` 的官方名称明确为“【无限演武】通关任意一个关卡”，QuestRange kind 为 20、event selector 为 1，
  但本地关卡 selector `row[10]` 是空字符串。CN 1.8.1 会把它解析为 `Option.Some([])`，按通用
  `QuestRangeReferenceIdKindTools` 无法匹配任何本地关卡；该行与任务文案及长期开放用途不一致。
- 当前实现不改变通用空 selector 语义，只对白名单 mission `10075` 校验 type 14、kind 20、event 1、空 selector、
  category 27 和官方 `score_attack_event_quest.eventId=1` 后计一次成功单人结算。这是为官方异常行设置的精确兼容，
  若后续 Content 修正 selector 或任务 ID 变化，不会自动扩展到其他任务。

## category 3：当前状态任务

- `1201/1202/1203/1204/1205/1206/1207/1212/1217/1218/1219/1220/1305/1306/1307` 仅在精确 mission ID、`mission_event` pattern type、所需 QuestRange 字段以及 `mission_event_reward` 全部阶段 target 与已审计结构一致时启用。任何字段缺失、类型错误、stage 不连续或 target 改变都会 fail closed，并保留数据库 progress。
- type 5 的 1305 不使用中文文案阈值，也不使用 Active Mission 的中间等级近似。服务端只根据角色 rarity、累计 EXP 和现有官方等级上限 EXP 表证明 50、60、70 这些奖励 target 的等级下界；无法取得 rarity、EXP 非法或阈值表异常时不回填。
- type 7 的六条任务读取 `players_characters_mana_nodes` 当前已解锁节点数，但每个 node 必须是对应角色 `mana_board.json` 各板 row 中的官方 multiplied ID；孤立、重复、非法或错角色的玩家节点只被忽略，其他合法节点继续形成安全下界。type 9 的 1306 从 `character.json` 读取 rarity，并以该 rarity 的官方等级上限 EXP 档位数校验 `0 <= over_limit_step <= max_over_limit_count` 后汇总；非法玩家角色或步数只跳过该角色。type 21 的 1204 按 CN 1.8.1 `CharacterQuestValues.character_1/2/3` 对应的 `character_quest_lookup` row[0..2] 建立精确映射，再与当前持有角色和 category 3 已完成关卡取交集；不再使用字符串前缀，`1410031` 因 row[0] 为 `141004`，不会错误归给角色 `141003`。
- type 22 的 1201/1202/1203 按 CN 1.8.1 `QuestRangeReferenceIdKind.Main` 的第一个 selector 精确绑定主线章节 1/2/3，后两个 selector 必须为 `(None)`。章节完成要求 `main_quest.json` 中该章节的全部官方关卡均有 category 1 `finished=1`；不是任意关卡完成数，也不要求 EX 章节或 SS 完成。主线表键异常或目标章节为空时不产生事实。
- type 34 的 1212/1307 使用当前装备记录的觉醒级数总和，即每种已持有装备的 `level - 1`。每个装备 ID 必须存在于当前 `equipment_dissolve.json`，官方 `max_level` 必须为正整数，且存档必须满足 `1 <= level <= max_level`；非法玩家装备只跳过自身，其他合法装备继续形成安全下界。它不统计装备持有数、stack 或 `enhancement_level`。装备被删除后当前值可能降低，因此所有计算仍与已持久化 progress 取最大值；这能回溯当前仍可见的觉醒状态，但不能重建已删除装备的历史觉醒次数。
- type 35 的 1220 只因官方唯一 target 为 1 而启用：每个普通 party preset 独立校验，非空魂珠 ID 必须在当前 `item_sale.json` 中属于 category 5，且同一 party 内同 ID 使用数不得超过 `players_items` 正整数持有量。不同 party 是可切换预设，不合并占用库存；一枚魂珠出现在两个不同 party、库存为 1 时，两者可分别合法。伪造、错误类型、未拥有或同 party 超额使用只使该 party 无效，不污染其他合法 party；存在至少一个合法非空 party 即证明进度至少为 1。该事实不是魂珠库存总数、不是队伍槽总数，也不是历史设置次数；魂珠已全部卸下时只能依赖已有 progress，若未来 target 大于 1 则规则自动关闭。
- `character.json`、`character_quest_lookup.json`、`mana_board.json`、`main_quest.json`、`equipment_dissolve.json` 和 `item_sale.json` 的派生索引按当前冻结 Content repository 对象缓存在进程内；任一官方表行无法解析时，只有对应事实族整体 fail closed。evaluationTime 下 15 条任务全部关闭时，`buildContext` 不读取这些索引，也不执行新增角色、玛纳节点、装备、物品或 party 查询。项目不支持运行时 Content 热更新，因此不增加失效协议。
- `integration:mission` 保持并行执行，但每个测试文件显式使用 60 秒 timeout。默认 30 秒在全组并发、类型转译和临时 SQLite 初始化竞争下曾接近或超过上限；新 current-state fixture 的专项运行约 6 秒，完整组验证用于区分环境资源竞争与本提交的真实性能回归。
- 上述 15 条均可从升级时已有的当前存档状态回溯一个安全下界，不新增累计表。与之不同，type 23 重复通关、战斗统计和业务操作次数只能从升级后的成功事务继续累计；历史唯一完成行或当前库存不能替代行为时间线。Event 开放期仍由既有 reconciliation 和主数据时间过滤处理，不读取存档 `time_offset`。

## 称号：客户端静默进度

- `47000/48000/49000/50000` 只依据官方 Degree row selector 接入。CN 1.8.1
  `DegreeMissionValues` 将严格字符串 token `40/41/42/43` 依次解析为
  `character_detail_zoom_illust_for_1min_count`、`character_detail_play_dot_sp_motion_count`、
  `home_tap_town_character_count`、`home_change_voice_count`。这里没有按中文描述、mission ID 末位或
  `row[1]` 的 `degree_*` 内部名称推测；尤其 50000 的权威字段不是 `home_voice_change_count`。
- 客户端事实链来自 CN 1.8.1 实际调用：插画放大测量达到 3600 帧后计 1，角色详情像素特殊动作播完计 1，
  星见镇角色或商人点击计 1，首页切换后的语音播放完成计 1。`MissionCounterLogic.send()` 只遍历五种白名单行为，
  将本地累计批次作为 `mission_param_list[].progress_value` 请求
  `mission/update_mission_progress`，随后清空本地计数；因此服务端按正增量累计，重复真实请求遵循既有累加语义。
- 服务端只接受白名单中的精确字段、正安全整数和当前开放的无 event scope 任务，并在现有
  `players_category_missions` 事务链中安全增量。非数组列表、非法元素、未知或近似字段、无存档账户、非正值、
  非安全整数和溢出均不增长；数据库重开后仍由 category 5 load 返回原进度。Degree computer 只纯读取持久化值，
  不在计算阶段写库，旧进度和新请求事实都不会倒退。
- 这四条证明的是官方客户端确实由对应 UI 动作产生并提交请求，不是服务端独立重演 UI，也不提供反作弊保证。
  升级前未保存的展示/点击历史无法从当前角色、首页或其他存档快照回填，服务端不补造历史次数。

## 称号：指定关卡累计通关

- 84 条 type 23 称号只接受主数据可精确闭合的 BossBattle stage group 和 Advent event。成功单人或协力 finish 会直接增加所有匹配的 category 5 任务进度；失败、缺少合法 category/quest ID 和非目标关卡不计入。
- finish 在原有结算事务中直接增加匹配的 category 5 任务进度，不建立第二份累计表；因此升级前已有进度会自然继续增长。服务端不从 `players_quest_progress.finished` 或 `multi_clear_count` 反推历史总次数，避免把唯一完成状态和部分协力次数混成累计事实。
- 这批规则暂与 `mission_degree.json` 一样使用仓库 bundled 1.4.54 主数据，并配套使用同版本 Boss/Advent 表，避免混用不同 Content snapshot。任务主数据切换到运行时 Content Release 属于后续统一改造，本批不单独制造半动态路径。

## 称号：战斗统计

- 46 条称号只记录成功 finish：单人专属、协力专属和两者通用字段按 `battle_kind` 分流；累计字段逐 zone 求和，单场最大字段先取 zone 最大再与历史最大比较。整数必须为非负安全整数，Float 必须有限且非负；非法值只关闭对应统计族。
- `players_degree_battle_stats` 从升级后的新结算开始记录，现有 category 5 持久化进度继续作为下限。服务端不从历史关卡完成行推算 FEVER、伤害或技能链等战斗细节。
- MVP 三条继续 fallback：客户端只提交 `is_mvp`，请求不含全员 MVP 分数，当前房间状态也无法验证唯一性或并列结果，服务端不把客户端自报值冒充权威事实。

## 称号：业务操作

- 珍品商店 Mana 3 条只在 `shop_type=TREASURE`、Mana 费用和奖励全部成功提交的通用购买事务内，按 `单价 * 数量` 增长；其他商店和其他 Mana 消费不计入。
- 装备觉醒 3 条按实际 `upgrade_count` 增长：单件水晶/stack 路径和批量去重后的总升级级数都在材料扣除与装备更新事务内记录，no-op 与失败请求不增长。
- 魂珠设置 3 条继续 fallback。当前 `/party/edit` 尚未完整校验魂珠所有权、可用副本、物品 category 和重复 party key；在补齐这些验证前，不把任意客户端快照差异计为权威操作。
- type 14 的 8 条累计任务从成功单人 finish 精确累计。目标仅为 1 的 `1213/1214/1215/1221/1303/1304` 同时允许由匹配的历史 `finished` 记录回填到 1；目标包含重复次数的 `1222/1300` 无法由数据库唯一关卡完成行重建，当前保留既有任务进度作为下限，只从升级后的新结算继续累计。

## 活动任务：战阵 SET 保存

- event 4～7 的 12 条 type 80/81/82 逐 ID 校验官方 pattern、QuestRange kind 16、event ID、保留空字段、精确开放期和唯一奖励阶段 target 1。任一主数据字段漂移即整族 fail closed。
- `/party/edit` 只在 `use_party_group_edit=true` 且成功映射并保存 `PartyCategory.RAID`、第 1 组、槽位 1/2/3 时，分别把对应主队伍、副 1、副 2 任务幂等完成到 1。同请求重复槽位先去重；普通编辑、其他队伍类别、其他组、槽位 4～10、非开放期及多个活动族重叠开放均不增长。
- 任务事实与队伍更新、主队伍选择和 Active Mission 队伍动作计数处于同一数据库事务；任务 SQL 失败会向外传播并整体回滚。成功响应不额外返回 `mission_info`，任务页继续通过现有进度接口读取。
- 这条事实只能证明玩家从 SET 编辑器成功保存了目标槽位。即使官方中文文案写着“复制替换”，服务端请求也不能证明用户点击过复制按钮，因此不能把它解释为复制按钮行为追踪。

## 称号指定 Boss 超级难度

- 13 条 `degree_boss_battle_ex_clear_single_*` 可以由主数据的 stage group + difficulty 与 `boss_battle_quest.json` 精确闭合，服务端只接受对应 category 2 关卡的 `finished=1` 记录。
- `11080`（大蛇）主数据要求 difficulty `4`，但官方表中该 stage group 只有 difficulty `1..3`。当前不把现有最高难度 3 推测为目标 4，保持持久化 fallback；如果后续 CDN 补齐 difficulty 4，才会自动进入计算路径。

## 称号 ExpertSingle 精确单关

- `57010` 至 `57120` 共 12 条只在 type 14、QuestRange kind 14、event ID 1 和 suffix 1 至 12 精确闭合时启用；目标关卡 `1001` 至 `1012` 必须存在于当前 Content snapshot 的 `expert_single_event_quest.json`。
- 玩家事实只读取 category 21 的 `players_quest_progress.finished=1`。其他 category 中相同 quest ID、未完成记录和缺失关卡均不计入，已有持久化进度仍取最大值。
- 该族奖励目标均为 1，因此历史唯一通关记录足够证明完成；没有用它推算重复通关次数或活动开放期内的时间线。
- 同一精确闭合规则也用于 27 条 QuestRange kind 9 的 WorldStory 任务和 1 条 QuestRange kind 5 的 Advent 任务；它们分别只读取 category 18 与 category 7 的完成记录，并要求目标存在于对应官方关卡表。
- 27 条 Carnival 与 6 条 HardMulti 的 type 23 称号奖励目标均为 1；服务端分别按 QuestRange kind 15/19、官方关卡表和 category 22/26 的唯一完成记录判断。它们不用于推算同类累计通关称号。
- `70000/70010` 两条 type 37 称号从主数据 `row[13]` 读取物品 `70014/70048`，并使用 `players_collected_items.total_obtained`。消费物品不会降低进度；累计事实表出现前的历史和存档导入缺失仍不猜测回填。
- `43000/43010/43020` 三条 type 36 称号只统计能在当前 `equipment_dissolve.json` 取得正整数 `max_level`、且玩家 `level >= max_level` 的装备记录。缺失主数据的装备不使用默认等级猜测，装备 stack 也不展开为多件。

## 称号挑战副本累计通关

- `10000/10010/10020` 的 pattern 分别要求 100、500、3000 次挑战副本成功通关。服务端按 CN 关卡类别枚举将挑战副本识别为 category 13，并在成功 finish 事务中增加独立的 `challenge_dungeon_clear_count`。
- 该计数不从 `players_quest_progress` 的唯一关卡行数反推，因此重复挑战同一关会正确累计；失败、普通关卡和事务回滚不会增加。
- 当前数据库迁移会为旧的 `players_mission_battle_counters` 表补列，但既有存档替换/导入格式没有该事实表。由于本项目暂不扩展数据库导入导出，替换后无法恢复这项新增历史事实；服务端不会根据库存或关卡快照猜测回填。

## 称号单人最高分

- `14000/14010/14020` 的阈值来自官方 `mission_degree` 描述，分别为 10000000、50000000、99999999；没有从相邻称号或客户端动画推测阈值。
- 服务端仅保存成功单人 finish 请求中的 `score` 最大值。协力战斗、失败结算、负数、非安全整数和缺失字段均不更新 `single_score_max`。
- `score` 是 CN 客户端提交的战斗统计字段，当前服务端没有战斗模拟或独立伤害/分数重算。该实现可支持官方客户端的协议流程，但数值真实性仍依赖客户端，不能当作反作弊校验。
- 旧数据库启动会补充 `single_score_max` 列；现有存档替换/导入不包含这张事实表，本任务不扩展数据库导入导出，也不会用关卡历史最佳分数猜测回填。

## 称号单人限时通关

- `15000/15010/15020` 的阈值来自官方 `mission_degree` 描述，分别为 60、10、5 秒；服务端换算为毫秒并保存成功单人 finish 的最短有效 `elapsed_time_ms`。
- 缺失、零值、负数、非安全整数、失败结算和协力结算均不更新 `single_clear_time_min`。已保存的最短时间只用于达成 0/1 称号，不从每关历史最佳记录猜测未记录的全局最快时间。
- `elapsed_time_ms` 来自官方客户端 finish 请求，当前服务端不重放战斗或独立校验计时；该事实链适用于协议兼容，不等价于反作弊验证。
- 旧数据库启动会补充 `single_clear_time_min` 列；现有存档替换/导入不包含这张事实表，本任务不扩展数据库导入导出。

## 称号领主战累计通关

- `30000/30010/30020` 的阈值来自官方 `mission_degree` 描述，分别为 10、500、5000 次。服务端按 `questCategory=2` 识别 CN 领主战，并在单人或协力成功 finish 中增加 `boss_battle_clear_count`。
- 该计数不依赖某个领主关卡的唯一 `players_quest_progress` 记录，因此重复挑战同一关仍会累计；失败、其他 category 和事务回滚不会增加。
- 该规则不区分单人/协力，因为主数据没有附加 battle kind 条件；若客户端实际只展示其中一种模式，需要以协议验收结果再缩小范围。

## 称号累计获得锻造石

- `41000/41010/41020` 使用当前配置的 `craft_point_item_id`，官方 CN 1.4.54 值为 `100000`。服务端读取 `players_collected_items.total_obtained`，不把当前库存当作累计获得量。
- 正常出售装备等发放路径通过 `givePlayerItemSync` 同步写入库存和累计获得事实，消费锻造石不会降低称号进度；其他物品 ID 不计入。
- schema 引入累计物品表之前的历史获得量无法回填，存档替换/导入也不包含该事实表。本任务继续保留这项既有边界，不根据当前库存猜测历史。

## 称号累计使用技能

- `33000/33010/33020` 的奖励阶段目标为 100、1000、10000 次。服务端在成功 finish 中汇总 `statistics.zones[].use_skill_count` 并累加到独立事实；单人和协力均计入，符合主数据 battle kind `3`。
- zone 缺失该字段按 0 处理；任一值为负数、非整数或累计溢出时，整场技能使用事实按 0 处理。失败结算不计入。
- 该统计来自官方客户端 finish 请求，服务端没有独立战斗模拟来重算技能使用次数；实现保证协议字段和事务边界，不提供反作弊证明。
- 旧数据库启动会补充 `skill_use_count` 列；既有存档替换/导入不携带该事实表，本任务不扩展数据库导入导出。

## 审阅方式

审阅时优先检查：

1. 官方 CDN 生成表中的 `unresolved` 是否只包含确实缺少或无法解码的程序；
2. 主位、连携角色、排除角色同时存在时的客户端进度；
3. 在任务前置完成前进行符合条件的战斗，随后进入任务页时是否应计入历史事实。
