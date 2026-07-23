# 装备系统 API

## 模块架构

```
src/routes/api/
├── equipment.ts          # 觉醒 + 保护 (upgrade, bulk_upgrade, set_protection)
├── sell.ts               # 分解/出售 (sell_equipment, sell_stack, bulk_sell_stack)

src/lib/
├── equipment.ts          # clientSerializeEquipment, buildFullEquipmentList
├── equipment-dissolve.ts # calculateDissolveRewards() — 统一溶解奖励计算
├── validate/             # 存档校验系统（/load 时自动净化）
│   ├── index.ts          # runPermanentValidators() + 注册表
│   ├── types.ts          # SaveValidator + TemporalFilter 接口
│   └── max-level.ts      # 装备觉醒等级净化（level > CDN max_level → clamp）

src/data/domains/
├── equipment.ts          # DB CRUD (insert, update, delete, get)
├── party.ts              # countAbilitySoulUsedInPartiesSync() — 队伍魂珠引用统计

assets/
├── equipment_dissolve.json   # CDN提取：ability_soul_id, obtain_source, generate_ability_soul, max_level
├── item_sale.json            # CDN提取：sale_price, sellable, category
```

## 端点总览

| 端点 | 模块 | 操作 | 消耗 | 获得 |
|------|------|------|------|------|
| `/upgrade` | equipment.ts | 单件觉醒 | stack + 锻造石 + 道具 | level↑ + 能力魂 |
| `/bulk_upgrade` | equipment.ts | 一键觉醒 | stack + 锻造石 | level↑ + 能力魂 |
| `/set_protection` | equipment.ts | 装备锁 | 无 | 无 |
| `/sell_equipment` | sell.ts | 单件出售 | stack=0 | 锻造石 + 星之粒 + 能力魂 |
| `/sell_stack` | sell.ts | 部分出售 | stack-N | 锻造石 + 星之粒 + 能力魂 |
| `/bulk_sell_stack` | sell.ts | 一键分解 | stack=0 | 锻造石 + 星之粒 + 能力魂 |

## 核心设计

### 装备行永不删除

分解/出售操作使用 `UPDATE players_equipment SET stack=0`，而非 `DELETE`。装备行始终保留，确保队伍引用不悬空，避免 C2267 崩溃。

### 溶解奖励计算

统一由 `calculateDissolveRewards()` 处理（`src/lib/equipment-dissolve.ts`），三端点复用。所有数值来自 CDN `assets/equipment_craft.json` + `assets/equipment_dissolve.json`：

```
锻造石 = getEquipmentCraftSync(rarity).dissolve_craft × count
星之粒 = (obtain_source == 0) ? getEquipmentCraftSync(rarity).dissolve_star × count : 0
能力魂 = (generate_ability_soul) ? { ability_soul_id: count } : {}
```

### CDN 数据校验

| 字段 | 来源 | 说明 |
|------|------|------|
| `ability_soul_id` | `assets/equipment_dissolve.json` | 魂珠 item ID |
| `obtain_source` | `assets/equipment_dissolve.json` | 仅 source=0 得星之粒 |
| `generate_ability_soul` | `assets/equipment_dissolve.json` | 仅 true 得能力魂 |
| `dissolve_craft` | `assets/equipment_craft.json` | 每级溶解锻造石 |
| `dissolve_star` | `assets/equipment_craft.json` | 每级溶解星之粒 |
| `awakening_craft` | `assets/equipment_craft.json` | 每级觉醒锻造石消耗 |

影响范围：
- `obtain_source ≠ 0`：366 件装备分解无星之粒
- `generate_ability_soul = false`：15 件装备分解/觉醒无能力魂

### 觉醒锻造石费用（来自 CDN）

| 稀有度 | 1★ | 2★ | 3★ | 4★ | 5★ |
|--------|----|----|----|----|----|
| 每级 | 5 | 10 | 15 | 20 | 25 |

## 出售端点详情

### `/sell_equipment` — 单件出售

```json
// Request
{ "equipment_list": [{ "equipment_id": 4010003 }], "viewer_id": 1, "api_count": 1 }

// Response
{
  "data": {
    "equipment_list": [ { "equipment_id": 4010003, "stack": 0, ... } ],
    "item_list": { "100000": 4, "990008": 0, "4010003": 1 },
    "mail_arrived": false
  }
}
```

特性：能力魂固定 1 个（非 stack 倍率），`equipment_list` 为全量快照。

### `/sell_stack` — 部分出售

```json
// Request
{ "equipment_list": [{ "equipment_id": 4010003, "number": 2 }], "viewer_id": 1, "api_count": 2 }
```

特性：按 `number` 扣除 stack，`equipment_list` 为全量快照。

### `/bulk_sell_stack` — 一键分解

```json
// Request
{ "equipment_ids": [3030021, 4030001], "viewer_id": 1, "api_count": 3 }
```

特性：批量操作，`equipment_list` 为全量快照。per-equipment 日志见 `[BULK_SELL]`。

## 觉醒端点详情

### `/upgrade` — 单件觉醒

```json
// Request
{ "equipment_id": 3010007, "upgrade_count": 2, "use_stack": true, "viewer_id": 1, "api_count": 4 }
```

特性：`use_stack=true` 消耗 stack 支付，`false` 消耗 item_id 支付。能力魂按 upgradeCount 发放（CDN 检查）。

### `/bulk_upgrade` — 一键觉醒

```json
// Request
{ "equipment_ids": [3010007, 4010003], "viewer_id": 1, "api_count": 5 }
```

特性：自动计算最大可升级数 `min(5 - level, stack)`，批量扣除锻造石。

## 物品出售（魂珠）

### `/item/sell`

```json
// Request
{ "item_id": 3010007, "sell_number": 5, "viewer_id": 1, "api_count": 6 }

// Response
{
  "data": {
    "item_list": { "3010007": 15 },
    "user_info": { "free_mana": 987969 },
    "mail_arrived": false
  }
}
```

**服务端校验**：
1. CDN `sellable=true` 才可出售
2. `category=5`（魂珠）会检查队伍引用：`sell_number ≤ owned - usedInParties`
3. 玛娜不超过 `max_mana` 上限

实现：`src/lib/item-sell.ts` → `sellItemSync()`

## 存档校验（Save Validator）

`/load` 时自动运行永久净化器，修复非法数据：

```
/load → runPermanentValidators(playerId)
  └── MaxLevelValidator: level > CDN.max_level → UPDATE level = max_level
```

| 验证器 | 类型 | 说明 |
|--------|:---:|------|
| `max-level` | 永久 | 装备 `level > CDN max_level` 自动回退 |
| (预留) 编队引用 | 永久 | `character/equipment/ability_soul` 不存在时置 null |
| (预留) EX 净化 | 暂时 | 未到开放时间的 EX 过滤输出（不改 DB） |

**永久净化**写 DB，不可恢复。**暂时净化**（`TemporalFilter`）只过滤输出，时间到自动恢复。

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/routes/api/equipment.ts` | 觉醒 + 保护 |
| `src/routes/api/sell.ts` | 分解/出售 |
| `src/routes/api/item.ts` | `/item/sell` 魂珠出售 |
| `src/lib/equipment.ts` | `buildFullEquipmentList()` 全量装备列表 |
| `src/lib/equipment-dissolve.ts` | 溶解奖励计算 + CDN 校验 |
| `src/lib/item-sell.ts` | 魂珠出售逻辑 |
| `src/lib/validate/` | 存档校验系统（/load 自动净化） |
| `scripts/gen_cdn_data.ts` | CDN 数据提取 |
| `assets/equipment_dissolve.json` | 装备溶解 CDN 数据（含 max_level） |
| `assets/item_sale.json` | 道具售价 CDN 数据 |
| `assets/equipment_craft.json` | 锻造/溶解/觉醒常量（按稀有度） |
