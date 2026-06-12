# 商店系统修复文档

本次修复解决了三个独立但相关的商店问题。

---

## 一、GeneralShop 进店 C8601 闪退

### 错误现象

进入游戏商店 → 报错 C8601（"指定的Key不存在。key=301132"）

### 根因

服务器 `shop/get_sales_list` 返回的商品 ID `301132` 在客户端 CDN 主数据二进制中不存在。

| 数据来源 | 版本 | 说明 |
|---------|------|------|
| `assets/general_shop.json`（服务器） | 含 275 条，84 条不在 CDN 中 | 来自 `wf-assets-cn` 1.4.54 |
| CDN 二进制 `upload/38/9ee6cc...`（客户端） | 版本 **1.4.48**，290 个条目 | 最后更新于 diff 1.4.47→1.4.48 |

**关键事实**：
- 该 CDN 二进制在 1.4.48 之后的 diff（1.4.48→1.4.49 ~ 1.4.53→1.4.54）中均未被更新
- 商品 301132 的 `availableFrom` 为 `2024-10-29`，而 CDN 二进制构建于 2024-08-01
- 客户端调用链：`ShopProductRepository/getProductsByRemoteResponse()` → `MasterBinaryMap/getIndex(301132)` → **key 不存在** → C8601

### 修复：CDN 白名单过滤

**原理**：解析 CDN 二进制文件（orderedmap 格式），提取其中已有的 270 个 GeneralShop 商品 ID，在 `/get_sales_list` 响应中过滤掉不在名单内的商品。

**文件变更**：

| 文件 | 变更 |
|------|------|
| `assets/cdn_general_shop_whitelist.json` | 新增，270 个有效商品 ID 的白名单 |
| `src/routes/api/shop.ts` | 在 `get_sales_list` 中，`ShopType.GENERAL (8)` 的商品若不在白名单则跳过 |

**CDN 二进制 orderedmap 格式解析**（供后续其他 shop type 参考）：

```
文件整体结构：
┌──────────────────────────────────────────────────┐
│ [4 bytes LE] header_compressed_size              │
│ [header_compressed_size bytes] zlib 压缩的 header │
│ [剩余字节] 每个 entry 的 value 数据               │
└──────────────────────────────────────────────────┘

Header 解压后（zlib.inflateSync）：
┌──────────────────────────────────────────────────┐
│ [4 bytes LE] entry_count                         │
│ [entry_count × 8 bytes] 交错存储：              │
│   key_end_pos[i] (4 bytes LE)  — key 字符串结束偏移│
│   value_end_pos[i] (4 bytes LE) — value 数据结束偏移│
│ [剩余字节] 无分隔符的 key 字符串拼接（UTF-8）      │
└──────────────────────────────────────────────────┘

Key 解析（getIntMap）：
  - key_end_pos 是累积偏移（差值编码）
  - key 为数字的 UTF-8 字符串（如 "100001"）
  - 通过 Std.parseInt() 转为整数
```

**过滤效果**：

| 统计 | 数量 |
|------|------|
| 白名单中的商品（可返回） | 191 |
| 被过滤的商品（不在 CDN） | 84 |
| 其中 2024-08-01 后添加 | 24（含 301132） |
| 其中 2024-08-01 前但不在此 CDN 二进制 | 60（310xxx 范围，来自后续版本数据） |

### 已知限制

- 白名单仅覆盖 **GeneralShop (type 8)**。BossCoin/Treasure/StarGrain/EventItem 未做 CDN 过滤
- 若客户端 CDN 版本更新，白名单需同步重建（运行解析脚本重新提取）

---

## 二、进游戏卡死 C8707

### 错误现象

游戏启动 → `/load` 返回后卡住 → 客户端 Beacon 日志反复打印：

```
ERR:C8707|data.user_character_mana_node_list[k][i]:302330201のデータが渡されましたが、Object型が期待されています。
```

### 根因

**两个问题叠加：**

**问题 1 — 数据库脏数据**：玩家 20（莫方）的角色 `151165` 被写入了 16 条无效的 mana_node 记录，`value` 为 `302330201`~`302330221`（不是合法的节点 ID，合法值应为 1、2 等小数字）。

**问题 2 — 序列化格式错误**：`/load` 端点中 `user_character_mana_node_list` 以扁平数字数组发送（`{ charId: [201, 202] }`），但客户端期望的是对象数组（`{ charId: [{ mana_node_multiplied_id: 201 }, { mana_node_multiplied_id: 202 }] }`）。

当节点列表为空数组 `[]` 时，客户端不检查元素类型，所以平时不报错。一旦有非空数组，客户端逐一校验元素，发现是数字而非 Object，抛出 C8707。

### 修复

| 组件 | 变更 |
|------|------|
| 数据库 | 删除 `players_characters_mana_nodes` 中 player=20, character=151165 的 16 条垃圾数据 |
| `src/data/types.ts` | `UserCharacterManaNodeList` 类型从 `Record<string, number[]>` 改为 `Record<string, { mana_node_multiplied_id: number }[]>` |
| `src/data/utils.ts` | `serializePlayerData()` 中包装 node ID 为 `{ mana_node_multiplied_id }` 对象 |
| `src/data/utils.ts` | `deserializePlayerData()` 中解包对象还原为内部 `number[]` 格式 |

**序列化代码**（`utils.ts:308`）：

```typescript
"user_character_mana_node_list": (() => {
    const list: Record<string, { mana_node_multiplied_id: number }[]> = {}
    for (const [charId, nodeIds] of Object.entries(toSerialize.characterManaNodeList)) {
        list[charId] = nodeIds.map(id => ({ mana_node_multiplied_id: id }))
    }
    return list
})(),
```

**反序列化代码**（`utils.ts:634`）：

```typescript
const rawCharacterManaNodeList = toDeserialize['user_character_mana_node_list']
const characterManaNodeList: Record<string, number[]> = {}
for (const [charId, nodes] of Object.entries(rawCharacterManaNodeList)) {
    characterManaNodeList[charId] = (nodes as { mana_node_multiplied_id: number }[]).map(n => n.mana_node_multiplied_id)
}
```

### 数据格式对照

| 场景 | 格式 |
|------|------|
| `/load` 响应（发给客户端） | `{ charId: [{ mana_node_multiplied_id: N }] }` |
| `/character/unlock` 响应 | `{ charId: [{ mana_node_multiplied_id: N }] }` |
| 数据库 `players_characters_mana_nodes.value` | 数字（如 `1`） |
| 内部 `MergedPlayerData.characterManaNodeList` | `Record<string, number[]>` |

---

## 三、Boss币商店内容为空

### 错误现象

进入 Boss币商店 → 不报错，但每个 boss 标签页均显示"无商品"

### 根因

**客户端请求的类别 ID 与服务器数据不匹配。**

客户端 CDN 主数据中的 `BossCoinShopCategory` 有 50 个类别（1-39、51-58、60-66、70-71）。但服务器 `assets/boss_coin_shop.json` 只有 27 个类别（1-33），缺失 34-39、51-58、60-66、70-71 共 21 个类别。

客户端进入每个 boss 标签页时，发送该页对应的 `boss_coin_shop_category_ids`（如 `[60]`、`[61]`），服务器 `getBossCoinShopItemsSync(categoryId)` 查不到数据，返回 `null` → `toParseShopItems` 中 BOSS_COIN 条目数为 0 → `sales_list` 为空。

**调试日志验证**：

```
[shop:req] viewer=9 types=[7] bossCats=[60] events=0
[shop:res] totalSales=0 byType={} toParseItems={"7":0}
```

`bossCats=[60]` — 客户端请求类别 60，但旧数据中无此类别。

### 修复：从 wf-assets-cn 重建 Boss 商店数据

**工具脚本**：`tools/rebuild_boss_coin_shop.ts`

**数据源**：`wf-assets-cn/orderedmap/shop/boss_coin_shop.json`（6566 条，原始格式为扁平数组）

**wf-assets-cn 原始格式**（每条是一个 50 元素的字符串数组）：

```
key = 商品 ID（如 "10000"）
value = [[
  [0] = category_id     [17] = cost_item_id   [25] = availableFrom
  [1] = sub_category     [18] = cost_amount    [26] = availableUntil
  [6] = item_name                             [27] = stock
  [12] = icon_path                             [32] = reward_type
  [13] = rarity                                [33] = reward_item_id
                                               [34] = reward_count
]]
```

**目标格式**（starpoint-cn 嵌套 JSON）：

```json
{
  "categoryId": {
    "itemId": {
      "costs": [{ "id": N, "amount": N }],
      "rewards": [{ "type": N, "id": N, "count": N }],
      "availableFrom": "YYYY-MM-DD HH:mm:ss",
      "availableUntil": "YYYY-MM-DD HH:mm:ss" | null,
      "stock": N
    }
  }
}
```

**脚本逻辑**：
1. 遍历 wf-assets-cn 全部 6566 条
2. 按 `[0]`（category_id）分组
3. 解析每个商品的 costs/rewards/dates
4. **保留已存在的商品**（星标-cn 中手动修改过的日期不被覆盖），仅新增不存在的
5. 输出 `boss_coin_shop.json` 和 `boss_coin_shop_item_category_map.json`

**处理结果**：

| 指标 | 旧值 | 新值 |
|------|------|------|
| 类别数 | 27 | 50 |
| 商品总数 | 4567 | 6132 |
| 新增类别 | — | 34-39, 51-58, 60-66, 70-71 |
| 现有类别新增商品 | — | 各 13-111 条 |

**注意**：新增商品使用 wf-assets-cn 的原始日期（多为 2025-06 至 2025-07），在当前服务器时间下均有效。如果未来服务器时间调整导致过期，需重新评估日期。

### 后续维护

**若客户端 CDN 版本更新导致新增更多类别**：
1. 检查日志中 `[shop:req]` 打印的 `bossCats` 是否包含未知 ID
2. 从最新 `wf-assets-cn/orderedmap/shop/boss_coin_shop.json` 重新运行 `tools/rebuild_boss_coin_shop.ts`
3. 验证新类别商品 `availableFrom` 是否在服务器时间范围内

**若需修改过期时间**：
- 直接编辑 `assets/boss_coin_shop.json` 中对应商品的 `availableUntil` 字段
- 设为 `null` 表示永久有效

---

## 相关文件索引

| 文件 | 用途 |
|------|------|
| `src/routes/api/shop.ts` | 商店 API 端点（含白名单过滤 + 调试日志） |
| `assets/cdn_general_shop_whitelist.json` | GeneralShop CDN 白名单（270 个 ID） |
| `assets/boss_coin_shop.json` | Boss 币商店商品数据（50 类别，6132 条） |
| `assets/boss_coin_shop_item_category_map.json` | Boss 币商品 → 类别映射 |
| `assets/general_shop.json` | 通用商店商品数据 |
| `src/data/utils.ts` | 玩家数据序列化（含 mana_node 格式修复） |
| `src/data/types.ts` | 数据类型定义 |
| `tools/rebuild_boss_coin_shop.ts` | Boss 币商店数据重建工具 |
| `docs/shop_fixes.md` | 本文档 |
