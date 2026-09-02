import {
    withInventoryBatchContextWithinTransactionSync,
} from "../inventory"

export interface EntryItemInventoryMutationResult {
    readonly afterAmount: number
    readonly obtainedAmount: number
}

export interface EntryItemInventoryPort {
    readAmount(itemId: number): number
    deduct(itemId: number, amount: number): EntryItemInventoryMutationResult
    restore(itemId: number, amount: number): EntryItemInventoryMutationResult
    flush(): void
}

export type WithEntryItemInventory = <T>(
    playerId: number,
    operation: (inventory: EntryItemInventoryPort) => T,
) => T

export const withEntryItemInventoryWithinTransactionSync: WithEntryItemInventory = (
    playerId,
    operation,
) => withInventoryBatchContextWithinTransactionSync({
    playerId,
    playerExistence: "caller-verified",
}, inventory => operation({
    readAmount: itemId => inventory.read(itemId).afterAmount,
    deduct: (itemId, amount) => inventory.deduct(itemId, amount),
    restore: (itemId, amount) => inventory.restore(itemId, amount),
    flush: () => { inventory.flush() },
}))
