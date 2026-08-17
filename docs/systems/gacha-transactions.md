# 抽卡写入事务

本文记录普通扭蛋抽取和兑换的持久化边界。卡池来源、赔率与动画种子另见[扭蛋赔率修复](./gacha-odds-fix.md)和[种子验证](../protocol/seed-verification.md)。

## 兑换

`/gacha/exchange_character` 与 `/gacha/exchange_equipment` 先校验卡池类型、目标是否可兑换以及 250 点兑换积分，再在一个 SQLite 事务中完成：

1. 发放角色或装备；
2. 写入领取历史；
3. 扣除兑换积分。

角色内部的主体和 bond token、装备库存、历史或积分任一步失败都会整体回滚。角色成功提交后仍经过觉醒解锁响应协调；协调为 fail-soft，不改变兑换事务结果。

## 正式抽取

`/gacha/exec` 在写事务外完成卡池规则校验、费用/票券计划、随机抽取和动画计划。计划通过后，以下持久状态在同一个事务中提交：

- 票券余额或活动免费次数；
- 角色、装备及重复角色补偿道具；
- 每条领取历史；
- 首抽状态和兑换积分；
- 免费/付费星导石余额；
- Active Mission 的角色抽取次数或活动抽取次数。

角色和装备奖励先转换为 `src/lib/gacha-reward-grant.ts` 的逐抽 `RewardGrantPlan`。每条 source 只保留 `drawIndex`、`kind` 和 `rewardId`，并严格对应同序的 draw、角色电影计划或装备 movie metadata；计划长度、source index、奖励 ID 或 metadata 不一致时在首笔奖励写入前 fail closed。`/gacha/exec` 在已有最外层事务内调用未公开的 transaction-owner detailed executor，不建立额外 savepoint，也不查询玩家前后态；owner 使用事务上下文中的三项已知余额快照。RewardGrant 的 `itemDeltas`、`isNew` 和 joined 内部事实只用于 projection，不进入响应。

角色 projection 按抽次保留 `movie_id`、`seed`、`entry_count`、`rarity_5_guarantee` 特殊路径、quarantine `markSent` 次数、重复角色的 `ex_boost_item` 本次增量和 `item_list` 最终库存；同角色对象按抽取顺序合并。装备 projection 保留每抽 `draw_equipment` 顺序、`treasure_up_type`、`is_erupt`，装备列表按 ID 只保留最后状态。未提供 owner callback 的直接内部调用仍使用 `gacha-reward-legacy.ts`，其结果由迁移前 fixture 锁定。

任一后段写入失败时，费用、奖励、历史、积分和任务事实全部回滚。角色 sampled log 只在最外层事务成功返回后记录一次；事务回滚时不会留下成功日志。响应只在事务提交后组装；角色列表再执行 fail-soft 的觉醒解锁协调。

## 待审阅边界

客户端通用请求层在网络失败时可能使用相同 `api_count` 自动重试。当前服务端没有持久化抽卡请求回执；若第一次事务已经提交而响应在网络中丢失，重试仍可能形成第二次合法抽取。`api_count` 的重置范围和跨会话唯一性尚无充分权威证据，本轮不以永久 `viewer_id + api_count` 去重，避免把后续正常请求误判为重试。

动画种子的近期发送标记属于进程内反作弊状态，不是玩家存档。数据库事务失败不会恢复该短期标记，但不会造成玩家扣费或奖励分裂。日志提交后的约束只适用于 sampled log，不改变种子算法、抽取概率或 movie plan 算法。

## 自动回归

`tools/gacha_write_transaction.test.cjs` 使用 SQLite trigger 注入角色历史、装备积分和最终任务事实失败，校验所有玩家持久状态回滚；同时覆盖 owner 十抽 projection、装备 metadata、unknown character、source mismatch、SQL/savepoint 约束、legacy fixture 和正常单抽的费用、奖励、历史、积分和任务计数。`tools/tutorial_update_step.test.cjs` 覆盖 Tutorial gacha 的失败日志、成功日志和 replay 不重复奖励/日志。
