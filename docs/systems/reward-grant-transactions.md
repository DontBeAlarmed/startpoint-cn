# 奖励发放事务

`src/lib/reward-grant/` 提供可组合的奖励计划和同步执行器。单人战斗 finish 的直接标准奖励、普通/Rare Score、Carnival 标准奖励、Mission 标准奖励、普通角色/装备抽卡生产路径、普通/bulk shop 标准奖励，以及邮件的六种标准附件已迁移到 owner 计划执行。box gacha 和 `TREASURE_EQUIPMENT` 强化商店仍保持各自领域 writer；邮件的六种专用余额也继续由邮件领域负责。Carnival degree、Mission degree/pass 点数/事实写入继续由领域模块负责。协力 Score 只复用规范化 Plan 的选择结果，继续通过 `givePlayerScoreRewardsSync()` 兼容 writer 发放，不使用事务拥有者入口。

## 安全公共 API

- `createRewardGrantPlan(entries)`：在写入前校验全部奖励并创建不可变计划。
- `executeRewardGrantPlanWithinTransactionSync(playerId, plan)`：在调用方已经开启的 SQLite 事务中执行计划。
- `executeRewardGrantPlanSync(playerId, plan)`：为独立调用建立一次 SQLite 事务并执行计划。

`executeRewardGrantPlanInTransactionOwnerSync(playerId, plan, knownPlayerBefore)` 与其 `Internal` detailed 版本是 executor 模块的内部事务拥有者契约，不从 `reward-grant/index.ts` 公共 barrel 导出。它仅供拥有最外层事务、负责绑定 `playerId` 与已知状态且保证错误向外传播的协调器使用；该入口复用调用方已知的玩家货币前态，不建立计划 savepoint。gacha route、Tutorial route、Score 适配器、shop reward 适配器和 mail reward 适配器均 direct import 需要的 owner 入口；详细结果类型与 `itemDeltas` 仅限各自 projection 内部使用，不得进入公共 barrel、HTTP/TCP 响应或其他结算模块。

计划条目通过泛型 `source` 保留调用方关联信息，例如抽取序号或邮件 ID。计划保持条目顺序和 `source` 引用，不复制或冻结 `source`；建计划时只读取一次条目及奖励必需字段，并把奖励复制成仅含 `name`、`type`、`id`、`count` 中适用字段的普通冻结对象。奖励对象、条目、条目数组和计划本身会被冻结，因此调用方之后修改原奖励对象不会改变计划，额外奖励字段也不会进入计划。

计划允许为空。所有已知奖励类型都会在建计划时校验：要求 ID 的类型必须提供正安全整数 ID，要求数量的类型必须提供正安全整数数量。未知类型以及缺失、非有限数、小数、零、负数或超出安全整数范围的字段会抛出 `RewardGrantPlanValidationError`，不会产生写入。

## 事务边界

所有执行入口都不信任传入对象的 TypeScript 结构类型，会在首笔写入前读取 `plan.entries`，并通过 `createRewardGrantPlan` 重新规范化和完整校验。伪造、畸形或带 getter 的运行时 Plan 与普通输入遵循同一快照规则；校验失败抛出 `RewardGrantPlanValidationError`，不会产生写入。

事务内执行器首先确认存在调用方活动事务，规范化 Plan，再通过嵌套的 `getDb().transaction` 建立计划级 SQLite savepoint。共享私有执行体在 savepoint 内先确认玩家存在，之后才按计划顺序发放奖励。未处于事务时抛出 `RewardGrantTransactionRequiredError`；玩家不存在时抛出 `RewardGrantPlayerNotFoundError`；角色配置等执行期错误抛出 `RewardGrantExecutionError`。任一错误都会回滚本计划的全部写入，即使调用方捕获错误并正常提交外层事务，也不会留下部分奖励；调用方在计划外的其他写入不受该 savepoint 回滚影响。

独立执行器在规范化 Plan 后，仅包装一次 `getDb().transaction` 并直接调用同一个私有执行体，不调用事务内执行器，因此公共模块不会形成“外层事务加计划 savepoint”的两层包装。两个入口都不提交或吞掉执行错误；调用方仍可通过抛错或显式回滚撤销包含奖励在内的整个外层事务。

事务拥有者入口同样要求活动事务，并在首笔写入前重新规范化完整 Plan，但不查询玩家前后态，也不建立 savepoint。它先各读取一次 `knownPlayerBefore.freeMana`、`freeVmoney` 和 `expPool`，复制为不含额外字段的普通对象；三字段必须是非负安全整数，否则抛出带 `field` 的 `RewardGrantKnownPlayerValidationError` 且零写入。每条 MANA、BEADS 或 EXP 奖励都先计算对应最终值，确认仍是非负安全整数后，才修改内存中的 `playerAfter` 与累计 delta；溢出时分别以 `freeMana`、`freeVmoney` 或 `expPool` 标识错误，并由事务拥有者回滚此前写入。执行过程最后用一条 `players` UPDATE 写入本 Plan 的最终三项余额与 mana 累计，并返回完整 `entries`、`aggregate` 和 `playerAfter`，不增加玩家 `SELECT` 或事务语句。owner CHARACTER 发放使用事务内 item/character writer，避免重复角色补偿为每抽建立 savepoint；它仍复用角色写入返回的首次获得事实，不为了 `joined_character_id_list` 预查一次角色所有权。

单人 Mission 适配器可向未公开的 owner direct 调用附带当前 `degreeId`，使 Mission 标准货币和领域称号选择继续合并为旧 writer 的一条玩家 UPDATE。该 patch 不属于 `RewardGrantPlan`、`RewardGrantResult` 或公共 barrel；degree 授予、响应和 invalidation 仍由 Mission granter 决定。

该入口不提供“调用方捕获错误后计划仍独立回滚”的保证；执行错误必须离开最外层事务回调，由事务拥有者回滚全部结算写入。它也不额外查询玩家存在性，空计划加不存在玩家不属于该内部入口的 API 保证；事务拥有者负责保证玩家与已知状态属于同一结算上下文。

## 结果语义

`RewardGrantResult.entries` 按输入顺序返回每条 `source`、计划中的奖励副本和该条的 `PlayerRewardResult`，其公共结构不包含 Score 专用 metadata。内部 Score 适配器通过未从 barrel 导出的详细入口取得同样顺序的内部 entries；CHARACTER 发生重复补偿时，内部 entry 的 `itemDeltas` 记录 `givePlayerCharacterSync()` 返回的本次补偿增量，仅供 Score 专用兼容 projection 使用，随后对外仍返回剥离 metadata 的公共结果，不进入任何 HTTP/TCP 响应。`aggregate` 与 `PlayerRewardResult` 兼容：

- `user_info` 是本次计划的货币增量；
- `items` 是每个物品 ID 提交后的最终库存，同一 ID 多次出现时保留最后后态；
- 角色和装备按 ID 去重，保留首次出现顺序并以最新结果替换内容；
- `joined_character_id_list` 稳定去重；
- 重复角色补偿会在同一事务中回读物品最终库存后态。

`playerAfter` 同时返回执行后的 `freeMana`、`freeVmoney` 和 `expPool`，后续调用方不需要为这些字段再次查询玩家。

## 抽卡逐抽 projection

普通抽卡的 plan source 只携带 `{ drawIndex, kind, rewardId }`，不携带 gacha 或 movie 大对象。gacha projection 在 owner detailed entries 上重建客户端结果：角色 entry 的内部补偿 delta 只成为当前 draw 的 `ex_boost_item` 增量，entry result 的 item 后态成为对应 ID 的最终 `item_list`；角色对象按同 ID 的出现顺序合并，特殊 `rarity_5_guarantee` 路径保持独立。装备 entry 按抽次生成 `draw_equipment`，movie effect 的 rank/guarantee metadata 同样按抽次匹配，响应中的 equipment list 对重复 ID 保留最后状态。

`rewardPlayerGachaDrawResultSync` 保留直接调用兼容性：有 owner callback 时执行 gacha plan，未提供时进入 `gacha-reward-legacy.ts`。legacy 路径仍在函数成功后记录旧 sampled log；生产 `/gacha/exec` 与 Tutorial 路径则只捕获 log closure，并在最外层事务提交成功后调用。Tutorial receipt replay 不经过 reward plan，因此不会重复奖励或 sampled success log。

## 商店标准奖励

普通 `/shop/buy` 与 `/shop/bulk_buy` 继续由 `event-shop-purchase.ts` 拥有最外层事务。商店先整体校验并扣除 user cost、item cost，再把扣款后的 `freeMana`、`freeVmoney` 和 `expPool` 作为 `knownPlayerBefore` 交给 `shop-reward-grant.ts`；因此同批奖励不能支付同批成本。shop plan source 以 `{ rewardIndex }` 稳定保留奖励输入顺序，但 adapter 只把聚合奖励结果和 `playerAfter` 返回给商店协调器，source 不进入客户端协议。

owner 返回的 item、角色、装备最终状态与货币后态直接用于商店响应，不再为最终 `user_info` 查询玩家；同一 item 多次奖励及重复角色补偿均返回数据库最终库存。purchase count、mana mission fact、pass-card point 或奖励执行失败必须离开事务回调，使成本、奖励和后续写入由同一个外层事务回滚。`TREASURE_EQUIPMENT` 强化商店继续执行专用装备成长事务，不经过 shop reward adapter。

## 邮件标准奖励

`mail-reward-grant.ts` 将 `ITEM`、`FREE_VMONEY`、`CHARACTER`、`EQUIPMENT`、`FREE_MANA`、`EXP_POOL` 分别映射为 RewardGrant 的 `ITEM`、`BEADS`、`CHARACTER`、`EQUIPMENT`、`MANA`、`EXP`。角色邮件按 `number` 展开；source 为 `{ mailId, attachmentIndex }`，保持请求中有效邮件和附件的顺序。`PAID_VMONEY`、`STAR_CRUMB`、`BOND_TOKEN`、`BOSS_BOOST_POINT`、`BOOST_POINT`、`RANK_POINT` 不进入 plan，也不增加 RewardGrant 公共类型。

`/mail/receive` 与 `/mail/receive_all` 各自拥有唯一最外层事务，并在其中读取一次奖励所需 Player 前态。adapter 的 owner 调用不查询 Player、不建立 savepoint；专用余额复用同一前态，只更新本批实际涉及字段。adapter 只返回邮件协议需要的角色、装备、最终 item 库存和最终绝对余额，plan source、`joined_character_id_list`、`isNew`、`itemDeltas` 均不向 route 暴露为响应字段。

全部有效邮件先完成校验，再执行标准 plan、专用写入和每封一次的领取历史；route 随后逐封标记领取，并在原有时点 reconcile Awake unlock。owner、专用写入、history、标记、未知角色或安全整数溢出必须抛出到最外层事务，使批量全部回滚。不支持附件仍由邮件领域返回 400，不会消费同批合法邮件。

## 后续迁移

单人 finish 通过事务拥有者入口迁移 clear、S+、普通/Rare Score、additional、rush、score-attack、Carnival kind 0/1/2/3/4 和 Mission kind 0/1/2/3/4/5 标准奖励，并维护三个货币后态字段。Carnival kind 7、Mission kind 6/7 以及 mission facts/stages、Carnival claimed/record 仍由领域 writer 负责。Mission granter 跨 stage 收集标准 entries，在 `persistPlayer()` 一次执行 owner callback；character amount 会在领域适配层展开为多个 CHARACTER entry，RewardGrant 的公共 character 类型不增加 count。普通/bulk shop 和邮件标准附件已在各自最外层事务中启用 owner callback；无 callback 的 Carnival standalone、active mission、pass-card 和 box gacha 继续使用原 writer，`TREASURE_EQUIPMENT` 继续使用装备强化专用路径。所有回滚仍由最外层事务拥有者负责，本模块不提供 Unit of Work、事件总线或插件扩展。
