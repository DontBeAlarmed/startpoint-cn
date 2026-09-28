import { getDb } from "../../data/db"
import {
    InventoryInsufficientItemError,
    InventoryTransactionError,
    InventoryValidationError,
} from "./errors"
import type { InventoryGrantResult, InventoryItemResult, InventoryMutationKind } from "./model"
import {
    InventorySqliteRepository,
    type InventoryStoredItem,
} from "./sqlite-repository"

interface PendingInventoryItem {
    readonly stored: InventoryStoredItem
    granted: number
    deducted: number
    restored: number
    touched: boolean
}

export interface InventoryBatchContextOptions {
    readonly playerId: number
    readonly preloadItemIds?: readonly number[]
    readonly playerExistence?: "verify" | "caller-verified"
}

export interface InventoryBatchContext {
    read(itemId: number): InventoryItemResult
    readMany(itemIds: readonly number[]): readonly InventoryItemResult[]
    grant(itemId: number, amount: number): InventoryItemResult
    grantWithCapacity(itemId: number, amount: number, maxCount: number): InventoryGrantResult
    deduct(itemId: number, amount: number): InventoryItemResult
    restore(itemId: number, amount: number): InventoryItemResult
    results(): readonly InventoryItemResult[]
    flush(): readonly InventoryItemResult[]
}

export interface InventoryBatchCheckpoint {
    readonly playerId: number
    readonly revision: number
}

interface InventoryBatchRuntimeState {
    readonly playerId: number
    revision: number
}

const inventoryBatchRuntimeStates = new WeakMap<object, InventoryBatchRuntimeState>()

function registerInventoryBatchContext(context: object, playerId: number): void {
    inventoryBatchRuntimeStates.set(context, { playerId, revision: 0 })
}

function recordInventoryBatchMutation(context: object): void {
    const state = inventoryBatchRuntimeStates.get(context)
    if (state === undefined) throw new Error("Inventory batch context is not registered")
    state.revision++
}

export function getInventoryBatchCheckpoint(
    context: InventoryBatchContext,
): InventoryBatchCheckpoint {
    const state = inventoryBatchRuntimeStates.get(context as object)
    if (state === undefined) {
        throw new InventoryTransactionError(
            "BATCH_CONTEXT_CLOSED",
            "inventory batch context is not owned by the Inventory runtime",
        )
    }
    return Object.freeze({ playerId: state.playerId, revision: state.revision })
}

/**
 * A callback-scoped batch that does not read Player or Item state until the
 * first real Inventory operation. Calling flush before activation is a no-op.
 * This is intended for mixed plans whose Item branch is only known at runtime.
 */
class DeferredInventoryBatchContext implements InventoryBatchContext {
    private readonly options: InventoryBatchContextOptions
    private active: InventoryBatchContextImpl | null = null
    private closed = false

    constructor(options: InventoryBatchContextOptions) {
        this.options = {
            playerId: positiveId(options.playerId, "INVALID_PLAYER_ID", "playerId"),
            preloadItemIds: Object.freeze(normalizeItemIds(options.preloadItemIds ?? [])),
            playerExistence: normalizePlayerExistence(options.playerExistence),
        }
        registerInventoryBatchContext(this, this.options.playerId)
    }

    read(itemId: number): InventoryItemResult {
        return this.requireActive().read(itemId)
    }

    readMany(itemIds: readonly number[]): readonly InventoryItemResult[] {
        return this.requireActive().readMany(itemIds)
    }

    grant(itemId: number, amount: number): InventoryItemResult {
        const result = this.requireActive().grant(itemId, amount)
        recordInventoryBatchMutation(this)
        return result
    }

    grantWithCapacity(itemId: number, amount: number, maxCount: number): InventoryGrantResult {
        const result = this.requireActive().grantWithCapacity(itemId, amount, maxCount)
        recordInventoryBatchMutation(this)
        return result
    }

    deduct(itemId: number, amount: number): InventoryItemResult {
        const result = this.requireActive().deduct(itemId, amount)
        recordInventoryBatchMutation(this)
        return result
    }

    restore(itemId: number, amount: number): InventoryItemResult {
        const result = this.requireActive().restore(itemId, amount)
        recordInventoryBatchMutation(this)
        return result
    }

    results(): readonly InventoryItemResult[] {
        this.assertUsable()
        return this.active?.results() ?? Object.freeze([])
    }

    flush(): readonly InventoryItemResult[] {
        this.assertUsable()
        if (this.active === null) {
            this.closed = true
            return Object.freeze([])
        }
        this.closed = true
        return this.active.flush()
    }

    closeCallbackScope(completedNormally: boolean): void {
        this.closed = true
        this.active?.closeCallbackScope(completedNormally)
    }

    private requireActive(): InventoryBatchContextImpl {
        this.assertUsable()
        if (this.active === null) {
            this.active = new InventoryBatchContextImpl(this.options)
        }
        return this.active
    }

    private assertUsable(): void {
        if (this.closed) {
            throw new InventoryTransactionError(
                "BATCH_CONTEXT_CLOSED",
                "inventory batch context is closed after flush or callback exit",
            )
        }
        assertActiveTransaction()
    }
}

function positiveId(value: unknown, reason: "INVALID_PLAYER_ID" | "INVALID_ITEM_ID", field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new InventoryValidationError(reason, `${field} must be a positive safe integer`)
    }
    return value
}

function normalizeItemIds(itemIds: readonly number[]): number[] {
    return [...new Set(itemIds.map(itemId => (
        positiveId(itemId, "INVALID_ITEM_ID", "itemId")
    )))].sort((left, right) => left - right)
}

function assertActiveTransaction(): void {
    if (!getDb().inTransaction) {
        throw new InventoryTransactionError(
            "TRANSACTION_REQUIRED",
            "inventory batch context requires an active transaction",
        )
    }
}

function normalizePlayerExistence(
    value: InventoryBatchContextOptions["playerExistence"],
): "verify" | "caller-verified" {
    if (value === undefined || value === "verify") return "verify"
    if (value === "caller-verified") return value
    throw new TypeError("invalid inventory player existence mode")
}

function mutationAmount(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new InventoryValidationError(
            "INVALID_AMOUNT",
            "inventory mutation amount must be a non-negative safe integer",
        )
    }
    return value
}

function addSafe(left: number, right: number, field: string): number {
    const result = left + right
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new InventoryValidationError(
            "SAFE_INTEGER_OVERFLOW",
            `${field} exceeds the safe integer range`,
        )
    }
    return result
}

function subtractSafe(left: number, right: number, field: string): number {
    const result = left - right
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new InventoryValidationError(
            "INVALID_STORED_STATE",
            `${field} would be a negative or unsafe integer`,
        )
    }
    return result
}

function freezeResult(result: InventoryItemResult): InventoryItemResult {
    return Object.freeze(result)
}

class InventoryBatchContextImpl implements InventoryBatchContext {
    private readonly playerId: number
    private readonly repository: InventorySqliteRepository
    private readonly pending = new Map<number, PendingInventoryItem>()
    private closed = false
    private flushed = false

    constructor(
        options: InventoryBatchContextOptions,
        repository: InventorySqliteRepository = new InventorySqliteRepository(),
    ) {
        this.assertActiveTransaction()
        this.playerId = positiveId(options.playerId, "INVALID_PLAYER_ID", "playerId")
        registerInventoryBatchContext(this, this.playerId)
        this.repository = repository
        if (normalizePlayerExistence(options.playerExistence) === "verify") {
            this.repository.requirePlayerSync(this.playerId)
        }
        this.load(options.preloadItemIds ?? [])
    }

    read(itemId: number): InventoryItemResult {
        this.assertUsable()
        return this.toResult(this.requirePending(itemId))
    }

    readMany(itemIds: readonly number[]): readonly InventoryItemResult[] {
        this.assertUsable()
        const ids = this.normalizeItemIds(itemIds)
        this.load(ids)
        return Object.freeze(ids.map(itemId => this.toResult(this.pending.get(itemId)!)))
    }

    grant(itemId: number, amount: number): InventoryItemResult {
        return this.mutate("grant", itemId, amount)
    }

    grantWithCapacity(itemId: number, amount: number, maxCount: number): InventoryGrantResult {
        this.assertUsable()
        const requestedAmount = mutationAmount(amount)
        const capacityLimit = mutationAmount(maxCount)
        const item = this.requirePending(itemId)
        const before = {
            granted: item.granted,
            deducted: item.deducted,
            restored: item.restored,
            touched: item.touched,
        }
        try {
            const currentAmount = addSafe(
                subtractSafe(item.stored.amount, item.deducted, `item ${item.stored.itemId} baseAmount`),
                item.restored,
                `item ${item.stored.itemId} baseAmount`,
            )
            const baseAmount = addSafe(
                currentAmount,
                item.granted,
                `item ${item.stored.itemId} currentAmount`,
            )
            const capacity = Math.max(0, capacityLimit - baseAmount)
            const acceptedAmount = Math.min(requestedAmount, capacity)
            item.granted = addSafe(
                item.granted,
                acceptedAmount,
                `item ${itemId} acceptedGrant`,
            )
            item.touched = true
            const mutation = this.toResult(item)
            recordInventoryBatchMutation(this as unknown as object)
            return Object.freeze({
                ...mutation,
                beforeAmount: baseAmount,
                requestedAmount,
                acceptedAmount,
                overflowAmount: requestedAmount - acceptedAmount,
            })
        } catch (error) {
            item.granted = before.granted
            item.deducted = before.deducted
            item.restored = before.restored
            item.touched = before.touched
            throw error
        }
    }

    deduct(itemId: number, amount: number): InventoryItemResult {
        return this.mutate("deduct", itemId, amount)
    }

    restore(itemId: number, amount: number): InventoryItemResult {
        return this.mutate("restore", itemId, amount)
    }

    results(): readonly InventoryItemResult[] {
        this.assertUsable()
        return this.projectTouchedResults()
    }

    flush(): readonly InventoryItemResult[] {
        this.assertUsable()
        const rows = [...this.pending.values()]
            .filter(item => item.touched)
            .sort((left, right) => left.stored.itemId - right.stored.itemId)
            .map(item => ({ item, result: this.toResult(item) }))
        this.closed = true
        const absoluteRows: { itemId: number; amount: number }[] = []
        const obtainedRows: { itemId: number; obtainedAmount: number }[] = []
        for (const { result } of rows) {
            absoluteRows.push({ itemId: result.itemId, amount: result.afterAmount })
            if (result.obtainedAmount > 0) {
                obtainedRows.push({ itemId: result.itemId, obtainedAmount: result.obtainedAmount })
            }
        }
        this.repository.writeAbsoluteItemsBatchSync(this.playerId, absoluteRows)
        this.repository.recordPositiveObtainedBatchSync(this.playerId, obtainedRows)
        this.flushed = true
        return Object.freeze(rows.map(({ result }) => result))
    }

    closeCallbackScope(completedNormally: boolean): void {
        const dirty = [...this.pending.values()].some(item => item.touched)
        this.closed = true
        if (completedNormally && dirty && !this.flushed) {
            throw new InventoryTransactionError(
                "UNFLUSHED_BATCH",
                "inventory batch callback returned with unflushed mutations",
            )
        }
    }

    private mutate(kind: InventoryMutationKind, itemId: number, rawAmount: number): InventoryItemResult {
        this.assertUsable()
        const amount = mutationAmount(rawAmount)
        const item = this.requirePending(itemId)
        const before = {
            granted: item.granted,
            deducted: item.deducted,
            restored: item.restored,
            touched: item.touched,
        }
        try {
            switch (kind) {
                case "grant":
                    item.granted = addSafe(item.granted, amount, `item ${itemId} requestedGrant`)
                    break
                case "deduct": {
                    const deducted = addSafe(item.deducted, amount, `item ${itemId} deductedAmount`)
                    if (deducted > item.stored.amount) {
                        throw new InventoryInsufficientItemError(
                            this.playerId,
                            item.stored.itemId,
                            item.stored.amount,
                            deducted,
                        )
                    }
                    item.deducted = deducted
                    break
                }
                case "restore":
                    item.restored = addSafe(item.restored, amount, `item ${itemId} restoredAmount`)
                    break
            }
            item.touched = true
            const result = this.toResult(item)
            recordInventoryBatchMutation(this)
            return result
        } catch (error) {
            item.granted = before.granted
            item.deducted = before.deducted
            item.restored = before.restored
            item.touched = before.touched
            throw error
        }
    }

    private requirePending(rawItemId: number): PendingInventoryItem {
        const itemId = positiveId(rawItemId, "INVALID_ITEM_ID", "itemId")
        const cached = this.pending.get(itemId)
        if (cached !== undefined) return cached
        const stored = this.repository.readItemSync(this.playerId, itemId)
        const pending = this.newPending(stored)
        this.pending.set(itemId, pending)
        return pending
    }

    private load(rawItemIds: readonly number[]): void {
        const itemIds = this.normalizeItemIds(rawItemIds)
            .filter(itemId => !this.pending.has(itemId))
        if (itemIds.length === 0) return
        const stored = this.repository.readItemsByIdsSync(this.playerId, itemIds)
        for (const itemId of itemIds) {
            const row = stored.get(itemId)
            if (row === undefined) {
                throw new InventoryValidationError(
                    "INVALID_STORED_STATE",
                    `inventory batch read omitted item ${itemId}`,
                )
            }
            this.pending.set(itemId, this.newPending(row))
        }
    }

    private newPending(stored: InventoryStoredItem): PendingInventoryItem {
        return { stored, granted: 0, deducted: 0, restored: 0, touched: false }
    }

    private toResult(item: PendingInventoryItem): InventoryItemResult {
        const baseAmount = addSafe(
            subtractSafe(item.stored.amount, item.deducted, `item ${item.stored.itemId} baseAmount`),
            item.restored,
            `item ${item.stored.itemId} baseAmount`,
        )
        const afterAmount = addSafe(
            baseAmount,
            item.granted,
            `item ${item.stored.itemId} afterAmount`,
        )
        return freezeResult({
            itemId: item.stored.itemId,
            beforeAmount: item.stored.amount,
            afterAmount,
            obtainedAmount: item.granted,
        })
    }

    private projectTouchedResults(): readonly InventoryItemResult[] {
        return Object.freeze([...this.pending.values()]
            .filter(item => item.touched)
            .sort((left, right) => left.stored.itemId - right.stored.itemId)
            .map(item => this.toResult(item)))
    }

    private normalizeItemIds(itemIds: readonly number[]): number[] {
        return normalizeItemIds(itemIds)
    }

    private assertActiveTransaction(): void {
        assertActiveTransaction()
    }

    private assertUsable(): void {
        if (this.closed) {
            throw new InventoryTransactionError(
                "BATCH_CONTEXT_CLOSED",
                "inventory batch context is closed after flush or callback exit",
            )
        }
        this.assertActiveTransaction()
    }
}

export function withInventoryBatchContextWithinTransactionSync<T>(
    options: InventoryBatchContextOptions,
    callback: (context: InventoryBatchContext) => T,
): T {
    if (typeof callback !== "function") {
        throw new TypeError("inventory batch callback must be a function")
    }
    const context = new InventoryBatchContextImpl(options)
    let completedNormally = false
    try {
        const result = callback(context)
        completedNormally = true
        return result
    } finally {
        context.closeCallbackScope(completedNormally)
    }
}

export function withDeferredInventoryBatchContextWithinTransactionSync<T>(
    options: InventoryBatchContextOptions,
    callback: (context: InventoryBatchContext) => T,
): T {
    if (typeof callback !== "function") {
        throw new TypeError("inventory batch callback must be a function")
    }
    assertActiveTransaction()
    const context = new DeferredInventoryBatchContext(options)
    let completedNormally = false
    try {
        const result = callback(context)
        completedNormally = true
        return result
    } finally {
        context.closeCallbackScope(completedNormally)
    }
}
