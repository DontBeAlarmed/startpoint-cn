# 战阵事件级奖励

## 协议流程

战阵（Raid）的普通关卡掉落仍使用 `score_reward`；事件级累计击破奖励是另一条链路。CN 1.8.1 客户端在成功 finish 后只读取：

- `quest_boss.kill_count`：当前关卡累计成功次数，每次成功只增加 1；
- `raid_boss.total_kill_count`：事件 Boss 的累计击破数；
- `raid_boss.hp_percentage`：当前 Boss 剩余权重进度换算的百分比；
- `auto_start_point` 和 `is_out_of_period`。

奖励弹窗不读取 finish 的额外字段。客户端返回战阵页面后调用 `/event/raid/summary`，再从
`kill_count_reward_data.reward_list` 读取本次待展示奖励。因此服务端将推进和发奖拆为两个事务：

1. finish 把关卡 `kill_count_weight` 加入事件权重；达到 `raid_event.required_kill_count` 时权重归零、总击破加一；
2. finish 同时把该玩家、该事件、该关卡的 `kill_count` 加一，并返回当前 Boss 和关卡状态；
3. summary 按玩家 `received_up_to` 与事件全局 `total_kill_count` 之间的新区间选择奖励；
4. summary 在同一 SQLite 事务中聚合发奖、更新库存和领奖游标，再返回奖励列表；
5. 重复 summary 没有新区间时返回空奖励列表。

Boss 权重和总击破保存在 `raid_event_boss_states`，同一数据库内所有玩家共享；玩家领奖游标保存在
`players_raid_events`，分关卡次数保存在 `players_raid_event_quests`。

## 主数据映射

| CDN 字段语义 | 服务端语义 |
|---|---|
| `raid_event.required_kill_count` | 当前 Boss 被击破所需的全局权重 |
| `raid_event_quest.kill_count_weight` | 一次成功战斗增加的权重，不直接等于 Boss 击破数 |
| 总击破阈值 | 玩家领奖游标跨过该阈值时发放一次 |
| 周期击破奖励（带起始值） | 每跨过一个周期阈值发放一次 |
| 每击破奖励（无起始值） | 按新增 Boss 击破数发放，不按关卡权重倍增 |
| 奖励 kind 0 | 道具，响应 `kind=1` |
| 奖励 kind 2 | 星导石，响应 `kind=3` |
| 奖励 kind 3 | Mana，响应 `kind=8` |

`raid_event_overall_reward` 每行最多有 10 个奖励槽。当前 CN 1.4.54 的 72 行中有 40 行使用第二槽，服务端会完整解析全部槽位；未知 kind 不进行推测转换。`raid_event.json` 的 7 个
`required_kill_count` 来自官方 CN 1.4.54 主数据，并纳入 Content Release 的 bundled 表契约。

## 待审阅边界

- 官方运营环境的 Raid Boss 明显是全服共享状态。本项目采用“同一 SQLite 数据库全局共享”，没有跨多个独立服务实例同步；多实例同时写入不在当前运行契约内。
- `raid_event.json` 和 `raid_event_overall_reward.json` 当前属于 Content Release 的 bundled 表，还没有 CDN OrderedMap 转换器。运行时会从当前快照读取，但新 CDN 包不会自动重建这两张表；待全表转换器阶段再改为动态来源。
- 官方 `required_kill_count` 面向大量玩家，单人私服推进会非常慢。当前没有私自缩放或把权重冒充击破数；若以后提供加速，必须作为显式配置并单独记录。
- 旧实现把每个玩家的 `total_kill_count` 实际写成累计权重，不能安全转换为全局 Boss 击破数。首次创建新全局状态表时会把旧玩家游标归零并从新的 Boss 状态重新开始；已经误发的库存无法可靠回收。
- 反编译能够证明 summary 是奖励展示入口，但无法仅凭客户端证明官方服务端是在 finish 预发库存、还是在 summary 同时发放。当前选择 summary 内原子发奖，使库存变化、奖励列表和领奖游标保持一致，仍需真实客户端流程验证。

## 客户端验收清单

1. 完成战阵关卡后，确认 finish 正常返回且关卡累计次数只增加 1。
2. 返回战阵页面，确认 summary 弹出每击破奖励且库存到账。
3. 同一页面重复刷新，确认奖励不重复发放。
4. 跨过总击破和周期阈值时，确认同一行的多个奖励槽全部显示并到账。
5. 重新 load 或重启服务，确认 Boss 状态、分关卡次数和玩家领奖游标保持。
