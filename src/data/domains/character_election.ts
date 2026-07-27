import { getDb } from "../db"
import { completePlayerEventMissionFactSync } from "./event_mission_entry_facts"

interface CharacterElectionVoteRow {
    readonly keyword_id: number
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0
}

export function getPlayerCharacterElectionVoteSync(
    playerId: number,
    electionId: number,
): number | null {
    if (!isPositiveSafeInteger(playerId) || !isPositiveSafeInteger(electionId)) return null
    const row = getDb().prepare(`
        SELECT keyword_id
        FROM players_character_election_votes
        WHERE player_id = ? AND election_id = ?
    `).get(playerId, electionId) as CharacterElectionVoteRow | undefined
    return row?.keyword_id ?? null
}

export interface RecordCharacterElectionVoteResult {
    readonly inserted: boolean
    readonly keywordId: number
}

export function recordPlayerCharacterElectionVoteSync(
    playerId: number,
    electionId: number,
    keywordId: number,
    votedAt: number,
    missionId: number,
): RecordCharacterElectionVoteResult {
    if (![playerId, electionId, keywordId, votedAt, missionId].every(isPositiveSafeInteger)) {
        throw new TypeError("character election vote values must be positive safe integers")
    }
    return getDb().transaction(() => {
        const existing = getPlayerCharacterElectionVoteSync(playerId, electionId)
        if (existing === null) {
            getDb().prepare(`
                INSERT INTO players_character_election_votes (
                    player_id, election_id, keyword_id, voted_at
                ) VALUES (?, ?, ?, ?)
            `).run(playerId, electionId, keywordId, votedAt)
        }
        completePlayerEventMissionFactSync(playerId, missionId)
        const missionProgress = getDb().prepare(`
            SELECT progress
            FROM players_category_missions
            WHERE player_id = ? AND category = 3 AND id = ?
        `).get(playerId, missionId) as { progress: number } | undefined
        if (!missionProgress
            || !Number.isSafeInteger(missionProgress.progress)
            || missionProgress.progress < 1) {
            throw new Error("character election mission fact was not persisted")
        }
        return {
            inserted: existing === null,
            keywordId: existing ?? keywordId,
        }
    }).immediate()
}
