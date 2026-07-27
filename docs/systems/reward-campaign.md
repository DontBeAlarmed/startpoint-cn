# 奖励活动倍率

## 范围

服务端从官方 `master/campaign/reward_campaign.orderedmap` 生成
`reward_campaign.json`，并在单人、联机战斗结算时应用道具、角色战斗经验和固定关卡
Mana 三类活动倍率。1.4.54 主数据共有 203 条：道具 179 条、经验 12 条、Mana
12 条。

转换器位于 `src/content/converters/reward-campaign.ts`，运行时匹配与数量计算位于
`src/lib/reward-campaign.ts`。服务启动前的 `content:sync` 会把 CDN 表转换为 Release
对象；`assets/reward_campaign.json` 是服务尚未初始化 Content Snapshot 时使用的官方
1.4.54 fallback。

## 匹配规则

- 活动时间按主数据中的 JST 时间解析，起止时刻均包含在有效期内。
- 关卡范围按官方 `QuestRangeReferenceIdKind` 的 category 和 ID 分段语义匹配。
- 同一关卡、同一奖励类型同时命中多条活动时取最大倍率，不累加也不相乘。
- 道具、经验、Mana 三种倍率互相独立。
- 当前 1.4.54 的 203 条记录全部是一次性时间段；转换器对尚未实现的 Weekly 记录明确拒绝，避免静默套用错误周期。

## 结算规则

- 普通 Score Reward 与 Rare Score Reward 均按 `floor(基础数量 × 最终倍率)` 结算。
- 活动与 Boost 使用官方加法叠加：`活动倍率 + (Boost ? 1 : 0)`。例如 2 倍活动叠加 2 倍 Boost，最终为 3 倍。
- 后台掉落倍率作为服主配置，在官方倍率完成取整后继续相乘，范围仍为 1 到 10。
- 角色战斗经验按 `ceil(基础经验 × 活动经验倍率)` 结算，不吃 Boost。
- 固定关卡 Mana 按活动 Mana 倍率放大；客户端上报的 `field_mana` 不放大。
- 角色、星导石不受道具倍率影响；固定经验池 `poolExpReward` 暂不套用活动倍率。
- 单次结算只读取一次服务器时间，活动匹配、任务事实和任务结算共用该时间快照。

以上行为对应 CN 1.8.1 反编译源码中的：

- `RewardCampaignValues.as`：时间、奖励类型、倍率和关卡范围字段；
- `CampaignRepository.as`：按时间与关卡应用活动；
- `CampaignLogicBase.as`：同类型重叠取最大倍率；
- `CommonBattleFinishDummyRemoteProcess.as`：Score Reward 取整、Boost 加法、固定 Mana 与角色经验处理。

## 延期边界

以下内容没有足够权威证据或不属于本次已验证范围，继续明确延期：

- `additional_reward` 的抽取和活动倍率；
- Weekly Reward Campaign 的跨周时间窗口；
- 固定经验池 `poolExpReward` 是否应用经验活动倍率；
- 客户端未使用的其他奖励结算入口。
