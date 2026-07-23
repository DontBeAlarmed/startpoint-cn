import { getDb } from "../db";
import { PlayerActiveMission, RawPlayerClearedRegularMission, RawPlayerActiveMission, RawPlayerActiveMissionStage } from "../types";
import { deserializeBoolean, serializeBoolean } from "../utils";

/**
 * Retrieve a list of a player's cleared regular missions.
 * 
 * @param playerId The ID of the player.
 * @returns A record, where the index is the id of the mission and the value is ???.
 */
export function getPlayerClearedRegularMissionListSync(
    playerId: number
): Record<string, number> {

    const raw = getDb().prepare(`
    SELECT id, value
    FROM players_cleared_regular_missions
    WHERE player_id = ?
    `).all(playerId) as RawPlayerClearedRegularMission[]

    const record: Record<string, number> = {}

    for (const rawClear of raw) {
        record[rawClear.id.toString()] = rawClear.value
    }

    return record
}

/**
 * Sets a regular mission as having been cleared by a player.
 * 
 * @param playerId The ID of the player.
 * @param missionId The ID of the mission that was cleared.
 * @param value 
 */
function insertPlayerClearedRegularMissionSync(
    playerId: number,
    missionId: number | string,
    value: number
) {
    getDb().prepare(`
    INSERT INTO players_cleared_regular_missions (id, value, player_id)
    VALUES (?, ?, ?)
    `).run(
        Number(missionId),
        value,
        playerId
    )
}

/**
 * Sets a list of regular missions as having been cleared by a player.
 * 
 * @param playerId The ID of the player.
 * @param missionList The list of missions that were cleared.
 */
export function insertPlayerClearedRegularMissionListSync(
    playerId: number,
    missionList: Record<string, number>
) {
    getDb().transaction(() => {
        for (const [missionId, value] of Object.entries(missionList)) {
            insertPlayerClearedRegularMissionSync(playerId, missionId, value)
        }
    })()
}
/**
/**
/**
 * Inserts a singular item into the player's inventory.
 * 
 * @param playerId The ID of the player.
 * @param itemId The ID of the item to insert.
 * @param amount The amount of the item to insert.
 */
function insertPlayerItemSync(
    playerId: number,
    itemId: number | string,
    amount: number
) {
    getDb().prepare(`
    INSERT INTO players_items (id, amount, player_id)
    VALUES (?, ?, ?)
    `).run(
        Number(itemId),
        amount,
        playerId
    )
}
/**
/**
/**
/**
 * Retrieves the missions that a player is currently completing.
 * 
 * @param playerId The ID of the player.
 * @returns A record of each mission and its current progress.
 */
/**
 * Retrieves the missions that a player is currently completing.
 * 
 * @param playerId The ID of the player.
 * @returns A record of each mission and its current progress.
 */
export function getPlayerActiveMissionsSync(
    playerId: number
): Record<string, PlayerActiveMission> {
    const rawMissions = getDb().prepare(`
    SELECT id, progress
    FROM players_active_missions
    WHERE player_id = ?
    `).all(playerId) as RawPlayerActiveMission[]

    const rawStages = getDb().prepare(`
    SELECT id, status, mission_id
    FROM players_active_missions_stages
    WHERE player_id = ?
    `).all(playerId) as RawPlayerActiveMissionStage[]

    const stageBuckets: Record<string, Record<string, boolean>> = {}

    for (const rawStage of rawStages) {
        const missionId = rawStage.mission_id.toString()
        let bucket = stageBuckets[missionId]
        if (!bucket) {
            bucket = {}
            stageBuckets[missionId] = bucket
        }

        bucket[rawStage.id] = deserializeBoolean(rawStage.status)
    }

    const final: Record<string, PlayerActiveMission> = {}

    for (const rawMission of rawMissions) {
        const id = rawMission.id.toString()

        final[id] = {
            progress: rawMission.progress,
            stages: stageBuckets[id] || []
        }
    }

    return final
}

/**
 * Inserts the data for a singular active mission stage into the database.
 * 
 * @param playerId The player's ID.
 * @param stageId The ID of the stage.
 * @param missionId The ID of the mission that this stage belongs to.
 * @param status The status of the stage.
 */
function insertPlayerActiveMissionStageSync(
    playerId: number,
    stageId: number | string,
    missionId: number | string,
    status: boolean
) {
    getDb().prepare(`
    INSERT INTO players_active_missions_stages (id, status, player_id, mission_id)
    VALUES (?, ?, ?, ?)   
    `).run(
        Number(stageId),
        serializeBoolean(status),
        playerId,
        Number(missionId)
    )
}

/**
 * Inserts a singular active mission into the database.
 * 
 * @param playerId The player's iD>
 * @param missionId The ID of the mission to insert.
 * @param mission The mission's data.
 */
function insertPlayerActiveMissionSync(
    playerId: number,
    missionId: number | string,
    mission: PlayerActiveMission
) {
    getDb().prepare(`
    INSERT INTO players_active_missions (id, progress, player_id)
    VALUES (?, ?, ?)
    `).run(
        Number(missionId),
        mission.progress,
        playerId
    )

    const stages = mission.stages
    if (stages) {
        for (const [stageId, stage] of Object.entries(stages)) {
            insertPlayerActiveMissionStageSync(playerId, stageId, missionId, stage)
        }
    }
}

/**
 * Batch inserts a record of active missions into the database.
 * 
 * @param playerId The player's ID.
 * @param missions The record of active missions to insert.
 */
export function insertPlayerActiveMissionsSync(
    playerId: number,
    missions: Record<string, PlayerActiveMission>
) {
    getDb().transaction(() => {
        for (const [missionId, mission] of Object.entries(missions)) {
            insertPlayerActiveMissionSync(playerId, missionId, mission)
        }
    })()
}

/**
 * Updates the progress value of a single active mission.
 */
export function updatePlayerActiveMissionSync(
    playerId: number,
    missionId: number | string,
    progress: number
) {
    getDb().prepare(`
    INSERT INTO players_active_missions (id, progress, player_id)
    VALUES (?, ?, ?)
    ON CONFLICT(id, player_id) DO UPDATE SET progress = excluded.progress
    `).run(Number(missionId), progress, playerId)
}

/** Atomically adds a client-reported counter delta to a mission. */
export function incrementPlayerActiveMissionSync(
    playerId: number,
    missionId: number | string,
    delta: number
) {
    getDb().prepare(`
    INSERT INTO players_active_missions (id, progress, player_id)
    VALUES (?, ?, ?)
    ON CONFLICT(id, player_id) DO UPDATE SET progress = progress + excluded.progress
    `).run(Number(missionId), delta, playerId)
}

/** Retrieves category-scoped mission progress without mixing equal IDs. */
export function getPlayerCategoryMissionsSync(
    playerId: number,
    category: number
): Record<string, PlayerActiveMission> {
    const missions = getDb().prepare(`
    SELECT id, progress
    FROM players_category_missions
    WHERE player_id = ? AND category = ?
    `).all(playerId, category) as RawPlayerActiveMission[]
    const stages = getDb().prepare(`
    SELECT id, status, mission_id
    FROM players_category_mission_stages
    WHERE player_id = ? AND category = ?
    `).all(playerId, category) as RawPlayerActiveMissionStage[]

    const stageBuckets: Record<string, Record<string, boolean>> = {}
    for (const stage of stages) {
        const missionId = String(stage.mission_id)
        const bucket = stageBuckets[missionId] ?? {}
        bucket[String(stage.id)] = deserializeBoolean(stage.status)
        stageBuckets[missionId] = bucket
    }

    const result: Record<string, PlayerActiveMission> = {}
    for (const mission of missions) {
        result[String(mission.id)] = {
            progress: mission.progress,
            stages: stageBuckets[String(mission.id)] ?? [],
        }
    }
    return result
}

export function getPlayerCategoryMissionListSync(
    playerId: number
): Record<string, Record<string, PlayerActiveMission>> {
    const categories = getDb().prepare(`
    SELECT DISTINCT category
    FROM players_category_missions
    WHERE player_id = ?
    ORDER BY category
    `).all(playerId) as { category: number }[]
    const result: Record<string, Record<string, PlayerActiveMission>> = {}
    for (const { category } of categories) {
        result[String(category)] = getPlayerCategoryMissionsSync(playerId, category)
    }
    return result
}

export function getPlayerClearedCollectItemEventMissionListSync(
    playerId: number
): Record<string, number> {
    const rows = getDb().prepare(`
    SELECT mission_id, MAX(id) AS stage
    FROM players_category_mission_stages
    WHERE player_id = ? AND category = 4 AND status = 1
    GROUP BY mission_id
    ORDER BY mission_id
    `).all(playerId) as { mission_id: number; stage: number }[]
    return Object.fromEntries(rows.map(row => [String(row.mission_id), row.stage]))
}

export function insertPlayerCategoryMissionListSync(
    playerId: number,
    categories: Record<string, Record<string, PlayerActiveMission>>
) {
    getDb().transaction(() => {
        for (const [categoryKey, missions] of Object.entries(categories)) {
            const category = Number(categoryKey)
            if (!Number.isInteger(category)) continue
            for (const [missionId, mission] of Object.entries(missions)) {
                updatePlayerCategoryMissionSync(playerId, category, missionId, mission.progress)
                if (!mission.stages || Array.isArray(mission.stages)) continue
                for (const [stageId, received] of Object.entries(mission.stages)) {
                    updatePlayerCategoryMissionStageSync(playerId, category, stageId, missionId, received)
                }
            }
        }
    })()
}

export function updatePlayerCategoryMissionSync(
    playerId: number,
    category: number,
    missionId: number | string,
    progress: number
) {
    getDb().prepare(`
    INSERT INTO players_category_missions (category, id, progress, player_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(category, id, player_id) DO UPDATE SET progress = excluded.progress
    `).run(category, Number(missionId), progress, playerId)
}

export function incrementPlayerCategoryMissionSync(
    playerId: number,
    category: number,
    missionId: number | string,
    delta: number
) {
    getDb().prepare(`
    INSERT INTO players_category_missions (category, id, progress, player_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(category, id, player_id) DO UPDATE SET progress = progress + excluded.progress
    `).run(category, Number(missionId), delta, playerId)
}

export function updatePlayerCategoryMissionStageSync(
    playerId: number,
    category: number,
    stageId: number | string,
    missionId: number | string,
    status: boolean
) {
    getDb().prepare(`
    INSERT INTO players_category_mission_stages (category, id, status, player_id, mission_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(category, id, mission_id, player_id) DO UPDATE SET status = excluded.status
    `).run(category, Number(stageId), serializeBoolean(status), playerId, Number(missionId))
}

export function deletePlayerCategoryMissionsSync(playerId: number, category: number) {
    getDb().transaction(() => {
        getDb().prepare(`DELETE FROM players_category_mission_stages WHERE player_id = ? AND category = ?`).run(playerId, category)
        getDb().prepare(`DELETE FROM players_category_missions WHERE player_id = ? AND category = ?`).run(playerId, category)
    })()
}

/**
 * Updates the status of a single active mission stage (claimed/unclaimed).
 */
export function updatePlayerActiveMissionStageSync(
    playerId: number,
    stageId: number | string,
    missionId: number | string,
    status: boolean
) {
    getDb().prepare(`
    INSERT OR REPLACE INTO players_active_missions_stages (id, status, player_id, mission_id)
    VALUES (?, ?, ?, ?)
    `).run(
        Number(stageId),
        serializeBoolean(status),
        playerId,
        Number(missionId)
    )
}
