# 装备升级与追忆强化审计

> 客户端验收：已通过（2026-07-17）。普通装备觉醒材料扣除与追忆装备逐级强化均符合预期。

## 两套系统的边界

普通装备觉醒与追忆装备强化是两套独立流程：

| 流程 | 端点 | 持久化字段 | 含义 |
|---|---|---|---|
| 普通装备觉醒 | `/equipment/upgrade`、`/equipment/bulk_upgrade` | `players_equipment.level` | 消耗重复装备或星铁钢，最高通常为 5 |
| 追忆装备强化 | `/shop/buy`，`shop_type=10` | `players_equipment.enhancement_level` | 在强化商店按购买数量逐级提升，最高可到 99 |

两者不能共用“阶段升级”语义。`equipment_enhancement_shop.enhancement_max_level` 是当前商品阶段的购买上限，不是一次购买后的目标等级。

## 追忆强化跳级缺陷

玩家对装备 `5020040` 连续购买商品 `56`、`57` 各一次后，数据库出现：

```text
level=5, enhancement_level=69
```

商品 `57` 属于第 2 阶段，`enhancement_max_level=69`。旧实现直接执行
`enhancement_level = max(current, enhancement_max_level)`，因此从 1 级购买一次便错误跳到 69 级。

CN 1.8.1 客户端的权威行为：

- `ShopBuyRealRemote` 将购买数量作为请求字段 `number` 发送。
- `ShopBuyDummyRemote` 按 `number` 循环调用 `addEquipmentEnhancement()`。
- `PlayerLogic.addEquipmentEnhancement()` 每次只执行 `enhancementLevel++`。
- `ShopGetSalesListDummyResponseTools` 仅用 `enhancement_max_level - enhancementLevel` 计算当前阶段库存。

修复后使用 `newEnhancementLevel = currentEnhancementLevel + number`，并在扣除材料前验证：

- `number` 是正整数；
- 请求商品确实是当前强化阶段；
- 新等级不超过该阶段的 `enhancement_max_level`；
- 普通觉醒等级满足 `require_awakening_level`。

材料、货币、追忆强化等级与购买记录在同一个 SQLite 事务内提交。

## 结论

装备觉醒的数量公式基本正确：每提升 1 级消耗 1 个重复装备或 1 个星铁钢，同时按装备稀有度消耗锻造石。问题在于服务端原先没有验证替代材料的类型和适用稀有度，也没有把多项库存更新放在同一事务中。

## CN 客户端规则

CN `ItemTable` 中只有两个 `EquipmentAwakingCrystal`：

| item_id | 名称 | 目标稀有度 | 允许低稀有度 |
|---:|---|---:|:---:|
| 12001 | 4 星星铁钢 | 4 | 是 |
| 12002 | 5 星星铁钢 | 5 | 否 |

`OwnedItemRepository.getEquipmentAwakingCrystal()` 会按 `target_equipment_rarity` 和 `is_allow_below_rarity` 选择材料。装备是否可升级还同时检查重复装备/星铁钢和锻造石。

## 原实现风险

1. `use_stack=false` 时任何现有 `item_id` 都能作为材料，低星星铁钢也能升级 5 星装备。
2. 传入锻造石、星之粒或能力魂 ID 时，材料扣除可能被后续同 key 的库存响应/奖励覆盖。
3. `upgrade_count` 的 0、负数会被静默改成 1，小数未拒绝，请求语义不可靠。
4. 材料、锻造石、装备等级和能力魂分多次写库，中途异常会形成部分扣除。

## 修复

- 新增 `canUseEquipmentAwakeningCrystal()`，严格对齐 12001/12002 的稀有度规则。
- `upgrade_count` 必须为正整数，`use_stack` 必须是布尔值。
- 单件与批量觉醒的库存写入均使用 SQLite 事务。
- `use_stack=true` 继续只扣装备 stack；`use_stack=false` 每级扣 1 个合法星铁钢；两者都按 CDN `awakening_craft` 扣锻造石。
