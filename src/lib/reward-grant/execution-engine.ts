import { givePlayerCharacterWithinTransactionSync } from "../character"
import { givePlayerEquipmentSync } from "../equipment"
import {
    getInventoryBatchCheckpoint,
    type InventoryBatchCheckpoint,
    type InventoryBatchContext,
} from "../inventory"
import {
    createPlayerResourceGrantState,
    grantPlayerResource,
    persistPlayerResourceGrantsWithinTransactionSync,
    snapshotPlayerResourceGrantState,
    type MutablePlayerResourceGrantState,
    type PlayerGrantResource,
    type PlayerResourceGrantState,
} from "../player-resource-grant"
import { RewardType } from "../types/rewards"
import {
    normalizePlannedItemOverflowDisposition,
    type PlannedItemOverflowDisposition,
} from "../item-overflow"
import {
    type RewardGrantCommand,
    type RewardGrantEntryOutcome,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
    type RewardGrantExecutionOptions,
    type RewardGrantItemOutcome,
    type RewardGrantKnownPlayerState,
    type RewardGrantObjectSnapshot,
} from "./execution-contract"
import { normalizeRewardGrantExecutionPlan } from "./execution-plan"
import { createRewardGrantExecutionResult } from "./execution-result"
import { normalizeRewardGrantKnownPlayerState } from "./execution-outcome"

export class RewardGrantAssetExecutionError extends Error {
    readonly entryIndex: number

    constructor(entryIndex: number, message: string) {
        super(`RewardGrant entry ${entryIndex} failed: ${message}`)
        this.name = "RewardGrantAssetExecutionError"
        this.entryIndex = entryIndex
    }
}

export interface PreparedRewardGrantExecution {
    readonly plan: RewardGrantExecutionPlan
    readonly result: RewardGrantExecutionResult
    readonly inventoryCheckpoint: InventoryBatchCheckpoint
    persistPlayerResources(): void
    writeItemOverflows(): void
}

function grantItem(
    inventory: InventoryBatchContext,
    itemId: number,
    requestedAmount: number,
    resources: MutablePlayerResourceGrantState,
    options: RewardGrantExecutionOptions,
    pendingItemOverflows: PlannedItemOverflowDisposition[],
): RewardGrantItemOutcome {
    if (options.itemOverflow === undefined) {
        const mutation = inventory.grant(itemId, requestedAmount)
        const beforeAmount = mutation.afterAmount - requestedAmount
        if (!Number.isSafeInteger(beforeAmount) || beforeAmount < 0) {
            throw new RewardGrantAssetExecutionError(-1, `invalid Item ${itemId} after-state`)
        }
        return Object.freeze({
            itemId,
            requestedAmount,
            acceptedAmount: requestedAmount,
            overflowAmount: 0,
            beforeAmount,
            afterAmount: mutation.afterAmount,
        })
    }
    const maxCount = options.itemOverflow.maxCount(itemId)
    const mutation = inventory.grantWithCapacity(itemId, requestedAmount, maxCount)
    let overflowDisposition: PlannedItemOverflowDisposition | null = null
    if (mutation.overflowAmount > 0) {
        overflowDisposition = normalizePlannedItemOverflowDisposition(
            options.itemOverflow.planOverflow(
                itemId,
                mutation.overflowAmount,
                resources.freeMana,
            ),
        )
        if (overflowDisposition.itemId !== itemId
            || overflowDisposition.overflowAmount !== mutation.overflowAmount) {
            throw new RewardGrantAssetExecutionError(-1, `invalid Item ${itemId} overflow disposition`)
        }
        if (overflowDisposition.kind === "sold" && overflowDisposition.acceptedMana > 0) {
            const mana = grantPlayerResource(
                resources,
                "freeMana",
                overflowDisposition.acceptedMana,
            )
            if (mana.beforeAmount !== overflowDisposition.manaBefore
                || mana.afterAmount !== overflowDisposition.manaAfter) {
                throw new RewardGrantAssetExecutionError(-1, `invalid Item ${itemId} sold Mana state`)
            }
        }
        pendingItemOverflows.push(overflowDisposition)
    }
    return Object.freeze({
        itemId,
        requestedAmount,
        acceptedAmount: mutation.acceptedAmount,
        overflowAmount: mutation.overflowAmount,
        beforeAmount: mutation.beforeAmount,
        afterAmount: mutation.afterAmount,
        ...(overflowDisposition === null
            ? {}
            : { overflowDispositions: Object.freeze([overflowDisposition]) }),
    })
}

function currencyForReward(type: RewardType): PlayerGrantResource | null {
    switch (type) {
        case RewardType.BEADS: return "freeVmoney"
        case RewardType.MANA: return "freeMana"
        case RewardType.EXP: return "expPool"
        default: return null
    }
}

function executeEntry(
    playerId: number,
    reward: RewardGrantCommand,
    entryIndex: number,
    inventory: InventoryBatchContext,
    resources: MutablePlayerResourceGrantState,
    options: RewardGrantExecutionOptions,
    pendingItemOverflows: PlannedItemOverflowDisposition[],
): RewardGrantEntryOutcome {
    switch (reward.type) {
        case RewardType.ITEM:
        case RewardType.ELEMENT:
        case RewardType.AETHER:
            return {
                kind: "item",
                item: grantItem(
                    inventory,
                    reward.id,
                    reward.count,
                    resources,
                    options,
                    pendingItemOverflows,
                ),
            }
        case RewardType.EQUIPMENT:
            return {
                kind: "equipment",
                equipmentId: reward.id,
                requestedAmount: reward.count,
                after: givePlayerEquipmentSync(
                    playerId,
                    reward.id,
                    reward.count,
                ) as RewardGrantObjectSnapshot,
            }
        case RewardType.CHARACTER: {
            const compensationItems: RewardGrantItemOutcome[] = []
            const granted = givePlayerCharacterWithinTransactionSync(
                playerId,
                reward.id,
                (_ownerId, itemId, amount) => {
                    if (compensationItems.length > 0) {
                        throw new RewardGrantAssetExecutionError(
                            entryIndex,
                            "Character produced more than one compensation Item",
                        )
                    }
                    compensationItems.push(
                        grantItem(
                            inventory,
                            itemId,
                            amount,
                            resources,
                            options,
                            pendingItemOverflows,
                        ),
                    )
                },
            )
            if (granted === null) {
                throw new RewardGrantAssetExecutionError(entryIndex, `unknown Character ${reward.id}`)
            }
            const compensationItem = compensationItems[0] ?? null
            if ((granted.item === undefined) !== (compensationItem === null)
                || (granted.item !== undefined && compensationItem !== null
                    && (granted.item.id !== compensationItem.itemId
                        || granted.item.count !== compensationItem.requestedAmount))) {
                throw new RewardGrantAssetExecutionError(
                    entryIndex,
                    "Character compensation result did not match its Inventory mutation",
                )
            }
            return {
                kind: "character",
                characterId: reward.id,
                isNew: granted.isNew,
                after: granted.character as RewardGrantObjectSnapshot,
                compensationItem,
            }
        }
        default: {
            const resource = currencyForReward(reward.type)
            if (resource === null) {
                throw new RewardGrantAssetExecutionError(entryIndex, "unsupported reward type")
            }
            const granted = grantPlayerResource(resources, resource, reward.count)
            return {
                kind: "currency",
                currency: granted.resource,
                requestedAmount: granted.requestedAmount,
                beforeAmount: granted.beforeAmount,
                afterAmount: granted.afterAmount,
            }
        }
    }
}

export function prepareRewardGrantExecution(
    playerId: number,
    rawPlan: RewardGrantExecutionPlan,
    knownPlayerBefore: RewardGrantKnownPlayerState,
    inventory: InventoryBatchContext,
    options: RewardGrantExecutionOptions = {},
): PreparedRewardGrantExecution {
    const plan = normalizeRewardGrantExecutionPlan(rawPlan)
    const known = normalizeRewardGrantKnownPlayerState(playerId, knownPlayerBefore)
    const resourceBefore: PlayerResourceGrantState = known
    const resources = createPlayerResourceGrantState(resourceBefore)
    const pendingItemOverflows: PlannedItemOverflowDisposition[] = []
    const outcomes = plan.entries.map((reward, entryIndex) => executeEntry(
        playerId,
        reward,
        entryIndex,
        inventory,
        resources,
        options,
        pendingItemOverflows,
    ))
    const resourceAfter = snapshotPlayerResourceGrantState(resources)
    const result = createRewardGrantExecutionResult(
        playerId,
        plan,
        outcomes,
        resourceAfter,
    )
    const inventoryCheckpoint = getInventoryBatchCheckpoint(inventory)
    let persisted = false
    return Object.freeze({
        plan,
        result,
        inventoryCheckpoint,
        persistPlayerResources() {
            if (persisted) {
                throw new RewardGrantAssetExecutionError(-1, "Player resources already persisted")
            }
            persistPlayerResourceGrantsWithinTransactionSync(resourceBefore, resourceAfter)
            persisted = true
        },
        writeItemOverflows() {
            for (const overflow of pendingItemOverflows) {
                options.itemOverflow?.finalizeOverflow(overflow)
            }
        },
    })
}
