import { getDb } from "../../data/db"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { givePlayerCharacterWithinTransactionSync } from "../character"
import { givePlayerEquipmentSync } from "../equipment"
import { PlayerRewardResult, RewardType } from "../types/rewards"
import { createRewardGrantPlan } from "./plan"
import {
    grantOwnerCurrency,
    persistOwnerCurrency,
    type RewardGrantOwnerPlayerUpdate,
} from "./owner-currency"
import {
    aggregateRewardGrantEntryResults,
    createRewardGrantEntryResult,
    emptyPlayerRewardResult,
    projectPublicRewardGrantResult,
    type InternalRewardGrantEntryResult,
    type InternalRewardGrantResult,
    type RewardGrantEntryExecution,
} from "./entry-result"
import {
    withExternalRewardGrantInventoryBatchSync,
    withRewardGrantInventoryBatchSync,
    type RewardGrantInventoryBatch,
} from "./inventory-adapter"
import type { InventoryBatchContext } from "../inventory"
import {
    RewardGrantEntry,
    RewardGrantPlan,
    RewardGrantPlayerAfter,
    RewardGrantResult,
    RewardGrantReward,
} from "./types"

export { RewardGrantKnownPlayerValidationError } from "./known-player"

export class RewardGrantTransactionRequiredError extends Error {
    constructor() {
        super("Reward grant execution requires an active transaction")
        this.name = "RewardGrantTransactionRequiredError"
    }
}

export class RewardGrantPlayerNotFoundError extends Error {
    readonly playerId: number

    constructor(playerId: number) {
        super(`Reward grant player not found: ${playerId}`)
        this.name = "RewardGrantPlayerNotFoundError"
        this.playerId = playerId
    }
}

export class RewardGrantExecutionError extends Error {
    readonly entryIndex: number
    readonly rewardType: RewardType

    constructor(entryIndex: number, rewardType: RewardType, message: string) {
        super(`Reward grant entry ${entryIndex} failed: ${message}`)
        this.name = "RewardGrantExecutionError"
        this.entryIndex = entryIndex
        this.rewardType = rewardType
    }
}

export function normalizeRewardGrantPlanInternal<TSource>(
    plan: RewardGrantPlan<TSource>,
): RewardGrantPlan<TSource> {
    const entries = typeof plan === "object" && plan !== null
        ? (plan as unknown as Record<string, unknown>).entries
        : undefined
    return createRewardGrantPlan(
        entries as readonly RewardGrantEntry<TSource>[],
    )
}

function getExistingPlayer(playerId: number) {
    const player = getPlayerSync(playerId)
    if (player === null) throw new RewardGrantPlayerNotFoundError(playerId)
    return player
}

function grantCurrencySync(
    playerId: number,
    reward: Extract<RewardGrantReward, { type: RewardType.BEADS | RewardType.MANA | RewardType.EXP }>,
): PlayerRewardResult {
    const player = getExistingPlayer(playerId)
    const result = emptyPlayerRewardResult()
    switch (reward.type) {
        case RewardType.BEADS:
            result.user_info.free_vmoney = reward.count
            updatePlayerSync({ id: playerId, freeVmoney: player.freeVmoney + reward.count })
            break
        case RewardType.MANA:
            result.user_info.free_mana = reward.count
            updatePlayerSync({
                id: playerId,
                freeMana: player.freeMana + reward.count,
                totalManaObtained: player.totalManaObtained + reward.count,
            })
            break
        case RewardType.EXP:
            result.user_info.exp_pool = reward.count
            updatePlayerSync({ id: playerId, expPool: player.expPool + reward.count })
            break
    }
    return result
}

function grantEntrySync(
    playerId: number,
    reward: RewardGrantReward,
    entryIndex: number,
    grantCurrency: typeof grantCurrencySync,
    grantItem: (itemId: number, amount: number) => number,
    grantCharacter: (
        playerId: number,
        characterId: number,
    ) => ReturnType<typeof givePlayerCharacterWithinTransactionSync>,
    getGrantedItemCount: (itemId: number) => number | null,
): RewardGrantEntryExecution {
    const result = emptyPlayerRewardResult()
    switch (reward.type) {
        case RewardType.ITEM:
        case RewardType.ELEMENT:
        case RewardType.AETHER:
            result.items[reward.id] = grantItem(reward.id, reward.count)
            return { result }
        case RewardType.EQUIPMENT:
            result.equipment_list.push(
                givePlayerEquipmentSync(playerId, reward.id, reward.count),
            )
            return { result }
        case RewardType.CHARACTER: {
            const granted = grantCharacter(playerId, reward.id)
            if (granted === null) {
                throw new RewardGrantExecutionError(
                    entryIndex,
                    reward.type,
                    `unknown character ${reward.id}`,
                )
            }
            result.character_list.push(granted.character)
            if (granted.isNew) result.joined_character_id_list.push(reward.id)
            if (granted.item !== undefined) {
                const finalCount = getGrantedItemCount(granted.item.id)
                if (finalCount === null) {
                    throw new RewardGrantExecutionError(
                        entryIndex,
                        reward.type,
                        `missing compensation item ${granted.item.id}`,
                    )
                }
                result.items[granted.item.id] = finalCount
                return {
                    result,
                    itemDeltas: {
                        [String(granted.item.id)]: granted.item.count,
                    },
                }
            }
            return { result }
        }
        case RewardType.BEADS:
        case RewardType.MANA:
        case RewardType.EXP:
            return { result: grantCurrency(playerId, reward) }
    }
}

function executeNormalizedRewardGrantPlanSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
): InternalRewardGrantResult<TSource> {
    if (getPlayerSync(playerId) === null) throw new RewardGrantPlayerNotFoundError(playerId)

    return withRewardGrantInventoryBatchSync(playerId, plan, inventory => {
        const entries = plan.entries.map((entry, entryIndex) => createRewardGrantEntryResult(
            entry,
            grantEntrySync(
                playerId,
                entry.reward,
                entryIndex,
                grantCurrencySync,
                (itemId, amount) => inventory.grant(itemId, amount),
                (pid, characterId) => givePlayerCharacterWithinTransactionSync(
                    pid,
                    characterId,
                    (_itemOwnerId, itemId, amount) => {
                        inventory.grant(itemId, amount)
                    },
                ),
                itemId => inventory.readGranted(itemId),
            ),
        ))
        inventory.flush()
        const playerAfter = getExistingPlayer(playerId)
        return {
            aggregate: aggregateRewardGrantEntryResults(entries),
            entries,
            playerAfter: {
                freeMana: playerAfter.freeMana,
                freeVmoney: playerAfter.freeVmoney,
                expPool: playerAfter.expPool,
            },
        }
    })
}

function executeNormalizedRewardGrantPlanAsTransactionOwnerWithInventoryInternalSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
    playerUpdate: RewardGrantOwnerPlayerUpdate,
    inventory: RewardGrantInventoryBatch,
): InternalRewardGrantResult<TSource> {
    const playerAfter = { ...knownPlayerBefore }
    const currencyDeltas = { freeMana: 0, freeVmoney: 0, expPool: 0 }
    const entries = plan.entries.map((entry, entryIndex) => createRewardGrantEntryResult(
        entry,
        grantEntrySync(
            playerId,
            entry.reward,
            entryIndex,
            (_pid, reward) => grantOwnerCurrency(reward, playerAfter, currencyDeltas),
            (itemId, amount) => inventory.grant(itemId, amount),
            (pid, characterId) => givePlayerCharacterWithinTransactionSync(
                pid,
                characterId,
                (_itemOwnerId, itemId, amount) => {
                    inventory.grant(itemId, amount)
                },
            ),
            itemId => inventory.readGranted(itemId),
        ),
    ))
    inventory.flush()
    persistOwnerCurrency(playerId, playerAfter, currencyDeltas, playerUpdate)
    return { aggregate: aggregateRewardGrantEntryResults(entries), entries, playerAfter }
}

export function executeNormalizedRewardGrantPlanAsTransactionOwnerInternalSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
    playerUpdate: RewardGrantOwnerPlayerUpdate = {},
): InternalRewardGrantResult<TSource> {
    return withRewardGrantInventoryBatchSync(playerId, plan, inventory => (
        executeNormalizedRewardGrantPlanAsTransactionOwnerWithInventoryInternalSync(
            playerId,
            plan,
            knownPlayerBefore,
            playerUpdate,
            inventory,
        )
    ))
}

export function executeNormalizedRewardGrantPlanAsTransactionOwnerWithExternalInventoryInternalSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
    knownPlayerBefore: RewardGrantPlayerAfter,
    inventoryContext: InventoryBatchContext,
    playerUpdate: RewardGrantOwnerPlayerUpdate = {},
): InternalRewardGrantResult<TSource> {
    return withExternalRewardGrantInventoryBatchSync(inventoryContext, inventory => (
        executeNormalizedRewardGrantPlanAsTransactionOwnerWithInventoryInternalSync(
            playerId,
            plan,
            knownPlayerBefore,
            playerUpdate,
            inventory,
        )
    ))
}

export function executeRewardGrantPlanWithinTransactionSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
): RewardGrantResult<TSource> {
    const db = getDb()
    if (!db.inTransaction) throw new RewardGrantTransactionRequiredError()
    const normalizedPlan = normalizeRewardGrantPlanInternal(plan)
    return db.transaction(() => projectPublicRewardGrantResult(
        executeNormalizedRewardGrantPlanSync(playerId, normalizedPlan),
    ))()
}

export function executeRewardGrantPlanSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
): RewardGrantResult<TSource> {
    const normalizedPlan = normalizeRewardGrantPlanInternal(plan)
    return getDb().transaction(() => projectPublicRewardGrantResult(
        executeNormalizedRewardGrantPlanSync(playerId, normalizedPlan),
    ))()
}
