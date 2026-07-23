# /latest/api/index.php/equipment/bulk_upgrade

一键觉醒（批量升级装备），CN 客户端通过装备列表「一键觉醒」按钮触发。

## Request
### Headers
```
Host: (server host)
Content-Type: application/x-www-form-urlencoded
PARAM: (session token)
SHORT_UDID: (device short udid)
APP_VER: (client version)
...
```

### Body
```json
{
  "equipment_ids": [5030037, 4030031],
  "viewer_id": 297417490,
  "api_count": 19
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `equipment_ids` | `int[]` | 要觉醒的装备 ID 列表 |
| `viewer_id` | `int` | 玩家 viewer_id |
| `api_count` | `int` | API 调用计数 |

> **注意**：客户端只传 `equipment_ids`，**不传** `upgrade_count` 和 `use_stack`。服务端自动计算每个装备的升级量。

## Response
```json
{
  "data_headers": {
    "servertime": 1752770286,
    "viewer_id": 297417490,
    "result_code": 1
  },
  "data": {
    "equipment_list": [
      {
        "null": 1,
        "viewer_id": 0,
        "equipment_id": 5030037,
        "protection": false,
        "level": 5,
        "enhancement_level": 0,
        "stack": 2
      }
    ],
    "item_list": {
      "100000": 1234,
      "5030037": 10
    },
    "mail_arrived": false
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `equipment_list` | `object[]` | 被觉醒的装备列表（`clientSerializeEquipment` 格式） |
| `item_list` | `Record<int, int>` | 更新的道具（锻造石余额 + 能力魂 ID × 数量） |
| `mail_arrived` | `bool` | 是否有新邮件 |

## 实现逻辑

### 自动计算升级量
```
upgradeCount = min(5 - equipment.level, equipment.stack)
```
跳过 `upgradeCount <= 0` 的装备（已满级或无 stack）。

### 消耗
- **锻造石**（item `100000`）：`awakening_craft_point[rarity] × upgradeCount`

### 获得
- 装备等级提升：`level += upgradeCount`
- Stack 减少：`stack -= upgradeCount`
- **能力魂**（item `equipmentId`）：`upgradeCount` 个

### 常量（来源：CDN `equipment_craft_point_exchange.json`）
| 稀有度 | awakening_craft_point |
|--------|---------------------|
| 1★ | 5 |
| 2★ | 10 |
| 3★ | 15 |
| 4★ | 20 |
| 5★ | 25 |

### 相关文件
- 实现：`src/routes/api/equipment.ts:337`
- 请求：CN 客户端 `EquipmentBulkUpgradeRealRemote.as`
- 离线逻辑：CN 客户端 `EquipmentBulkUpgradeDummyRemote.as`
