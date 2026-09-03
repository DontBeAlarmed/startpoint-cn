import type {
    RewardGrantExecutionOptions,
    RewardGrantExecutionPlan,
    RewardGrantExecutionResult,
    RewardGrantKnownPlayerState,
} from "../../reward-grant"
import { grantSingleSettlementPlanWithinTransactionSync } from "./single-settlement-reward-grant"

export class SingleSettlementRewardTargetMismatchError extends Error {
    constructor(
        readonly ownerPlayerId: number,
        readonly targetPlayerId: number,
    ) {
        super(`Single settlement reward target player ${targetPlayerId} does not match owner player ${ownerPlayerId}`)
        this.name = "SingleSettlementRewardTargetMismatchError"
    }
}

export function createSingleSettlementStandardRewardGrant(
    playerId: number,
    updatePlayerState: (state: RewardGrantKnownPlayerState) => void,
    observeGrant?: (grant: RewardGrantExecutionResult) => void,
    options: RewardGrantExecutionOptions = {},
): {
    assertTargetPlayer: (targetPlayerId: number) => void
    forCarnival: (
        targetPlayerId: number,
        plan: RewardGrantExecutionPlan,
        knownPlayerBefore: RewardGrantKnownPlayerState,
    ) => RewardGrantExecutionResult
    forMission: (
        plan: RewardGrantExecutionPlan,
        knownPlayerBefore: RewardGrantKnownPlayerState,
    ) => RewardGrantExecutionResult
} {
    const grant = (
        plan: RewardGrantExecutionPlan,
        knownPlayerBefore: RewardGrantKnownPlayerState,
    ): RewardGrantExecutionResult => {
        const result = grantSingleSettlementPlanWithinTransactionSync(
            playerId,
            plan,
            knownPlayerBefore,
            options,
        )
        updatePlayerState(result.playerAfter)
        observeGrant?.(result)
        return result
    }
    const assertTargetPlayer = (targetPlayerId: number): void => {
        if (targetPlayerId !== playerId) {
            throw new SingleSettlementRewardTargetMismatchError(playerId, targetPlayerId)
        }
    }
    return {
        assertTargetPlayer,
        forCarnival: (targetPlayerId, plan, knownPlayerBefore) => {
            assertTargetPlayer(targetPlayerId)
            return grant(plan, knownPlayerBefore)
        },
        forMission: grant,
    }
}
