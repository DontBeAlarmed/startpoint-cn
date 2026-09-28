# 排名活动（Ranking Event）

> 状态：本服实时只读摘要可用；排名奖励不发放，`receive_reward` 以官方 `status=3`（无可领）诚实应答

CN 1.8.1 只会请求 `ranking_event/get_summary` 和 `ranking_event/receive_reward`。两者均已注册。

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

## receive_reward 与官方 status 语义

客户端协议定义三个 status（`RankingEventReceiveRewardRealRemote.successHandler` 只接受这三个值，
其余值走未定义分支）：

| status | 官方含义 | 官方前提 | 本服行为 |
|---|---|---|---|
| 1 | 首次领取成功 | 服务端在同一事务中真实发放奖励并记录领取状态 | 不使用：无奖励来源，回 1 会让客户端按本地奖励表展示拿不到的奖励 |
| 2 | 重复领取 | 按 `(player_id, event_id, quest_kind)` 记录领取状态 | 不使用（同上） |
| 3 | 未参赛 / 无可领奖励 | 无 | **恒定返回**：本服不发放排名奖励，任何玩家都没有可领的奖励 |

官方按玩家存档与领取状态区分 1/2/3；在出现真实奖励来源（例如自制活动）之前，有记录与无记录玩家的
诚实答案都是 3，因此实现为恒定应答，不读取存档。当某活动接入真实奖励来源时，在同一决策点按官方
决策表（无记录 → 3；有记录未领 → 发放并回 1；已领 → 2）扩展分支即可；协议形状（信封、MsgPack、
会话链路）已就位。

### 已定案的扩展设计：官方历史排名线（待数据，未实施）

发放档位的判定计划采用"官方历史排名线"模式，数据需从官方公告全量爬取中单独整理（每活动 × 每档
时间线，带公告出处，作为官方历史数据进内容管线；整理完成前本节不实施）：

- 机制：客户端档位显示唯一输入是服务端 `rank_percentage`（`getRankRating`：值/100，取第一个
  `border ≥ 值/100` 的档）。服务端把 `best_elapsed_time_ms` 与官方线比较，映射为合成百分位
  （达到第 k 档 → 下发 `border[k]×100`），客户端即显示对应档位字母；发放按同一档位选行，
  保持"显示=所得"。
- 开关：挂 `server-settings`（`web_api/settings`），默认使用官方线；无公告线数据的活动回落实时
  百分位（现有 `getPlayerQuestLocalRankPercentageSync`，与客户端同源）。
- 单人/小人口结论：实时百分位在单人时为 0，客户端必然显示 SS；官方线模式是避免小人口满档的途径。
- 不采用的先例：参考实现中的伪造基准时间（上游）与 `名次/N` 公式（早期基线，且其 0-1 刻度被客户端
  按 0-100 解析导致全员显示 SS）均不可引用。

历史上无条件 `status=1` 的假成功（不发放、不记录、无事务）已移除；任何形式的伪装领取都不得恢复。
客户端把 status=1 解释为领取成功并按 rank 档位渲染本地奖励一览，因此"回 1 不发奖"比明确无可领更有害。

## 路由可达性

CN 1.8.1 的 Remote 注册表中没有 Rush 排名端点，也没有 Raid 的选择文件夹、重置或排名端点。
这些旧服务端路由已移除并返回 H404：

- `/event/rush/ranking`、`/event/rush/ranking/played_party`；
- `/event/raid/select_folder`、`/event/raid/reset`；
- `/event/raid/ranking`、`/event/raid/ranking/party`、`/event/raid/ranking_reward`。

Rush 的 `RankingParty` 场景名称容易产生误解：它展示自己的已用队伍，数据来自 `/event/rush/summary`，
不会请求排行榜。Raid 文件夹点击也是客户端本地场景切换，不需要 `select_folder`。

## 验证入口

- `tools/ranking_event_route.test.cjs`：未参赛、真实成绩、队长、百分位、领奖 `status=3`
  应答（含重复请求与未知活动）；
- `tools/event_route_reachability.test.cjs`：7 个 CN 1.8.1 不可达端点保持未注册。
