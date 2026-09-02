import { getPlayerSync } from "../../data/domains/player"
import {
    createRewardGrantPlan,
    type RewardGrantPlan,
    type RewardGrantReward,
} from "../reward-grant"
import type {
    InternalRewardGrantEntryResult,
    InternalRewardGrantResult,
} from "../reward-grant/entry-result"
import {
    emptyPlayerRewardResult,
} from "../reward-grant/entry-result"
import {
    executeRewardGrantPlanInTransactionOwnerInternalSync,
} from "../reward-grant/owner-executor"
import {
    RewardType,
    type GivePlayerScoreRewardsResult,
    type PlayerRewardResult,
    type Reward,
} from "../types"
import {
    projectGrantedScoreRewardSettlementResult,
    projectScoreRewardSettlementResult,
} from "./score-reward-settlement"
import type {
    ScoreRewardSelection,
    ScoreRewardSource,
} from "./score-reward-selection"

export interface LegacyQuestRewardSource {
    readonly index: number
}

function executeLegacyQuestRewardPlanWithinTransactionSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
): InternalRewardGrantResult<TSource> | null {
    if (plan.entries.length === 0) return null

    // Legacy callers grant several reward phases in sequence. Read the current
    // state for every facade call rather than reusing a settlement-start snapshot.
    const player = getPlayerSync(playerId)
    if (player === null) return null

    return executeRewardGrantPlanInTransactionOwnerInternalSync(
        playerId,
        plan,
        {
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        },
    )
}

function projectLegacyQuestRewardEntries(
    entries: readonly InternalRewardGrantEntryResult<LegacyQuestRewardSource>[],
): PlayerRewardResult {
    const result = emptyPlayerRewardResult()
    const characters = new Map<number, Object>()
    const equipment = new Map<number, Object>()
    const items = new Map<number, number>()

    for (const entry of entries) {
        result.user_info.free_mana += entry.result.user_info.free_mana
        result.user_info.free_vmoney += entry.result.user_info.free_vmoney
        result.user_info.exp_pool += entry.result.user_info.exp_pool

        if (entry.reward.type === RewardType.CHARACTER) {
            for (const character of entry.result.character_list) {
                characters.set(entry.reward.id, character)
            }
        }
        if (entry.reward.type === RewardType.EQUIPMENT) {
            for (const grantedEquipment of entry.result.equipment_list) {
                equipment.set(entry.reward.id, grantedEquipment)
            }
        }

        const projectedItems = entry.reward.type === RewardType.CHARACTER
            ? entry.itemDeltas ?? {}
            : entry.result.items
        for (const [itemIdText, count] of Object.entries(projectedItems)) {
            const itemId = Number(itemIdText)
            items.set(itemId, (items.get(itemId) ?? 0) + count)
        }
    }

    result.character_list = [...characters.values()]
    result.equipment_list = [...equipment.values()]
    for (const [itemId, count] of items) result.items[itemId] = count

    // This facade historically never reported newly joined character IDs.
    result.joined_character_id_list = []
    return result
}

export function grantLegacyQuestRewardsWithinTransactionSync(
    playerId: number,
    rewards: readonly Reward[],
): PlayerRewardResult | null {
    if (rewards.length === 0) return emptyPlayerRewardResult()

    const plan = createRewardGrantPlan(rewards.map((reward, index) => ({
        source: { index },
        reward: reward as RewardGrantReward,
    })))
    const grant = executeLegacyQuestRewardPlanWithinTransactionSync(playerId, plan)
    return grant === null ? null : projectLegacyQuestRewardEntries(grant.entries)
}

export function grantLegacyQuestScoreRewardsWithinTransactionSync(
    playerId: number,
    selection: ScoreRewardSelection,
): GivePlayerScoreRewardsResult {
    const grant = executeLegacyQuestRewardPlanWithinTransactionSync<ScoreRewardSource>(
        playerId,
        selection.plan,
    )
    return grant === null
        ? projectScoreRewardSettlementResult(selection, emptyPlayerRewardResult(), [])
        : projectGrantedScoreRewardSettlementResult(selection, grant)
}
