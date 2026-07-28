# 商店与兑换

本文描述 `/shop/get_sales_list`、`/shop/buy` 及相关商店资产的当前职责。狂热激战的兼容商店边界见[狂热激战](./rush-event.md)，星之粒角色/装备兑换见 `src/routes/api/exchange.ts`。

## 数据与入口

| 数据或模块 | 用途 |
|---|---|
| `assets/general_shop.json` | 通用商店 |
| `assets/cdn_general_shop_whitelist.json` | 当前客户端确实存在的 GeneralShop ID |
| `assets/boss_coin_shop.json` | Boss 币分类商品 |
| `assets/shop_select_item_campaign.json` | 选择式商店活动的开放期和合法 lineup |
| `assets/star_grain_shop.json` | 星之粒商店与组合奖励 |
| `assets/equipment_enhancement_shop.json` | 追忆装备阶段强化商品 |
| `src/data/domains/shopPurchase.ts` | 玩家按商店类型、日/月周期和总量记录购买次数 |
| `src/data/domains/shop-campaign-lineup.ts` | 玩家首次选择的 campaign lineup |
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
6. 读取玩家购买记录，计算当前日、当前月、总累计及最终剩余库存。

GeneralShop 额外通过 `cdn_general_shop_whitelist.json` 过滤客户端主数据中不存在的商品，避免返回未知 ID 触发 C8601。该白名单只用于 GeneralShop；其他类型依赖各自的受控运行资产。

追忆装备强化不是普通堆叠购买。列表按 `groupId` 汇总阶段，并根据玩家当前 `enhancementLevel` 返回下一可购买阶段、剩余级数和 group 信息；满级时仍返回组信息，但库存为 0。

## 通用购买事务

`/shop/buy` 先校验 viewer、商品、正整数购买数量、库存与余额。普通购买由 `executeGenericShopPurchaseSync()` 在单一 SQLite 事务内完成：

1. 读取最新玩家状态与购买次数；
2. 对活动商店执行开放期校验；
3. 校验 Mana、星导石、羁绊证或道具成本；
4. 扣除货币和道具；
5. 按购买数量展开并发放全部奖励；
6. 按商店类型累加当前日、当前月和总购买次数；若支付类型为玛纳，同时累计 Active Mission 的实际玛纳消费量；
7. 返回最终玩家、物品、角色与装备状态。

任一步失败都回滚整个购买，不保留“已扣成本但未发奖”或“已发奖但未记库存”的部分状态。购买数量必须是正安全整数。

官方表中的 `buy_max_count` 只限制单次请求数量，不是永久库存。总次数限制来自 `max_frequency`，周期限制来自 `daily_stock` 和 `monthly_stock`；列表中的 `stock_quantity` 取三个剩余限制的最小值，三者都未配置时返回 `-1`。日库存按北京时间每日 05:00 重置，月库存按每月 1 日北京时间 05:00 重置；General Shop 的 `specified_months` 会把月周期锚定到指定月份。商品 ID 在不同商店类型之间允许重名，所有计数都以 `shop_type + shop_item_id` 隔离。

升级前的 `players_shop_purchases` 没有商店类型。服务端会先保留为未知类型的兼容累计，并在该商品首次于某个明确商店购买时一次性迁入该类型；迁入后删除旧源记录，避免重启后重复导入。旧数据本身无法证明重名商品属于哪个商店，因此首次迁入前仍属于兼容边界。

支持的通用奖励包括道具、经验池、玛纳、角色和装备。角色响应会经过觉醒解锁发布协调，避免商店获得角色时丢失当前应公开的 `mana_board_awake` 状态。

## 批量购买

`/shop/bulk_buy` 接受客户端的 `shop_type` 与 `buy_item_list` 映射。当前只开放国服 1.8.1 客户端确认使用批量入口的活动道具商店（type 4）和 Boss Coin 商店（type 7）；General、星之粒与追忆装备强化继续走各自单品或专用流程。

批次先使用同一个服务器时间快照解析全部商品，并汇总货币成本、道具成本、单次上限、日/月/总库存与奖励。所有余额校验都基于批次开始时的库存，因此本批商品奖励不能反过来支付本批另一件商品的成本。预检通过后，成本扣除、全部奖励、每件商品的周期购买数、玛纳任务事实和响应状态在同一 SQLite 事务内提交；任一商品失败会回滚整批。

活动商品过期沿用客户端已确认的 `2053`。商品不存在、数量非法、库存不足或余额不足沿用 HTTP 400，不猜测国服专用业务错误码。单品与批量入口共用同一周期键和库存校验，不会把 `daily_stock` 或 `monthly_stock` 误当永久库存。

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

## 选择式 Campaign Lineup

`/shop/get_campaign_lineup_id` 与 `/shop/set_campaign_lineup_id` 只接受 Event Item Shop（type 4）和 Boss Coin Shop（type 7）。Content Sync 同时读取以下官方表，并生成统一的 `shop_select_item_campaign.json`：

- `event_shop_select_item_campaign.orderedmap`；
- `event_shop_select_item_campaign_lineup.orderedmap`；
- `boss_coin_shop_select_item_campaign.orderedmap`；
- `boss_coin_shop_select_item_campaign_lineup.orderedmap`。

商品转换保留 `campaignId` 和可选的 `lineupId`。没有 campaign 的普通商品以及有 campaign、无 lineup 的公共商品始终进入候选；带 lineup 的商品只有在玩家为同一 `shop_type + campaign_id` 选择了该 lineup 后才会出现在列表中。`/buy` 与 `/bulk_buy` 会再次执行相同授权，不能通过手写商品 ID 绕过列表过滤。

玩家选择保存在 `players_shop_campaign_lineups`。首次选择写入；相同值的传输重试幂等成功；不同值拒绝且不覆盖第一次选择。国服客户端只明确处理活动期外码 `1652`，因此服务端只在已知 campaign 期外返回该码；非法 campaign、非法 lineup 和重复改选使用 HTTP 400，不虚构未知业务码。开放期按国服 UTC+8 解释，首尾均包含，并统一使用全局服务器时间。

CN 1.4.54 的 Event Shop 共有 6 个选择活动、27 个 lineup，bundled fallback 中 246 个相关商品已从官方表回填，其中 111 个是公共商品、135 个属于指定 lineup。同期 Boss Coin 选择活动和 lineup 表均为空，服务端原样生成空表，不推测补充。后续 CDN 出现合法 Boss Coin 定义时，Content Sync 会按同一规则自动生成。

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
- `tools/shop_campaign_lineup.test.cjs`；
- `tools/shop_bulk_purchase.test.cjs`；
- `tools/shop_purchase_period_storage.test.cjs`；
- `tools/star_grain_material_pack.test.cjs`；
- `tools/equipment_enhancement.test.cjs`。

修改商店业务代码后运行 `npm run test:changed`；重建星之粒资产时单独运行 generator 测试；模块提交前运行 `npm run verify:full`。
