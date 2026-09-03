import { getPlayerSync } from "../data/domains/player"
import {
    collectRewardGrantItemOverflowDispositions,
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    type RewardGrantCommand,
    type RewardGrantExecutionResult,
} from "./reward-grant"
import { createRewardGrantItemOverflowPolicy } from "./reward-grant-item-overflow"
import { getAwakeFactKeysFromRewardGrants } from "./mission/awake-reward-facts"
import type { FactKey } from "./mission/facts/fact-key"
import type { PlayerRewardResult, Reward } from "./types"

export interface RaidEventRewardGrantResult {
    readonly rewardResult: PlayerRewardResult
    readonly invalidatedFactKeys: readonly FactKey[]
}

function projectRaidEventRewards(grant: RewardGrantExecutionResult): PlayerRewardResult {
    const result: PlayerRewardResult = {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
    const characters = new Map<number, Object>()
    const equipment = new Map<number, Object>()
    for (const entry of grant.entries) {
        const outcome = entry.outcome
        if (outcome.kind === "currency") {
            const field = outcome.currency === "freeMana"
                ? "free_mana"
                : outcome.currency === "freeVmoney" ? "free_vmoney" : "exp_pool"
            result.user_info[field] += outcome.requestedAmount
        } else if (outcome.kind === "item") {
            result.items[outcome.item.itemId]
                = (result.items[outcome.item.itemId] ?? 0) + outcome.item.afterAmount
        } else if (outcome.kind === "character") {
            characters.set(outcome.characterId, outcome.after)
            if (outcome.compensationItem !== null) {
                const compensation = outcome.compensationItem
                result.items[compensation.itemId]
                    = (result.items[compensation.itemId] ?? 0) + compensation.acceptedAmount
            }
        } else {
            equipment.set(outcome.equipmentId, outcome.after)
        }
    }
    result.character_list = [...characters.values()]
    result.equipment_list = [...equipment.values()]
    const itemOverflowDispositions = collectRewardGrantItemOverflowDispositions(grant)
    if (itemOverflowDispositions.length > 0) {
        result.itemOverflowDispositions = itemOverflowDispositions
    }
    return result
}

export function grantRaidEventRewardsWithinTransactionSync(
    playerId: number,
    rewards: readonly Reward[],
): RaidEventRewardGrantResult {
    const player = getPlayerSync(playerId)
    if (player === null) throw new Error(`Raid reward Player ${playerId} does not exist`)
    const plan = createRewardGrantExecutionPlan(rewards as readonly RewardGrantCommand[])
    const grant = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
        playerId,
        plan,
        {
            playerId: player.id,
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        },
        { itemOverflow: createRewardGrantItemOverflowPolicy(playerId) },
    )
    return {
        rewardResult: projectRaidEventRewards(grant),
        invalidatedFactKeys: getAwakeFactKeysFromRewardGrants(grant),
    }
}
