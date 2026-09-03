# 奖励发放事务

`src/lib/reward-grant/` 提供有限的 typed 正向奖励计划和同步执行器。Login、Gift、Scheduled、Mail、Shop、Gacha、Box、Single/Multi 结算、Mission、Carnival、Story、Raid 和 Score 的生产奖励消费者均已迁移到 target typed contract；每个来源仍保留自己的事务、receipt、响应和事实投影。box gacha、`TREASURE_EQUIPMENT` 强化商店、角色成长和活动状态仍由各自领域 writer 负责。

C5 已删除迁移期的 Quest reward facade、Gacha 无 owner fallback 以及旧 RewardGrant core。生产代码只通过目标 typed public barrel 和各来源 source-local adapter 进入奖励协调核；`src/legacy/multiBattleQuest.ts.bak` 仅作为历史归档，不属于生产运行路径。

## 安全公共 API

- `createRewardGrantExecutionPlan(entries)`：校验并创建不含 source/name 的不可变 typed 资产计划。
- `executeRewardGrantExecutionPlanWithinTransactionSync(playerId, plan)`：在调用方已经开启的 SQLite 事务中执行计划。
- `executeRewardGrantExecutionPlanSync(playerId, plan)`：为独立调用建立一次 SQLite 事务并执行计划。

`executeRewardGrantExecutionPlanAsTransactionOwnerSync(playerId, plan, knownPlayerBefore)` 是公共 typed transaction-owner 契约，要求 known state 携带同一 `playerId`，不建立计划 savepoint。需要共享来源 Inventory 的 Shop、Gacha、Box 使用各自 source adapter 调用 external-finalization API，并由来源在验证后显式 finalize；其他来源使用 RewardGrant 自有 Inventory。旧 owner/internal API 已删除。

target 计划条目只包含正向资产 command 和连续数组位置。抽取序号、邮件 ID、Score drop index、活动 definition 等 source metadata 留在来源 adapter，并按本地 entry index 关联；不会进入 RewardGrant plan/result。奖励对象、条目数组和计划本身会被冻结，额外展示字段不会进入资产 identity。

计划允许为空。target typed 计划会校验所有已知奖励类型：要求 ID 的类型必须提供正安全整数 ID，要求数量的类型必须提供正安全整数数量。未知类型以及缺失、非有限数、小数、零、负数或超出安全整数范围的字段会抛出 `RewardGrantContractValidationError`，不会产生写入。

## 事务边界

所有执行入口都不信任传入对象的 TypeScript 结构类型，会在首笔写入前读取 `plan.entries`，并通过 `createRewardGrantExecutionPlan` 重新规范化和完整校验。伪造、畸形或带 getter 的运行时 Plan 与普通输入遵循同一快照规则；校验失败抛出 `RewardGrantContractValidationError`，不会产生写入。

事务内执行器首先确认存在调用方活动事务，规范化 Plan，再通过嵌套的 `getDb().transaction` 建立计划级 SQLite savepoint。共享私有执行体在 savepoint 内先确认玩家存在，之后才按计划顺序发放奖励。未处于事务时抛出 `RewardGrantExecutionTransactionError`；计划或 known-player 快照不符合 typed contract 时抛出 `RewardGrantContractValidationError`；角色、装备、Item 或其他资产执行失败时抛出对应的资产执行错误。任一错误都会回滚本计划的全部写入，即使调用方捕获错误并正常提交外层事务，也不会留下部分奖励；调用方在计划外的其他写入不受该 savepoint 回滚影响。

独立执行器在规范化 Plan 后，仅包装一次 `getDb().transaction` 并直接调用同一个私有执行体，不调用事务内执行器，因此公共模块不会形成“外层事务加计划 savepoint”的两层包装。两个入口都不提交或吞掉执行错误；调用方仍可通过抛错或显式回滚撤销包含奖励在内的整个外层事务。

事务拥有者入口同样要求活动事务，并在首笔写入前重新规范化完整 Plan，但不查询完整玩家前后态，也不建立 savepoint。它先各读取一次 `knownPlayerBefore.freeMana`、`freeVmoney` 和 `expPool`，复制为不含额外字段的普通对象；身份、字段缺失或非负安全整数校验失败时抛出 `RewardGrantContractValidationError` 且零写入。每条 MANA、BEADS 或 EXP 奖励都先计算对应最终值，确认仍是非负安全整数后，才修改内存中的 `playerAfter` 与累计 delta；溢出时分别以 `freeMana`、`freeVmoney` 或 `expPool` 标识错误，并由事务拥有者回滚此前写入。纯货币、纯装备、空计划和首次角色获得不会激活 Inventory；发生 direct Item 或运行时重复角色补偿时，Inventory 在当前事务中读取明确 Item 前态，但通过 `caller-verified` 复用 RewardGrant 入口已有的玩家存在性合同，不重复查询 Player。执行过程最后在 Inventory flush 后用一条 `players` UPDATE 写入本 Plan 的最终三项余额与 mana 累计。owner CHARACTER 继续复用角色写入返回的首次获得事实，不为了 `joined_character_id_list` 预查一次角色所有权。

Mission 的 `degreeId` 不再传入 RewardGrant。RewardGrant 先完成标准资产和 Player resource update，Mission source 随后以窄 Player update 写入当前 degree；degree、标准奖励和 stage receipt 仍处于同一外层事务。含 degree+standard 的 batch 因 owner 分离固定增加一次 `players` UPDATE，属于已审查接受的 `O(1)` 性能成本。

该入口不提供“调用方捕获错误后计划仍独立回滚”的保证；执行错误必须离开最外层事务回调，由事务拥有者回滚全部结算写入。它也不额外查询玩家存在性，空计划加不存在玩家不属于该内部入口的 API 保证；事务拥有者负责保证玩家与已知状态属于同一结算上下文。

## 结果语义

`RewardGrantExecutionResult.entries` 按输入顺序返回 typed command 和 typed outcome，`assets` 提供稳定的最终资产摘要，`playerAfter` 提供带 `playerId` 的资源绝对后态。来源 adapter 根据客户端合同决定使用 `afterAmount`、`acceptedAmount` 或逐 entry 对象；Score 的 drop metadata、Gacha 动画、Story/Raid/Multi 响应字段不进入 RewardGrant。

来源兼容 DTO 仍保持原有语义：

- `user_info` 是本次计划的货币增量；
- `items` 是每个物品 ID 提交后的最终库存，同一 ID 多次出现时保留最后后态；
- 角色和装备按 ID 去重，保留首次出现顺序并以最新结果替换内容；
- `joined_character_id_list` 由来源 adapter 按来源合同决定；
- 重复角色补偿同时提供 accepted delta 与 absolute after-state，来源不得混用。

`playerAfter` 同时返回执行后的 `freeMana`、`freeVmoney` 和 `expPool`，后续调用方不需要为这些字段再次查询玩家。

RewardGrant 只负责调用方事务中的奖励计划与结果，不保存 HTTP 成功响应。当前 single finish 会在同一外层事务内形成最终
Player/item 投影并删除数据库 active，提交后再删除内存 active；若后续 projector、序列化或网络发送失败，旧成功响应不能
重放，重试会因 active 不存在而拒绝。当前明确不新增通用 receipt 表或全局 finish 幂等框架，这是已知边界，不是待本 Gate
完成的迁移项。

## 抽卡逐抽 projection

普通抽卡的 target plan 只携带 Character/Equipment asset command，不携带 gacha、movie 或 source 大对象。Gacha adapter 以本地 `drawResult` 数组位置关联 typed entries：角色 entry 的 compensation `acceptedAmount` 只成为当前 draw 的 `ex_boost_item` 增量，`afterAmount` 成为对应 ID 的最终 `item_list`；角色对象按同 ID 的出现顺序合并，特殊 `rarity_5_guarantee` 路径保持独立。装备 entry 按抽次生成 `draw_equipment`，movie effect 的 rank/guarantee metadata 同样按抽次匹配，响应中的 equipment list 对重复 ID 保留最后状态。

`rewardPlayerGachaDrawResultSync` 的生产调用要求显式提供 typed owner；`/gacha/exec` 与 Tutorial 路径都在各自来源事务内使用 owner contract。生产路径捕获 log closure，并在最外层事务提交成功后调用。Tutorial receipt replay 不经过 reward plan，因此不会重复奖励或 sampled success log。

## 商店标准奖励

普通 `/shop/buy` 与 `/shop/bulk_buy` 继续由 `event-shop-purchase.ts` 拥有最外层事务。商店先整体校验并扣除 user cost、item cost，再把扣款后的 `freeMana`、`freeVmoney` 和 `expPool` 作为带真实身份的 `knownPlayerBefore` 交给 `shop-reward-grant.ts`；因此同批奖励不能支付同批成本。shop adapter 保留本地奖励顺序并只返回兼容 DTO 与 typed invalidation facts，source 不进入客户端协议。

owner 返回的 item、角色、装备最终状态与货币后态直接用于商店响应，不再为最终 `user_info` 查询玩家；同一 item 多次奖励及重复角色补偿均返回数据库最终库存。purchase count、mana mission fact、pass-card point 或奖励执行失败必须离开事务回调，使成本、奖励和后续写入由同一个外层事务回滚。`TREASURE_EQUIPMENT` 强化商店继续执行专用装备成长事务，不经过 shop reward adapter。

RewardGrant 的 transaction-owner、within 和 standalone 三条路径都通过同一个惰性 Inventory batch 发放 Item。静态 direct Item ID 首次激活时一次批读；重复角色补偿通过显式 port 加入同一 batch，不触发 Growth 自建 Item owner。每个物品 ID 在内存中累计最终数量和 `total_obtained`，计划末尾只写入一次库存和一次收集总量；逐条响应仍保留每次 mutation 当时的绝对数量。纯货币、纯装备、空计划和首次获得角色不激活 Inventory。

## 邮件标准奖励

`mail-reward-grant.ts` 将 `ITEM`、`FREE_VMONEY`、`CHARACTER`、`EQUIPMENT`、`FREE_MANA`、`EXP_POOL` 分别映射为 RewardGrant 的 `ITEM`、`BEADS`、`CHARACTER`、`EQUIPMENT`、`MANA`、`EXP`。角色邮件按 `number` 展开；邮件 ID 和附件序号只保留在 Mail adapter 的本地顺序中。`PAID_VMONEY`、`STAR_CRUMB`、`BOND_TOKEN`、`BOSS_BOOST_POINT`、`BOOST_POINT`、`RANK_POINT` 不进入 plan，也不增加 RewardGrant 公共类型。

`/mail/receive` 与 `/mail/receive_all` 各自拥有唯一最外层事务，并在其中读取一次奖励所需 Player 前态。adapter 的 owner 调用不查询 Player、不建立 savepoint；专用余额复用同一前态，只更新本批实际涉及字段。adapter 只返回邮件协议需要的角色、装备、最终 item 库存和最终绝对余额，RewardGrant 的身份、执行字段和来源 metadata 均不向 route 暴露为响应字段。

全部有效邮件先完成校验，再执行标准 plan、专用写入和每封一次的领取历史；route 随后逐封标记领取，并在原有时点 reconcile Awake unlock。owner、专用写入、history、标记、未知角色或安全整数溢出必须抛出到最外层事务，使批量全部回滚。不支持附件仍由邮件领域返回 400，不会消费同批合法邮件。

## 后续迁移

单人 finish、Multi、Mission、Carnival、Story 和 Raid 已通过各自 source-local adapter 使用 typed target；各领域仍负责 clear/S+、任务进度、活动状态、receipt、Mission facts、Growth publication 和响应。Mission 的 degree patch 已回到 Mission/Player adapter；含 degree+standard 的 batch 固定增加一次窄 Player UPDATE。普通/bulk shop、Gacha、Box 和邮件标准附件已在各自最外层事务中启用 typed owner；`TREASURE_EQUIPMENT` 继续使用装备强化专用路径。所有回滚仍由最外层事务拥有者负责，本模块不提供 Unit of Work、事件总线或插件扩展。
