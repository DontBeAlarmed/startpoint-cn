import {
    getPlayerItemSync,
    recordPlayerCollectedItemWithinTransactionSync,
    setPlayerItemWithinTransactionSync,
    updatePlayerItemSync,
} from "../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../data/domains/player"
import { getDb } from "../data/db"
import { getItemEffectSync, ItemEffectEntry } from "./assets"
import { computeRealTimeStamina } from "./stamina"
import { Player } from "../data/types"

const AS3_INT_MAX = 2_147_483_647

export interface ItemUseInventoryChange {
    readonly id: number
    readonly beforeCount: number
    readonly hasExistingRow: boolean
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
    readonly createItemUsePlan: typeof createItemUsePlan
    readonly applyItemUsePlanSync: typeof applyItemUsePlanSync
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

function createItemUsePlan(
    body: unknown,
    player: Player,
    maxStaminaOverflow: number,
): ItemUsePlan {
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

    const inventoryChanges: ItemUseInventoryChange[] = []
    const affectedItemIds = new Set([...requestedCounts.keys(), ...rewardCounts.keys()])
    for (const itemId of affectedItemIds) {
        const deductionCount = requestedCounts.get(itemId) ?? 0
        const rewardCount = rewardCounts.get(itemId) ?? 0
        const beforeAmount = getPlayerItemSync(player.id, itemId)
        const beforeCount = beforeAmount ?? 0
        if (beforeCount < deductionCount) throw new ItemUseValidationError("Insufficient items.")
        const finalCount = beforeCount - deductionCount + rewardCount
        if (!Number.isSafeInteger(finalCount) || finalCount < 0 || finalCount > AS3_INT_MAX) {
            throw new ItemUseValidationError(`Final item count is out of range for item ${itemId}.`)
        }
        inventoryChanges.push({
            id: itemId,
            beforeCount,
            hasExistingRow: beforeAmount !== null,
            deductionCount,
            rewardCount,
            finalCount,
        })
    }

    let staminaPlan: ItemUseStaminaPlan | null = null
    if (stamina.hasItem) {
        if (stamina.recovery <= 0) throw new ItemUseValidationError("Zero recovery.")
        const current = computeRealTimeStamina(player)
        if (current >= maxStaminaOverflow) {
            throw new ItemUseValidationError("Already at max stamina.", 2102)
        }
        const after = Math.min(current + stamina.recovery, maxStaminaOverflow)
        staminaPlan = {
            current,
            recovery: stamina.recovery,
            after,
            recoveryTime: new Date(),
        }
    }

    const rewards = [...rewardCounts].map(([id, count]): ItemUseRewardDelta => ({ id, count }))
    if (inventoryChanges.length === 0) {
        throw new ItemUseValidationError("No supported items.")
    }

    return { inventoryChanges, rewards, stamina: staminaPlan }
}

function applyItemUsePlanSync(playerId: number, plan: ItemUsePlan): Record<string, number> {
    for (const item of plan.inventoryChanges) {
        if (item.deductionCount > 0 && item.rewardCount === 0) {
            updatePlayerItemSync(playerId, item.id, item.beforeCount - item.deductionCount)
        }
    }
    if (plan.stamina !== null) {
        updatePlayerSync({
            id: playerId,
            stamina: plan.stamina.after,
            staminaHealTime: plan.stamina.recoveryTime,
        })
    }
    for (const item of plan.inventoryChanges) {
        if (item.rewardCount <= 0) continue
        setPlayerItemWithinTransactionSync(
            playerId,
            item.id,
            item.finalCount,
            item.hasExistingRow,
        )
        recordPlayerCollectedItemWithinTransactionSync(playerId, item.id, item.rewardCount)
    }

    return Object.fromEntries(plan.inventoryChanges.map(item => [
        String(item.id),
        item.finalCount,
    ]))
}

const DEFAULT_SETTLEMENT_DEPENDENCIES: ItemUseSettlementDependencies = {
    getPlayerSync,
    createItemUsePlan,
    applyItemUsePlanSync,
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
    const plan = dependencies.createItemUsePlan(body, player, maxStaminaOverflow)
    const itemList = dependencies.applyItemUsePlanSync(playerId, plan)
    return { plan, itemList }
}
