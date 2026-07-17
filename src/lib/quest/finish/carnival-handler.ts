import { QuestCategory } from "../../types"
import {
    CarnivalRewardDefinition,
    CarnivalRewardGrantResult,
    getEligibleCarnivalRewards,
} from "../../carnival-rewards"

interface CarnivalEventData {
    is_record_valid: boolean
    leader_character_id: number
    new_degree_ids: number[]
    previous_total_best_score: number
    reward_ids: number[]
    score: { difficulty_bonus: number, time_bonus: number }
}

export interface CarnivalEventFinishResult {
    carnivalEventData: CarnivalEventData
    rewardResult: CarnivalRewardGrantResult
}

const emptyRewardResult = (): CarnivalRewardGrantResult => ({
    user_info: { free_vmoney: 0, free_mana: 0, exp_pool: 0 },
    item_list: {},
    equipment_list: [],
    new_degree_ids: [],
})

export function handleCarnivalEventFinish(params: {
    questCategory: number
    questAccomplished: boolean
    questId: number
    questData: { eventId?: number, folderId?: number, difficultyScore?: number, timeLimitMs?: number }
    clearTime: number
    party: { characters: ({ id: number | null } | null)[], unison_characters: ({ id: number | null } | null)[], leader?: { id: number | null } | null }
    playerId: number
    getRecordsFn: (playerId: number, eventId: number) => { folderId: number, bestScore: number | null }[]
    upsertFn: (playerId: number, eventId: number, folderId: number, score: number, chars: (number | null)[], unisons: (number | null)[]) => void
    getRewardDefinitionsFn?: (eventId: number) => CarnivalRewardDefinition[]
    getClaimedRewardIdsFn?: (playerId: number, eventId: number) => Set<number>
    grantRewardsFn?: (playerId: number, definitions: CarnivalRewardDefinition[]) => CarnivalRewardGrantResult
    claimRewardIdsFn?: (playerId: number, eventId: number, rewardIds: number[]) => void
    transactionFn?: <T>(operation: () => T) => T
}): CarnivalEventFinishResult | null {
    const { questCategory, questAccomplished, questData, clearTime, party, playerId, getRecordsFn, upsertFn } = params

    if (questCategory !== QuestCategory.CARNIVAL_EVENT || !questAccomplished) return null

    const { eventId, folderId, difficultyScore, timeLimitMs } = questData
    if (eventId === undefined || folderId === undefined || difficultyScore === undefined || timeLimitMs === undefined) return null

    const transactionFn = params.transactionFn ?? (operation => operation())
    return transactionFn(() => {
        const characterIds = party.characters.map(v => v?.id ?? null)
        const unisonCharacterIds = party.unison_characters.map(v => v?.id ?? null)
        const leaderCharId = party.leader?.id ?? 0
        const records = getRecordsFn(playerId, eventId)
        const previousTotalBestScore = records.reduce(
            (sum, record) => sum + (record.bestScore ?? 0),
            0,
        )
        const previousFolderBestScore = records.find(record => record.folderId === folderId)?.bestScore ?? 0
        const difficultyBonus = difficultyScore
        const timeBonus = Math.max(0, timeLimitMs - Math.round(clearTime))
        const totalScore = difficultyBonus + timeBonus
        const totalBestScore = previousTotalBestScore
            - previousFolderBestScore
            + Math.max(previousFolderBestScore, totalScore)

        upsertFn(playerId, eventId, folderId, totalScore, characterIds, unisonCharacterIds)

        const rewardDefinitions = params.getRewardDefinitionsFn?.(eventId) ?? []
        const claimedRewardIds = params.getClaimedRewardIdsFn?.(playerId, eventId) ?? new Set<number>()
        const eligibleRewards = getEligibleCarnivalRewards(
            rewardDefinitions,
            eventId,
            totalBestScore,
            claimedRewardIds,
        )
        const rewardResult = eligibleRewards.length > 0 && params.grantRewardsFn !== undefined
            ? params.grantRewardsFn(playerId, eligibleRewards)
            : emptyRewardResult()
        const rewardIds = eligibleRewards.map(reward => reward.id)
        const backfilledThresholds = eligibleRewards
            .filter(reward => reward.score <= previousTotalBestScore)
            .map(reward => reward.score)
        // The client derives the reward popup rows from previous/current score, not reward_ids.
        const popupPreviousTotalBestScore = backfilledThresholds.length > 0
            ? Math.min(previousTotalBestScore, Math.min(...backfilledThresholds) - 1)
            : previousTotalBestScore
        if (rewardIds.length > 0) {
            params.claimRewardIdsFn?.(playerId, eventId, rewardIds)
        }

        return {
            carnivalEventData: {
                is_record_valid: true,
                leader_character_id: leaderCharId,
                new_degree_ids: rewardResult.new_degree_ids,
                previous_total_best_score: popupPreviousTotalBestScore,
                reward_ids: rewardIds,
                score: { difficulty_bonus: difficultyBonus, time_bonus: timeBonus },
            },
            rewardResult,
        }
    })
}
