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
- CN 1.8.1 的 `MissionCounterLogic` 只静默发送五种客户端行为：角色详情插画停留一分钟、角色点阵动作、
  主页点击城镇角色、主页切换语音和主页推特确认。`update_mission_progress` 只接受这五种白名单，
  并只写入服务器时间下已开放的匹配任务；未知、非正整数、历史期和未来期输入均不写库。
- 单人和多人结算统一通过 `recordMissionBattleFacts` 写入独立事实。完成 finish 请求会增加游玩次数；只有成功通关才增加
  单人/协力累计通关、房主/成员通关、评级、角色通关、队长 power flip、队伍组合和种族组合。
  `players_quest_progress` 只表示不同关卡的历史最佳状态，不再冒充累计通关次数。
- 角色觉醒配对按数值 ID 归一化，读取时合并旧反序记录；`2310012` 同场校验拉姆斯队长与 Human、Dragon、Devil。
  `3310032/3310033` 只在指定单人关卡与指定角色组合同场成功时增加 category 9 持久进度。
  信赖证列表为空时不会完成任务。
- 角色觉醒 144 条任务均已进入服务端计算。新增 `3210132/3210133/3410012/3410013` 的 QuestRange、
  `1610022/2610072` 的无阵亡规则，并补齐 `1510062` 的队长与拉芙同场规则；纯通用角色通关回退经
  CN 主数据逐条审计后为 55 条。核心解锁与领奖流程已通过客户端，144 条条件尚未由客户端逐条验收。
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
- category 5 共 1288 条。当前自动计算 1045 条有权威服务端事实的任务：玩家等级 8 条、持有角色数 3 条、
  上限突破总次数 3 条、玛纳板节点数 3 条、信赖之证数 3 条、单人 SS 次数 3 条、累计冲刺 3 条、领主战累计通关 3 条、单人最高分 3 条、单人限时通关 3 条、挑战副本累计通关 3 条、第二玛纳板累计节点数 3 条、第二玛纳板指定角色完成 472 条、累计消耗体力 3 条、累计登录 3 条、章节主线与高难全通 12 条、练习关卡 SS 5 条、珍品商店购买次数 3 条、指定 Boss 超级难度 13 条。
  另外 484 条 type 44 从主数据 `row[15]` 读取指定角色 ID；该角色已有 `status>=1` 的信赖之证时进度为 1。
  在本项目受支持的官方客户端养成流程中，信赖之证状态是该条件达成后的持久标志，因此这里不使用缺失的 EXP 等级曲线重复推算等级。
  `status=1` 表示待领取，`status=2` 表示已领取，两者都属于已经获得；总数称号和指定角色称号均不会因领取后状态变化而倒退。
  单人 SS 使用独立计数，协力 SS 不会污染；schema 6 升级前混合累计的旧 SS 无法可靠拆分，因此不回填。
- 已接入的简单称号族包括协力成功总数 3 条、作为房主的协力成功总数 3 条、已完成角色剧情数 3 条、挑战副本累计通关 3 条、单人最高分 3 条和单人限时通关 3 条。角色剧情
  使用 SQL `COUNT(*)` 直接统计 category 3 已完成关卡，并由
  `idx_players_quest_progress_player_section_finished` covering index 支持。
- 当前称号覆盖为 `1045/1288`，约 `81.1%`；unsupported 为 243 条。累计冲刺称号直接读取原有 `players.total_dashes`；领主战称号只读取 category 2 成功结算累计；单人最高分称号只读取成功单人 finish 的官方 `score`，保存最高值；单人限时称号只读取成功单人 finish 的有效 `elapsed_time_ms` 最小值并按主数据秒数判定；后三类战斗事实都不由服务端重算，协力、失败和非法值不计入。挑战副本称号使用独立累计计数器，仅接受 category 13 成功结算，不能从唯一关卡完成记录推算重复通关；失败、普通关卡和回滚不增加。第二玛纳板只按官方 `mana_board.json` 的第二板节点集合判断，未知或缺失内容不猜测；累计体力和登录使用玩家主表的累计字段；章节称号要求同一章 `main_quest.json` 与 `ex_quest.json` 的所有关卡均有 `finished=1` 记录；练习关卡称号按主数据列出的 category 15 关卡集合和 `clear_rank=5` 判断；珍品商店称号只累计 `treasure_shop.json` 中商品 ID 的购买记录；指定 Boss 超级难度只接受精确 CDN 映射；其余复杂条件继续保留持久化 fallback，
  不根据中文描述或历史最佳记录推算。
- 角色等级称号暂不自动计算：当前服务端资产没有完整 EXP 到等级曲线，只保存角色累计 EXP 和上限突破状态；
  在 CDN 转换器补齐权威曲线前不使用近似阈值。

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
- 当前 category 3 共启用 961 条严格事实：805 条 QuestRange 协力规则和 156 条关卡/物品规则。
  新增的 156 条包括 40 条 `get_item_count`、54 条土俑单关卡、18 条土俑聚合任务、37 条崩坏域庆贺单关卡
  和 7 条崩坏域庆贺聚合任务。土俑与崩坏域任务均由 CDN 关卡表、活动任务主数据和持久化关卡完成记录闭合，
  不读取客户端自报计数。其余 1551 条（包括 mission 1807）仍使用持久化 fallback。
  任务页不从旧 `mission_event_quest_map.json` 直接推算；只有通过 `computer-event-safe.ts` 白名单的精确规则才会自动计算和发奖。
  后续仍需补全活动范围、评级、房主/成员、救援、阶段和 client check 等谓词后逐批启用。

## Pass 分类与等级奖励

- 官方 CN 1.4.54 包含 76 条 PassDaily、76 条 PassWeek、115 条 PassEvent、19 期活动和 1140 条等级奖励，
  已由 `content:pass` 生成服务端资产；不再使用“官方主数据缺失”的旧结论。
- category 6 已接入单人、协力、冲刺和体力；category 7 已接入协力和体力，救援与表情仍保留持久化 fallback；
  category 8 已接入活动登录、type 16 指定协力关卡和 6 条按 `battle_kind`/QuestRange 匹配的 type 23 活动关卡。
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

- category 4 已形成累计获得量、活动隔离、结算、发奖和 load 映射；category 5 已接入上述 1045 条权威事实。
  两类仍需 CN 客户端验证提示、奖励和重启持久化；category 5 的其余任务需逐族补事实。
- category 3 已启用 805 条按 mission ID 的严格协力规则和 156 条关卡/物品规则；其余 1551 条复杂规则继续补类型化事实，
  旧 map 只作历史审计，不作为自动事实或发奖依据。Attention 在缺少权威来源前保持禁用。
- Pass 的救援、表情和购买流程尚未完成，三分类、活动关卡累计和等级奖励主链已具备自动测试，仍需 CN 客户端验收。
- 角色觉醒的配对、竞速进度仍依赖已记录的本地计数器与映射；奖励结算与最终特殊奖励触发已按
  CN 1.8.1 主数据实现。

因此，分类隔离存储、主数据列解释、客户端静默上报边界、独立战斗事实、周期重置、普通/每日/每周自动结算、
收集任务、部分称号、Active Mission 内容/可用性/结算核心与领奖安全以及角色觉醒核心时序已经具备，但任务模块整体仍是部分完成。
下一阶段继续扩展活动类型化事实、称号剩余事实、Pass 剩余 pattern 与 Active Mission。
