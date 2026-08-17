import type {
    RewardGrantPlayerAfter,
    RewardGrantResult,
    RewardGrantReward,
} from "../../reward-grant"
import {
    createRewardGrantPlan,
} from "../../reward-grant"
import {
    executeRewardGrantPlanInTransactionOwnerInternalSync,
    executeRewardGrantPlanInTransactionOwnerSync,
} from "../../reward-grant/owner-executor"
import {
    projectPublicRewardGrantResult,
    type InternalRewardGrantResult,
} from "../../reward-grant/entry-result"
import type { GivePlayerScoreRewardsResult, Reward } from "../../types"
import {
    projectGrantedScoreRewardSettlementResult,
} from "../score-reward-settlement"
import type {
    ScoreRewardSelection,
    ScoreRewardSource,
} from "../score-reward-selection"

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

export function withSingleSettlementExpPool(
    state: RewardGrantPlayerAfter,
    expPool: number,
): RewardGrantPlayerAfter {
    return { ...state, expPool }
}

export interface SingleSettlementScoreRewardGrant {
    readonly grant: RewardGrantResult<ScoreRewardSource>
    readonly result: GivePlayerScoreRewardsResult
}

export function grantSingleSettlementScoreRewardsWithinTransactionSync(
    playerId: number,
    selection: ScoreRewardSelection,
    knownPlayerBefore: RewardGrantPlayerAfter,
): SingleSettlementScoreRewardGrant {
    // Internal detail stays local to Score projection; the adapter's grant remains public.
    const detailedGrant: InternalRewardGrantResult<ScoreRewardSource> =
        executeRewardGrantPlanInTransactionOwnerInternalSync(
            playerId,
            selection.plan,
            knownPlayerBefore,
        )
    const grant = projectPublicRewardGrantResult(detailedGrant)
    return {
        grant,
        result: projectGrantedScoreRewardSettlementResult(selection, detailedGrant),
    }
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
