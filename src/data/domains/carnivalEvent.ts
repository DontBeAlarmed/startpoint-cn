import { getDb } from "../db";
import { PlayerCarnivalEventRecord, RawPlayerCarnivalEventRecord } from "../types";
import { deserializeNumberList, serializeNumberList } from "../utils";
import {
    getClaimedCarnivalRewardIdsSync,
    insertClaimedCarnivalRewardIdsSync,
} from "../../lib/carnival-reward-persistence";

function buildRecord(raw: RawPlayerCarnivalEventRecord): PlayerCarnivalEventRecord {
    return {
        eventId: raw.event_id,
        folderId: raw.folder_id,
        bestScore: raw.best_score,
        previousScore: raw.previous_score,
        previousCharacterIds: raw.previous_character_ids !== null ? deserializeNumberList(raw.previous_character_ids) : null,
        previousUnisonCharacterIds: raw.previous_unison_character_ids !== null ? deserializeNumberList(raw.previous_unison_character_ids) : null,
    }
}

export function getPlayerCarnivalEventRecordsSync(
    playerId: number,
    eventId: number
): PlayerCarnivalEventRecord[] {
    const rows = getDb().prepare(`
    SELECT player_id, event_id, folder_id, best_score, previous_score, previous_character_ids, previous_unison_character_ids
    FROM players_carnival_event_records
    WHERE player_id = ? AND event_id = ?
    `).all(playerId, eventId) as RawPlayerCarnivalEventRecord[]

    return rows.map(buildRecord)
}

export function getPlayerCarnivalEventRecordSync(
    playerId: number,
    eventId: number,
    folderId: number
): PlayerCarnivalEventRecord | null {
    const raw = getDb().prepare(`
    SELECT player_id, event_id, folder_id, best_score, previous_score, previous_character_ids, previous_unison_character_ids
    FROM players_carnival_event_records
    WHERE player_id = ? AND event_id = ? AND folder_id = ?
    `).get(playerId, eventId, folderId) as RawPlayerCarnivalEventRecord | undefined

    return raw ? buildRecord(raw) : null
}

export function upsertPlayerCarnivalEventRecordSync(
    playerId: number,
    eventId: number,
    folderId: number,
    score: number,
    characterIds: (number | null)[],
    unisonCharacterIds: (number | null)[]
): PlayerCarnivalEventRecord {
    const existing = getPlayerCarnivalEventRecordSync(playerId, eventId, folderId)
    const bestScore = existing ? Math.max(existing.bestScore ?? 0, score) : score

    getDb().prepare(`
    INSERT INTO players_carnival_event_records (player_id, event_id, folder_id, best_score, previous_score, previous_character_ids, previous_unison_character_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, event_id, folder_id) DO UPDATE SET
        best_score = excluded.best_score,
        previous_score = excluded.previous_score,
        previous_character_ids = excluded.previous_character_ids,
        previous_unison_character_ids = excluded.previous_unison_character_ids
    `).run(
        playerId,
        eventId,
        folderId,
        bestScore,
        score,
        serializeNumberList(characterIds),
        serializeNumberList(unisonCharacterIds)
    )

    return {
        eventId,
        folderId,
        bestScore,
        previousScore: score,
        previousCharacterIds: characterIds,
        previousUnisonCharacterIds: unisonCharacterIds,
    }
}

export function getPlayerClaimedCarnivalRewardIdsSync(
    playerId: number,
    eventId: number,
): Set<number> {
    return getClaimedCarnivalRewardIdsSync(getDb(), playerId, eventId)
}

export function insertPlayerClaimedCarnivalRewardIdsSync(
    playerId: number,
    eventId: number,
    rewardIds: number[],
) {
    insertClaimedCarnivalRewardIdsSync(getDb(), playerId, eventId, rewardIds)
}

export function runCarnivalEventTransactionSync<T>(operation: () => T): T {
    return getDb().transaction(operation)()
}
