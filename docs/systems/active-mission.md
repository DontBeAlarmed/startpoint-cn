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
- 装备累计强化等级、当前队伍魂珠装配、宝藏商店购买历史和首领币商店购买历史也可用于对应事实的单调校准；
  其中“首次操作”类事实若历史已被旧存档丢失，不会用当前状态反推过去行为。
- `real_incentive_1_boss_coin_exchange`（pattern 84）与首领币商店购买历史共用已持久化的购买次数；它不读取余额，也不把普通物品兑换误判为首领币兑换。
- `total_used_mana_count` 和 `total_gacha_character_count` 使用独立的玩家计数器表，避免从余额或角色库存反推；玛纳板学习与觉醒、
  通用商店和追忆强化的玛纳支付会在原业务事务内累计实际消费量，正式 `/gacha/exec` 会按实际角色抽取数累计，重复角色也计数；
- 旧存档无法可靠回填上述历史。教程赠送、兑换角色和尚未接入的玛纳消费入口不伪造计数，事务失败也不会留下计数。
- 任务前置与 phase 会在同一次请求内固定点推进，数据库写入使用单一 SQLite 事务，失败整体回滚；
- 回归活动通过 event `string_id` 中的 `come_back_mission` 识别；当前没有回归资格生产者时 fail closed，不会把 250xx
  任务发给普通玩家。普通 `kind=1` 事件不因此被误判为回归活动。

这组状态事实只写入 `all_active_mission_list`，不会写入角色觉醒使用的 category 9 `active_mission_list`。

上述能力构成内容解释、首任务生产、状态事实校准、可用性判定、安全领奖和存储链。当前已接入 96 条定义中的
37 条状态/累计事实计算（其中回归活动事实仍需资格回调才能生产），其余 59 条业务事实仍没有权威生产入口；除已接入
事实、Contents Guide 首任务、存档导入或既有数据库记录外，`players_active_missions` 不会自行生成完整进度。因此
Active Mission 仍是部分完成，不能只因状态校准、首任务与领奖接口可用就标记为完整。

## 后续实现原则

下一阶段按主数据 pattern type 分批接入权威服务端事实，并保持以下边界：

1. 只实现当前存档或正式请求能够证明的条件；缺等级曲线、战斗统计或客户端检查的数据继续 fail closed。
2. 事件开放期、前置任务和分组关系从 `mission_active.json`、`mission_active_event.json` 读取，不从中文文案推测。
3. 进度创建、增量、领奖和奖励发放保持幂等；领取接口以数据库进度和当前 Content snapshot 的有效性共同校验。
4. 不修改客户端，不把旧 Active Mission 存储与 category 9 角色觉醒任务重新混用。
