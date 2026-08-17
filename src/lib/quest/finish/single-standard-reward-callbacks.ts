import type {
    RewardGrantPlan,
    RewardGrantPlayerAfter,
    RewardGrantResult,
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
    updatePlayerState: (state: RewardGrantPlayerAfter) => void,
): {
    assertTargetPlayer: (targetPlayerId: number) => void
    forCarnival: <TSource>(
        targetPlayerId: number,
        plan: RewardGrantPlan<TSource>,
        knownPlayerBefore: RewardGrantPlayerAfter,
    ) => RewardGrantResult<TSource>
    forMission: <TSource>(
        plan: RewardGrantPlan<TSource>,
        knownPlayerBefore: RewardGrantPlayerAfter,
        playerUpdate: { readonly degreeId?: number },
    ) => RewardGrantResult<TSource>
} {
    const grant = <TSource>(
        plan: RewardGrantPlan<TSource>,
        knownPlayerBefore: RewardGrantPlayerAfter,
        playerUpdate: { readonly degreeId?: number } = {},
    ): RewardGrantResult<TSource> => {
        const result = grantSingleSettlementPlanWithinTransactionSync(
            playerId,
            plan,
            knownPlayerBefore,
            playerUpdate,
        )
        updatePlayerState(result.playerAfter)
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
        forMission: (plan, knownPlayerBefore, playerUpdate) => grant(
            plan,
            knownPlayerBefore,
            playerUpdate,
        ),
    }
}
