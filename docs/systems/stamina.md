# 体力系统(Stamina)
> 状态: 已实现   关键文件: assets/config.json, assets/quest_entry_costs.json, src/lib/stamina.ts, assets/cdndata/player_rank_full.json   相关端点: /shop/recover_stamina, /item/use_item

本文档描述体力系统(2026-06-25 updated)的实现:恢复/消耗流程、体力配置、关卡进入消耗、道具使用、等级提升、遗留问题,以及关卡进入消耗 key 格式。

## Stamina system (2026-06-25)

### Max stamina by degree (2026-06-25)
`assets/cdndata/player_rank_full.json` — 完整 0–250 级表，每级包含 `[maxStamina, total_rp_threshold, heal_rate]`。

- **0～100 级**：用户实测数据（101 个点）
- **101～250 级**：CDN `player_rank.json`（150 个点）
- `getMaxStamina(degreeId)` 查表获取等级体力上限
- `getRankDegree(rankPoint)` 二分搜索获取当前等级
- 升级时体力回满 = `getMaxStamina(newDegreeId)`
- 溢出上限固定 999（道具/星导石恢复的硬上限）

#### heal_rate 未对齐（2026-06-25）
CDN 中 heal_rate 用于客户端计算显示恢复速度（公式：`300 × (1 - heal_rate)` 秒/点）。当前服务端采用**预计算模式**：`computeRealTimeStamina()` 用 `Date.now()` 真实时间 + 固定 300 秒/点计算恢复量，并在 `/load`/`start`/`finish` 响应中发送计算结果 + 当前 `stamina_heal_time`，强制客户端显示服务端计算的值。

**与官方的差异**：
- 官方让客户端自行用 heal_rate 计算恢复 → `stamina_heal_time` 发 DB 旧时间
- 我们预计算后发送 → `stamina_heal_time` 发当前时间，客户端 elapsed≈0
- 1～100 级 heal_rate 目前全部填 `0.0`（不影响显示，服务端预计算覆盖）

未来若改为官方模式，需要补全 1～100 级每级的真实 heal_rate 值。

### Recovery/consumption flow
Stamina is stored as `players.stamina` + `players.stamina_heal_time`. Server computes real-time recovery using `Date.now()`, but sends `stamina_heal_time: getServerTime()` to the client so client-side calculation yields `elapsed=0` and displays the server-computed value directly.

### Fix: real-time recovery on /load (2026-06-25)
Previously `/load` sent the raw DB `stamina` value without computing elapsed recovery, causing all offline stamina regen to be lost. Now `src/lib/stamina.ts:computeRealTimeStamina()` is called in `/load` (`src/data/utils.ts`) before building the response, and the computed value is persisted back to DB.

### Rank level-up system (2026-06-25)
- `degreeId` was previously never updated from `rankPoint` (stuck at 1). Now `getRankDegree(rankPoint)` queries `assets/cdndata/player_rank.json` to find the appropriate degree ID at `/finish`.
- On level up, stamina is refilled to 999 (max overflow).
- Multi battle: stamina deduction and level-up NOT implemented yet — deferred until co-op system is stable.

Affected endpoints and their response `stamina_heal_time` format:
| Endpoint | Format |
|----------|--------|
| `/load` | `computeRealTimeStamina()` + `getServerTime()` (virtual) |
| `/single_battle_quest/start` | `computeRealTimeStamina()` → deduction + `getServerTime()` (virtual) |
| `/single_battle_quest/finish` | `computeRealTimeStamina()` + `getServerTime()` (virtual) + degree update |
| `/shop/recover_stamina` | `getServerTime()` (virtual) |
| `/item/use_item` | `getServerTime()` (virtual) |

### Stamina config
`assets/config.json` — 51 config values, currently hardcoded (CDN binary `master/config/config.orderedmap` not extractable — salt `K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy` hash doesn't match entity list, likely CN/GF version uses different salt).

Key stamina config values:
- `stamina_recovery_seconds`: 300 (5 min/pt)
- `stamina_recovery_virtual_money`: 50 (stone cost)
- `stamina_recovery_value`: 100 (recovery amount)
- `max_stamina_overflow`: 999 (cap)
- Min stamina: 0, Max: 999 (overflow), Natural cap: rank-based

### Quest entry costs
`assets/quest_entry_costs.json` — CDN 原值（无折扣），`scripts/gen_entry_costs.js` 自动校准索引生成。2018 quests total, 1629 with stamina > 0。

### Stamina campaign discounts (2026-06-30)

**数据流**：
```
/startsingle_battle_quest
  → getStaminaCost(questKey)
    → getActiveCampaignRate(category, questId, getServerDate())
      → 遍历 stamina_campaign.json 453 条
        → quest_type 匹配 category
        → quest_ids 匹配 questId
        → serverDate 在 [start, end] 内
        → 多命中取 min(rate)
    → cost = max(1, floor(baseCost × rate))
  → 扣除 cost 体力
```

**关键文件**：

| 文件 | 作用 |
|------|------|
| `assets/stamina_campaign.json` | CN CDN 453 条 campaign，含 quest_type / quest_ids / start / end / rate |
| `lib/stamina-campaign.ts` | 加载 campaign 数据，quest_type 映射（20 种），时间有效性 + quest_id 匹配 |
| `lib/stamina-cost.ts` | `getStaminaCost()` 封装：baseCost 来自 `entry_costs.json`，rate 来自 campaign，折后 ≥ 1 |

**折扣率**：`stamina_consumption_rate`（0.25=1/4, 0.5=半价）。无匹配 → rate=1 → 原价。

### Item usage
New endpoint `/item/use_item` (`src/routes/api/item.ts`). Handles `StaminaFixed(2)` and `StaminaRate(3)` effect items. CDN item data extracted to `assets/item_data.json` (100 items with effect info). Response `item_list` uses `IntMap<int>` format (`{itemId: count}`).

### DB path fix
`src/data/index.ts` — replaced `process.cwd()` with `path.resolve(__dirname, "../../.database")`. DB always at `starpoint-cn/.database/wdfp_data.db` regardless of startup directory.

### Payment
`/payment/item_list` returns empty `[]` (IAP disabled). Leiting SDK payment flow cannot be completed without real Leiting store. Remaining payment endpoints (`/start`, `/finish`, `/report_purchase_result`, `/query_purcharge`) are stubs.

### Remaining issues
1. Config values from CDN binary — need to find correct salt/path for GF version
2. Mission system — 3 endpoints return empty (deferred)
3. Multi battle stamina deduction + level-up — deferred until co-op stable
4. Auto-repeat H400: 自动连战不检查体力，体力耗尽时客户端连续发 /start 被服务端 H400 拒绝 → 崩溃。需服务端对 `is_auto_start_mode=true` 返回非致命响应（待修复）

## Mission progress system (2026-06-25)

### Server-side computation
Mission progress is fully computed server-side in `get_mission_progress`, aligned with official behavior:
- **Degree missions** (8 rank growth): `progress = getRankDegree(rankPoint)`, target from CDN descriptions
- **Quest clear missions**: progress = count of `finished=true` quests in `players_quest_progress`
- **Stamina use missions**: progress = `players.total_stamina_used` (accumulated on `/start`)
- **Rank evaluation missions** (SS/S/A/B): progress = count of quests with matching `clear_rank`
- **Prefix matching**: covers all daily/event variants (`single_battle_play_2`, `single_battle_play_xm19`, etc.)

### Pattern coverage
| Category | Missions | Computable | Notes |
|----------|----------|------------|-------|
| Regular (1) | 120 | ~5 (quest clear + rank) | |
| Daily (2) | 656 | ~20 (quest clear + stamina) | Includes `_2`, `_3`, event-specific variants |
| Event (3) | 2512 | 0 | Event missions depend on CDN event table |
| Degree (5) | 1288 | 8 (rank growth) | Remaining 1280 are character/event-specific |
| Weekly (10) | 2 | 0 | |

### Known limitations
- **No daily reset**: `totalQuestClears` and `totalStaminaUsed` are absolute totals, not daily counters. Daily missions appear permanently completed after first login.
- **Event missions**: 4800+ event-specific missions cannot be computed without CDN event→quest mapping.
- **heal_rate**: 1-100 levels set to `0.0` (server pre-computes recovery, client-side rate unused).

## Quest entry cost key format
`quest_entry_costs.json` uses `{category}_{questId}` compound keys to avoid collisions between main story quests (category=1) and EX quests (category=4) that share the same questId (e.g., `1_1001001` = 0 stamina, `4_1001001` = 12 stamina).
