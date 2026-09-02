import { getPlayerSync } from "../../data/domains/player"
import {
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
} from "../reward-grant"
import {
    type GivePlayerScoreRewardsResult,
    type PlayerRewardResult,
    type Reward,
} from "../types"
import {
    projectGrantedScoreRewardSettlementResult,
} from "./score-reward-settlement"
import type {
    ScoreRewardSelection,
} from "./score-reward-selection"
import { validateScoreRewardSelection } from "./score-reward-projection"

function emptyLegacyQuestRewardResult(): PlayerRewardResult {
    return {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
}

function executeLegacyQuestRewardPlanWithinTransactionSync(
    playerId: number,
    plan: RewardGrantExecutionPlan,
): RewardGrantExecutionResult | null {
    if (plan.entries.length === 0) return null

    // Legacy callers grant several reward phases in sequence. Read the current
    // state for every facade call rather than reusing a settlement-start snapshot.
    const player = getPlayerSync(playerId)
    if (player === null) return null

    return executeRewardGrantExecutionPlanAsTransactionOwnerSync(
        playerId,
        plan,
        {
            playerId: player.id,
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        },
    )
}

function projectLegacyQuestRewardEntries(
    entries: RewardGrantExecutionResult["entries"],
): PlayerRewardResult {
    const result = emptyLegacyQuestRewardResult()
    const characters = new Map<number, Object>()
    const equipment = new Map<number, Object>()
    const items = new Map<number, number>()

    for (const entry of entries) {
        const outcome = entry.outcome
        if (outcome.kind === "currency") {
            const field = outcome.currency === "freeMana"
                ? "free_mana"
                : outcome.currency === "freeVmoney" ? "free_vmoney" : "exp_pool"
            result.user_info[field] += outcome.requestedAmount
        } else if (outcome.kind === "item") {
            items.set(
                outcome.item.itemId,
                (items.get(outcome.item.itemId) ?? 0) + outcome.item.afterAmount,
            )
        } else if (outcome.kind === "character") {
            characters.set(outcome.characterId, outcome.after)
            if (outcome.compensationItem !== null) {
                const compensation = outcome.compensationItem
                items.set(
                    compensation.itemId,
                    (items.get(compensation.itemId) ?? 0) + compensation.acceptedAmount,
                )
            }
        } else {
            equipment.set(outcome.equipmentId, outcome.after)
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
    if (rewards.length === 0) return emptyLegacyQuestRewardResult()

    const plan = createRewardGrantExecutionPlan(rewards as readonly RewardGrantCommand[])
    const grant = executeLegacyQuestRewardPlanWithinTransactionSync(playerId, plan)
    return grant === null ? null : projectLegacyQuestRewardEntries(grant.entries)
}

export function grantLegacyQuestScoreRewardsWithinTransactionSync(
    playerId: number,
    selection: ScoreRewardSelection,
): GivePlayerScoreRewardsResult {
    validateScoreRewardSelection(selection)
    const grant = executeLegacyQuestRewardPlanWithinTransactionSync(
        playerId,
        selection.plan,
    )
    if (grant === null) {
        return {
            drop_score_reward_ids: [],
            drop_rare_reward_ids: [],
            ...emptyLegacyQuestRewardResult(),
        }
    }
    return projectGrantedScoreRewardSettlementResult(selection, grant)
}
