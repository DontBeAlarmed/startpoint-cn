export type InventoryValidationReason =
    | "INVALID_PLAYER_ID"
    | "INVALID_ITEM_ID"
    | "INVALID_AMOUNT"
    | "INVALID_STORED_STATE"
    | "SAFE_INTEGER_OVERFLOW"

export class InventoryValidationError extends Error {
    readonly reason: InventoryValidationReason

    constructor(reason: InventoryValidationReason, message: string) {
        super(message)
        this.name = "InventoryValidationError"
        this.reason = reason
    }
}

export type InventoryTransactionReason =
    | "TRANSACTION_REQUIRED"
    | "ACTIVE_TRANSACTION_NOT_ALLOWED"
    | "BATCH_CONTEXT_CLOSED"

export class InventoryTransactionError extends Error {
    readonly reason: InventoryTransactionReason

    constructor(reason: InventoryTransactionReason, message: string) {
        super(message)
        this.name = "InventoryTransactionError"
        this.reason = reason
    }
}

export class InventoryInsufficientItemError extends Error {
    readonly playerId: number
    readonly itemId: number
    readonly beforeAmount: number
    readonly requestedDeduction: number

    constructor(
        playerId: number,
        itemId: number,
        beforeAmount: number,
        requestedDeduction: number,
    ) {
        super(
            `player ${playerId} has ${beforeAmount} of item ${itemId}; `
            + `cannot deduct ${requestedDeduction}`,
        )
        this.name = "InventoryInsufficientItemError"
        this.playerId = playerId
        this.itemId = itemId
        this.beforeAmount = beforeAmount
        this.requestedDeduction = requestedDeduction
    }
}
