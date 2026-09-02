export interface InventoryItemResult {
    readonly itemId: number
    readonly beforeAmount: number
    readonly afterAmount: number
    readonly obtainedAmount: number
}

export interface InventoryItemMutationCommand {
    readonly playerId: number
    readonly itemId: number
    readonly amount: number
}

export type InventoryMutationKind = "grant" | "deduct" | "restore"
