# 背包与装备写入事务

本文记录体力道具、普通道具出售、装备保护和装备分解的数据库一致性边界。

## 体力道具

`/item/use_item` 的请求是数组。服务端先按道具 ID 合并数量，再校验效果、持有数和体力上限；同一 ID 出现两次
不会分别读取旧库存并只扣最后一次。全部道具扣除与玩家体力、恢复时间更新在一个 SQLite 事务中提交。

## 普通道具出售

`sellItemSync()` 在事务中重新读取出售配置、持有数、已装备能力魂和玛纳上限，并一次完成道具扣除、免费玛纳及
累计获得玛纳更新。玩家字段写入失败时不会留下已扣道具。

## 装备保护与分解

- `/equipment/set_protection` 的批量保护更新同成同败；不存在的装备仍按原兼容语义跳过；
- `/equipment/sell_equipment` 先去重并完整校验，再一次写入全部 stack 和奖励；
- `/equipment/sell_stack` 先按装备 ID 合并出售数，拒绝零、负数、小数，并一次提交 stack 与奖励；
- `/equipment/bulk_sell_stack` 的全部 stack、锻造石、星之粒和能力魂共享事务。

奖励计算公式没有在本轮改变。任何奖励 INSERT/UPDATE 失败都会回滚装备扣除。

## 回归

`tools/inventory_write_transaction.test.cjs` 使用真实 Fastify 路由和 SQLite trigger，覆盖重复体力道具、体力更新
失败、道具售出玛纳失败、三种装备分解奖励失败以及批量保护第二项失败。所有故障都要求请求前后存档快照一致。
