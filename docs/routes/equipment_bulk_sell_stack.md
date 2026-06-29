# /latest/api/index.php/equipment/bulk_sell_stack

一键分解（批量出售装备全部 stack），CN 客户端通过装备列表「一键分解」按钮触发。
装备 stack 清零（保留装备行），获得锻造石 + 星之粒 + 能力魂。

## Request

```json
{ "equipment_ids": [3030021, 4030001], "viewer_id": 297417490, "api_count": 19 }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `equipment_ids` | `int[]` | 要分解的装备 ID 列表 |
| `viewer_id` | `int` | 玩家 viewer_id |
| `api_count` | `int` | API 调用计数 |

## Response

```json
{
  "data_headers": { "servertime": 1752772027, "viewer_id": 297417490, "result_code": 1 },
  "data": {
    "equipment_list": [
      { "equipment_id": 1030031, "protection": false, "level": 1, "enhancement_level": 0, "stack": 3 }
    ],
    "item_list": { "100000": 1280, "990008": 42, "3030021": 8, "4030001": 6 },
    "mail_arrived": false
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `equipment_list` | `object[]` | 分解后**全部剩余**装备快照（被分解的 stack=0，行仍保留） |
| `item_list` | `Record<int, int>` | 更新的物品：`100000`（锻造石）、`990008`（星之粒）、魂珠 ID（能力魂） |

## 实现逻辑

### 奖励计算（CDN 校验）

```typescript
calculateDissolveRewards(equipmentId, stack) → { craftPoints, starGrains, abilitySouls }
```

| 奖励 | 条件 | 公式 |
|------|------|------|
| 锻造石 | 总是 | `getEquipmentCraftSync(rarity).dissolve_craft × stack` |
| 星之粒 | `obtain_source == 0` | `getEquipmentCraftSync(rarity).dissolve_star × stack` |
| 能力魂 | `generate_ability_soul == true` | `{ ability_soul_id: stack }` |

### 操作

1. Phase 1: 累加所有装备的奖励（CDN 数据查询）
2. Phase 2: `UPDATE stack = 0`（保留装备行，避免 C2267 队伍悬空引用）
3. 发放锻造石、星之粒、能力魂
4. 获取全部剩余装备 → 完整快照返回

### 常量（来源：CDN `assets/equipment_craft.json`）

| 稀有度 | dissolve_craft | dissolve_star | awakening_craft |
|--------|:---:|:---:|:---:|
| 1★ | 1 | 0 | 5 |
| 2★ | 2 | 0 | 10 |
| 3★ | 3 | 1 | 15 |
| 4★ | 4 | 5 | 20 |
| 5★ | 5 | 15 | 25 |

- `craft_point_item_id`: 来自 `getConfigSync()` CDN config
- `star_grain_item_id`: 来自 `getConfigSync()` CDN config

### 相关文件

- 实现：`src/routes/api/sell.ts`
- 奖励计算：`src/lib/equipment-dissolve.ts` + `src/lib/equipment-dissolve.ts`
- CDN 数据：`assets/equipment_dissolve.json` + `assets/equipment_craft.json`
- 客户端：`EquipmentBulkSellStackRealRemote.as` / `EquipmentBulkSellStackDummyRemote.as`
