import { Database as BetterSqlite3Database } from "better-sqlite3"
import type { PlayerCarnivalEventRecord, PlayerCarnivalRewardClaim } from "../data/types"

export interface CarnivalSaveState {
    carnivalEventRecords: PlayerCarnivalEventRecord[]
    carnivalRewardClaims: PlayerCarnivalRewardClaim[]
    degreeIds: number[]
}

type CarnivalSaveStateInput = Partial<CarnivalSaveState>

interface RawCarnivalRecord {
    event_id: number
    folder_id: number
    best_score: number | null
    previous_score: number | null
    previous_character_ids: string | null
    previous_unison_character_ids: string | null
}

function deserializeNullableNumberList(value: string | null): (number | null)[] | null {
    if (value === null) return null
    return value.split(",").map(part => part === "" ? null : Number(part))
}

function serializeNullableNumberList(value: (number | null)[] | null): string | null {
    return value === null ? null : value.map(entry => entry ?? "").join(",")
}

export function getCarnivalSaveStateSync(
    db: BetterSqlite3Database,
    playerId: number,
): CarnivalSaveState {
    const records = db.prepare(`
        SELECT event_id, folder_id, best_score, previous_score,
            previous_character_ids, previous_unison_character_ids
        FROM players_carnival_event_records
        WHERE player_id = ?
        ORDER BY event_id, folder_id
    `).all(playerId) as RawCarnivalRecord[]
    const rewardClaims = db.prepare(`
        SELECT event_id, reward_id
        FROM players_carnival_event_rewards
        WHERE player_id = ?
        ORDER BY event_id, reward_id
    `).all(playerId) as { event_id: number, reward_id: number }[]
    const degrees = db.prepare(`
        SELECT degree_id
        FROM players_degrees
        WHERE player_id = ?
        ORDER BY degree_id
    `).all(playerId) as { degree_id: number }[]

    return {
        carnivalEventRecords: records.map(record => ({
            eventId: record.event_id,
            folderId: record.folder_id,
            bestScore: record.best_score,
            previousScore: record.previous_score,
            previousCharacterIds: deserializeNullableNumberList(record.previous_character_ids),
            previousUnisonCharacterIds: deserializeNullableNumberList(record.previous_unison_character_ids),
        })),
        carnivalRewardClaims: rewardClaims.map(claim => ({
            eventId: claim.event_id,
            rewardId: claim.reward_id,
        })),
        degreeIds: degrees.map(degree => degree.degree_id),
    }
}

export function insertCarnivalSaveStateSync(
    db: BetterSqlite3Database,
    playerId: number,
    state: CarnivalSaveStateInput,
) {
    const insertRecord = db.prepare(`
        INSERT INTO players_carnival_event_records
            (player_id, event_id, folder_id, best_score, previous_score,
                previous_character_ids, previous_unison_character_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertClaim = db.prepare(`
        INSERT INTO players_carnival_event_rewards (player_id, event_id, reward_id)
        VALUES (?, ?, ?)
    `)
    const insertDegree = db.prepare(`
        INSERT INTO players_degrees (player_id, degree_id)
        VALUES (?, ?)
    `)

    db.transaction(() => {
        for (const record of state.carnivalEventRecords ?? []) {
            insertRecord.run(
                playerId,
                record.eventId,
                record.folderId,
                record.bestScore,
                record.previousScore,
                serializeNullableNumberList(record.previousCharacterIds),
                serializeNullableNumberList(record.previousUnisonCharacterIds),
            )
        }
        for (const claim of state.carnivalRewardClaims ?? []) {
            insertClaim.run(playerId, claim.eventId, claim.rewardId)
        }
        for (const degreeId of state.degreeIds ?? []) insertDegree.run(playerId, degreeId)
    })()
}
