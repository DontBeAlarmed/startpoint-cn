import { getDb } from "../db"

const EVENT_MISSION_CATEGORY = 3

interface MissionProgressRow {
    readonly progress: number
}
function getMissionProgressSync(playerId: number, missionId: number): number | undefined {
    return (getDb().prepare(`
        SELECT progress
        FROM players_category_missions
        WHERE player_id = ? AND category = ? AND id = ?
    `).get(playerId, EVENT_MISSION_CATEGORY, missionId) as MissionProgressRow | undefined)?.progress
}

function isValidKey(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0
}

function isValidProgress(value: number | undefined): boolean {
    return value === undefined
        || Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

export function recordPlayerEventMissionLoginDaySync(
    playerId: number,
    missionId: number,
    naturalDay: number,
): boolean {
    if (!isValidKey(playerId) || !isValidKey(missionId)
        || !Number.isSafeInteger(naturalDay)) return false

    return getDb().transaction(() => {
        const lastCountedDay = (getDb().prepare(`
            SELECT last_counted_day
            FROM players_event_mission_login_days
            WHERE player_id = ? AND mission_id = ?
        `).get(playerId, missionId) as { last_counted_day: number } | undefined)?.last_counted_day
        if (lastCountedDay !== undefined
            && (!Number.isSafeInteger(lastCountedDay) || lastCountedDay >= naturalDay)) return false

        const progress = getMissionProgressSync(playerId, missionId)
        if (!isValidProgress(progress) || progress === Number.MAX_SAFE_INTEGER) return false

        getDb().prepare(`
            INSERT INTO players_event_mission_login_days
                (player_id, mission_id, last_counted_day)
            VALUES (?, ?, ?)
            ON CONFLICT(player_id, mission_id) DO UPDATE SET
                last_counted_day = excluded.last_counted_day
        `).run(playerId, missionId, naturalDay)
        getDb().prepare(`
            INSERT INTO players_category_missions (category, id, progress, player_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(category, id, player_id) DO UPDATE SET
                progress = excluded.progress
        `).run(EVENT_MISSION_CATEGORY, missionId, (progress ?? 0) + 1, playerId)
        return true
    }).immediate()
}

export function completePlayerEventMissionFactSync(
    playerId: number,
    missionId: number,
): boolean {
    if (!isValidKey(playerId) || !isValidKey(missionId)) return false

    return getDb().transaction(() => {
        const progress = getMissionProgressSync(playerId, missionId)
        if (!isValidProgress(progress) || (progress ?? 0) >= 1) return false
        getDb().prepare(`
            INSERT INTO players_category_missions (category, id, progress, player_id)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(category, id, player_id) DO UPDATE SET progress = 1
        `).run(EVENT_MISSION_CATEGORY, missionId, playerId)
        return true
    })()
}
