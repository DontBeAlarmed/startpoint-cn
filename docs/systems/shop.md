# 商店与兑换

本文描述 `/shop/get_sales_list`、`/shop/buy` 及相关商店资产的当前职责。狂热激战的兼容商店边界见[狂热激战](./rush-event.md)，星之粒角色/装备兑换见 `src/routes/api/exchange.ts`。

## 数据与入口

| 数据或模块 | 用途 |
|---|---|
| `assets/general_shop.json` | 通用商店 |
| `assets/cdn_general_shop_whitelist.json` | 当前客户端确实存在的 GeneralShop ID |
| `assets/boss_coin_shop.json` | Boss 币分类商品 |
| `assets/star_grain_shop.json` | 星之粒商店与组合奖励 |
| `assets/equipment_enhancement_shop.json` | 追忆装备阶段强化商品 |
| `src/data/domains/shopPurchase.ts` | 玩家累计购买次数 |
| `src/lib/event-shop-purchase.ts` | 通用购买校验与事务 |
| `src/routes/api/shop.ts` | 列表与购买端点 |

运行时商品读取由 `src/lib/assets.ts` 和当前 Content repository 接线决定。某张资产存在不等于客户端一定有对应 ID；返回列表仍需遵守客户端主数据和活动开放期。

## 商品列表

`/shop/get_sales_list` 按客户端请求组合来源：

1. `shop_types` 读取普通商店类型；
2. `event_list` 按活动类型与活动 ID 合并活动商品；
3. `boss_coin_shop_category_ids` 按 Boss 分类合并商品；
4. `equipment_enhancement_shop_category_ids` 限制追忆装备强化分类；
5. 使用统一服务器时间过滤尚未开放或已经结束的商品；
6. 读取玩家购买记录，计算剩余库存和累计购买次数。

GeneralShop 额外通过 `cdn_general_shop_whitelist.json` 过滤客户端主数据中不存在的商品，避免返回未知 ID 触发 C8601。该白名单只用于 GeneralShop；其他类型依赖各自的受控运行资产。

追忆装备强化不是普通堆叠购买。列表按 `groupId` 汇总阶段，并根据玩家当前 `enhancementLevel` 返回下一可购买阶段、剩余级数和 group 信息；满级时仍返回组信息，但库存为 0。

## 通用购买事务

`/shop/buy` 先校验 viewer、商品、正整数购买数量、库存与余额。普通购买由 `executeGenericShopPurchaseSync()` 在单一 SQLite 事务内完成：

1. 读取最新玩家状态与购买次数；
2. 对活动商店执行开放期校验；
3. 校验 Mana、星导石、羁绊证或道具成本；
4. 扣除货币和道具；
5. 按购买数量展开并发放全部奖励；
6. 累加 `players_shop_purchases`；若支付类型为玛纳，同时累计 Active Mission 的实际玛纳消费量；
7. 返回最终玩家、物品、角色与装备状态。

任一步失败都回滚整个购买，不保留“已扣成本但未发奖”或“已发奖但未记库存”的部分状态。购买数量必须是正安全整数；库存按累计购买数限制。

支持的通用奖励包括道具、经验池、玛纳、角色和装备。角色响应会经过觉醒解锁发布协调，避免商店获得角色时丢失当前应公开的 `mana_board_awake` 状态。

## 追忆装备强化

`ShopType.TREASURE_EQUIPMENT` 使用独立路径：

- 商品描述目标装备、阶段与 `enhancementMaxLevel`；
- `planEquipmentEnhancementPurchase()` 根据当前强化等级计算目标等级；
- 材料、货币、装备等级与购买记录在同一事务中更新；
- 商品存在玛纳价格时，同一事务还会累计 Active Mission 的实际玛纳消费量；当前 1.4.54 官方表没有这类价格，逻辑用于保持动态 Content 表兼容；
- 响应返回 `equipment_list` 的最终强化等级；
- 该流程不会套用普通装备强化的逐级素材模型。

客户端展示的“阶段”与数据库中的 `enhancementLevel` 是同一条状态链的不同表现，不能把商店阶段号直接当作最终装备等级。

## 星之粒组合奖励

星之粒培育素材箱商品是购买时立即展开的多奖励商品，不是进入背包后再开启的箱子。`assets/star_grain_shop.json` 的 `rewards` 可以包含多项；通用购买事务会一次发放所有奖励，并且不会把商品 ID 自身作为背包道具。

重建工具 `tools/rebuild_star_grain_shop.ts` 从 CN 主数据的六组奖励槽生成运行资产。非法或部分填写的槽位会使生成失败，不静默丢弃奖励。生成器属于数据维护工具，普通服务启动不会自动执行它。

## Boss 币与活动商店

Boss 币列表严格按客户端传入的 category ID 查询 `boss_coin_shop.json`。分类不存在时返回空集合，不猜测相邻分类，也不把其他活动商品混入。

活动商店的开放期使用统一服务器时间。列表过滤开放期，购买时再次校验，避免客户端持有旧列表后购买已经关闭的商品。狂热激战部分活动在官方 CN 数据中缺少完整商品与代币定义，当前兼容来源和推测性边界单独记录在[狂热激战](./rush-event.md)。

## 玩家序列化边界

商店购买可能同时改变玩家货币、物品、角色和装备。响应字段使用各领域的统一客户端序列化器；商店文档不定义 Mana Node 的 `/load` 结构。

当前 Mana Node 元素契约由 `src/data/types.ts` 和 `src/data/utils/serialize-player.ts` 维护，元素为：

```text
{ multiplied_id, awake_level }
```

不得使用旧字段 `mana_node_multiplied_id`，也不得在商店处理中复制一套独立序列化逻辑。

## 已知边界

- 并非全部商店表都已由 Content Sync 动态生成；未接入转换器的类型继续使用版本内置资产；
- GeneralShop 白名单需要与受支持客户端 CDN 同步维护；
- 狂热激战兼容商店仍含推测性数据，不能标记为官方 CDN 完整还原；
- 支付服务不提供真实雷霆 IAP；
- 商店客户端全类型、全部库存周期和异常回滚尚未形成完整人工验收矩阵。

## 验证入口

主要相关测试：

- `tools/shop_repository.test.cjs`；
- `tools/shop_repository_integration.test.cjs`；
- `tools/rush_event_shop.test.cjs`；
- `tools/rush_event_shop_route.test.cjs`；
- `tools/star_grain_material_pack.test.cjs`；
- `tools/equipment_enhancement.test.cjs`。

修改商店业务代码后运行 `npm run test:changed`；重建星之粒资产时单独运行 generator 测试；模块提交前运行 `npm run verify:full`。
