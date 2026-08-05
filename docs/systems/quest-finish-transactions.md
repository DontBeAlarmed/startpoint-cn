# 战斗关卡结算事务

本文记录 `single_battle_quest/finish` 与 `multi_battle_quest/finish` 的数据库事务边界。审计目标是避免客户端收到
失败响应后重试，却因上一次请求已经写入部分奖励、进度或任务事实而形成重复领取或撕裂存档。

## 单人分类覆盖

`src/routes/api/singleBattleQuest.ts` 先完成请求、关卡、active quest 和奖励配置校验，再通过一个外层
`getDb().transaction(executeFinishWrites)()` 执行全部持久写入。该总事务适用于 `getQuestFromCategorySync()`
支持的所有通用战斗分类，不依赖分类是否另有专用响应字段。

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
由外层事务回滚全部通用和专用写入。数据库提交成功后才删除进程内 active quest，因此失败请求可用原请求重试。

## 协力结算

协力 finish 的首通/S+ 奖励、关卡进度、玩家数值、普通与追加掉落、任务事实、角色经验、觉醒校准和数据库
active quest 删除同样由一个外层事务覆盖。服务端先在事务外向 Hub 只读验证参与者、房间、
`battleSessionId` 和最终完成事实，网络等待不会占用本地 SQLite 事务。

Hub 验证通过后，`runMultiActiveQuestSettlementTransaction()` 在同步 SQLite 事务内重新读取该玩家的
active quest，并严格比较 `playId`、关卡分类与 ID、协力标记、房间、`battleSessionId`、Boost 使用状态和
续关次数。只有全部匹配才执行奖励、库存、任务、履历和邮件相关写入，并在同一事务末尾删除 active quest。
若另一请求已经完成删除，或存储身份已变化，本次请求在任何结算写入前失败。Hub 不接收玩家数据库句柄，也
不执行玩家奖励回调；每个节点只结算自己的本地存档。

事务提交后才处理房间内存状态和 `follow_info`。后者只是结算响应中的队友展示资料，不是奖励依据：查询某个
真人队友失败时，服务端记录包含 viewer ID 的警告并跳过该项，继续返回成功结算；自己、NPC 和重复 viewer ID
仍会被过滤。这样非关键资料故障不会制造“客户端收到 500，但奖励已经到账”的假失败。

## 回归约束

- `tools/score_attack_route_transaction.test.cjs` 对 category 27 和普通 category 1 注入晚期删除失败，确认所有
  数值、奖励、进度、履历和任务写入回滚，数据库及内存 active quest 保留；
- `tools/multi_finish_follow_info.test.cjs` 注入单个队友资料查询异常，确认其他队友仍返回且只记录一条警告；
- `tools/multi_remote_settlement.test.cjs` 通过真实协力路由、项目 SQLite schema 和 Hub verifier 屏障并发提交
  两个 finish，确认仅一个请求结算，另一个在事务内复核失败且玩家全部可观测表不再变化；
- 活动专项测试继续验证各处理器自身的幂等键和业务字段，不能由总事务测试替代。

本结论只覆盖服务端数据库一致性。各分类的客户端动画、响应字段和双客户端协力流程仍按对应系统文档验收。
