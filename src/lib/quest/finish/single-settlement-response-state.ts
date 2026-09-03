import type { Player } from "../../../data/types"
import type {
    RewardGrantExecutionResult,
    RewardGrantKnownPlayerState,
} from "../../reward-grant"
import type { Reward } from "../../types"
import { getAwakeFactKeysFromRewardGrants } from "../../mission/awake-reward-facts"
import type { FactKey } from "../../mission/facts/fact-key"
import {
    grantSingleSettlementRewardsWithinTransactionSync,
    projectSingleSettlementRewardGrant,
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
    readonly rewardPlayerState: RewardGrantKnownPlayerState
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
        freeMana: rewardPlayerState.freeMana,
        freeVmoney: rewardPlayerState.freeVmoney,
        expPool: rewardPlayerState.expPool,
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
    readonly userInfo?: Readonly<Record<string, number>>
}

export function createSingleSettlementResponseState(playerId: number, player: Player) {
    if (player.id !== playerId) {
        throw new Error(`Single settlement Player ${player.id} does not match owner ${playerId}`)
    }
    let playerState: RewardGrantKnownPlayerState = {
        playerId: player.id,
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
    }
    let degreeId = player.degreeId
    let rewardInvalidatedFactKeys: readonly FactKey[] = Object.freeze([])
    const itemList: Record<string, number> = {}
    const observeItems = (items: Readonly<Record<string, number>> | undefined): void => {
        if (items !== undefined) Object.assign(itemList, items)
    }
    const observeGrant = (grant: RewardGrantExecutionResult): void => {
        playerState = grant.playerAfter
        const invalidated = getAwakeFactKeysFromRewardGrants(grant)
        if (invalidated.length > 0) rewardInvalidatedFactKeys = invalidated
        observeItems(Object.fromEntries(grant.assets.items.map(item => [
            String(item.itemId),
            item.afterAmount,
        ])))
    }
    return {
        get playerState(): RewardGrantKnownPlayerState {
            return playerState
        },
        get rewardInvalidatedFactKeys(): readonly FactKey[] {
            return rewardInvalidatedFactKeys
        },
        setPlayerState(state: RewardGrantKnownPlayerState): void {
            playerState = state
        },
        setExpPool(expPool: number): void {
            playerState = { ...playerState, expPool }
        },
        grant(
            targetPlayerId: number,
            rewards: readonly Reward[],
        ) {
            const grant = grantSingleSettlementRewardsWithinTransactionSync(
                targetPlayerId,
                rewards,
                playerState,
            )
            observeGrant(grant)
            return projectSingleSettlementRewardGrant(grant)
        },
        observeGrant(grant: RewardGrantExecutionResult): void {
            observeGrant(grant)
        },
        observeResult(result: SingleSettlementObservedResult | undefined): void {
            if (result === undefined) return
            observeItems(result.itemList)
            if (result.userInfo !== undefined) {
                playerState = {
                    playerId: playerState.playerId,
                    freeMana: result.userInfo.free_mana ?? playerState.freeMana,
                    freeVmoney: result.userInfo.free_vmoney ?? playerState.freeVmoney,
                    expPool: result.userInfo.exp_pool ?? playerState.expPool,
                }
                degreeId = result.userInfo.degree_id ?? degreeId
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
