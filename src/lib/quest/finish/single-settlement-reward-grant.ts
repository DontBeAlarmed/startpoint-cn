import type {
    RewardGrantPlayerAfter,
    RewardGrantResult,
    RewardGrantReward,
} from "../../reward-grant"
import {
    createRewardGrantPlan,
} from "../../reward-grant"
import { executeRewardGrantPlanInTransactionOwnerSync } from "../../reward-grant/executor"
import type { PlayerRewardResult, Reward } from "../../types"

export type SingleSettlementRewardSourceKind =
    | "clear"
    | "s_plus"
    | "additional"
    | "rush"
    | "score_attack"

export interface SingleSettlementRewardSource {
    readonly kind: SingleSettlementRewardSourceKind
    readonly index: number
}

export function advanceSingleSettlementRewardPlayerState(
    state: RewardGrantPlayerAfter,
    userInfo: PlayerRewardResult["user_info"],
): RewardGrantPlayerAfter {
    return {
        freeMana: state.freeMana + userInfo.free_mana,
        freeVmoney: state.freeVmoney + userInfo.free_vmoney,
        expPool: state.expPool + userInfo.exp_pool,
    }
}

export function withSingleSettlementExpPool(
    state: RewardGrantPlayerAfter,
    expPool: number,
): RewardGrantPlayerAfter {
    return { ...state, expPool }
}

export function grantSingleSettlementRewardsWithinTransactionSync(
    playerId: number,
    kind: SingleSettlementRewardSourceKind,
    rewards: readonly Reward[],
    knownPlayerBefore: RewardGrantPlayerAfter,
): RewardGrantResult<SingleSettlementRewardSource> {
    const plan = createRewardGrantPlan(rewards.map((reward, index) => ({
        source: { kind, index },
        reward: reward as RewardGrantReward,
    })))
    return executeRewardGrantPlanInTransactionOwnerSync(playerId, plan, knownPlayerBefore)
}
