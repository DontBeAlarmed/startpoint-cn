import { getPlayerSync } from "../../data/domains/player"
import {
    createRewardGrantExecutionPlan,
    collectRewardGrantItemOverflowDispositions,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
} from "../../lib/reward-grant"
import { createRewardGrantItemOverflowPolicy } from "../../lib/reward-grant-item-overflow"
import { getAwakeFactKeysFromRewardGrants } from "../../lib/mission/awake-reward-facts"
import type { FactKey } from "../../lib/mission/facts/fact-key"
import {
    selectScoreRewardGrantPlan,
    type ScoreRewardSelectionOptions,
} from "../../lib/quest/score-reward-selection"
import {
    projectGrantedScoreRewardSettlementResult,
    recordScoreRewardSettlement,
} from "../../lib/quest/score-reward-settlement"
import { validateScoreRewardSelection } from "../../lib/quest/score-reward-projection"
import type {
    GivePlayerScoreRewardsResult,
    PlayerRewardResult,
    Reward,
    ScoreReward,
} from "../../lib/types"

function emptyRewardResult(): PlayerRewardResult {
    return {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
}

function projectMultiRewardGrant(grant: RewardGrantExecutionResult): PlayerRewardResult {
    const result = emptyRewardResult()
    const characters = new Map<number, Object>()
    const equipment = new Map<number, Object>()
    for (const currency of grant.assets.currencies) {
        const field = currency.currency === "freeMana"
            ? "free_mana"
            : currency.currency === "freeVmoney" ? "free_vmoney" : "exp_pool"
        result.user_info[field] = currency.requestedAmount
    }
    for (const entry of grant.entries) {
        const outcome = entry.outcome
        if (outcome.kind === "item") {
            result.items[outcome.item.itemId]
                = (result.items[outcome.item.itemId] ?? 0) + outcome.item.afterAmount
        } else if (outcome.kind === "character") {
            characters.set(outcome.characterId, outcome.after)
            if (outcome.compensationItem !== null) {
                const compensation = outcome.compensationItem
                result.items[compensation.itemId]
                    = (result.items[compensation.itemId] ?? 0) + compensation.acceptedAmount
            }
        } else if (outcome.kind === "equipment") {
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

export class MultiSettlementRewardGranter {
    private playerFactInvalidated = false

    constructor(private readonly playerId: number) {}

    get invalidatedFactKeys(): readonly FactKey[] {
        return this.playerFactInvalidated
            ? Object.freeze([Object.freeze({ kind: "player" as const })])
            : Object.freeze([])
    }

    private execute(plan: RewardGrantExecutionPlan): RewardGrantExecutionResult | null {
        if (plan.entries.length === 0) return null
        const player = getPlayerSync(this.playerId)
        if (player === null) return null
        const grant = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            this.playerId,
            plan,
            {
                playerId: player.id,
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            },
            { itemOverflow: createRewardGrantItemOverflowPolicy(this.playerId) },
        )
        if (getAwakeFactKeysFromRewardGrants(grant).length > 0) {
            this.playerFactInvalidated = true
        }
        return grant
    }

    grantRewards(rewards: readonly Reward[]): PlayerRewardResult | null {
        if (rewards.length === 0) return emptyRewardResult()
        const plan = createRewardGrantExecutionPlan(rewards as readonly RewardGrantCommand[])
        const grant = this.execute(plan)
        return grant === null ? null : projectMultiRewardGrant(grant)
    }

    grantReward(reward: Reward): PlayerRewardResult | null {
        return this.grantRewards([reward])
    }

    grantScoreRewards(
        groupId?: number,
        scoreRewards?: readonly ScoreReward[],
        boostPointUsed = false,
        questElement?: number,
        lottery?: ScoreRewardSelectionOptions,
    ): GivePlayerScoreRewardsResult {
        const selection = selectScoreRewardGrantPlan(
            groupId,
            scoreRewards,
            boostPointUsed,
            questElement,
            lottery,
        )
        validateScoreRewardSelection(selection)
        const grant = this.execute(selection.plan)
        const result = grant === null
            ? { drop_score_reward_ids: [], drop_rare_reward_ids: [], ...emptyRewardResult() }
            : projectGrantedScoreRewardSettlementResult(selection, grant)
        if (grant !== null) {
            const itemOverflowDispositions = collectRewardGrantItemOverflowDispositions(grant)
            if (itemOverflowDispositions.length > 0) {
                result.itemOverflowDispositions = itemOverflowDispositions
            }
        }
        recordScoreRewardSettlement(this.playerId, selection, result)
        return result
    }
}
