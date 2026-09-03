import {
    createRewardGrantExecutionPlan,
    collectRewardGrantItemOverflowDispositions,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    type RewardGrantExecutionOptions,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
    type RewardGrantCommand,
    type RewardGrantKnownPlayerState,
} from "../../reward-grant"
import type { GivePlayerScoreRewardsResult, PlayerRewardResult, Reward } from "../../types"
import {
    projectGrantedScoreRewardSettlementResult,
} from "../score-reward-settlement"
import type { ScoreRewardSelection } from "../score-reward-selection"
import { validateScoreRewardSelection } from "../score-reward-projection"

export function withSingleSettlementExpPool(
    state: RewardGrantKnownPlayerState,
    expPool: number,
): RewardGrantKnownPlayerState {
    return { ...state, expPool }
}

export function projectSingleSettlementRewardGrant(
    grant: RewardGrantExecutionResult,
): PlayerRewardResult {
    const currency = Object.fromEntries(grant.assets.currencies.map(entry => [
        entry.currency,
        entry.requestedAmount,
    ]))
    const itemOverflowDispositions = collectRewardGrantItemOverflowDispositions(grant)
    return {
        user_info: {
            free_mana: currency.freeMana ?? 0,
            free_vmoney: currency.freeVmoney ?? 0,
            exp_pool: currency.expPool ?? 0,
        },
        character_list: grant.assets.characters.map(entry => entry.after),
        joined_character_id_list: grant.assets.characters
            .filter(entry => entry.joined)
            .map(entry => entry.characterId),
        equipment_list: grant.assets.equipment.map(entry => entry.after),
        items: Object.fromEntries(grant.assets.items.map(entry => [
            String(entry.itemId),
            entry.afterAmount,
        ])),
        ...(itemOverflowDispositions.length === 0
            ? {}
            : { itemOverflowDispositions }),
    }
}

export interface SingleSettlementScoreRewardGrant {
    readonly grant: RewardGrantExecutionResult
    readonly result: GivePlayerScoreRewardsResult
}

export function grantSingleSettlementScoreRewardsWithinTransactionSync(
    playerId: number,
    selection: ScoreRewardSelection,
    knownPlayerBefore: RewardGrantKnownPlayerState,
    options: RewardGrantExecutionOptions = {},
): SingleSettlementScoreRewardGrant {
    validateScoreRewardSelection(selection)
    const grant = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
        playerId,
        selection.plan,
        knownPlayerBefore,
        options,
    )
    return {
        grant,
        result: projectGrantedScoreRewardSettlementResult(selection, grant),
    }
}

export function grantSingleSettlementRewardsWithinTransactionSync(
    playerId: number,
    rewards: readonly Reward[],
    knownPlayerBefore: RewardGrantKnownPlayerState,
    options: RewardGrantExecutionOptions = {},
): RewardGrantExecutionResult {
    const plan = createRewardGrantExecutionPlan(rewards as readonly RewardGrantCommand[])
    return grantSingleSettlementPlanWithinTransactionSync(playerId, plan, knownPlayerBefore, options)
}

export function grantSingleSettlementPlanWithinTransactionSync(
    playerId: number,
    plan: RewardGrantExecutionPlan,
    knownPlayerBefore: RewardGrantKnownPlayerState,
    options: RewardGrantExecutionOptions = {},
): RewardGrantExecutionResult {
    return executeRewardGrantExecutionPlanAsTransactionOwnerSync(
        playerId,
        plan,
        knownPlayerBefore,
        options,
    )
}
