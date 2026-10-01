# 排名活动（Ranking Event）

> 状态：本服实时只读摘要可用；排名奖励按官方领奖表发放，`receive_reward` 实现官方 status=1/2/3 决策表

CN 1.8.1 只会请求 `ranking_event/get_summary` 和 `ranking_event/receive_reward`。两者均已注册。

## 只读摘要

`get_summary` 只接受客户端固定的 `quest_kind=1`，并按活动 ID 的精确关卡映射读取
`players_quest_progress`。没有参赛记录、队长快照缺失或队长已不在存档时，响应为
`{ best_record: null }`，客户端按“尚未参赛”处理。

有合法记录时返回：

- 存档中的最高分、最佳耗时和是否完成；
- 该次记录保存的队长 ID，以及当前存档中该角色的进化立绘等级；
- 当前数据库内同关卡参与者的实时百分位；
- `rank_border_top` 为本服当前真实榜首记录（排序口径与百分位一致；客户端排名表与
  结果弹窗按该字段绘制榜首标记，官方系实现恒以非空对象下发，故不发 null）。

本服百分位按官方记录排序方向计算：有完成耗时的玩家优先，完成者按耗时升序；未完成者排在其后并按分数降序。
百分位为“严格优于当前记录的人数 / 当前参与人数 × 100”，并列记录得到相同百分位。它只描述当前服务端数据库，
会随其他玩家成绩变化，不是官方全服排名，也不是活动结束时的冻结结算结果。

## receive_reward 与官方 status 语义

客户端协议定义三个 status（`RankingEventReceiveRewardRealRemote.successHandler` 只接受这三个值，
其余值走未定义分支）。服务端实现完整决策表：

| status | 官方含义 | 本服行为 |
|---|---|---|
| 1 | 首次领取成功 | 参赛记录存在时：官方 `ranking_event_ranking_reward` 表按玩家档位选行，逐槽发放（Item/Equipment 经 Inventory owner、Stone→星导石、Mana、PooledExp、Degree 幂等发放），领取记录与发放同一事务，失败整体回滚 |
| 2 | 重复领取 | 领取记录（`players_ranking_reward_claims`，UNIQUE(player_id, ranking_event_id)）已存在时只回摘要，不再发放 |
| 3 | 未参赛 / 无可领奖励 | 无参赛记录或未知活动 |

### 档位判定（与客户端显示同源）

`rank_percentage` 为 0-100、越小越强（"严格优于当前记录的人数 / 参与人数 × 100"），与
`get_summary` 摘要同源。并列第一名会算出精确的 0，而客户端结果弹窗动画在 rate=1.0（仅 percent=0
可达到）时以 `ranks[-1]` 崩溃（F1009，2026-09-28 实机证实）；客户端离线 dummy 的合法输入域为
[0.5, 100]，因此服务端将百分位钳制为不低于 0.5——不改变任何档位（最小边界 3%）与发放。档位选行复刻客户端 `getRankRating` 的比较方向：取表中第一个
`rank_border >= rank_percentage/100` 的行，溢出取最低档。奖励发放与摘要显示读同一张官方表、
同一个百分位来源（`src/lib/ranking-reward.ts` 的接缝），保证"客户端展示的档位 = 实际发放的档位"
（客户端奖励一览按同一张表本地渲染）。`rank_border_top` 同样随摘要下发本服真实榜首记录
（2026-09-28 实机发现：发 `null` 时客户端结果弹窗排名表绘制崩溃 F1009，官方系实现均发非空对象）。

官方领奖表由 CDN 动态转换生成（converter `reward`，逐档校验 rank_border、reason_id 与 10 个
通用奖励槽）；`multiplied_id`（活动倍率锚点）已随表转换，发放暂按基础数量执行，倍率接线待后续。

无条件的 `status=1` 假成功（不发放、不记录、无事务）仍是禁止项：status=1 必须与真实发放同事务。

### 已定案的扩展设计：官方历史排名线（待数据，未实施）

当前档位来源是实时百分位（小人口私服下档位普遍偏高，单人 = 满档，与客户端显示一致）。为回到
官服体验，计划从官方公告全量爬取整理"每活动 × 每档时间线"（带公告出处，官方历史数据进内容管线；
覆盖范围即 5 个首届试炼，复刻 1000/1001 每档仅玛那×20000、无档位差异）：

- 机制：服务端把 `best_elapsed_time_ms` 与官方线比较，映射为合成 `rank_percentage`
  （达到第 k 档 → 下发 `border[k]×100`），客户端即显示对应档位字母；发放按同一档位选行。
- 开关：挂 `server-settings`（`web_api/settings`），默认使用官方线；无公告线数据的活动回落
  实时百分位。
- 接缝：`get_summary` 与 `receive_reward` 共用同一档位解析，接入官方线只需在该解析处增加
  来源分支，两端点零改动。
- 不采用的先例：参考实现中的伪造基准时间（上游）与 `名次/N` 公式（早期基线，且其 0-1 刻度被客户端
  按 0-100 解析导致全员显示 SS）均不可引用。

## 路由可达性

CN 1.8.1 的 Remote 注册表中没有 Rush 排名端点，也没有 Raid 的选择文件夹、重置或排名端点。
这些旧服务端路由已移除并返回 H404：

- `/event/rush/ranking`、`/event/rush/ranking/played_party`；
- `/event/raid/select_folder`、`/event/raid/reset`；
- `/event/raid/ranking`、`/event/raid/ranking/party`、`/event/raid/ranking_reward`。

Rush 的 `RankingParty` 场景名称容易产生误解：它展示自己的已用队伍，数据来自 `/event/rush/summary`，
不会请求排行榜。Raid 文件夹点击也是客户端本地场景切换，不需要 `select_folder`。

## 验证入口

- `tools/ranking_event_route.test.cjs`：未参赛、真实成绩、队长、百分位、领奖决策表
  （status 1 首领档位精确发放 / 2 重复不重发 / 3 未参赛、未知活动）、事务回滚；
- `tools/event_route_reachability.test.cjs`：7 个 CN 1.8.1 不可达端点保持未注册。
