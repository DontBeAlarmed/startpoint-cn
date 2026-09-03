# D18b Item Overflow Disposition 与客户端 Toast

状态：生产实现与聚焦自动验证已完成，等待独立终审、服务重启和 CN 客户端实机验收。本文修订 D18 “所有 Item overflow 一律进入 Mail”的旧私服策略；D16 Inventory owner、D17 RewardGrant typed core 和 D18 capacity allocation 继续有效。

## 1. 目标

正向 Item grant 先由 Inventory 按 `max_count` 分配实际入包量，再按 Item Content 对真正的 overflow 作有限处置：

```text
sellable=true  -> 直接出售为 Mana
sellable=false -> 创建无限容量的 Item Mail
```

每个实际处置结果通过 CN 客户端已有的 `data.over_max` common response 字段发布，使客户端显示右上角 Overflow Toast。该结果只描述已经由 owner 提交的事实，不成为新的资产 owner。

## 2. 已确认事实

### 2.1 Item Content

CN `item.orderedmap` 的以下字段已经进入 `item_inventory_policy.json`：

| 字段 | 列 | 职责 |
|---|---:|---|
| `category` | 14 | Item 分类；category 6 具有 Mail 领取特殊行为 |
| `sale_price` | 16 | 每个 overflow Item 出售所得 Mana |
| `max_count` | 18 | Inventory 持有上限 |
| `sellable` | 21 | 是否允许出售；是 Mail/Sold disposition 的唯一出售资格 |

`sale_price > 0` 不等于允许出售。当前 CN Content 的 1284 个 Item 都有正数 sale price，其中 299 个仍为 `sellable=false`。

证据样本：

| Item | ID | category | sellable | sale price | 客户端/策略事实 |
|---|---:|---:|---:|---:|---|
| 火元素 | 1 | 2 | true | 5 | overflow 直接出售候选 |
| 雷元素 | 9 | 2 | true | 5 | 官服截图中 4 个出售为 20 Mana |
| 寄居蟹船长的银币 | 40090 | 6 | true | 3 | 官服截图中 48 个出售为 144 Mana |
| 人偶核心（代币扭蛋） | 30102 | 3 | false | 100 | 不得出售，overflow 进入 Mail |
| 人偶核心（交换用） | 60003 | 3 | true | 1 | 与 30102 同名但可出售，必须按 ID/Content 判断 |

`effect_kind`、名称、是否限时或正数 sale price 均不能替代 `sellable`。

### 2.2 CN 客户端 common response

每个成功 HTTP 响应的 `data.over_max` 是可选数组。客户端通用响应处理在 endpoint-specific success handler 之前解析它，并将每条记录转换为右上角 `ToastKind.Overflow`。

Item 使用的 wire process type：

| `process_type` | 客户端含义 | 必需字段 |
|---:|---|---|
| 1 | Mail | `item.item_id`、`item.number` |
| 2 | Sold | `item.item_id`、`item.number`、`amount_sold` |
| 3 | Discard | `item.item_id`、`item.number`；本 Gate 不产生 |

`mail_arrived` 只负责邮件到达状态，不能触发 Overflow Toast，也不能代替 `over_max`。

### 2.3 Mail 领取可达性

CN 客户端对普通 Item Mail 在容量不足时阻止领取。只有同时满足以下条件的 Item，客户端才允许在库存已满时继续发起 Mail receive：

```text
sellable=true
category=6
```

因此现有 Mail 的领取策略不能扩展为“所有 sellable Item Mail 在满仓时自动出售”。本 Gate 只为 category 6 的客户端可达路径增加部分入包、差值出售；其它 Item Mail 继续整封 exact claim，容量不足时保留未领取，`receive_all` 跳过。

## 3. 目标行为

### 3.1 服务端生成型正向奖励

Inventory 继续先计算：

```text
capacity = max(0, maxCount - beforeAmount)
acceptedAmount = min(requestedAmount, capacity)
overflowAmount = requestedAmount - acceptedAmount
afterAmount = beforeAmount + acceptedAmount
```

历史库存已超过 `max_count` 时容量为 0，但不倒扣历史数量。

若 `overflowAmount == 0`，不执行 disposition，也不产生 `over_max`。

若 `overflowAmount > 0`：

```text
sellable=true:
  soldMana = overflowAmount * salePrice
  Item Mail = 0
  disposition = Sold

sellable=false:
  soldMana = 0
  Item Mail = overflowAmount
  disposition = Mail
```

所有输入、乘法、求和与 owner after-state 必须保持非负 safe integer；非法 Content 或溢出在任何 disposition 写入前 fail closed。

### 3.2 自动出售 Mana

自动出售产生的 `soldMana` 交给现有 Mana capacity 规则：

```text
currentMana = freeMana + paidMana
capacityMana = max(0, maxMana - currentMana)
acceptedMana = min(soldMana, capacityMana)
overflowMana = soldMana - acceptedMana
```

- `acceptedMana` 立即增加 `free_mana` 和 `total_mana_obtained`；
- `overflowMana` 创建无限容量的 `FREE_MANA` Mail，创建时不增加 `total_mana_obtained`；
- Item 已经完成 Sold disposition，不再因 Mana overflow 创建 Item Mail；
- `over_max.amount_sold` 表示本次 Item 出售产生的完整 `soldMana`，不是仅立即入账的 `acceptedMana`。

这条链最多发生一次 Item -> Mana 转换，不形成 Item Mail/Mana Mail 的递归处置。

### 3.3 Mail 处置

邮箱不设置业务层条数上限，不删除最早邮件，不因 Item 是否可售而淘汰现有 Mail。

- 新生成的 `sellable=false` Item overflow 创建 Item Mail；
- 已存在的普通 Item Mail继续 exact claim；
- 普通 Item Mail 容量不足时保留，`receive_all` 跳过；
- category 6 且 sellable 的 Item Mail允许 accepted 入包、overflow 出售；
- 已存在的历史 sellable Item overflow Mail 不后台批量出售；
- 成功领取的 Mail 继续写 history 后物理删除。

## 4. Typed disposition

新增窄的无状态结果值，不把 Common Response 字段放进 Inventory 或 Mail owner：

```ts
type ItemOverflowDisposition =
    | Readonly<{
        kind: "mail"
        itemId: number
        overflowAmount: number
        mailIds: readonly number[]
      }>
    | Readonly<{
        kind: "sold"
        itemId: number
        overflowAmount: number
        soldMana: number
        acceptedMana: number
        overflowMana: number
        manaMailIds: readonly number[]
      }>
```

该值只携带已有 owner 结果：

- Inventory 拥有 accepted Item 与 `total_obtained`；
- Item Content 决定 sellability 与 sale price；
- Player/Mana adapter 拥有 Mana capacity 和累计量；
- Mail owner 创建 Item/FREE_MANA Mail；
- 来源 adapter 将 disposition 投影为 `data.over_max`。

不得从响应 DTO 反推或重新执行 disposition。

## 5. Common Response 投影

窄 projector 只接收已冻结的 disposition，不读数据库、Content、时间或事务状态。

Mail：

```json
{
  "process_type": 1,
  "item": {
    "item_id": 30102,
    "number": 20
  }
}
```

Sold：

```json
{
  "process_type": 2,
  "amount_sold": 60,
  "item": {
    "item_id": 1,
    "number": 12
  }
}
```

同一请求产生多个 disposition 时保持奖励执行顺序；同 Item 的多个结果不因投影而重复执行 Mail/Sold。没有 disposition 时 `over_max` 省略或为客户端等价的 `null`，不返回伪造空 Toast。

本 Gate 只建立 Item overflow 的窄 common-response slice，不提前统一 Character、Equipment、EXP、Star Crumb 或其它 D28 AcquisitionOutcome。

## 6. 事务顺序

来源继续拥有最外层事务：

```text
来源成本/状态前置写
  -> RewardGrant / Inventory capacity allocation
  -> Inventory flush
  -> Item disposition
       sellable=true  -> Mana capacity -> Player write -> optional FREE_MANA Mail
       sellable=false -> Item Mail
  -> 来源 receipt/history/progress
  -> commit
  -> response over_max projection
```

任一 Inventory、Mana、Mail、receipt、history、progress 或后置来源写失败，必须回滚本次 accepted Item、出售 Mana、Mail 和来源状态。Toast 只在事务成功后由响应发布。

## 7. 来源范围

凡已启用 D18 Item cap 的服务端生成型正向来源均使用同一 disposition：

- Single/Multi battle，包括 clear、S+、score、additional 与关联 Mission/Awake；
- Gacha、Box Gacha 和重复角色补偿 Item；
- Mission、Active Mission、Pass Card；
- Login、Gift、Scheduled；
- Shop/Exchange 的服务端防御性 overflow；
- Story、Raid、Event；
- Equipment、Item Use 与 Character Growth 的正向 Item grant。

Shop 正常客户端请求仍受客户端购买前上限约束；其服务端 disposition 是并发、旧状态或异常请求的防御边界，不构造官方客户端正常 overflow 场景。

Scheduled 的合法管理配置还要求 `trigger_threshold + grant_amount < inventory_cap <= max_count`，因此正常配置不会主动产生 overflow。该来源仍安装统一 policy，作为旧规则、跨进程并发或状态漂移的最终写入边界；测试不伪造违反配置约束的 Scheduled overflow。

## 8. 明确不实施

- 不建立 Mail 最大条数或淘汰队列；
- 不删除最早的有效未领取邮件；
- 不让 `sale_price > 0` 绕过 `sellable=false`；
- 不把普通 Item Mail 的客户端不可达满仓请求设计成 E2E；
- 不自动处理现有历史 sellable Item Mail；
- 不产生 `process_type=3` Discard；
- 不修改 deduct、restore、maintenance、save import 或战斗入口退款；
- 不提前实现完整 D28 Common Response projector；
- 不猜测官服邮箱容量、错误码或其它资产的 overflow 规则。

## 9. 测试与性能

测试服从 CN 客户端可达性，保留有限代表：

1. Box Gacha 的 sellable Item：部分 accepted、差值 Sold、数量守恒；
2. Single finish 的满仓 sellable Item：全部 Sold，与战斗状态同事务；
3. 一个真实 `sellable=false` Item（30102）：差值进入 Mail；
4. category 6 sellable Mail：可容纳部分入包、差值 Sold；
5. 普通 Item Mail：容量不足仍保留并由 `receive_all` 跳过；
6. sold Mana 接近 `max_mana`：部分入账、差值进入 FREE_MANA Mail；
7. disposition 后的来源故障：Item、Mana、Mail、history/progress 全回滚；
8. common response：Mail/Sold 精确字段、顺序、无 overflow 时无 Toast；
9. `total_obtained` 只增加 accepted Item，`total_mana_obtained` 只增加 accepted Mana。

不建立来源 × Item × 容量 × fault 的笛卡尔积。公共纯计划和事务测试证明过的组合，每类来源只保留一个客户端可达代表。

性能要求：

- 每个 distinct overflow Item 的 Content policy lookup 为 O(1)；
- 不逐 Item 回读完整 Player 或 Mail 列表；
- Mana 最终 Player update 按请求聚合，不按 Item N 次更新；
- Mail 写入只按实际 `sellable=false` Item 或 Mana overflow 数量线性增长；
- 无 overflow 时不新增 SQL、Mail 或 response allocation。

## 10. 退出条件

```text
D18B_DESIGN_STATUS: APPROVED
D18B_IMPLEMENTATION_STATUS: COMPLETE (focused verification passed; final review pending)
ITEM_OVERFLOW_DISPOSITION: ACTIVE_SELLABLE_SOLD_UNSELLABLE_MAIL
OVER_MAX_TOAST: ACTIVE_CN_COMMON_RESPONSE
MAIL_CAPACITY: PRIVATE_UNLIMITED
```

实现提交为 `52a16817`、`c0fd8f30`、`c1863a54`、`892824a2`、`a083e022` 与 `30afb2e6`。聚焦验证覆盖 pure disposition/projector、RewardGrant、Mail、Gift、Login、Mission、Raid、Single/Multi、数据库、规则、协议和活动；任务组的旧虚构 Item 夹具已换成真实 Content Item 或完整 Content overlay。Gate A broad 在 D18b 前已经唯一运行并闭环，本补丁按批准约束只运行受影响聚焦组和失败叶子，不重跑 broad。

剩余退出项是文档/卫生检查、独立 whole-range 审查、服务重启与 CN 客户端实机复测；自动验证不能替代 Toast、页面状态和重登体验。
