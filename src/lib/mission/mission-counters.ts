import { getDb } from "../../data/db"

export type MissionCounterQualifierValue = string | number | boolean

export interface MissionCounterQuery {
    dimension: string
    scopeType: "lifetime" | "event" | "character"
    scopeKey: string
    qualifier?: Record<string, MissionCounterQualifierValue | null | undefined>
}

export function normalizeMissionCounterQualifier(
    qualifier: Record<string, MissionCounterQualifierValue | null | undefined> = {},
): Record<string, MissionCounterQualifierValue> {
    const normalized: Record<string, MissionCounterQualifierValue> = {}
    for (const key of Object.keys(qualifier).sort()) {
        const value = qualifier[key]
        if (value === null || value === undefined || value === "(None)" || value === "") continue
        normalized[key] = value
    }
    return normalized
}

export function makeMissionCounterKey(query: MissionCounterQuery): string {
    return [
        query.dimension,
        query.scopeType,
        query.scopeKey,
        JSON.stringify(normalizeMissionCounterQualifier(query.qualifier)),
    ].join("|")
}

/** 通用任务计数器：「累计做 X」型任务事实源（cond20/92 救援、新手救援等）。 */
export function addMissionCounterSync(playerId: number, query: MissionCounterQuery, amount = 1): number {
    if (amount <= 0) return getMissionCounterValueSync(playerId, query)
    const counterKey = makeMissionCounterKey(query)
    const qualifierJson = JSON.stringify(normalizeMissionCounterQualifier(query.qualifier))
    const row = getDb().prepare(`
        INSERT INTO players_mission_counters
            (player_id, counter_key, dimension, scope_type, scope_key, qualifier_json, value)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id, counter_key) DO UPDATE SET
            value = value + excluded.value
        RETURNING value
    `).get(playerId, counterKey, query.dimension, query.scopeType, query.scopeKey, qualifierJson, amount) as { value: number }
    return row.value
}

export function getMissionCounterValueSync(playerId: number, query: MissionCounterQuery): number {
    const row = getDb().prepare(`
        SELECT value FROM players_mission_counters
        WHERE player_id = ? AND counter_key = ?
    `).get(playerId, makeMissionCounterKey(query)) as { value: number } | undefined
    return row?.value ?? 0
}

/** 一次取多条精确 key（无前缀扫描）。 */
export function getMissionCounterValuesSync(
    playerId: number,
    queries: readonly MissionCounterQuery[],
): Map<string, number> {
    const keys = [...new Set(queries.map(makeMissionCounterKey))]
    const values = new Map(keys.map(key => [key, 0]))
    if (keys.length === 0) return values
    const rows = getDb().prepare(`
        SELECT counter_key, value FROM players_mission_counters
        WHERE player_id = ? AND counter_key IN (${keys.map(() => "?").join(", ")})
    `).all(playerId, ...keys) as { counter_key: string, value: number }[]
    for (const row of rows) values.set(row.counter_key, Number(row.value) || 0)
    return values
}
