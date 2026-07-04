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
