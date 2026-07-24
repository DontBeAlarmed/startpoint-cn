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

上述能力构成内容解释、首任务生产、可用性判定、安全领奖和存储链。当前仅接入 96 条业务事实中的 Contents Guide
首任务，其他 95 条仍没有权威业务入口；除该首任务、存档导入或既有数据库记录外，`players_active_missions` 不会自行生成
完整进度。因此 Active Mission 仍是部分完成，不能只因首任务与领奖接口可用就标记为完整。

## 后续实现原则

下一阶段按主数据 pattern type 分批接入权威服务端事实，并保持以下边界：

1. 只实现当前存档或正式请求能够证明的条件；缺等级曲线、战斗统计或客户端检查的数据继续 fail closed。
2. 事件开放期、前置任务和分组关系从 `mission_active.json`、`mission_active_event.json` 读取，不从中文文案推测。
3. 进度创建、增量、领奖和奖励发放保持幂等；领取接口以数据库进度和当前 Content snapshot 的有效性共同校验。
4. 不修改客户端，不把旧 Active Mission 存储与 category 9 角色觉醒任务重新混用。
