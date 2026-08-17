# 战斗关卡结算事务

本文记录 `single_battle_quest/finish` 与 `multi_battle_quest/finish` 的数据库事务边界。审计目标是避免客户端收到
失败响应后重试，却因上一次请求已经写入部分奖励、进度或任务事实而形成重复领取或撕裂存档。

## 单人请求身份与事务权威

单人 `/start`、`/play_continue` 和 `/abort` 先通过 viewer session 形成只包含 `accountId`、`playerId` 的身份快照。
该快照不读取、验证或缓存完整 Player，也不携带余额、体力或 active quest 等可变状态。身份解析成功只表示请求能够定位
存档；若 Player 在身份解析后被删除，后续事务内领域路径仍必须 fail closed。

`/start` 的 Player、实时体力与入场成本结果由 `runStartEntryTransaction()` 在同一个 SQLite 事务内读取和计算，日志中的
扣费前后体力也使用该事务结果。`/play_continue` 的 Player 余额与持久化 active quest 由
`runSingleContinueLifecycleTransaction()` 在事务内读取，首次请求和幂等 replay 均不得复用事务外 Player 快照。
`/abort` 把可缺省的 `play_id`、`quest_id`、`category` 传入 `runAbortEntryTransaction()`；该事务只读取一次 stored active，
并用同一行恢复真正缺失的字段、判断身份匹配、退款和删除。显式有限数值（包括 `category=0`）保持请求值，不按缺失处理。
事务结果返回已解析身份和观察到的 active 信息，供响应与日志投影使用；只有数据库提交成功后才清理内存 active quest。

单人 `/finish` 不使用上述 identity-only 入口，仍通过 `validateSessionAndPlayer()` 获取完整 Player，并交给既有 finish
协调器。这里没有全局请求上下文或跨事务缓存：identity snapshot 只负责定位，所有会影响写入决定的可变状态继续以所属
事务内读取为权威。

## 单人分类覆盖

`src/routes/api/singleBattleQuest.ts` 只完成请求校验、session 适配、协调器调用和 HTTP 发送。它把已校验请求、玩家存档与
内存 active quest 交给 `src/lib/quest/finish/single-orchestrator.ts`；协调器读取关卡与奖励配置、准备只读结算上下文，
再通过 `runSingleFinishSettlementTransaction()` 进入一个外层事务。事务回调调用
`src/lib/quest/finish/single-settlement-writes.ts` 执行全部持久写入。该总事务适用于
`getQuestFromCategorySync()` 支持的所有通用战斗分类，不依赖分类是否另有专用响应字段。

clear、S+、普通与 Rare Score、additional、rush 和 score-attack 的标准奖励由该最外层事务的拥有者通过
executor 模块内部的 `executeRewardGrantPlanInTransactionOwnerSync()` 发放；该入口不从 reward-grant 公共 barrel 导出。只有 Score 单人适配器 direct import 名为 `Internal` 的详细 owner 入口，用于读取 CHARACTER 补偿增量；该 metadata 不进入公共 `RewardGrantResult`、HTTP/TCP 响应或其他结算模块。入口在首写前把调用方维护的 `freeMana`、`freeVmoney` 和 `expPool` 各读取一次，校验为非负安全整数并复制为精确三字段快照，再规范化 Plan。它不查询玩家前后态，也不增加计划 savepoint；奖励异常不得在结算回调内捕获，必须继续向外传播并回滚整个 finish。需要允许调用方捕获错误并继续提交时，仍应使用带计划 savepoint 的
`executeRewardGrantPlanWithinTransactionSync()`。

Score 的抽取、倍率和 ELEMENT/AETHER 上下文 ID 在进入 owner 前由纯选择核心一次完成；运行时 wrapper 只负责读取内容、服务器设置和服务器时间并注入核心。Plan source 以 `score_common`、`score_rare` 保留 group、客户端 index 和最终数量，响应 drop IDs 与执行结果共同使用这些 source。执行后协调器直接采用 owner 返回的 `playerAfter`，不再从响应 `user_info` 重复推导货币后态。采样日志只在最外层事务提交成功后记录一次，任一后续写入失败并回滚时不记录。

事务提交成功后，路由预先计算响应头、服务器时间换算与邮件状态，再交给
`src/lib/quest/finish/single-response-projector.ts` 构造成功响应。projector 是纯投影层：不读取数据库、运行时内容或当前时间，
也不访问 Fastify；它只消费协调器成功结果和路由提供的只读快照，并按既有顺序合并通用任务与角色觉醒任务响应。
失败响应、HTTP header、状态码和发送仍由路由负责。

通用事务包括：

- 首通与 S+ 奖励、普通掉落、Rare Score Reward、Additional Reward；
- 关卡完成进度、最高分、评级、耗时和队长记录；
- 玛纳、经验池、Rank Point、Boost、角色战斗经验与升级体力；
- 每日挑战点、任务战斗事实、任务领奖结算与角色觉醒解锁校准；
- 数据库中的 active quest 删除。

以下分类在通用结算上增加专用写入，但仍处于同一个外层事务：

| 分类 | 专用状态 |
|---|---|
| `15 PRACTICE` | 练习战履历 |
| `22 CARNIVAL_EVENT` | 土俑分数、配队记录、累计分奖励与防重复领取 |
| `23 RAID_EVENT` | 战阵击破进度、房主事实与事件状态 |
| `24 RUSH_EVENT` | 狂热激战轮次、配队、文件夹通关与奖励 |
| `27 SCORE_ATTACK_EVENT` | 无限演武履历、最高分、档位奖励与 active quest 删除 |

专用处理器内部若再次开启 SQLite transaction，`better-sqlite3` 会把它作为嵌套保存点；异常继续向外传播，最终
由外层事务回滚全部通用和专用写入。协调器只在数据库提交成功后删除进程内 active quest，因此失败请求可用原请求重试。
单人结算事务拥有者负责把 `playerId` 与请求开始时读取的玩家状态绑定，并在固定奖励、普通 Score、角色战斗经验和后续直接奖励之间维护 `freeMana`、`freeVmoney` 和 `expPool` 后态；因此首通 clear/S+ 各省去一次玩家前态查询，不增加奖励写入或事务语句。owner 状态或奖励异常必须继续向外传播，不能在结算回调内捕获后提交。

## 协力结算

协力 finish 的首通/S+ 奖励、关卡进度、玩家数值、普通与追加掉落、任务事实、角色经验、觉醒校准和数据库
active quest 删除同样由一个外层事务覆盖。服务端先在事务外向 Hub 只读验证参与者、房间、
`battleSessionId` 和最终完成事实，再由 coordinator 权威结束已满足条件的房间生命周期；网络等待不会占用本地
SQLite 事务。Hub 在房间释放后继续限时保留完成事实，本地结算失败不会消费该事实。

Hub 验证通过后，`runMultiActiveQuestSettlementTransaction()` 在同步 SQLite 事务内重新读取该玩家的
active quest，并严格比较 `playId`、关卡分类与 ID、协力标记、房间、`battleSessionId`、Boost 使用状态和
续关次数。只有全部匹配才执行奖励、库存、任务、履历和邮件相关写入，并在同一事务末尾删除 active quest。
若另一请求已经完成删除，或存储身份已变化，本次请求在任何结算写入前失败。Hub 不接收玩家数据库句柄，也
不执行玩家奖励回调；每个节点只结算自己的本地存档。若事务失败，奖励写入和 active quest 删除一起回滚，
原请求可以再次使用保留的 Hub 完成事实结算。

事务提交后才处理 `follow_info`。它只是结算响应中的队友展示资料，不是奖励依据：查询某个
真人队友失败时，服务端记录包含 viewer ID 的警告并跳过该项，继续返回成功结算；自己、NPC 和重复 viewer ID
仍会被过滤。这样非关键资料故障不会制造“客户端收到 500，但奖励已经到账”的假失败。

## 回归约束

- `tools/quest_session_identity.test.cjs` 确认 identity-only resolver 在 session/playerId 缺失时 fail closed，且不调用
  Player loader；`tools/single_battle_identity_reads.test.cjs` 对真实 Fastify 和 SQLite 请求逐次统计 start、continue
  首次/replay、abort 完整/缺字段的 Player 与 active SELECT；
- `tools/score_attack_route_transaction.test.cjs` 对 category 27 和普通 category 1 注入晚期删除失败，确认所有
  数值、奖励、进度、履历和任务写入回滚，数据库及内存 active quest 保留；
- `tools/multi_finish_follow_info.test.cjs` 注入单个队友资料查询异常，确认其他队友仍返回且只记录一条警告；
- `tools/multi_remote_settlement.test.cjs` 通过真实协力路由、项目 SQLite schema 和 Hub verifier 屏障并发提交
  两个 finish，确认仅一个请求结算，另一个在事务内复核失败且玩家全部可观测表不再变化；
- 活动专项测试继续验证各处理器自身的幂等键和业务字段，不能由总事务测试替代。

本结论只覆盖服务端数据库一致性。各分类的客户端动画、响应字段和双客户端协力流程仍按对应系统文档验收。
