# Item Inventory Owner 与写入事务

本文记录当前 Item Inventory owner、EventTrade 到期转换，以及体力道具、普通道具出售、装备保护和装备分解的数据库一致性边界。

## Inventory owner

正常业务的 Item grant、deduct 和 restore 统一通过 `lib/inventory` 写入。standalone 命令自行拥有事务；within-transaction 命令和 callback-scoped batch 必须复用来源用例的活动事务。Shop、Gacha、Exchange、Mission、Battle、Character Growth 和 RewardGrant 可以提供来源规划或调用 Inventory adapter，但不能直接写 `players_items` 或 `players_collected_items`。

同一 batch 内相同 Item 的重复 grant/deduct/restore 会先归一化，再按 Item ID 稳定写入最终绝对数量。正向 grant 只按实际进入 Inventory 的数量增加 `players_collected_items.total_obtained`；deduct、战斗资源 restore、后台精确设置、存档恢复和过期清零都不增加累计获得量。调用方已经在当前事务读取并验证 Player 时，必须显式选择 `caller-verified`，不能依赖隐式信任。

后台精确 set/delete、旧存档导入和 V2 registry restore 保持独立 maintenance/save 权限，不伪装成玩家业务 grant。D18 已在已盘点的正常正向 Item grant 入口启用 `grantWithCapacity`：读取 runtime Item policy 的 `max_count`，只让 accepted 数量进入 Inventory，其余交给来源的 overflow Mail adapter。deduct、restore、maintenance 和 save/import 仍保持原语义。

## EventTrade 到期转换

`/load` 在登录奖励和定时资源结算之后、最终完整序列化之前，读取冻结的 `item_inventory_policy.json`。只有持有量大于 0、`effect_kind=9`、存在结束时间且虚拟业务时间按秒已经超过结束时间的 EventTrade 才会转换；`sellable=false` 不排除自动转换，无结束时间和非 EventTrade Item 保持不变。

到期计划先批量读取玩家可能持有的 EventTrade，再按各 Item 的 `sale_price` 计算 Mana。容量使用 `free_mana + paid_mana` 与 `config.max_mana`；D16 只有在整批 Mana 都能立即进入余额时，才在一个事务中清零 Item、增加 `free_mana` 和 `total_mana_obtained`。任一写入失败会整体回滚，重复 `/load` 自然 no-op。

若整批存在 Mana overflow，D18 登录仍成功，但会在同一事务中清除 EventTrade Item、把 accepted Mana 入账，并把 overflow 拆分为 FREE_MANA Mail。缺失或非法 Item policy 属于 Content 完整性错误，继续 fail closed。

## 体力道具

`/item/use_item` 的请求是数组。服务端先按道具 ID 合并数量，再校验效果、持有数和体力上限；同一 ID 出现两次
不会分别读取旧库存并只扣最后一次。全部道具扣除与玩家体力、恢复时间更新在一个 SQLite 事务中提交。

规划阶段基于 Inventory transaction snapshot 计算每个受影响 Item 的最终数量。deduct 与返还 grant 进入同一 batch，
最后由 Inventory repository 对每个 distinct Item 执行一次 absolute flush；库存行是否存在不离开 Inventory。返还部分
单独增加本次正向 grant 的累计获得事实，不在奖励写入前重新读取同一道具。这样同一道具同时被扣除和返还时只保留
一次最终库存更新，响应中的 `item_list` 与事务内最终状态一致。

## 普通道具出售

`sellItemSync()` 在事务中重新读取出售配置、持有数、已装备能力魂和玛纳上限，并一次完成道具扣除、免费玛纳及
累计获得玛纳更新。玩家字段写入失败时不会留下已扣道具。

## 装备保护与分解

- `/equipment/set_protection` 的批量保护更新同成同败；不存在的装备仍按原兼容语义跳过；
- 三个装备分解入口都会拒绝 `protection=true` 的装备，避免绕过锁定直接清空 stack；批量请求遇到已锁定装备时整体拒绝，不执行部分出售；
- `/equipment/sell_equipment` 先去重并完整校验，再一次写入全部 stack 和奖励；
- `/equipment/sell_stack` 先按装备 ID 合并出售数，拒绝零、负数、小数，并一次提交 stack 与奖励；
- `/equipment/bulk_sell_stack` 的全部 stack、锻造石、星之粒和能力魂共享事务。

三条装备分解接口都遵循 CDN 的 `generate_ability_soul` 标记；区别只在于分解数量：

- `/equipment/sell_equipment` 会出售并删除选中的装备记录；由于客户端的 `stack` 只表示重复数，因此实际出售数量为 `stack + 1`；
- `/equipment/sell_stack` 按请求中的 `number` 发放；
- `/equipment/bulk_sell_stack` 按每件装备被清零前的完整 `stack` 发放。

因此，装备是否在分解后消失与是否获得魂珠是两个独立判断：前者由出售数量决定，后者由 CDN 标记和实际分解数量共同决定。

奖励计算公式没有在本轮改变。任何奖励 INSERT/UPDATE 失败都会回滚装备扣除。

## 回归与性能

`tools/inventory_write_transaction.test.cjs` 与 `tools/item_use_cultivate_pack.test.cjs` 使用真实 Fastify 路由和 SQLite
trigger，覆盖重复体力道具、计划态最终库存写入、体力更新失败、道具售出玛纳失败、三种装备分解奖励失败以及批量保护
第二项失败，以及保护装备拒绝。所有故障都要求请求前后存档快照一致；同道具扣返场景还锁定结算阶段只读取一次 `players_items`。

Inventory owner 测试另外覆盖 standalone/within/batch 生命周期、同 Item 合并、累计获得量、maintenance/save 边界和中途故障回滚。EventTrade `/load` 测试覆盖首次转换、重复幂等、paid+free 容量、overflow Mail、非 EventTrade/no-end、提交后响应和 late failure rollback；Mail claim 测试覆盖 Item/Mana 容量阻塞、receive_all 跳过和过期 EventTrade 自动出售。

性能准入锁定合法 N=0、N=1 和批量到期状态：N=0 只有一次候选库存批读，不建立结算事务、不写数据库；N=1 与批量都只读取一次候选库存、固定次数读取 Player 和更新一次 Mana，只有 distinct 到期 Item 写入按 N 线性增长，不产生 N+1 Player 或 Currency 操作。
