# 排名活动（Ranking Event）

> 状态：本服实时只读摘要可用；冻结榜单与排名奖励明确未实现

CN 1.8.1 只会请求 `ranking_event/get_summary` 和 `ranking_event/receive_reward`。当前服务端保留前者，
后者在完整结算链实现前不注册，客户端会收到 H404；不能以 `status=1` 伪装已发奖。

## 只读摘要

`get_summary` 只接受客户端固定的 `quest_kind=1`，并按活动 ID 的精确关卡映射读取
`players_quest_progress`。没有参赛记录、队长快照缺失或队长已不在存档时，响应为
`{ best_record: null }`，客户端按“尚未参赛”处理。

有合法记录时返回：

- 存档中的最高分、最佳耗时和是否完成；
- 该次记录保存的队长 ID，以及当前存档中该角色的进化立绘等级；
- 当前数据库内同关卡参与者的实时百分位；
- `rank_border_top: null`，不伪造官方冻结榜线。

本服百分位按官方记录排序方向计算：有完成耗时的玩家优先，完成者按耗时升序；未完成者排在其后并按分数降序。
百分位为“严格优于当前记录的人数 / 当前参与人数 × 100”，并列记录得到相同百分位。它只描述当前服务端数据库，
会随其他玩家成绩变化，不是官方全服排名，也不是活动结束时的冻结结算结果。

## 奖励边界

旧实现无条件返回 `status=1`，但没有扣写领取状态、没有发放奖励，也没有事务；客户端会把它解释为领取成功并展示最终奖励。
该假成功已移除。未来恢复 `receive_reward` 必须作为一个完整模块同时实现：

1. 将活动周期与排名奖励表纳入 Content Release；
2. 在聚合结束时冻结本服排名或明确采用其他可审计排名源；
3. 按 `(player_id, event_id, quest_kind)` 保存唯一领取状态；
4. 校验领奖期并在同一事务中发奖、写领取记录和返回库存变化；
5. 首领、重复领取、未参赛分别返回客户端定义的 `status=1/2/3`。

只补静态奖励表不足以实现排名奖励，因为 CDN 不包含实时玩家排名。

## 路由可达性

CN 1.8.1 的 Remote 注册表中没有 Rush 排名端点，也没有 Raid 的选择文件夹、重置或排名端点。
这些旧服务端路由已移除并返回 H404：

- `/event/rush/ranking`、`/event/rush/ranking/played_party`；
- `/event/raid/select_folder`、`/event/raid/reset`；
- `/event/raid/ranking`、`/event/raid/ranking/party`、`/event/raid/ranking_reward`。

Rush 的 `RankingParty` 场景名称容易产生误解：它展示自己的已用队伍，数据来自 `/event/rush/summary`，
不会请求排行榜。Raid 文件夹点击也是客户端本地场景切换，不需要 `select_folder`。

## 验证入口

- `tools/ranking_event_route.test.cjs`：未参赛、真实成绩、队长、百分位和领奖 H404；
- `tools/event_route_reachability.test.cjs`：7 个 CN 1.8.1 不可达端点保持未注册。
