import { getPlayerSync, updatePlayerSync } from "../data/domains/player"
import { getDb } from "../data/db"
import { getItemEffectSync, ItemEffectEntry } from "./assets"
import {
    type InventoryItemResult,
    withInventoryBatchContextWithinTransactionSync,
} from "./inventory"
import { createRewardGrantItemOverflowPolicy } from "./reward-grant-item-overflow"
import { computeRealTimeStamina } from "./stamina"
import { Player } from "../data/types"
import { getRealNow } from "../runtime/time/game-time"

const AS3_INT_MAX = 2_147_483_647

export interface ItemUseInventoryChange {
    readonly id: number
    readonly beforeCount: number
    readonly deductionCount: number
    readonly rewardCount: number
    readonly finalCount: number
}

export interface ItemUseRewardDelta {
    readonly id: number
    readonly count: number
}

export interface ItemUseStaminaPlan {
    readonly current: number
    readonly recovery: number
    readonly after: number
    readonly recoveryTime: Date
}

export interface ItemUsePlan {
    readonly inventoryChanges: readonly ItemUseInventoryChange[]
    readonly rewards: readonly ItemUseRewardDelta[]
    readonly stamina: ItemUseStaminaPlan | null
}

export class ItemUseValidationError extends Error {
    constructor(message: string, public readonly resultCode?: number) {
        super(message)
        this.name = "ItemUseValidationError"
    }
}

export class ItemUsePlayerNotFoundError extends Error {
    constructor() {
        super("Player not found.")
        this.name = "ItemUsePlayerNotFoundError"
    }
}

export interface ItemUseSettlementResult {
    readonly plan: ItemUsePlan
    readonly itemList: Record<string, number>
}

export interface ItemUseSettlementDependencies {
    readonly getPlayerSync: typeof getPlayerSync
    readonly createItemUseIntent: typeof createItemUseIntent
    readonly createItemUseStaminaPlan: typeof createItemUseStaminaPlan
    readonly updatePlayerSync: typeof updatePlayerSync
    readonly withInventoryBatchContextWithinTransactionSync:
        typeof withInventoryBatchContextWithinTransactionSync
}

interface ParsedItemRequest {
    readonly id: number
    readonly count: number
    readonly selectIndex: number
}

interface StaminaSummary {
    recovery: number
    hasItem: boolean
}

interface ItemUseStaminaIntent {
    readonly recovery: number
}

interface ItemUseIntent {
    readonly affectedItemIds: readonly number[]
    readonly deductions: readonly ItemUseRewardDelta[]
    readonly rewards: readonly ItemUseRewardDelta[]
    readonly stamina: ItemUseStaminaIntent | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRequest(body: unknown): ParsedItemRequest[] {
    if (!isRecord(body) || !Array.isArray(body.items) || body.items.length === 0) {
        throw new ItemUseValidationError("Invalid request body.")
    }

    return body.items.map((rawItem, index) => {
        const id = isRecord(rawItem) ? rawItem.id : undefined
        const count = isRecord(rawItem) ? rawItem.number : undefined
        const selectIndex = isRecord(rawItem) ? rawItem.selectIndex : undefined
        if (!isRecord(rawItem)
            || typeof id !== "number"
            || !Number.isSafeInteger(id)
            || id <= 0
            || typeof count !== "number"
            || !Number.isSafeInteger(count)
            || count <= 0
            || typeof selectIndex !== "number"
            || !Number.isSafeInteger(selectIndex)) {
            throw new ItemUseValidationError(`Invalid item request at index ${index}.`)
        }
        return {
            id,
            count,
            selectIndex,
        }
    })
}

function getCultivateReward(
    itemId: number,
    effect: ItemEffectEntry,
    selectIndex: number,
): { itemId: number; amount: number } {
    if (effect.effectKind !== 22) {
        throw new ItemUseValidationError(`Item ${itemId} is not a cultivate pack.`)
    }
    if (!Array.isArray(effect.selectRewards) || effect.selectRewards.length < 6) {
        throw new ItemUseValidationError(`Item ${itemId} has no complete selection rewards.`)
    }
    if (selectIndex < 1 || selectIndex > 6) {
        throw new ItemUseValidationError(`Invalid selection index for item ${itemId}.`)
    }

    const reward = effect.selectRewards[selectIndex - 1]
    const rewardItemId = isRecord(reward) ? reward.itemId : undefined
    const rewardAmount = isRecord(reward) ? reward.amount : undefined
    if (!isRecord(reward)
        || typeof rewardItemId !== "number"
        || !Number.isSafeInteger(rewardItemId)
        || rewardItemId <= 0
        || typeof rewardAmount !== "number"
        || !Number.isSafeInteger(rewardAmount)
        || rewardAmount <= 0) {
        throw new ItemUseValidationError(`Item ${itemId} has an invalid selection reward.`)
    }
    return { itemId: rewardItemId, amount: rewardAmount }
}

function getStaminaRecovery(
    effect: ItemEffectEntry,
    itemId: number,
    maxStaminaOverflow: number,
): number {
    if (effect.effectKind === 2) {
        return effect.effectValue
    }
    if (effect.effectKind === 3) {
        return Math.floor(Math.max(0, maxStaminaOverflow) * Math.max(0, effect.effectValue) / 100)
    }
    throw new ItemUseValidationError(`Unsupported item effect for item ${itemId}.`)
}

function addSafeCount(map: Map<number, number>, itemId: number, count: number): void {
    const next = (map.get(itemId) ?? 0) + count
    if (!Number.isSafeInteger(next) || next <= 0) {
        throw new ItemUseValidationError(`Item count overflow for item ${itemId}.`)
    }
    map.set(itemId, next)
}

function createItemUseIntent(
    body: unknown,
    maxStaminaOverflow: number,
): ItemUseIntent {
    const requests = parseRequest(body)
    const requestedCounts = new Map<number, number>()
    const selectedIndexes = new Map<number, number>()
    const rewardCounts = new Map<number, number>()
    const stamina: StaminaSummary = { recovery: 0, hasItem: false }

    for (const request of requests) {
        const effect = getItemEffectSync(request.id)
        if (!effect) throw new ItemUseValidationError(`Item ${request.id} has no effect.`)

        if (effect.effectKind === 22) {
            const previousIndex = selectedIndexes.get(request.id)
            if (previousIndex !== undefined && previousIndex !== request.selectIndex) {
                throw new ItemUseValidationError(`Item ${request.id} has conflicting selections.`)
            }
            selectedIndexes.set(request.id, request.selectIndex)
            const reward = getCultivateReward(request.id, effect, request.selectIndex)
            addSafeCount(rewardCounts, reward.itemId, reward.amount * request.count)
        } else if (effect.effectKind === 2 || effect.effectKind === 3) {
            const recovery = getStaminaRecovery(effect, request.id, maxStaminaOverflow)
            if (!Number.isFinite(recovery) || recovery < 0) {
                throw new ItemUseValidationError(`Item ${request.id} has invalid stamina recovery.`)
            }
            stamina.hasItem = true
            addSafeCount(requestedCounts, request.id, request.count)
            const totalRecovery = stamina.recovery + recovery * request.count
            if (!Number.isSafeInteger(totalRecovery)) {
                throw new ItemUseValidationError("Stamina recovery overflow.")
            }
            stamina.recovery = totalRecovery
        } else {
            throw new ItemUseValidationError(`Unsupported item effect for item ${request.id}.`)
        }

        if (effect.effectKind === 22) addSafeCount(requestedCounts, request.id, request.count)
    }

    const affectedItemIds = new Set([...requestedCounts.keys(), ...rewardCounts.keys()])
    if (stamina.hasItem) {
        if (stamina.recovery <= 0) throw new ItemUseValidationError("Zero recovery.")
    }

    if (affectedItemIds.size === 0) {
        throw new ItemUseValidationError("No supported items.")
    }

    return {
        affectedItemIds: [...affectedItemIds],
        deductions: [...requestedCounts].map(([id, count]) => ({ id, count })),
        rewards: [...rewardCounts].map(([id, count]) => ({ id, count })),
        stamina: stamina.hasItem ? { recovery: stamina.recovery } : null,
    }
}

function createItemUseStaminaPlan(
    player: Player,
    intent: ItemUseStaminaIntent | null,
    maxStaminaOverflow: number,
): ItemUseStaminaPlan | null {
    if (intent === null) return null
    const current = computeRealTimeStamina(player)
    if (current >= maxStaminaOverflow) {
        throw new ItemUseValidationError("Already at max stamina.", 2102)
    }
    return {
        current,
        recovery: intent.recovery,
        after: Math.min(current + intent.recovery, maxStaminaOverflow),
        recoveryTime: getRealNow(),
    }
}

function planInventoryChanges(
    intent: ItemUseIntent,
    inventory: readonly InventoryItemResult[],
): readonly ItemUseInventoryChange[] {
    const beforeByItemId = new Map(inventory.map(item => [item.itemId, item.beforeAmount]))
    const deductionByItemId = new Map(intent.deductions.map(item => [item.id, item.count]))
    const rewardByItemId = new Map(intent.rewards.map(item => [item.id, item.count]))

    return intent.affectedItemIds.map(itemId => {
        const beforeCount = beforeByItemId.get(itemId)
        if (beforeCount === undefined) {
            throw new Error(`Inventory preload omitted item ${itemId}.`)
        }
        const deductionCount = deductionByItemId.get(itemId) ?? 0
        const rewardCount = rewardByItemId.get(itemId) ?? 0
        if (beforeCount < deductionCount) throw new ItemUseValidationError("Insufficient items.")
        const finalCount = beforeCount - deductionCount + rewardCount
        if (!Number.isSafeInteger(finalCount) || finalCount < 0 || finalCount > AS3_INT_MAX) {
            throw new ItemUseValidationError(`Final item count is out of range for item ${itemId}.`)
        }
        return { id: itemId, beforeCount, deductionCount, rewardCount, finalCount }
    })
}

function projectItemList(
    changes: readonly ItemUseInventoryChange[],
    results: readonly InventoryItemResult[],
): Record<string, number> {
    const resultByItemId = new Map(results.map(result => [result.itemId, result]))
    return Object.fromEntries(changes.map(change => {
        const result = resultByItemId.get(change.id)
        const baseAfter = change.beforeCount - change.deductionCount
        const acceptedReward = result === undefined
            ? null
            : result.afterAmount - baseAfter
        if (result === undefined
            || !Number.isSafeInteger(acceptedReward)
            || (acceptedReward as number) < 0
            || (acceptedReward as number) > change.rewardCount
            || result.afterAmount > AS3_INT_MAX) {
            throw new Error(`Inventory flush result did not match item use plan for item ${change.id}.`)
        }
        return [String(change.id), result.afterAmount]
    }))
}

const DEFAULT_SETTLEMENT_DEPENDENCIES: ItemUseSettlementDependencies = {
    getPlayerSync,
    createItemUseIntent,
    createItemUseStaminaPlan,
    updatePlayerSync,
    withInventoryBatchContextWithinTransactionSync,
}

export function settleItemUseInCallerTransactionSync(
    playerId: number,
    body: unknown,
    maxStaminaOverflow: number,
    dependencies: ItemUseSettlementDependencies = DEFAULT_SETTLEMENT_DEPENDENCIES,
): ItemUseSettlementResult {
    if (!getDb().inTransaction) {
        throw new Error("settleItemUseInCallerTransactionSync requires an active caller transaction")
    }
    const player = dependencies.getPlayerSync(playerId)
    if (!player) throw new ItemUsePlayerNotFoundError()
    const intent = dependencies.createItemUseIntent(body, maxStaminaOverflow)

    return dependencies.withInventoryBatchContextWithinTransactionSync({
        playerId,
        preloadItemIds: intent.affectedItemIds,
    }, inventory => {
        const changes = planInventoryChanges(intent, inventory.readMany(intent.affectedItemIds))
        const staminaPlan = dependencies.createItemUseStaminaPlan(
            player,
            intent.stamina,
            maxStaminaOverflow,
        )
        for (const deduction of intent.deductions) inventory.deduct(deduction.id, deduction.count)
        const overflowPolicy = createRewardGrantItemOverflowPolicy(playerId)
        const pendingOverflows: Array<{ itemId: number, amount: number }> = []
        for (const reward of intent.rewards) {
            const grant = inventory.grantWithCapacity(
                reward.id,
                reward.count,
                overflowPolicy.maxCount(reward.id),
            )
            if (grant.overflowAmount > 0) {
                pendingOverflows.push({ itemId: reward.id, amount: grant.overflowAmount })
            }
        }
        if (staminaPlan !== null) {
            dependencies.updatePlayerSync({
                id: playerId,
                stamina: staminaPlan.after,
                staminaHealTime: staminaPlan.recoveryTime,
            })
        }
        const results = inventory.flush()
        for (const overflow of pendingOverflows) {
            overflowPolicy.writeOverflow(overflow.itemId, overflow.amount)
        }
        const plan: ItemUsePlan = {
            inventoryChanges: changes,
            rewards: intent.rewards,
            stamina: staminaPlan,
        }
        return { plan, itemList: projectItemList(changes, results) }
    })
}
