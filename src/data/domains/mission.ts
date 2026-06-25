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
    UPDATE players_active_missions SET progress = ?
    WHERE player_id = ? AND id = ?
    `).run(progress, playerId, Number(missionId))
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
    UPDATE players_active_missions_stages SET status = ?
    WHERE player_id = ? AND id = ? AND mission_id = ?
    `).run(
        serializeBoolean(status),
        playerId,
        Number(stageId),
        Number(missionId)
    )
}
