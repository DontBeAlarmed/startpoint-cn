import { getPlayerSync } from "../data/domains/player"
import {
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    type RewardGrantCommand,
    type RewardGrantExecutionResult,
} from "./reward-grant"
import {
    getAwakeFactKeysFromRewardGrants,
} from "./mission/awake-reward-facts"
import type { FactKey } from "./mission/facts/fact-key"
import type { PlayerRewardResult, Reward } from "./types"

export interface StoryRewardGrantResult {
    readonly rewardResult: PlayerRewardResult
    readonly invalidatedFactKeys: readonly FactKey[]
}

function projectStoryRewardGrant(grant: RewardGrantExecutionResult): PlayerRewardResult {
    const result: PlayerRewardResult = {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
    for (const entry of grant.entries) {
        const outcome = entry.outcome
        if (outcome.kind === "currency") {
            const field = outcome.currency === "freeMana"
                ? "free_mana"
                : outcome.currency === "freeVmoney" ? "free_vmoney" : "exp_pool"
            result.user_info[field] += outcome.requestedAmount
        } else if (outcome.kind === "item") {
            result.items[outcome.item.itemId] = outcome.item.afterAmount
        } else if (outcome.kind === "character") {
            result.character_list = [outcome.after]
            if (outcome.compensationItem !== null) {
                result.items[outcome.compensationItem.itemId]
                    = outcome.compensationItem.acceptedAmount
            }
        } else {
            result.equipment_list = [outcome.after]
        }
    }
    return result
}

export function grantStoryRewardWithinTransactionSync(
    playerId: number,
    reward: Reward,
): StoryRewardGrantResult {
    const player = getPlayerSync(playerId)
    if (player === null) throw new Error(`Story reward Player ${playerId} does not exist`)
    const plan = createRewardGrantExecutionPlan([reward as RewardGrantCommand])
    const grant = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
        playerId,
        plan,
        {
            playerId: player.id,
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        },
    )
    return {
        rewardResult: projectStoryRewardGrant(grant),
        invalidatedFactKeys: getAwakeFactKeysFromRewardGrants(grant),
    }
}
