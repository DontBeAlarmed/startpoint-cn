import { getDb } from "../../data/db"
import { withInventoryBatchContextWithinTransactionSync } from "./batch-context"
import { InventoryTransactionError } from "./errors"
import type {
    InventoryItemMutationCommand,
    InventoryItemResult,
    InventoryMutationKind,
} from "./model"

function applyMutation(
    kind: InventoryMutationKind,
    command: InventoryItemMutationCommand,
): InventoryItemResult {
    return withInventoryBatchContextWithinTransactionSync({
        playerId: command.playerId,
        preloadItemIds: [command.itemId],
    }, context => {
        switch (kind) {
            case "grant": context.grant(command.itemId, command.amount); break
            case "deduct": context.deduct(command.itemId, command.amount); break
            case "restore": context.restore(command.itemId, command.amount); break
        }
        const [result] = context.flush()
        if (result === undefined) throw new Error("inventory mutation did not produce a result")
        return result
    })
}

function withinTransaction(
    kind: InventoryMutationKind,
    command: InventoryItemMutationCommand,
): InventoryItemResult {
    const db = getDb()
    if (!db.inTransaction) {
        throw new InventoryTransactionError(
            "TRANSACTION_REQUIRED",
            "inventory within-transaction command requires an active transaction",
        )
    }
    return db.transaction(() => applyMutation(kind, command))()
}

function standalone(
    kind: InventoryMutationKind,
    command: InventoryItemMutationCommand,
): InventoryItemResult {
    const db = getDb()
    if (db.inTransaction) {
        throw new InventoryTransactionError(
            "ACTIVE_TRANSACTION_NOT_ALLOWED",
            "inventory standalone command cannot run inside an active transaction",
        )
    }
    return db.transaction(() => applyMutation(kind, command))()
}

export function grantInventoryItemSync(command: InventoryItemMutationCommand): InventoryItemResult {
    return standalone("grant", command)
}

export function deductInventoryItemSync(command: InventoryItemMutationCommand): InventoryItemResult {
    return standalone("deduct", command)
}

export function restoreInventoryItemSync(command: InventoryItemMutationCommand): InventoryItemResult {
    return standalone("restore", command)
}

export function grantInventoryItemWithinTransactionSync(
    command: InventoryItemMutationCommand,
): InventoryItemResult {
    return withinTransaction("grant", command)
}

export function deductInventoryItemWithinTransactionSync(
    command: InventoryItemMutationCommand,
): InventoryItemResult {
    return withinTransaction("deduct", command)
}

export function restoreInventoryItemWithinTransactionSync(
    command: InventoryItemMutationCommand,
): InventoryItemResult {
    return withinTransaction("restore", command)
}
