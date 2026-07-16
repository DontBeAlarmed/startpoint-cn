# 特殊装备升级材料审计

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
