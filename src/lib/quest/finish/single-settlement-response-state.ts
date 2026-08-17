import type { Player } from "../../../data/types"
import type {
    RewardGrantPlayerAfter,
    RewardGrantResult,
} from "../../reward-grant"
import type { Reward } from "../../types"
import {
    grantSingleSettlementRewardsWithinTransactionSync,
    type SingleSettlementRewardSourceKind,
} from "./single-settlement-reward-grant"

export interface SingleSettlementFinalPlayerProjection {
    readonly freeMana: number
    readonly freeVmoney: number
    readonly expPool: number
    readonly expPooledTime: Date
    readonly rankPoint: number
    readonly degreeId: number
    readonly stamina: number
    readonly staminaHealTime: Date
    readonly boostPoint: number
    readonly bossBoostPoint: number
}

export interface SingleSettlementFinalPlayerProjectionInput {
    readonly initialPlayer: Player
    readonly rewardPlayerState: RewardGrantPlayerAfter
    readonly rankPoint: number
    readonly degreeId: number
    readonly stamina: number
    readonly staminaHealTime: Date
    readonly boostPoint: number
    readonly bossBoostPoint: number
}

export function buildSingleSettlementFinalPlayerProjection({
    initialPlayer,
    rewardPlayerState,
    rankPoint,
    degreeId,
    stamina,
    staminaHealTime,
    boostPoint,
    bossBoostPoint,
}: SingleSettlementFinalPlayerProjectionInput): SingleSettlementFinalPlayerProjection {
    return {
        ...rewardPlayerState,
        expPooledTime: initialPlayer.expPooledTime,
        rankPoint,
        degreeId,
        stamina,
        staminaHealTime,
        boostPoint,
        bossBoostPoint,
    }
}

interface SingleSettlementObservedResult {
    readonly itemList: Readonly<Record<string, number>>
    readonly degreeIds: readonly number[]
    readonly userInfo?: Readonly<Record<string, number>>
}

export function createSingleSettlementResponseState(playerId: number, player: Player) {
    let playerState: RewardGrantPlayerAfter = {
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
    }
    let degreeId = player.degreeId
    const itemList: Record<string, number> = {}
    const observeItems = (items: Readonly<Record<string, number>> | undefined): void => {
        if (items !== undefined) Object.assign(itemList, items)
    }
    const observeGrant = <TSource>(grant: RewardGrantResult<TSource>): void => {
        playerState = grant.playerAfter
        observeItems(grant.aggregate.items)
    }
    return {
        get playerState(): RewardGrantPlayerAfter {
            return playerState
        },
        setPlayerState(state: RewardGrantPlayerAfter): void {
            playerState = state
        },
        setExpPool(expPool: number): void {
            playerState = { ...playerState, expPool }
        },
        grant(
            targetPlayerId: number,
            kind: SingleSettlementRewardSourceKind,
            rewards: readonly Reward[],
        ) {
            const grant = grantSingleSettlementRewardsWithinTransactionSync(
                targetPlayerId,
                kind,
                rewards,
                playerState,
            )
            observeGrant(grant)
            return grant.aggregate
        },
        observeGrant<TSource>(grant: RewardGrantResult<TSource>): void {
            observeGrant(grant)
        },
        observeResult(result: SingleSettlementObservedResult | undefined): void {
            if (result === undefined) return
            observeItems(result.itemList)
            degreeId = result.degreeIds.at(-1) ?? degreeId
            if (result.userInfo !== undefined) {
                playerState = {
                    freeMana: result.userInfo.free_mana ?? playerState.freeMana,
                    freeVmoney: result.userInfo.free_vmoney ?? playerState.freeVmoney,
                    expPool: result.userInfo.exp_pool ?? playerState.expPool,
                }
            }
        },
        observeItems,
        finalize(input: Omit<SingleSettlementFinalPlayerProjectionInput,
            "initialPlayer" | "rewardPlayerState" | "degreeId">) {
            return {
                itemList: { ...itemList },
                finalPlayerProjection: buildSingleSettlementFinalPlayerProjection({
                    ...input,
                    initialPlayer: player,
                    rewardPlayerState: playerState,
                    degreeId,
                }),
            }
        },
    }
}
