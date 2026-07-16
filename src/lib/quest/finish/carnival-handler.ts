import { QuestCategory } from "../../types"

interface CarnivalEventData {
    is_record_valid: boolean
    leader_character_id: number
    new_degree_ids: number[]
    previous_total_best_score: number
    reward_ids: number[]
    score: { difficulty_bonus: number, time_bonus: number }
}

export function handleCarnivalEventFinish(params: {
    questCategory: number
    questAccomplished: boolean
    questId: number
    questData: { eventId?: number, folderId?: number, difficultyScore?: number, timeLimitMs?: number }
    clearTime: number
    party: { characters: ({ id: number | null } | null)[], unison_characters: ({ id: number | null } | null)[], leader?: { id: number | null } | null }
    playerId: number
    getRecordsFn: (playerId: number, eventId: number) => { bestScore: number | null }[]
    upsertFn: (playerId: number, eventId: number, folderId: number, score: number, chars: (number | null)[], unisons: (number | null)[]) => void
}): CarnivalEventData | null {
    const { questCategory, questAccomplished, questData, clearTime, party, playerId, getRecordsFn, upsertFn } = params

    if (questCategory !== QuestCategory.CARNIVAL_EVENT || !questAccomplished) return null

    const { eventId, folderId, difficultyScore, timeLimitMs } = questData
    if (eventId === undefined || folderId === undefined || difficultyScore === undefined || timeLimitMs === undefined) return null

    const characterIds = party.characters.map(v => v?.id ?? null)
    const unisonCharacterIds = party.unison_characters.map(v => v?.id ?? null)
    const leaderCharId = party.leader?.id ?? 0

    const previousTotalBestScore = getRecordsFn(playerId, eventId)
        .reduce((sum, record) => sum + (record.bestScore ?? 0), 0)
    const difficultyBonus = difficultyScore
    const timeBonus = Math.max(0, timeLimitMs - Math.round(clearTime))
    const totalScore = difficultyBonus + timeBonus

    upsertFn(playerId, eventId, folderId, totalScore, characterIds, unisonCharacterIds)

    return {
        is_record_valid: true,
        leader_character_id: leaderCharId,
        new_degree_ids: [],
        previous_total_best_score: previousTotalBestScore,
        reward_ids: [],
        score: { difficulty_bonus: difficultyBonus, time_bonus: timeBonus }
    }
}
