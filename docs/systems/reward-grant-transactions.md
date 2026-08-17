# 奖励发放事务

`src/lib/reward-grant/` 提供可组合的奖励计划和同步执行器。该模块只负责公共发放核心；现有单人战斗、扭蛋、商店、邮件和任务调用方尚未迁移，原有 `givePlayerRewardsSync` 行为保持不变。

## 公共 API

- `createRewardGrantPlan(entries)`：在写入前校验全部奖励并创建不可变计划。
- `executeRewardGrantPlanWithinTransactionSync(playerId, plan)`：在调用方已经开启的 SQLite 事务中执行计划。
- `executeRewardGrantPlanSync(playerId, plan)`：为独立调用建立一次 SQLite 事务并执行计划。

计划条目通过泛型 `source` 保留调用方关联信息，例如抽取序号或邮件 ID。计划保持条目顺序和 `source` 引用，不复制或冻结 `source`；建计划时只读取一次条目及奖励必需字段，并把奖励复制成仅含 `name`、`type`、`id`、`count` 中适用字段的普通冻结对象。奖励对象、条目、条目数组和计划本身会被冻结，因此调用方之后修改原奖励对象不会改变计划，额外奖励字段也不会进入计划。

计划允许为空。所有已知奖励类型都会在建计划时校验：要求 ID 的类型必须提供正安全整数 ID，要求数量的类型必须提供正安全整数数量。未知类型以及缺失、非有限数、小数、零、负数或超出安全整数范围的字段会抛出 `RewardGrantPlanValidationError`，不会产生写入。

## 事务边界

两个执行入口都不信任传入对象的 TypeScript 结构类型，会在首笔写入前读取 `plan.entries`，并通过 `createRewardGrantPlan` 重新规范化和完整校验。伪造、畸形或带 getter 的运行时 Plan 与普通输入遵循同一快照规则；校验失败抛出 `RewardGrantPlanValidationError`，不会产生写入。

事务内执行器首先确认存在调用方活动事务，规范化 Plan，再通过嵌套的 `getDb().transaction` 建立计划级 SQLite savepoint。共享私有执行体在 savepoint 内先确认玩家存在，之后才按计划顺序发放奖励。未处于事务时抛出 `RewardGrantTransactionRequiredError`；玩家不存在时抛出 `RewardGrantPlayerNotFoundError`；角色配置等执行期错误抛出 `RewardGrantExecutionError`。任一错误都会回滚本计划的全部写入，即使调用方捕获错误并正常提交外层事务，也不会留下部分奖励；调用方在计划外的其他写入不受该 savepoint 回滚影响。

独立执行器在规范化 Plan 后，仅包装一次 `getDb().transaction` 并直接调用同一个私有执行体，不调用事务内执行器，因此公共模块不会形成“外层事务加计划 savepoint”的两层包装。两个入口都不提交或吞掉执行错误；调用方仍可通过抛错或显式回滚撤销包含奖励在内的整个外层事务。

## 结果语义

`RewardGrantResult.entries` 按输入顺序返回每条 `source`、计划中的奖励副本和该条的 `PlayerRewardResult`。`aggregate` 与 `PlayerRewardResult` 兼容：

- `user_info` 是本次计划的货币增量；
- `items` 是每个物品 ID 提交后的最终库存，同一 ID 多次出现时保留最后后态；
- 角色和装备按 ID 去重，保留首次出现顺序并以最新结果替换内容；
- `joined_character_id_list` 稳定去重；
- 重复角色补偿会在同一事务中回读物品最终库存后态。

`playerAfter` 同时返回执行后的 `freeMana`、`freeVmoney` 和 `expPool`，后续调用方不需要为这些字段再次查询玩家。

## 后续迁移

Task23–26 可以在各自既有外层事务中组合计划并逐步迁移调用方。迁移阶段仍需保持各业务的奖励算法、顺序、时间语义和响应协议；本模块不提供批量 SQL、Unit of Work、事件总线或插件扩展。
