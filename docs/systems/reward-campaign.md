# 奖励活动倍率

## 范围

服务端从官方 `master/campaign/reward_campaign.orderedmap` 生成
`reward_campaign.json`，并在单人、联机战斗结算时应用道具、角色战斗经验、固定经验池和固定关卡
Mana 三类倍率。1.4.54 主数据共有 203 条：道具 179 条、经验 12 条、Mana
12 条。

转换器位于 `src/content/converters/reward-campaign.ts`，运行时匹配与数量计算位于
`src/lib/reward-campaign.ts`。服务启动前的 `content:sync` 会把 CDN 表转换为 Release
对象；`assets/reward_campaign.json` 是服务尚未初始化 Content Snapshot 时使用的官方
1.4.54 fallback。

## 匹配规则

- CN 客户端沿用 JST 类型名，但实际初始化为 UTC+8；活动起止时刻按北京时间解析，首尾均包含。
- 关卡范围按官方 `QuestRangeReferenceIdKind` 的 category 和 ID 分段语义匹配。
- 同一关卡、同一奖励类型同时命中多条活动时取最大倍率，不累加也不相乘。
- 道具、经验、Mana 三种倍率互相独立。
- `Once` 使用一次性闭区间；`Weekly` 先限制在总起止期内，再按 `0=周日...6=周六` 和记录自身的重置时刻匹配北京时间游戏日。
- 当前 1.4.54 的 203 条记录全部是 `Once`；Weekly 支持用于后续动态 Content Release，不改变当前活动集合。

## 结算规则

- 普通 Score Reward 与 Rare Score Reward 均按 `floor(基础数量 × 最终倍率)` 结算。
- 活动与 Boost 使用官方加法叠加：`活动倍率 + (Boost ? 1 : 0)`。例如 2 倍活动叠加 2 倍 Boost，最终为 3 倍。
- 后台掉落倍率作为服主配置，在官方倍率完成取整后继续相乘，范围仍为 1 到 10。
- 角色战斗经验按 `ceil(基础经验 × 活动经验倍率)` 结算，不吃 Boost。
- 固定关卡 Mana 与 `poolExpReward` 分别应用 Mana/EXP 活动倍率及 Boost 加法增量，并按 `floor` 取整；客户端上报的 `field_mana` 不放大。
- 角色战斗经验不吃 Boost；角色、星导石不受道具倍率影响。
- 单次结算只读取一次服务器时间，活动匹配、任务事实和任务结算共用该时间快照。

以上行为对应 CN 1.8.1 反编译源码中的：

- `RewardCampaignValues.as`：时间、奖励类型、倍率和关卡范围字段；
- `CampaignRepository.as`：按时间与关卡应用活动；
- `CampaignLogicBase.as`：同类型重叠取最大倍率；
- `CommonBattleFinishDummyRemoteProcess.as`：Score Reward 取整、Boost 加法、固定 Mana 与角色经验处理。

## Additional Reward

服务端还从六张官方 OrderedMap 生成 `additional_reward_rules.json`，并在单人、联机
finish 的同一 SQLite 事务中结算追加奖励：

- Collect Item Event 同时校验活动期、前置关卡和 `QuestRange`；
- 敌人等级按 `enemyLevelMin <= enemyLevel` 的全部档位累计发放，不只取最高档；
- Boss Pickup 只允许联机结算触发；
- 道具数量继续应用 Item Campaign、Boost 加法和后台掉落倍率；
- 响应同时返回发奖后的 `item_list` 与动画使用的
  `drop_additional_reward_ids[{group_id,index,number}]`；
- 发奖、关卡进度、任务事实和 active quest 删除共享一个事务，失败时整体回滚。

官方 1.4.54 数据共有 378 个奖励组，每组恰好一个 `Item` 候选且 `weight=1`，因此当前
实现可以确定性发放。未来 CDN 若出现多候选组或非 `Item` 候选，服务端会 fail closed，不
推测随机抽签或其他奖励类型语义。当前 Boss Pickup 的 594 条 schedule 均未配置奖励组，
所以 1.4.54 实际触发源只有 Collect Item Event；`available_rank` 保留在生成表中，但没有
权威证据表明它是服务端发奖门槛，当前不参与判断。

客户端仍需实机确认追加奖励到账、动画、Boost 显示以及单人/联机结算表现。客户端未使用的
其他奖励结算入口不在当前支持范围。
