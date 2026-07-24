# Active Mission

## 官方内容表

国服 1.4.54 的 `wf-assets-cn/orderedmap/active_mission/` 包含：

- `active_mission.json`：96 条任务定义；
- `active_mission_event.json`：4 个活动定义，event ID 为 1、2、3、150；
- `active_mission_reward.json`：96 条任务的阶段与奖励。

仓库运行资产对应为 `mission_active.json`、`mission_active_event.json` 和
`mission_active_reward.json`。运行：

```bash
npm run content:active-mission
```

可从受支持的官方 `wf-assets-cn` 重新生成三张表。Content registry 将其作为 bundled 表纳入
Content Release；这一步只补齐服务端解释 Active Mission 所需的定义，不改变 CDN 包或客户端。

运行时核心、奖励解析与领奖路由均可显式读取当前 `ContentRepository`。服务启动没有激活 Content Release 时，
这些读取器仍以 bundled assets 作为兼容默认；激活 Release 后，领奖校验使用同一快照中的任务、事件和奖励表，
不会继续读取旧 bundled 表。该能力只在进程启动时选择的 snapshot 内生效，不提供运行中热切换。

## 当前服务端边界

`/api/index.php/active_mission/receive` 已实现以下能力：

- 校验任务存在、阶段存在、完成阈值和重复请求；
- 按国服客户端实际使用的 UTC+8 偏移解释主表时间，并区分任务可推进期与展示/领奖期；
- 校验事件前置关卡、phase、`need` 和 `show` 前置阶段；
- 提供单调、幂等的统一进度结算核心：普通完成阶段写为待领取，限时阶段缺少权威秒数时拒绝完成；
- 在单一 SQLite 事务中写入领取状态并发放星导石、物品、装备、角色、玛纳、经验和称号；
- 返回角色觉醒校准、邮件状态和各类库存变化；
- `/load`、存档导入导出和数据库层可持久化 `all_active_mission_list`。

`/api/index.php/contents_guide/start` 已接通 Contents Guide 首任务的生产链：

- 使用请求 `event_id` 在当前 Content snapshot 中查找唯一的 `string_id = contents_guide_start` 任务，且事件必须为
  `ContentsGuide`（kind 2）；缺失、重复、类型不符或主表异常均以 400 拒绝；
- 使用全局服务器时间、玩家关卡进度和 Active Mission 统一可用性核心校验事件开放期、event 2 前置关卡
  `1008004`、phase、`need` 与 `show`；
- 在单一 SQLite 事务内读取任务状态、以权威绝对进度 1 幂等结算，并持久化进度与新完成的待领取阶段；数据库错误会整体回滚；
- 返回标准 `active_mission_list` 增量供 CN 客户端通用层立即合并，不在该入口发奖；奖励仍由
  `/api/index.php/active_mission/receive` 领取。

`/load` 在序列化玩家数据前会使用当前 Content snapshot 重算并持久化一组可由服务端状态证明的事实：

- `quest_clear`：依据 CN 1.8.1 的 `QuestRangeReferenceIdKind` 支持 Main、Ex 和 WorldStoryEvent；
- `target_mission_clear`：目标任务全部奖励阶段达到目标进度即可完成，不要求目标奖励已经领取；
- `total_login_days` 和 `used_stamina_count`：使用玩家存档中的绝对累计值，只增不减；
- 角色剧情、角色等级/进化/突破、指定角色拥有、装备满级、第二玛纳板完成、信赖之证和已释放玛纳/能力节点
  从当前角色、装备和玛纳节点存档重算；未知的角色经验曲线或缺失的 CDN 表会保持 fail closed；
- 普通装备累计觉醒等级（使用 `players_equipment.level - 1`，不混入追忆强化阶段）、当前队伍魂珠装配、宝藏商店购买历史和首领币商店购买历史也可用于对应事实的单调校准；
  pattern 64 只统计首领币商品奖励类型为装备的购买，pattern 84 统计首领币商店全部商品购买；
  其中“首次操作”类事实若历史已被旧存档丢失，不会用当前状态反推过去行为。
- `real_incentive_1_boss_coin_exchange`（pattern 84）与首领币商店购买历史共用已持久化的购买次数；它不读取余额，也不把普通物品兑换误判为首领币兑换。
- `total_used_mana_count`、`total_gacha_character_count` 以及首次编队动作使用独立的玩家计数器表，避免从余额、角色库存或当前队伍快照反推；玛纳板学习与觉醒、
  通用商店和追忆强化的玛纳支付会在原业务事务内累计实际消费量，正式 `/gacha/exec` 会按实际角色抽取数累计，重复角色也计数；
- `party/edit` 成功保存有效装备、连携角色或队伍角色时，分别累计 pattern 58、59、60；该计数与队伍快照写入同一事务，清空队伍或后续卸下装备不会抹掉已发生的首次动作。
- `/expod/inject_exp` 成功消耗经验池并写入角色经验时累计 pattern 63；经验池、角色经验和动作计数共享同一事务，异常不会留下半次注入。
- 使用 `payment_type=CAMPAIGN` 成功完成一次卡池活动抽取时累计 pattern 83；普通卡池、角色兑换和邮件发放不计入该事实。
- pattern 14、16、17 读取既有 `MissionBattleCounters` 的单人通关、联机通关和房主通关累计；当前回归活动资格仍未生产，因此相关回归任务继续 fail closed。
- pattern 23（`battle_clear_count`）按 CN 1.8.1 的 `row[32]` 和 `row[34..37]` 读取指定战斗类型与 QuestRange：`1` 为单人、`2` 为协力、`3` 为任意战斗；单人使用关卡的 `finished`，协力使用 `multi_clear_count`，任意战斗按每个关卡取两者的较大值，避免把首次协力通关重复计算。主线、EX、领主战、每日关卡、活动关卡和其余官方 QuestRange 均按类别与 ID 严格匹配，空 selector 不当作通配。
- pattern 26（`ss_rank_count`）使用独立战斗评级事实；无 QuestRange 的定义按 `row[32]` 分离单人、协力和任意战斗，避免从关卡历史最佳反推重复 SS 次数。当前唯一的 pattern 26 定义属于回归活动，因缺少资格生产者仍由事件资格层 fail closed。
- pattern 66（`chapter_complete`）从当前 Content snapshot 的主线/高难关卡表建立指定章节的完整战斗关卡集合，并要求每关历史最佳评价均为 SS；只有带 `rankPointReward` 的可挑战关卡参与判定。高难关卡按客户端 Active Mission 的 `+10,000,000` 命名空间归一化，空集合和非 Main/Ex 范围继续 fail closed。
- pattern 65（`quest_challenge`）在单人 `/start` 成功持久化练习战斗时累计专用事实，不等待通关，也不从 `players_quest_progress` 反推。该计数与体力/门票扣除、active quest 持久化和普通任务结算处于同一事务；入场失败或事务回滚不会留下挑战次数。当前仅接受官方定义使用的 Practice QuestRange，其他范围 fail closed。
- pattern 70（`battle_clear_with_specific_party`）从 `row[46]` 读取指定队长。无 QuestRange 时按 `leader_clear_count` 与 `leader_multi_count` 严格区分单人、协力和任意通关；带 QuestRange 的官方定义仅接受单人模式，并从对应关卡历史记录核对 `leader_character_id`。带范围的协力定义因无法证明历史最佳记录来自哪种战斗模式而 fail closed。
- pattern 71/72/73 在成功结算时检查 `row[43]` 指定角色是否实际位于本次主位或连携队伍，并按 `row[32]` 与 QuestRange 校验战斗类型和关卡。pattern 71 要求通关当时已经释放第二玛纳板的全部能力节点，pattern 72/73 分别要求当时等级达到 80/100；匹配结果写入通用 `(pattern, character_id)` 条件事实表，与原战斗奖励处于同一事务。`/load` 只读取已记录事实，不会用后续养成状态补配旧通关。
- 旧存档无法可靠回填上述历史。教程赠送、兑换角色和尚未接入的玛纳消费入口不伪造计数，事务失败也不会留下计数。
- 任务前置与 phase 会在同一次请求内固定点推进，数据库写入使用单一 SQLite 事务，失败整体回滚；
- 回归活动通过 event `string_id` 中的 `come_back_mission` 识别；当前没有回归资格生产者时 fail closed，不会把 250xx
  任务发给普通玩家。普通 `kind=1` 事件不因此被误判为回归活动。

这组状态事实只写入 `all_active_mission_list`，不会写入角色觉醒使用的 category 9 `active_mission_list`。

上述能力构成内容解释、首任务生产、状态事实校准、可用性判定、安全领奖和存储链。当前已接入 37 个实际使用的 pattern，
对应 79 条定义；其中 15 条回归定义仍需资格回调才能生产。其余 17 条定义仍未接入服务端事实生产者，
但它们并不都缺少客户端依据：CN 1.8.1 的战斗结算协议明确包含 `equipment_element`、分区统计中的
`skill_point_over_on_start`，以及 `client_checks` 字段。除已接入事实、Contents Guide 首任务、存档导入或既有数据库记录外，
`players_active_missions` 不会自行生成完整进度。因此 Active Mission 仍是部分完成，不能只因状态校准、首任务与领奖接口可用
就标记为完整。

## 剩余 17 条定义的证据审计

### Contents Guide：20011～20017（7 条）

这 7 条定义均属于 event 2、`battle_kind=3` 的任意战斗，并通过任务前置关系依次开放。

| 任务 | 主数据条件 | 当前判断 |
|---|---|---|
| 20011 | `character_element=1` | 可由角色主数据和本次队伍角色 ID 判定；1 是客户端的火属性目标值 |
| 20012 | `character_element=1`、`equipment_element=1` | 角色条件可判定；装备条件应使用客户端结算上传的 `equipment_element`，不能从装备 ID 猜属性 |
| 20013 | `character_element=3` | 可由角色主数据和本次队伍角色 ID 判定；3 是客户端的雷属性目标值 |
| 20014 | `character_element=3`、`equipment_element=3` | 角色条件可判定；装备条件同 20012 |
| 20015 | `action_effects=ACToleranceOfElement_Down`、排除 `depraved_monk` | 仍需解析技能/动作效果主数据，不能只按角色名称硬编码 |
| 20016 | `action_effects=CreateNormalHeal,CreateRatioHeal,ACRegeneration`、排除 `compliment_oiran` | 仍需解析技能/动作效果主数据，不能只按角色名称硬编码 |
| 20017 | pattern 91，开局技能槽充满 | 结算协议有 `zones[].skill_point_over_on_start`，需确认计数语义和三名主位角色的对应关系后实现 |

客户端 `BattleQuestFinishRemoteUtil` 会在结算请求中发送 `equipment_element`；客户端统计类型还声明了
`skill_point_over_on_start` 和 `client_checks`。因此 20011～20014、20017 不应再被描述为“没有协议字段”，
而应分别补齐队伍元素事实、装备元素透传与开局技能统计解析。20015～20016 的阻塞点是服务端当前没有
技能动作效果索引，不是任务主数据缺失。

### 外部活动：21030（1 条）

`real_incentive_1_multi_special_exchange` 对应 2022 年限时的“大家一起选”活动，属于 `multi_special_exchange`
交互，不是普通单人战斗。当前没有对应活动入口，暂不实现。

### 回归活动：25009～25022 中的 9 条未接入定义

这些定义属于 event 150，`string_id` 含 `come_back_mission`，包括消灭敌人、冲刺、破坏弱点、强化弹射、发动技能、
技能连锁、战力和 10 秒内通关等条件。部分战斗统计字段已经存在，但当前没有回归资格生产者；资格层会 `fail closed`，
不会把回归任务发给普通玩家。它们应在回归资格协议明确后再逐项接入。

## 后续实现原则

下一阶段按主数据 pattern type 分批接入权威服务端事实，并保持以下边界：

1. 只实现当前存档或正式请求能够证明的条件；缺等级曲线、战斗统计或客户端检查的数据继续 fail closed。
2. 事件开放期、前置任务和分组关系从 `mission_active.json`、`mission_active_event.json` 读取，不从中文文案推测。
3. 进度创建、增量、领奖和奖励发放保持幂等；领取接口以数据库进度和当前 Content snapshot 的有效性共同校验。
4. 不修改客户端，不把旧 Active Mission 存储与 category 9 角色觉醒任务重新混用。

单人体验优先顺序为：先实现并测试 20011/20013 的角色元素条件，再补 20012/20014 的客户端
`equipment_element` 透传与判定；随后确认 `skill_point_over_on_start` 的计数语义并处理 20017。
20015/20016 要等技能动作效果索引准备好后再实现。21030、回归资格和 Pass type 20 继续保持低优先级，
不使用推测值完成任务。
