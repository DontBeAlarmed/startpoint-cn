# Mission Dimension Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production-safe slice of mission dimension progress: reusable counters, battle finish dimension writes, and daily battle mission evaluation with fallback.

**Architecture:** Add a small mission event and counter layer under `src/lib/mission`, double-write battle finish dimensions from existing single/multi finish routes, then let `RegularComputer` read supported daily battle dimensions from counters while preserving current DB/client fallback. Existing reward, stage, and active mission flows remain unchanged.

**Tech Stack:** TypeScript, Fastify route handlers, better-sqlite3, existing `ts-node/register` verification scripts, existing `npm run typecheck`.

---

## Scope

This plan implements Phases 1-4 from `docs/superpowers/specs/2026-07-05-mission-dimension-design.md` only where behavior can be kept safe:

- Counter infrastructure.
- Battle finish event shape and dimension writer.
- Single and multi battle double-write.
- Daily battle mission evaluator for safe dimensions.
- Awake counter shadowing and parity checks, without switching user-facing awake progress away from legacy sources.

This plan does not implement weekly rewards, achievement tasks, full event mission migration, or removal of legacy awake tracker tables. Those require a follow-up plan after this counter layer has runtime evidence.

## Existing Dirty Worktree Guard

Before executing any task, check `git status --short`. Do not stage or modify unrelated current work such as `src/routes/api/gacha.ts`, `src/lib/gacha-ticket.ts`, `scripts/test_gacha_ticket_mapping.js`, local backup JSON files, or local tool/decompile directories.

## File Structure

Create:

- `src/lib/mission/counters.ts`: counter key normalization, counter reads, additive writes, max writes, period snapshots.
- `src/lib/mission/events.ts`: mission progress event types and battle finish event extraction helpers.
- `src/lib/mission/battle-dimensions.ts`: converts `BattleFinishMissionEvent` into counter writes.
- `src/lib/mission/evaluator.ts`: maps supported mission definitions to counter queries.

Modify:

- `src/data/initializers/wdfpData.ts`: creates counter and counter snapshot tables.
- `src/lib/mission/index.ts`: exports new counter, event, dimension, and evaluator APIs.
- `src/routes/api/singleBattleQuest.ts`: double-writes battle dimensions after existing finish trackers are built.
- `src/multi/http/battle.ts`: double-writes battle dimensions after existing finish trackers are built.
- `src/routes/web_api/player.ts`: snapshots mission counters during daily and weekly reset endpoints.
- `src/lib/mission/computer-regular.ts`: reads supported daily battle dimensions from counters and falls back safely.
- `src/lib/mission/computer-awake.ts`: optionally builds counter values for parity, but keeps legacy progress authoritative.
- `docs/systems/mission-dimension-progress.md`: updates current coverage and remaining gaps.

---

### Task 1: Counter Storage And Domain Primitives

**Files:**
- Modify: `src/data/initializers/wdfpData.ts`
- Create: `src/lib/mission/counters.ts`
- Modify: `src/lib/mission/index.ts`

- [ ] **Step 1: Run the failing counter module check**

Run:

```powershell
node -r ts-node/register -e "require('./src/lib/mission/counters')"
```

Expected: FAIL with `Cannot find module './src/lib/mission/counters'`.

- [ ] **Step 2: Add counter tables**

In `src/data/initializers/wdfpData.ts`, add this block after the existing `players_active_missions_stages` table creation:

```ts
    database.prepare(`CREATE TABLE IF NOT EXISTS players_mission_counters (
        player_id INTEGER NOT NULL,
        counter_key TEXT NOT NULL,
        dimension TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        qualifier_json TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (player_id, counter_key),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_mission_counter_snapshots (
        player_id INTEGER NOT NULL,
        period_type TEXT NOT NULL,
        counter_key TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (player_id, period_type, counter_key),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
```

- [ ] **Step 3: Create `src/lib/mission/counters.ts`**

Create the file with this implementation:

```ts
import { getDb } from "../../data/db"

export type MissionCounterScopeType = "lifetime" | "event" | "character"
export type MissionCounterPeriod = "daily" | "weekly"
export type MissionCounterQualifierValue = string | number | boolean

export interface MissionCounterQuery {
    dimension: string
    scopeType: MissionCounterScopeType
    scopeKey: string
    qualifier?: Record<string, MissionCounterQualifierValue | null | undefined>
}

export interface MissionCounterRow extends MissionCounterQuery {
    counterKey: string
    qualifierJson: string
    value: number
}

export function normalizeMissionCounterQualifier(
    qualifier: Record<string, MissionCounterQualifierValue | null | undefined> = {}
): Record<string, MissionCounterQualifierValue> {
    const normalized: Record<string, MissionCounterQualifierValue> = {}
    for (const key of Object.keys(qualifier).sort()) {
        const value = qualifier[key]
        if (value === null || value === undefined || value === "(None)" || value === "") continue
        normalized[key] = value
    }
    return normalized
}

export function serializeMissionCounterQualifier(
    qualifier: Record<string, MissionCounterQualifierValue | null | undefined> = {}
): string {
    return JSON.stringify(normalizeMissionCounterQualifier(qualifier))
}

export function makeMissionCounterKey(query: MissionCounterQuery): string {
    return [
        query.dimension,
        query.scopeType,
        query.scopeKey,
        serializeMissionCounterQualifier(query.qualifier),
    ].join("|")
}

function nowSql(): string {
    return new Date().toISOString()
}

export function addMissionCounterSync(playerId: number, query: MissionCounterQuery, amount: number = 1): number {
    if (amount <= 0) return getMissionCounterValueSync(playerId, query)
    const counterKey = makeMissionCounterKey(query)
    const qualifierJson = serializeMissionCounterQualifier(query.qualifier)
    getDb().prepare(`
    INSERT INTO players_mission_counters
        (player_id, counter_key, dimension, scope_type, scope_key, qualifier_json, value, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, counter_key) DO UPDATE SET
        value = value + excluded.value,
        updated_at = excluded.updated_at
    `).run(playerId, counterKey, query.dimension, query.scopeType, query.scopeKey, qualifierJson, amount, nowSql())
    return getMissionCounterValueSync(playerId, query)
}

export function setMissionCounterMaxSync(playerId: number, query: MissionCounterQuery, value: number): number {
    const counterKey = makeMissionCounterKey(query)
    const qualifierJson = serializeMissionCounterQualifier(query.qualifier)
    getDb().prepare(`
    INSERT INTO players_mission_counters
        (player_id, counter_key, dimension, scope_type, scope_key, qualifier_json, value, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, counter_key) DO UPDATE SET
        value = MAX(value, excluded.value),
        updated_at = excluded.updated_at
    `).run(playerId, counterKey, query.dimension, query.scopeType, query.scopeKey, qualifierJson, value, nowSql())
    return getMissionCounterValueSync(playerId, query)
}

export function getMissionCounterValueSync(playerId: number, query: MissionCounterQuery): number {
    const counterKey = makeMissionCounterKey(query)
    const row = getDb().prepare(`
    SELECT value FROM players_mission_counters
    WHERE player_id = ? AND counter_key = ?
    `).get(playerId, counterKey) as { value: number } | undefined
    return row?.value ?? 0
}

export function getMissionCounterSnapshotValueSync(playerId: number, periodType: MissionCounterPeriod, query: MissionCounterQuery): number {
    const counterKey = makeMissionCounterKey(query)
    const row = getDb().prepare(`
    SELECT value FROM players_mission_counter_snapshots
    WHERE player_id = ? AND period_type = ? AND counter_key = ?
    `).get(playerId, periodType, counterKey) as { value: number } | undefined
    return row?.value ?? 0
}

export function getMissionCounterDeltaSync(playerId: number, periodType: MissionCounterPeriod, query: MissionCounterQuery): number {
    const current = getMissionCounterValueSync(playerId, query)
    const snapshot = getMissionCounterSnapshotValueSync(playerId, periodType, query)
    return Math.max(0, current - snapshot)
}

export function snapshotAllMissionCountersSync(playerId: number, periodType: MissionCounterPeriod): number {
    const rows = getDb().prepare(`
    SELECT counter_key, value FROM players_mission_counters
    WHERE player_id = ?
    `).all(playerId) as { counter_key: string; value: number }[]

    const insert = getDb().prepare(`
    INSERT INTO players_mission_counter_snapshots
        (player_id, period_type, counter_key, value, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_id, period_type, counter_key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)

    const timestamp = nowSql()
    const tx = getDb().transaction(() => {
        for (const row of rows) insert.run(playerId, periodType, row.counter_key, row.value, timestamp)
    })
    tx()
    return rows.length
}
```

- [ ] **Step 4: Export counter APIs**

In `src/lib/mission/index.ts`, add:

```ts
export type {
    MissionCounterPeriod,
    MissionCounterQualifierValue,
    MissionCounterQuery,
    MissionCounterRow,
    MissionCounterScopeType,
} from "./counters"
export {
    addMissionCounterSync,
    getMissionCounterDeltaSync,
    getMissionCounterSnapshotValueSync,
    getMissionCounterValueSync,
    makeMissionCounterKey,
    normalizeMissionCounterQualifier,
    serializeMissionCounterQualifier,
    setMissionCounterMaxSync,
    snapshotAllMissionCountersSync,
} from "./counters"
```

- [ ] **Step 5: Verify key stability and table creation**

Run:

```powershell
node -r ts-node/register -e "const {makeMissionCounterKey}=require('./src/lib/mission/counters'); const a=makeMissionCounterKey({dimension:'battle.clear',scopeType:'lifetime',scopeKey:'all',qualifier:{mode:'multi',questId:1}}); const b=makeMissionCounterKey({dimension:'battle.clear',scopeType:'lifetime',scopeKey:'all',qualifier:{questId:1,mode:'multi'}}); if(a!==b) throw new Error(a+' !== '+b); console.log(a)"
```

Expected: PASS and prints `battle.clear|lifetime|all|{"mode":"multi","questId":1}`.

Run:

```powershell
node -r ts-node/register -e "const {getDb}=require('./src/data/db'); const rows=getDb().prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('players_mission_counters','players_mission_counter_snapshots') ORDER BY name\").all(); console.log(rows.map(r=>r.name).join(',')); if(rows.length!==2) throw new Error('missing counter tables')"
```

Expected: PASS and prints `players_mission_counter_snapshots,players_mission_counters`.

- [ ] **Step 6: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/data/initializers/wdfpData.ts src/lib/mission/counters.ts src/lib/mission/index.ts
git commit -m "feat: add mission counter storage"
```

Expected: commit succeeds and does not include unrelated gacha or local tool files.

---

### Task 2: Battle Mission Events And Dimension Writer

**Files:**
- Create: `src/lib/mission/events.ts`
- Create: `src/lib/mission/battle-dimensions.ts`
- Modify: `src/lib/mission/index.ts`

- [ ] **Step 1: Run the failing event module check**

Run:

```powershell
node -r ts-node/register -e "require('./src/lib/mission/events'); require('./src/lib/mission/battle-dimensions')"
```

Expected: FAIL with missing module error.

- [ ] **Step 2: Create `src/lib/mission/events.ts`**

Create:

```ts
export interface BattleStatisticsSummary {
    dashCount: number
    powerFlipCount: number
    skillCount: number
    maxComboCount: number
    clearPhase?: number
}

export interface BattleFinishMissionEvent {
    type: "battle_finish"
    playerId: number
    questCategory: number
    questId: number
    accomplished: boolean
    mode: "single" | "multi"
    role?: "host" | "guest"
    clearRank?: number | null
    clearTimeMs: number
    partyCharacterIds: number[]
    leaderCharacterId?: number
    unisonCharacterIds: number[]
    statistics: BattleStatisticsSummary
    eventId?: number
}

export type MissionProgressEvent = BattleFinishMissionEvent

export function summarizeBattleStatistics(raw: any): BattleStatisticsSummary {
    const zones = Array.isArray(raw?.zones) ? raw.zones : []
    let dashCount = 0
    let powerFlipCount = 0
    for (const zone of zones) {
        dashCount += Number(zone?.use_dash_count ?? 0)
        powerFlipCount += Number(zone?.use_power_flip_count ?? 0)
    }
    return {
        dashCount,
        powerFlipCount,
        skillCount: Number(raw?.use_skill_count ?? raw?.skill_count ?? 0),
        maxComboCount: Number(raw?.max_combo_count ?? 0),
        clearPhase: raw?.clear_phase === undefined ? undefined : Number(raw.clear_phase),
    }
}

export function collectPartyCharacterIds(party: any): { partyCharacterIds: number[]; leaderCharacterId?: number; unisonCharacterIds: number[] } {
    const characters = Array.isArray(party?.characters) ? party.characters : []
    const unisons = Array.isArray(party?.unison_characters) ? party.unison_characters : []
    const partyCharacterIds = characters.map((c: any) => Number(c?.id ?? 0)).filter((id: number) => id > 0)
    const unisonCharacterIds = unisons.map((c: any) => Number(c?.id ?? 0)).filter((id: number) => id > 0)
    const leaderCharacterId = partyCharacterIds[0]
    return { partyCharacterIds, leaderCharacterId, unisonCharacterIds }
}
```

- [ ] **Step 3: Create `src/lib/mission/battle-dimensions.ts`**

Create:

```ts
import { getCharacterRaces, getRaceKeyString } from "../quest/finish/race-utils"
import { addMissionCounterSync, setMissionCounterMaxSync } from "./counters"
import type { BattleFinishMissionEvent } from "./events"
import type { MissionCounterQuery } from "./counters"

function add(playerId: number, query: MissionCounterQuery, amount: number = 1): void {
    addMissionCounterSync(playerId, query, amount)
}

function recordCharacterCounters(event: BattleFinishMissionEvent): void {
    const allCharacters = [...new Set([...event.partyCharacterIds, ...event.unisonCharacterIds])]
    for (const characterId of allCharacters) {
        add(event.playerId, {
            dimension: "character.battle_clear",
            scopeType: "character",
            scopeKey: String(characterId),
            qualifier: { position: "any" },
        })
    }

    if (event.leaderCharacterId) {
        add(event.playerId, {
            dimension: "character.battle_clear",
            scopeType: "character",
            scopeKey: String(event.leaderCharacterId),
            qualifier: { position: "leader" },
        })
    }

    const sortedCharacters = [...allCharacters].sort((a, b) => a - b)
    for (let i = 0; i < sortedCharacters.length - 1; i++) {
        for (let j = i + 1; j < sortedCharacters.length; j++) {
            add(event.playerId, {
                dimension: "character.co_clear",
                scopeType: "lifetime",
                scopeKey: "all",
                qualifier: { characters: `${sortedCharacters[i]},${sortedCharacters[j]}` },
            })
        }
    }

    const races = sortedCharacters.flatMap(characterId => getCharacterRaces(characterId))
    const raceKey = getRaceKeyString(races)
    if (raceKey) {
        add(event.playerId, {
            dimension: "character.race_clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { raceKey },
        })
    }
}

export function recordBattleMissionDimensions(event: BattleFinishMissionEvent): void {
    if (!event.accomplished) return

    add(event.playerId, {
        dimension: "battle.clear",
        scopeType: "lifetime",
        scopeKey: "all",
        qualifier: { mode: "any" },
    })
    add(event.playerId, {
        dimension: "battle.clear",
        scopeType: "lifetime",
        scopeKey: "all",
        qualifier: { mode: event.mode },
    })
    add(event.playerId, {
        dimension: "battle.quest_clear",
        scopeType: "lifetime",
        scopeKey: "all",
        qualifier: { questCategory: event.questCategory, questId: event.questId, mode: "any" },
    })
    add(event.playerId, {
        dimension: "battle.quest_clear",
        scopeType: "lifetime",
        scopeKey: "all",
        qualifier: { questCategory: event.questCategory, questId: event.questId, mode: event.mode },
    })

    if (event.clearRank !== null && event.clearRank !== undefined) {
        add(event.playerId, {
            dimension: "battle.rank_clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { rank: event.clearRank },
        })
    }

    if (event.statistics.clearPhase !== undefined) {
        add(event.playerId, {
            dimension: "battle.phase_clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { phase: event.statistics.clearPhase },
        })
    }

    if (event.statistics.dashCount > 0) {
        add(event.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "dash" },
        }, event.statistics.dashCount)
    }
    if (event.statistics.powerFlipCount > 0) {
        add(event.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "power_flip" },
        }, event.statistics.powerFlipCount)
    }
    if (event.statistics.skillCount > 0) {
        add(event.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "skill" },
        }, event.statistics.skillCount)
    }
    if (event.statistics.maxComboCount > 0) {
        setMissionCounterMaxSync(event.playerId, {
            dimension: "battle.max_combo",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: {},
        }, event.statistics.maxComboCount)
    }

    recordCharacterCounters(event)
}
```

- [ ] **Step 4: Export event and dimension APIs**

In `src/lib/mission/index.ts`, add:

```ts
export type { BattleFinishMissionEvent, BattleStatisticsSummary, MissionProgressEvent } from "./events"
export { collectPartyCharacterIds, summarizeBattleStatistics } from "./events"
export { recordBattleMissionDimensions } from "./battle-dimensions"
```

- [ ] **Step 5: Verify event writer through rollback**

Run:

```powershell
node -r ts-node/register -e "const {getDb}=require('./src/data/db'); const {recordBattleMissionDimensions,getMissionCounterValueSync}=require('./src/lib/mission'); const player=getDb().prepare('SELECT id FROM players LIMIT 1').get(); if(!player) throw new Error('no player row'); const event={type:'battle_finish',playerId:player.id,questCategory:2,questId:101,accomplished:true,mode:'multi',clearRank:5,clearTimeMs:1000,partyCharacterIds:[111001,111002],leaderCharacterId:111001,unisonCharacterIds:[211001],statistics:{dashCount:2,powerFlipCount:1,skillCount:3,maxComboCount:44,clearPhase:2}}; const tx=getDb().transaction(()=>{recordBattleMissionDimensions(event); const multi=getMissionCounterValueSync(player.id,{dimension:'battle.clear',scopeType:'lifetime',scopeKey:'all',qualifier:{mode:'multi'}}); const dash=getMissionCounterValueSync(player.id,{dimension:'battle.stat',scopeType:'lifetime',scopeKey:'all',qualifier:{kind:'dash'}}); const leader=getMissionCounterValueSync(player.id,{dimension:'character.battle_clear',scopeType:'character',scopeKey:'111001',qualifier:{position:'leader'}}); if(multi!==1||dash!==2||leader!==1) throw new Error(JSON.stringify({multi,dash,leader})); throw new Error('ROLLBACK_OK')}); try{tx()}catch(e){if(e.message!=='ROLLBACK_OK') throw e}; console.log('battle dimension writer ok')"
```

Expected: PASS and prints `battle dimension writer ok`.

- [ ] **Step 6: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/lib/mission/events.ts src/lib/mission/battle-dimensions.ts src/lib/mission/index.ts
git commit -m "feat: add battle mission dimensions"
```

Expected: commit succeeds and only includes mission files.

---

### Task 3: Double-Write Battle Finish Dimensions

**Files:**
- Modify: `src/routes/api/singleBattleQuest.ts`
- Modify: `src/multi/http/battle.ts`

- [ ] **Step 1: Add imports to single battle finish route**

In `src/routes/api/singleBattleQuest.ts`, add these imports near existing mission tracker imports:

```ts
import { collectPartyCharacterIds, recordBattleMissionDimensions, summarizeBattleStatistics } from "../../lib/mission"
```

- [ ] **Step 2: Double-write single battle finish event**

In `src/routes/api/singleBattleQuest.ts`, after the existing calls to `trackCharacterClears(finishCtx)`, `trackLeaderPowerflip(finishCtx)`, `trackPartyCoClears(finishCtx)`, and `trackPowerflip(finishCtx)`, add:

```ts
        const singleBattleParty = collectPartyCharacterIds(finishCtx.party)
        recordBattleMissionDimensions({
            type: "battle_finish",
            playerId,
            questCategory,
            questId,
            accomplished: questAccomplished,
            mode: "single",
            clearRank,
            clearTimeMs: clearTime,
            ...singleBattleParty,
            statistics: summarizeBattleStatistics(finishCtx.statistics),
            eventId: questData.eventId,
        })
```

- [ ] **Step 3: Add imports to multi battle finish route**

In `src/multi/http/battle.ts`, add:

```ts
import { collectPartyCharacterIds, recordBattleMissionDimensions, summarizeBattleStatistics } from "../../lib/mission";
```

- [ ] **Step 4: Double-write multi battle finish event**

In `src/multi/http/battle.ts`, after the existing calls to `trackCharacterClears(finishCtx)`, `trackLeaderPowerflip(finishCtx)`, `trackPartyCoClears(finishCtx)`, and `trackPowerflip(finishCtx)`, add:

```ts
        const multiBattleParty = collectPartyCharacterIds(finishCtx.party)
        recordBattleMissionDimensions({
            type: "battle_finish",
            playerId,
            questCategory,
            questId,
            accomplished: questAccomplished,
            mode: "multi",
            role: activeQuestData.roomNumber ? "host" : undefined,
            clearRank,
            clearTimeMs: clearTime,
            ...multiBattleParty,
            statistics: summarizeBattleStatistics(finishCtx.statistics),
            eventId: (questData as any).eventId,
        })
```

- [ ] **Step 5: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Run illegal reference scan**

Run:

```powershell
rg "D:\\|C:\\|decompile|ffdec|mod-tools|export\\|plugin://|app://" src\lib\mission src\routes\api\singleBattleQuest.ts src\multi\http\battle.ts -n
```

Expected: no matches. `rg` may exit with code 1 when there are no matches.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/routes/api/singleBattleQuest.ts src/multi/http/battle.ts
git commit -m "feat: record mission dimensions on battle finish"
```

Expected: commit succeeds and excludes unrelated gacha files.

---

### Task 4: Counter Snapshots For Daily And Weekly Reset

**Files:**
- Modify: `src/routes/web_api/player.ts`

- [ ] **Step 1: Add snapshot import**

In `src/routes/web_api/player.ts`, add:

```ts
import { snapshotAllMissionCountersSync } from "../../lib/mission"
```

- [ ] **Step 2: Snapshot counters in daily reset**

In the `/:id/daily_reset` handler, after existing `takeSnapshot(playerId, 'daily', ...)` logic succeeds, add:

```ts
            const missionCounterSnapshots = snapshotAllMissionCountersSync(playerId, "daily")
            console.log(`[MISSION] daily counter snapshot player=${playerId} counters=${missionCounterSnapshots}`)
```

- [ ] **Step 3: Snapshot counters in weekly reset**

In the `/:id/weekly_reset` handler, after existing `takeSnapshot(playerId, 'weekly', ...)` logic succeeds, add:

```ts
            const missionCounterSnapshots = snapshotAllMissionCountersSync(playerId, "weekly")
            console.log(`[MISSION] weekly counter snapshot player=${playerId} counters=${missionCounterSnapshots}`)
```

- [ ] **Step 4: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Verify snapshot function with rollback**

Run:

```powershell
node -r ts-node/register -e "const {getDb}=require('./src/data/db'); const {addMissionCounterSync,snapshotAllMissionCountersSync,getMissionCounterSnapshotValueSync}=require('./src/lib/mission'); const player=getDb().prepare('SELECT id FROM players LIMIT 1').get(); if(!player) throw new Error('no player row'); const query={dimension:'battle.clear',scopeType:'lifetime',scopeKey:'all',qualifier:{mode:'multi'}}; const tx=getDb().transaction(()=>{addMissionCounterSync(player.id,query,5); const count=snapshotAllMissionCountersSync(player.id,'daily'); const snap=getMissionCounterSnapshotValueSync(player.id,'daily',query); if(count<1||snap<5) throw new Error(JSON.stringify({count,snap})); throw new Error('ROLLBACK_OK')}); try{tx()}catch(e){if(e.message!=='ROLLBACK_OK') throw e}; console.log('counter snapshot ok')"
```

Expected: PASS and prints `counter snapshot ok`.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/routes/web_api/player.ts
git commit -m "feat: snapshot mission counters on reset"
```

Expected: commit succeeds.

---

### Task 5: Daily Battle Counter Evaluator

**Files:**
- Create: `src/lib/mission/evaluator.ts`
- Modify: `src/lib/mission/index.ts`
- Modify: `src/lib/mission/computer-regular.ts`

- [ ] **Step 1: Run the failing evaluator check**

Run:

```powershell
node -r ts-node/register -e "require('./src/lib/mission/evaluator')"
```

Expected: FAIL with missing module error.

- [ ] **Step 2: Create `src/lib/mission/evaluator.ts`**

Create:

```ts
import {
    getMissionCounterDeltaSync,
    getMissionCounterValueSync,
    type MissionCounterPeriod,
    type MissionCounterQuery,
} from "./counters"

export interface MissionEvaluationInput {
    playerId: number
    category: number
    missionId: number
    pattern: string
    definition?: any[]
    period?: MissionCounterPeriod
}

export interface MissionEvaluationResult {
    supported: boolean
    progress: number
    reason?: string
}

function cell(row: any[] | undefined, index: number): string {
    const value = row?.[index]
    if (value === undefined || value === null || value === "(None)") return ""
    return String(value)
}

function getQuestFilter(definition?: any[]): { questCategory?: number; questId?: number } {
    const questCategory = parseInt(cell(definition, 7))
    const questId = parseInt(cell(definition, 8))
    return {
        questCategory: Number.isNaN(questCategory) ? undefined : questCategory,
        questId: Number.isNaN(questId) ? undefined : questId,
    }
}

function readCounter(playerId: number, query: MissionCounterQuery, period?: MissionCounterPeriod): number {
    return period
        ? getMissionCounterDeltaSync(playerId, period, query)
        : getMissionCounterValueSync(playerId, query)
}

function supported(progress: number): MissionEvaluationResult {
    return { supported: true, progress }
}

function unsupported(reason: string): MissionEvaluationResult {
    return { supported: false, progress: 0, reason }
}

export function evaluateMissionCounterProgress(input: MissionEvaluationInput): MissionEvaluationResult {
    const kind = parseInt(cell(input.definition, 2))
    const period = input.period

    if (kind === 14 || input.pattern.startsWith("single_battle_play")) {
        const filter = getQuestFilter(input.definition)
        if (filter.questCategory !== undefined && filter.questId !== undefined) {
            return supported(readCounter(input.playerId, {
                dimension: "battle.quest_clear",
                scopeType: "lifetime",
                scopeKey: "all",
                qualifier: { questCategory: filter.questCategory, questId: filter.questId, mode: "single" },
            }, period))
        }
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "single" },
        }, period))
    }

    if (kind === 16 || input.pattern.startsWith("multi_battle_play")) {
        const filter = getQuestFilter(input.definition)
        if (filter.questCategory !== undefined && filter.questId !== undefined) {
            return supported(readCounter(input.playerId, {
                dimension: "battle.quest_clear",
                scopeType: "lifetime",
                scopeKey: "all",
                qualifier: { questCategory: filter.questCategory, questId: filter.questId, mode: "multi" },
            }, period))
        }
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "multi" },
        }, period))
    }

    if (kind === 23 || input.pattern.startsWith("battle_clear_count")) {
        return supported(readCounter(input.playerId, {
            dimension: "battle.clear",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { mode: "any" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_dash")) {
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "dash" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_power_flip")) {
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "power_flip" },
        }, period))
    }

    if (kind === 28 && input.pattern.startsWith("use_skill")) {
        return supported(readCounter(input.playerId, {
            dimension: "battle.stat",
            scopeType: "lifetime",
            scopeKey: "all",
            qualifier: { kind: "skill" },
        }, period))
    }

    return unsupported(`unsupported mission kind ${Number.isNaN(kind) ? "unknown" : kind}`)
}
```

- [ ] **Step 3: Export evaluator**

In `src/lib/mission/index.ts`, add:

```ts
export type { MissionEvaluationInput, MissionEvaluationResult } from "./evaluator"
export { evaluateMissionCounterProgress } from "./evaluator"
```

- [ ] **Step 4: Use evaluator in `RegularComputer`**

In `src/lib/mission/computer-regular.ts`, import the evaluator:

```ts
import { evaluateMissionCounterProgress } from "./evaluator"
```

After the `target_mission_clear` block and before the existing `isComputablePattern` block, add:

```ts
    if (category === 2) {
        const evaluated = evaluateMissionCounterProgress({
            playerId: ctx.playerId,
            category,
            missionId,
            pattern,
            definition,
            period: "daily",
        })
        if (evaluated.supported) return Math.max(evaluated.progress, dbProgress)
    }
```

This preserves client/DB progress when a player already has current daily progress from the old flow.

- [ ] **Step 5: Verify evaluator reads daily delta**

Run:

```powershell
node -r ts-node/register -e "const {getDb}=require('./src/data/db'); const {addMissionCounterSync,snapshotAllMissionCountersSync,evaluateMissionCounterProgress}=require('./src/lib/mission'); const player=getDb().prepare('SELECT id FROM players LIMIT 1').get(); if(!player) throw new Error('no player row'); const query={dimension:'battle.clear',scopeType:'lifetime',scopeKey:'all',qualifier:{mode:'multi'}}; const tx=getDb().transaction(()=>{addMissionCounterSync(player.id,query,7); snapshotAllMissionCountersSync(player.id,'daily'); addMissionCounterSync(player.id,query,3); const result=evaluateMissionCounterProgress({playerId:player.id,category:2,missionId:3,pattern:'multi_battle_play',definition:['multi_battle_play','',16],period:'daily'}); if(!result.supported||result.progress!==3) throw new Error(JSON.stringify(result)); throw new Error('ROLLBACK_OK')}); try{tx()}catch(e){if(e.message!=='ROLLBACK_OK') throw e}; console.log('daily evaluator ok')"
```

Expected: PASS and prints `daily evaluator ok`.

- [ ] **Step 6: Verify daily all-clear still works**

Run:

```powershell
node -r ts-node/register -e "const {RegularComputer}=require('./src/lib/mission/computer-regular'); const base={playerId:1,category:2,player:{totalStaminaUsed:0},questProgress:{},totalQuestClears:3,totalStories:0,rankCounts:{},snapshot:null,activeMissionProgress:{2:1,3:1,4:10}}; console.log('allClearComplete', RegularComputer.compute(5, base, 0)); const missing={...base,activeMissionProgress:{2:1,3:1}}; console.log('allClearMissingDash', RegularComputer.compute(5, missing, 0));"
```

Expected: prints `allClearComplete 4` and `allClearMissingDash 3`.

- [ ] **Step 7: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src/lib/mission/evaluator.ts src/lib/mission/index.ts src/lib/mission/computer-regular.ts
git commit -m "feat: evaluate daily battle mission counters"
```

Expected: commit succeeds.

---

### Task 6: Awake Counter Shadow Verification

**Files:**
- Modify: `docs/systems/mission-dimension-progress.md`

This task intentionally does not switch awake mission progress to counters. The current awake calculator reads legacy tables that already contain historical values. New counters start from implementation time, so switching without backfill would regress existing players. The first safe step is to double-write counters through Task 3 and document that awake migration needs either backfill or a legacy-floor strategy.

- [ ] **Step 1: Verify current awake reward/progress smoke script**

Run:

```powershell
node -r ts-node/register -e "const {getAwakeMissionRewards}=require('./src/lib/mission'); console.log(JSON.stringify(getAwakeMissionRewards(11,1)));"
```

Expected: prints `[{"kind":1,"amount":10,"itemId":1}]`.

- [ ] **Step 2: Update progress document**

In `docs/systems/mission-dimension-progress.md`, add a short note under the dimension coverage section:

```md
### 觉醒任务迁移原则

战斗结算已经可以双写 character/battle/co-clear/race counter，但角色觉醒任务暂不直接切换到 counter。原因是旧存档的历史觉醒进度保存在 legacy 表中，新 counter 从上线后开始累计。迁移策略必须使用 backfill 或 legacy floor，避免已有角色觉醒任务进度回退。
```

- [ ] **Step 3: Run UTF-8 readability check**

Run:

```powershell
node -e "const fs=require('fs'); const p='docs/systems/mission-dimension-progress.md'; const s=fs.readFileSync(p,'utf8'); if(!s.includes('觉醒任务迁移原则')) throw new Error('doc note missing'); console.log('doc ok')"
```

Expected: PASS and prints `doc ok`.

- [ ] **Step 4: Commit**

Run:

```powershell
git add docs/systems/mission-dimension-progress.md
git commit -m "docs: document awake counter migration guard"
```

Expected: commit succeeds.

---

### Task 7: Final Verification And Coverage Report

**Files:**
- Modify: `docs/systems/mission-dimension-progress.md`

- [ ] **Step 1: Run full typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run reward and daily dependency regression**

Run:

```powershell
node -r ts-node/register -e "const {getRegularMissionRewards,getDailyMissionRewards,getAwakeMissionRewards,getCollectMissionRewards,getCurrentStage,getCompletedStageNumbers}=require('./src/lib/mission'); console.log('regularReward', JSON.stringify(getRegularMissionRewards(1,1))); console.log('dailyReward', JSON.stringify(getDailyMissionRewards(1,1))); console.log('awakeReward', JSON.stringify(getAwakeMissionRewards(11,1))); console.log('collectReward', JSON.stringify(getCollectMissionRewards(1500,1))); console.log('dailyStageAfter', getCurrentStage(2,1,3), JSON.stringify(getCompletedStageNumbers(2,1,3)));"
```

Expected output includes:

```text
regularReward [{"kind":0,"amount":5}]
dailyReward [{"kind":0,"amount":5}]
awakeReward [{"kind":1,"amount":10,"itemId":1}]
collectReward [{"kind":3,"amount":10000}]
dailyStageAfter 1 [1]
```

- [ ] **Step 3: Run counter evaluator regression**

Run:

```powershell
node -r ts-node/register -e "const {makeMissionCounterKey,evaluateMissionCounterProgress}=require('./src/lib/mission'); const key=makeMissionCounterKey({dimension:'battle.clear',scopeType:'lifetime',scopeKey:'all',qualifier:{questId:1,mode:'multi'}}); if(key!=='battle.clear|lifetime|all|{\"mode\":\"multi\",\"questId\":1}') throw new Error(key); const unsupported=evaluateMissionCounterProgress({playerId:1,category:2,missionId:999,pattern:'unknown_pattern',definition:['unknown_pattern','',999],period:'daily'}); if(unsupported.supported) throw new Error('unsupported pattern should not be supported'); console.log('counter regression ok')"
```

Expected: PASS and prints `counter regression ok`.

- [ ] **Step 4: Run illegal reference scan**

Run:

```powershell
rg "D:\\|C:\\|decompile|ffdec|mod-tools|export\\|plugin://|app://" src\lib\mission src\routes\api\singleBattleQuest.ts src\multi\http\battle.ts src\routes\web_api\player.ts docs\systems\mission-dimension-progress.md -n
```

Expected: no matches. `rg` may exit with code 1 when there are no matches.

- [ ] **Step 5: Update coverage report**

In `docs/systems/mission-dimension-progress.md`, update the status notes to say:

```md
第一批维度化实现后，每日任务中的 single/multi/battle clear 与 dash/powerflip/skill 可由服务端 counter evaluator 读取，并保留 DB/client fallback。角色觉醒已开始由战斗结算双写 character counter，但正式切换仍等待 backfill 或 legacy-floor 策略。
```

- [ ] **Step 6: Commit final docs**

Run:

```powershell
git add docs/systems/mission-dimension-progress.md
git commit -m "docs: update mission dimension implementation status"
```

Expected: commit succeeds.

- [ ] **Step 7: Confirm final status**

Run:

```powershell
git status --short --branch
```

Expected: no tracked mission changes remain. Unrelated local gacha changes and local tool/decompile files may still appear and should remain unstaged.

---

## Plan Self-Review

Spec coverage:

- Counter infrastructure is covered by Task 1.
- Battle finish event and dimension writes are covered by Tasks 2 and 3.
- Daily/weekly snapshot support is covered by Task 4.
- Daily evaluator with fallback is covered by Task 5.
- Awake migration risk is handled by Task 6 without risking progress regression.
- Final verification and documentation are covered by Task 7.

Type consistency:

- `MissionCounterQuery`, `MissionCounterPeriod`, and `MissionEvaluationResult` are defined before use.
- `recordBattleMissionDimensions`, `collectPartyCharacterIds`, and `summarizeBattleStatistics` are exported from `src/lib/mission/index.ts` before route imports use them.
- Daily evaluator returns `{ supported, progress }`, and `RegularComputer` only uses counter progress when `supported=true`.

Execution note:

- Use one commit per task.
- If any verification fails, stop and fix that task before continuing.
- Do not stage unrelated current work outside the files listed for each task.
