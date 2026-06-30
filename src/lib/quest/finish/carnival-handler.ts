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
    clearTime: number
    party: { characters: ({ id: number | null } | null)[], unison_characters: ({ id: number | null } | null)[], leader?: { id: number | null } | null }
    playerId: number
    carnivalLookup: Record<string, { difficulty_score: number, time_limit_ms: number, folder_id: number, event_id: number }>
    upsertFn: (playerId: number, eventId: number, folderId: number, score: number, chars: (number | null)[], unisons: (number | null)[]) => void
}): CarnivalEventData | null {
    const { questCategory, questAccomplished, questId, clearTime, party, playerId, carnivalLookup, upsertFn } = params

    if (questCategory !== QuestCategory.CARNIVAL_EVENT || !questAccomplished) return null

    const carnivalInfo = carnivalLookup[String(questId)]
    if (!carnivalInfo) return null

    const characterIds = party.characters.map(v => v?.id ?? null)
    const unisonCharacterIds = party.unison_characters.map(v => v?.id ?? null)
    const leaderCharId = party.leader?.id ?? 0

    const difficultyBonus = carnivalInfo.difficulty_score * 100
    const timeBonus = Math.max(0, carnivalInfo.time_limit_ms - clearTime)
    const totalScore = difficultyBonus + timeBonus

    upsertFn(playerId, carnivalInfo.event_id, carnivalInfo.folder_id, totalScore, characterIds, unisonCharacterIds)

    return {
        is_record_valid: true,
        leader_character_id: leaderCharId,
        new_degree_ids: [],
        previous_total_best_score: 0,
        reward_ids: [],
        score: { difficulty_bonus: difficultyBonus, time_bonus: timeBonus }
    }
}
