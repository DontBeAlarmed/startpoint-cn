# /latest/api/index.php/expod/bulk_stack_to_exp

一键转换（批量将重复角色转换为经验池 + 星之粒），CN 客户端通过角色列表「一键转换」按钮触发。
筛选所有已达到最大突破且有多余 stack 的角色，将其全部 stack 转换。

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
  "viewer_id": 297417490,
  "api_count": 32
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `viewer_id` | `int` | 玩家 viewer_id |
| `api_count` | `int` | API 调用计数 |

> **注意**：请求体为空（只有标准字段），服务端自行遍历全部角色并筛选。

## Response
```json
{
  "data_headers": {
    "servertime": 1752772551,
    "viewer_id": 297417490,
    "result_code": 1
  },
  "data": {
    "character_list": [
      {
        "viewer_id": 297417490,
        "character_id": 141165,
        "stack": 0,
        "over_limit_step": 12,
        "exp": 5000,
        "exp_total": 5000,
        "create_time": 1752772000.0,
        "update_time": 1752772551.0,
        "join_time": 1752772000.0
      }
    ],
    "converted_exp_info": {
      "add_exp": 5500
    },
    "item_list": {
      "990008": 456
    },
    "user_info": {
      "exp_pool": 996014504,
      "exp_pooled_time": 1752772551.0
    },
    "mail_arrived": false
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `character_list` | `object[]` | **被转换的角色列表**（stack 已置 0） |
| `converted_exp_info.add_exp` | `int` | 总获得经验值 |
| `item_list` | `Record<int, int>` | 全部物品（含更新后的 `990008` 星之粒） |
| `user_info` | `object` | 玩家信息（`exp_pool` + `exp_pooled_time`） |
| `mail_arrived` | `bool` | 是否有新邮件 |

## 实现逻辑

### 筛选条件
```typescript
stack > 0 && overLimitStep >= characterMaxOverLimits[rarity]
```

### 转换公式
```
addExp       = rarityStackConvertExp[rarity]       × stack
addStarGrain = rarityStackConvertItemCount[rarity] × stack
```

### 操作
1. 遍历全部角色，筛选符合条件的
2. 每角色：stack → 0，累加 exp + starGrain
3. `updatePlayerSync` 增加经验池
4. `givePlayerItemSync` 发放星之粒（item `990008`）
5. 返回被修改的角色列表 + 全部物品

### 掉落常量（与单角色 `stack_to_exp` 共用）

| 稀有度 | 经验 | 星之粒 |
|--------|------|--------|
| 1★ | 500 | 2 |
| 2★ | 500 | 2 |
| 3★ | 500 | 2 |
| 4★ | 2000 | 10 |
| 5★ | 10000 | 30 |

### 突破上限 `characterMaxOverLimits`

| 稀有度 | 最大突破步数 |
|--------|------------|
| 1★ | 12 |
| 2★ | 10 |
| 3★ | 8 |
| 4★ | 6 |
| 5★ | 4 |

### 相关文件
- 实现：`src/routes/api/expod.ts:144`
- 上限常量：`src/routes/api/character.ts:41`
- 请求：CN 客户端 `ExpodBulkStackToExpRealRemote.as`
- 离线逻辑：CN 客户端 `ExpodBulkStackToExpDummyRemote.as`
