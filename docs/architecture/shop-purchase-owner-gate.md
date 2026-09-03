# D19 Shop Purchase Owner 目标架构

本文定义 Shop Purchase Owner 的稳定目标架构、客户端/Content 证据和功能边界；执行顺序、基线、提交、审查与运行状态保留在版本库外计划中。

## 1. 目标

D19 将 Shop 产品、开放期、库存/购买次数、single/bulk 购买计划和最外层事务收口到一个明确的 Shop Purchase owner，并补齐 CN 1.4.54 当前真实存在但服务端尚未运行的 Shop Content。

本 Gate 不重新实现 D16–D18b 已经稳定的资产能力：

- Inventory 继续拥有 Item 数量、cap、accepted/overflow、绝对后态与 `total_obtained`；
- RewardGrant 继续协调正向 Item/Character/Equipment/Currency；
- Item overflow 继续按 `sellable` 进入 Sold 或无限 Mail，Mana 二次超限进入 FREE_MANA Mail；
- `data.over_max` 继续由已有无状态 projector 生成；
- Character、Equipment、Currency、Mail 和 Mission 状态仍由各自 owner 写入。

Shop owner 只协调一个购买用例，不成为通用 Economy、Exchange、资产或 Content service。

## 2. CN 客户端可达边界

### 2.1 Shop type

CN 1.8.1 的正常 single `/shop/buy` 支持以下 8 个 type：

| type | 客户端产品 | single | bulk |
|---:|---|---:|---:|
| 2 | Treasure | 是 | 否 |
| 3 | Special Pack | 是；导航产品除外 | 否 |
| 4 | Event Item | 是 | 是 |
| 5 | Mana Shop | 是 | 否 |
| 7 | Boss Coin | 是 | 是 |
| 8 | General | 是 | 否 |
| 9 | Star Grain | 是 | 否 |
| 10 | Equipment Enhancement | 是 | 否 |

single 请求为：

```text
{ shop_type, shop_item_id, number }
```

bulk 请求为：

```text
{ shop_type, buy_item_list: { "<shop_item_id>": count } }
```

bulk 的正常 UI 入口只有 Event Item 和 Boss Coin。空 map、跨 Shop type、重复 key 和其他 type bulk 不进入客户端 E2E；其中重复 key 在对象协议上无法表达，只保留 command/server-boundary 防护。

### 2.2 客户端前置校验

客户端在发送请求前综合检查：

- price 与 Item cost；
- `buy_max_count`；
- daily/monthly/total 剩余次数；
- Item/EXP/Mana/Equipment 产物容量；
- Equipment Enhancement 当前阶段。

bulk 使用成本副本与产物容量副本逐产品计算可买量。因此正常客户端不会主动制造 Shop Item overflow。D18b Shop disposition 是旧状态、并发、未来 Content 或直接服务端调用的防御边界，不建立伪造正常客户端 overflow E2E。

当前实际 Shop Content 中没有同一产品的 cost/reward Item 重合。服务端仍保持“全批成本先验证并扣除，再按扣费后 Inventory 状态发奖”的 command 不变量，但只保留一个 server-boundary 代表测试。

### 2.3 成功响应

single 和 bulk 均先经过客户端 Common Response merge。bulk endpoint-specific callback 不读取业务 body，因此必须由 common response提供资产后态。

Shop 响应必须遵守：

- `user_info`、`item_list`、Character、Equipment 使用 owner 已提交的绝对后态；
- Optional 未涉及字段省略，不以 0 清空客户端旧状态；
- `over_max` 只描述真实已提交 disposition；
- `mail_arrived` 在提交后读取；
- 客户端按成功请求数量自行更新 Shop-local stock/purchase count，不要求服务端返回次数 delta。

### 2.4 已知错误码

- `2053` 是客户端明确处理的 Shop period error；
- `3010` 的触发条件无法由当前静态证据完整推出，本 Gate 不猜测；
- 余额、库存、非法产品与不支持 purchase 使用有限 400/fail-closed；
- 统一计划固定 `period → per-request/period stock → balances/costs → mutation` 的校验顺序，删除 route/domain 重复优先级。

## 3. CN Content 实际范围

当前 CN 1.4.54 源表实际包含：

| type | 源表 | 产品数 | 当前服务端缺口 |
|---:|---|---:|---|
| 2 | `treasure_shop` | 108 | 已转换 |
| 3 | `special_pack_shop` | 158 | 只保留 1 个 Pass Card 产品 |
| 4 | `event_item_shop` | 8,532 | 已转换 |
| 5 | `mana_shop` | 3 | 完全缺失 |
| 7 | `boss_coin_shop` | 6,566 | runtime/bundled 需与当前 release 同步 |
| 8 | `general_shop` | 290 | 动态 cost schedule 缺失 |
| 9 | `star_grain_shop` | 75 | runtime/bundled 需与当前 release 同步 |
| 10 | `equipment_enhancement_shop` | 191 | 已转换，事务 owner 仍在 route |

### 3.1 Special Pack

158 个产品中：

- 156 个 `special_exchange_campaign_id == 0`，是 Shop direct purchase；
- 2 个非零，只导航到独立 Special Exchange。

D19 可以让两类产品共同进入 listing catalog，但只有 direct purchase 产品可以生成购买计划。导航产品不得调用 Shop owner，也不得把 Special Exchange 生命周期并入 D19。

Special Pack 支持多奖励槽，当前真实组合包括多 Item 与 Item+EXP；Pass Card Point 继续作为独立 product effect adapter，不扩展 RewardGrant 类型。

### 3.2 Mana Shop

3 个产品使用普通星导石、free-first 扣款，并由 `purchase_count + additional_count` 形成 Mana 产物。`ShopType.U5` 改名为语义化的 `MANA`，数值保持 5；这不是新增协议值。

### 3.3 动态成本

General 产品 `220032` 引用 `cost_item_schedule_id=equipment_awaking_crystal_piece`，没有静态 cost。当前 converter 丢弃该引用，导致可零成本购买。

D19 引入 typed `shop_cost_item_schedule`。每一行包含 `scheduleId + start/end + business month + ordered costs`；effective resolver 使用同一个 captured virtual business time，在固定 CN UTC+8 时区求月份，并要求该月恰好一个 `start <= now <= end` 的有效行。零行或同一时刻多行重叠都 fail closed。8 月的权威成本为：

```text
Item 40122 × 75
Item 40052 × 75
```

缺失 schedule、月份条目、非法 Item/count 或重复不一致时必须在任何购买写入前 fail closed。

### 3.4 两种时钟

- 产品开放期和动态 schedule 月份使用本次请求捕获的虚拟业务时间，月份固定按 CN UTC+8 计算，不依赖宿主机时区；
- daily/monthly purchase-count bucket 保持现有真实时间与重置小时语义。

两种时钟职责不同，不因统一 Shop owner 而机械合并。

### 3.5 当前生产兼容输入

Shop catalog 除原始 Content 外必须保留三个当前生产输入：

- 常驻 Rush `700011–700017` 复用 `700001–700007` 产品，并增加独立 compatibility period；这是明确的私服兼容层，不冒充 CN 原始 Event Shop 行；
- General Shop 的 CN 客户端 ID 白名单继续在 listing 层生效，不能因全量 catalog 建立而暴露客户端不支持的产品；
- `/get_campaign_lineup_id` 与 `/set_campaign_lineup_id` 保持独立 HTTP 生命周期，但其持久选择是 purchase owner 的授权输入。

因此产品 period 是 primary/compatibility window 的集合；任一窗口命中即允许 listing/purchase。Event index 同时索引原始 event ID 与批准的 Rush compatibility target ID。

## 4. 当前服务端问题

当前 generic single/bulk 已正确具备：

- 一个来源最外层 SQLite 事务；
- transaction-owner RewardGrant；
- shared Inventory context；
- 全批成本先于奖励；
- 同 Item cost/reward 的扣费后容量；
- bulk all-or-nothing；
- purchase-count snapshot/bulk reader；
- absolute Player/Item response；
- D18b Sold/Mail 与 `over_max`。

D19 不替换这些不变量，只消除以下结构与功能缺口：

1. `src/routes/api/shop.ts` 仍约 883 行，Equipment Enhancement 在 route 内拥有第二套成本、事务、Equipment 写入与响应；
2. `src/lib/event-shop-purchase.ts` 约 688 行，混合 model、period、cost/reward 计划、single/bulk 两套循环、计数 adapter 与事务执行；
3. route 和 domain 重复检查 `buy_max_count`、数量与 period；
4. 非 Event type 没有 purchase-time period enforcement；
5. owner 接受 route 注入的任意 `ShopItem`，没有 Shop-local authoritative offer resolver；
6. Shop Content 不完整；
7. `how-to-get` 每次合并/扫描约 1.6 万产品，并在缺少 bulk reader 时逐候选读取 purchase count；
8. 多个测试锁定源码 symbol、复制事务 harness 或构造当前 Content 不可能出现的五资产 Shop 产品。

## 5. 目标模块

```text
src/lib/shop/
├── model.ts
├── errors.ts
├── period.ts
├── catalog.ts
├── effective-offer.ts
├── purchase-plan.ts
├── purchase-owner.ts
├── payment-adapter.ts
├── equipment-enhancement-adapter.ts
├── result.ts
└── response-projector.ts

src/content/converters/shop/
├── layouts.ts
├── product-parser.ts
├── cost-schedule.ts
├── special-pack.ts
└── index.ts
```

实际实施只创建被真实调用的模块；不为了匹配目录图建立空 abstraction。现有 `src/content/converters/shop.ts` 可以在迁移期作为薄 façade，Gate 结束前不得保留两套 converter owner。

`src/lib/shop-reward-grant.ts` 保持独立 source adapter，不并回 Shop owner。

## 6. 领域合同

### 6.1 Catalog product

```ts
type ShopCatalogEntry = ShopPurchaseProduct | ShopNavigationProduct

interface ShopPurchaseProduct {
  readonly kind: "purchase"
  readonly shopType: ShopType
  readonly shopItemId: number
  readonly periods: readonly ShopPeriod[]
  readonly scope:
    | { readonly kind: "ordinary" }
    | { readonly kind: "event"; readonly eventType: number; readonly eventId: number; readonly campaignId?: number; readonly lineupId?: number }
    | { readonly kind: "bossCoin"; readonly categoryId: number; readonly campaignId?: number; readonly lineupId?: number }
    | { readonly kind: "equipmentEnhancement"; readonly categoryId: number; readonly groupId: number }
  readonly limits: ShopLimits
  readonly userCost?: ShopUserCost
  readonly staticItemCosts: readonly ShopItemCost[]
  readonly costScheduleId?: string
  readonly rewards: readonly ShopReward[]
  readonly effect:
    | { readonly kind: "standard" }
    | { readonly kind: "passCardPoint"; readonly points: number }
    | { readonly kind: "equipmentEnhancement"; readonly equipmentId: number; readonly stage: number; readonly maxLevel: number; readonly requiredAwakeningLevel: number }
}

interface ShopNavigationProduct {
  readonly kind: "specialExchangeLink"
  readonly shopType: ShopType.SPECIAL_PACK
  readonly shopItemId: number
  readonly periods: readonly ShopPeriod[]
  readonly specialExchangeCampaignId: number
}
```

Navigation product 只允许 listing/navigation adapter 消费。Purchase owner 接收它时 fail closed。

### 6.2 Effective offer

`resolveEffectiveShopOffer(shopType, shopItemId, virtualNow)` 是玩家无关的第一步：

- 从当前 Content Snapshot 对应的 immutable catalog O(1) 查找；
- 校验 entry 为 purchase；
- 校验开放期；
- 将 static costs 或 schedule costs 解析为冻结的当前 offer；schedule 先按 CN UTC+8 月份索引候选，再按 row start/end 选取唯一有效行；
- 不读取玩家、数据库、购买次数或 HTTP body。

第二步由 Shop owner 在事务内批量读取玩家 Campaign Lineup snapshot，并授权全部 campaign-bound offer：公共 campaign 商品不要求 lineup；指定 lineup 商品必须与玩家当前选择完全一致。任何未选择或选择其他 lineup 的 offer 在成本、奖励和次数写入前拒绝，route 与其他 command 调用者都不能绕过。

### 6.3 Purchase plan

single 是长度 1 的 batch command；HTTP endpoint 仍独立。

```ts
interface ShopPurchaseCommand {
  readonly playerId: number
  readonly shopType: ShopType
  readonly entries: readonly {
    readonly shopItemId: number
    readonly purchaseAmount: number
  }[]
  readonly virtualNow: Date
  readonly realNow: Date
}
```

planner 输出：

- stable entry order；
- 每产品 period key 与 count snapshot key；
- 聚合 Player currency cost；
- 聚合 Item cost；
- ordered RewardGrant commands；
- product effect intents；
- purchase-count intents；
- Mana spent fact；
- preload Item IDs。

所有乘法、加法、数量和累计使用 non-negative safe integer；Character reward 的 purchase amount 必须先受真实 product limit 约束，不能先展开无界数组。

### 6.4 Transaction owner

唯一顺序为：

```text
resolve authoritative effective offers
  → begin Shop outer transaction
  → read Player once
  → bulk read purchase-count snapshots
  → bulk read selected Campaign Lineups
  → authorize every campaign-bound offer
  → validate all limits and Player/Item costs
  → create one shared Inventory context
  → apply payment through the narrow Player resource payment adapter
  → deduct every Item cost
  → execute ordered standard rewards through Shop RewardGrant
  → execute typed product effects through narrow adapters
  → write purchase counts from captured snapshots
  → publish Mission/Pass facts inside the same transaction
  → return typed absolute result
  → commit
  → route performs post-commit Growth publication and `mail_arrived`
```

任何 cost、RewardGrant、disposition、Equipment effect、Pass point、purchase count 或 Mission fact 失败，整个批次回滚。bulk 不 catch/continue，不产生部分成功结果。

### 6.5 Payment adapter

Shop payment adapter 只服务 Shop transaction owner，不是通用 Economy bus。它根据 owner 已读取的 Player snapshot：

- 规划普通 Stone/Mana free-first、paid-only Stone 和 Bond Token 扣费；
- 在同一外层事务内提交并返回绝对 Player resource after-state；
- 将扣费后 after-state 作为 RewardGrant 的 `knownPlayerBefore`；
- 保证后续正向 Mana/EXP/Stone 及 Item overflow Sold Mana 不被成本前快照覆盖。

同种货币既支付又被奖励、Mana cost 与 Sold Mana 同批时，最终 Player 状态必须形成一条连续 after-state 链。RewardGrant 仍只处理正向奖励，不承担 payment。

### 6.6 Equipment Enhancement adapter

该 adapter：

- 在 Shop 外层事务内读取目标 Equipment 当前状态；
- 使用预排序 stage catalog 验证当前 stage；
- 调现有纯 `planEquipmentEnhancementPurchase()`；
- 写 `enhancementLevel`；
- 返回绝对 Equipment after-state。

它不处理 Shop period、cost、purchase count、HTTP、RewardGrant 或 Mail。Shop owner 不把 enhancement 伪装成普通 Equipment reward。

### 6.7 Result 与 projector

Shop result 只携带已提交事实：

- final Player resource state；
- final Item map；
- Character/Equipment after-state；
- joined Character IDs 与事实失效键；
- Item overflow dispositions；
- endpoint-local Mission delta。

Shop response projector 是无状态纯函数，不读数据库、不启动事务、不重新计算购买。`mail_arrived` 和 post-commit Growth publication 留在 route adapter。完整跨域 Common Response 仍属于 D28。

## 7. Shop-local immutable index

Catalog 与当前 Content Snapshot 同生命周期，至少提供：

- `(shopType, shopItemId) → entry`；
- `(eventType, eventId) → product IDs`；
- `bossCategory → product IDs`；
- `equipment category/group → ordered stages`；
- `(reward kind, reward ID) → product refs`；
- `(schedule ID, month) → readonly schedule rows`，再由 captured virtual time 选取唯一有效 row；
- Rush compatibility target event ID → source products + compatibility windows。

`how-to-get` 使用 reward reverse index，并强制使用 purchase-count bulk reader；不得重新合并并扫描全部 Shop 表。目标复杂度从 O(全部约 1.6 万产品 + 逐候选 SQL) 收敛到 O(匹配产品 + 必需 Equipment stages)，数据库 purchase-count SELECT 保持整批固定数量。

该 index 是 Shop typed Content adapter，不是 D27 万能 raw Content service。

## 8. 旧存档兼容

当前 typed counter 主键：

```text
(player_id, shop_type, shop_item_id, period_type, period_key)
```

必须保留：

- `players_shop_purchases` legacy 数据；
- `shop_type=-1` first-touch 兼容；
- snapshot-owned bulk writer；
- corrupt/unsafe integer fail-closed。

当前有大量产品 ID 跨 Shop type 重叠，无法从 legacy row 无损推断类型。D19 不做 eager migration，不删除 legacy 表，不新增 schema。

## 9. 测试可达性

### 9.1 保留/新增

- single type `2/3/4/5/7/8/9/10` 各一个真实可购买产品；
- bulk 只覆盖 type 4/7，各一个成功和一个整批失败；
- 所有可购买 type 的 period 拒绝与 `2053` 零写入；
- Mana Shop free-first 与 Mana absolute after-state；
- Special Pack direct purchase、多 Item、Item+EXP、Pass Point，以及 link 不可 purchase；
- General `220032` 8 月动态成本；
- schedule start 前/end 后、结束边界包含、UTC+8 月末/月初、非重叠历史行和重叠行 fail-closed；宿主时区不影响结果；
- Campaign Lineup：已选成功、未选拒绝、选错拒绝、公共商品不要求 lineup；route/command 各一个绕过防护；
- Rush compatibility period、General whitelist、get/set Campaign Lineup 端点保持；
- 同 Item cost/reward 只保留一个 server-boundary；
- Equipment Enhancement 当前 stage、成本、次数、后态与 late rollback；
- 一次 D18b Mail/Sold source rollback；
- response Optional/absolute characterization；
- 同种货币 payment+reward、Mana payment+Sold Mana、RewardGrant late fault 不覆盖 payment；
- legacy counter first-touch 与 query plan；
- Content converter/current release smoke。

### 9.2 删除候选

替代 owner 稳定后删除或下沉：

- 锁定内部函数名、调用次数和源码文本的正则；
- Shop adapter 直接构造当前 converter 不会产生的 ELEMENT/AETHER/BEADS；
- 当前 Content 不存在的 Item+Mana+EXP+Character+Equipment 单产品；
- 多套重复 SQLite-like fault harness；
- type 2/3/5/8/9/10 的 bulk E2E 笛卡尔积；
- 已由 RewardGrant adversarial suite 证明的非法结果全矩阵。

Save/admin/corrupt-state、真实 rollback、D18b disposition、purchase-count compatibility 和性能测试不因客户端不可达而删除。

## 10. 性能 admission

最低结构要求：

- Catalog 每个 Content Snapshot 最多构建一次；
- direct offer lookup O(1)；
- bulk offer 解析 O(n)；
- single owner Player read 固定；
- bulk purchase-count SELECT 固定 2 次，不按产品 N+1；
- Inventory 静态 Item IDs 一次批读，每个 final Item ID 最多一次 absolute write；
- RewardGrant 不增加 nested outer transaction；
- sales list O(requested products + response)；
- how-to-get O(match count)，不随无关产品增长；
- response bytes 与实际返回 offer/asset 数线性；
- 真实最大正常页面和 500-entry server-boundary 负载不造成无界 event-loop stall；
- 不把跨机器 wall-clock 写为硬门槛，SQL/lookup/transaction/projector 结构为主要 admission。

若为正确性增加固定 O(1) 读取，必须在 snapshot 中显式说明；不得接受随产品数增长的额外 Player、Content 或 purchase-count 查询。

## 11. 明确不实施

- 不实现或猜测 `3010 ShopStepOverDay`；
- 不模拟未知 Treasure discount；
- 不把 Special Exchange link 变成 Shop purchase；
- 不合并 Star Crumb、Bond Token 或 Gacha Exchange；
- 不把 Equipment Enhancement 送入普通 RewardGrant；
- 不重写 Inventory cap、Mail/Sold、Mana overflow 或 `over_max`；
- 不扩展 bulk 到客户端无入口的 Shop type；
- 不建立通用 Economy/Command Bus、万能 product plugin 或依赖注入容器；
- 不删除 legacy purchase-count 数据；
- 不把延期客户端实测解释为官服行为证据。

## 12. 架构完成条件

- 8 个真实 single type 全部有 authoritative runtime；bulk 仍只允许 4/7；
- `220032` 不再零成本；
- 所有 purchase product 强制 period；
- Campaign-bound product 的 lineup 授权只能由 owner 在事务内裁决；
- single/bulk 使用同一 plan/owner；
- Equipment Enhancement route 内不再直接拥有购买事务或 Equipment 最终写；
- Special Exchange link 只能 listing/navigation；
- how-to-get 无全 Shop 扫描和逐候选 purchase-count N+1；
- generic 与特殊产品响应均为绝对后态；
- D16–D18b 资产边界无回归；
- 旧 facade/重复 route 分支和已批准 test debt 删除；
- Rush compatibility、General whitelist 和 Campaign Lineup 独立端点不因 catalog 迁移丢失；
- Payment、RewardGrant 与 Sold Mana 使用连续 Player after-state，不发生旧快照覆盖。
