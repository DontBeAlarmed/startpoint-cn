# 奖励发放事务

`src/lib/reward-grant/` 提供可组合的奖励计划和同步执行器。该模块只负责公共发放核心；单人战斗 finish 的直接标准奖励以及普通/Rare Score 已迁移，扭蛋、商店、邮件、Carnival 和 Mission 仍保持原有 writer。协力 Score 只复用规范化 Plan 的选择结果，继续通过 `givePlayerScoreRewardsSync()` 兼容 writer 发放，不使用事务拥有者入口。

## 安全公共 API

- `createRewardGrantPlan(entries)`：在写入前校验全部奖励并创建不可变计划。
- `executeRewardGrantPlanWithinTransactionSync(playerId, plan)`：在调用方已经开启的 SQLite 事务中执行计划。
- `executeRewardGrantPlanSync(playerId, plan)`：为独立调用建立一次 SQLite 事务并执行计划。

`executeRewardGrantPlanInTransactionOwnerSync(playerId, plan, knownPlayerBefore)` 是 executor 模块的内部事务拥有者契约，不从 `reward-grant/index.ts` 公共 barrel 导出。它仅供拥有最外层事务、负责绑定 `playerId` 与已知状态且保证错误向外传播的协调器使用；该入口复用调用方已知的玩家货币前态，不建立计划 savepoint。Score 单人适配器才允许 direct import 名为 `Internal` 的详细入口；详细结果类型与 `itemDeltas` 仅限该适配器内部使用，不得进入公共 barrel、HTTP/TCP 响应或其他结算模块。

计划条目通过泛型 `source` 保留调用方关联信息，例如抽取序号或邮件 ID。计划保持条目顺序和 `source` 引用，不复制或冻结 `source`；建计划时只读取一次条目及奖励必需字段，并把奖励复制成仅含 `name`、`type`、`id`、`count` 中适用字段的普通冻结对象。奖励对象、条目、条目数组和计划本身会被冻结，因此调用方之后修改原奖励对象不会改变计划，额外奖励字段也不会进入计划。

计划允许为空。所有已知奖励类型都会在建计划时校验：要求 ID 的类型必须提供正安全整数 ID，要求数量的类型必须提供正安全整数数量。未知类型以及缺失、非有限数、小数、零、负数或超出安全整数范围的字段会抛出 `RewardGrantPlanValidationError`，不会产生写入。

## 事务边界

所有执行入口都不信任传入对象的 TypeScript 结构类型，会在首笔写入前读取 `plan.entries`，并通过 `createRewardGrantPlan` 重新规范化和完整校验。伪造、畸形或带 getter 的运行时 Plan 与普通输入遵循同一快照规则；校验失败抛出 `RewardGrantPlanValidationError`，不会产生写入。

事务内执行器首先确认存在调用方活动事务，规范化 Plan，再通过嵌套的 `getDb().transaction` 建立计划级 SQLite savepoint。共享私有执行体在 savepoint 内先确认玩家存在，之后才按计划顺序发放奖励。未处于事务时抛出 `RewardGrantTransactionRequiredError`；玩家不存在时抛出 `RewardGrantPlayerNotFoundError`；角色配置等执行期错误抛出 `RewardGrantExecutionError`。任一错误都会回滚本计划的全部写入，即使调用方捕获错误并正常提交外层事务，也不会留下部分奖励；调用方在计划外的其他写入不受该 savepoint 回滚影响。

独立执行器在规范化 Plan 后，仅包装一次 `getDb().transaction` 并直接调用同一个私有执行体，不调用事务内执行器，因此公共模块不会形成“外层事务加计划 savepoint”的两层包装。两个入口都不提交或吞掉执行错误；调用方仍可通过抛错或显式回滚撤销包含奖励在内的整个外层事务。

事务拥有者入口同样要求活动事务，并在首笔写入前重新规范化完整 Plan，但不查询玩家前后态，也不建立 savepoint。它先各读取一次 `knownPlayerBefore.freeMana`、`freeVmoney` 和 `expPool`，复制为不含额外字段的普通对象；三字段必须是非负安全整数，否则抛出带 `field` 的 `RewardGrantKnownPlayerValidationError` 且零写入。执行过程使用该快照更新货币并返回完整 `entries`、`aggregate` 和 `playerAfter`，不增加玩家 `SELECT` 或事务语句。CHARACTER 发放直接复用 `givePlayerCharacterSync()` 内部查询返回的首次获得事实，不再为了 `joined_character_id_list` 预查一次角色所有权。

该入口不提供“调用方捕获错误后计划仍独立回滚”的保证；执行错误必须离开最外层事务回调，由事务拥有者回滚全部结算写入。它也不额外查询玩家存在性，空计划加不存在玩家不属于该内部入口的 API 保证；事务拥有者负责保证玩家与已知状态属于同一结算上下文。

## 结果语义

`RewardGrantResult.entries` 按输入顺序返回每条 `source`、计划中的奖励副本和该条的 `PlayerRewardResult`，其公共结构不包含 Score 专用 metadata。内部 Score 适配器通过未从 barrel 导出的详细入口取得同样顺序的内部 entries；CHARACTER 发生重复补偿时，内部 entry 的 `itemDeltas` 记录 `givePlayerCharacterSync()` 返回的本次补偿增量，仅供 Score 专用兼容 projection 使用，随后对外仍返回剥离 metadata 的公共结果，不进入任何 HTTP/TCP 响应。`aggregate` 与 `PlayerRewardResult` 兼容：

- `user_info` 是本次计划的货币增量；
- `items` 是每个物品 ID 提交后的最终库存，同一 ID 多次出现时保留最后后态；
- 角色和装备按 ID 去重，保留首次出现顺序并以最新结果替换内容；
- `joined_character_id_list` 稳定去重；
- 重复角色补偿会在同一事务中回读物品最终库存后态。

`playerAfter` 同时返回执行后的 `freeMana`、`freeVmoney` 和 `expPool`，后续调用方不需要为这些字段再次查询玩家。

## 后续迁移

单人 finish 通过事务拥有者入口迁移 clear、S+、普通/Rare Score、additional、rush 和 score-attack 标准奖励，并维护三个货币后态字段。Score 选择层的 source 区分 common/rare，并保存真实 group ID、客户端 index 和最终数量；drop IDs 由同一 source 投影。与旧 writer 相比，首通场景减少 clear/S+ 各一次玩家前态查询，Score 货币奖励也不再查询玩家前态；奖励写入数、事务语句和响应行为不变。后续迁移仍需保持各业务的奖励算法、顺序、时间语义和响应协议；本模块不提供批量 SQL、Unit of Work、事件总线或插件扩展。
