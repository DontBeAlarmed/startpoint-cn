# 体力系统(Stamina)
> 状态: 已实现   关键文件: assets/config.json, assets/quest_entry_costs.json, src/lib/stamina.ts, src/routes/api/shop.ts   相关端点: /shop/recover_stamina, /item/use_item

本文档描述体力系统(2026-06-25 updated)的实现:恢复/消耗流程、体力配置、关卡进入消耗、道具使用、等级提升、遗留问题,以及关卡进入消耗 key 格式。

## Stamina system (2026-06-25)

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
`assets/quest_entry_costs.json` — regenerated from CDN JSON with correct per-type stamina index:
- main/ex/boss/world_story_boss: `chapter[69]`
- advent: `chapter[75]`
- daily_week: `chapter[64]`
- daily_exp_mana: `chapter[65]`
- rush: `chapter[67]`
- tower_dungeon: `chapter[68]`
- solo_time_attack/hard_multi: `chapter[70]`
- 2018 quests total, 1629 with stamina > 0

### Item usage
New endpoint `/item/use_item` (`src/routes/api/item.ts`). Handles `StaminaFixed(2)` and `StaminaRate(3)` effect items. CDN item data extracted to `assets/item_data.json` (100 items with effect info). Response `item_list` uses `IntMap<int>` format (`{itemId: count}`).

### DB path fix
`src/data/index.ts` — replaced `process.cwd()` with `path.resolve(__dirname, "../../.database")`. DB always at `starpoint-cn/.database/wdfp_data.db` regardless of startup directory.

### Payment
`/payment/item_list` returns empty `[]` (IAP disabled). Leiting SDK payment flow cannot be completed without real Leiting store. Remaining payment endpoints (`/start`, `/finish`, `/report_purchase_result`, `/query_purcharge`) are stubs.

### Remaining issues
1. Config values from CDN binary — need to find correct salt/path for GF version
2. Mission system — 3 endpoints return empty (deferred)
3. Multi battle stamina deduction + level-up — deferred until co-op stable (see `multiBattleQuest.ts`)
4. `staminaHealTime` time base mismatch: DB uses `new Date()` (real time), response uses `getServerTime()` (virtual with offset). Invisible when `timeOffset=null`, but may show desync when server time is overridden via dashboard.

## Quest entry cost key format
`quest_entry_costs.json` uses `{category}_{questId}` compound keys to avoid collisions between main story quests (category=1) and EX quests (category=4) that share the same questId (e.g., `1_1001001` = 0 stamina, `4_1001001` = 12 stamina).
