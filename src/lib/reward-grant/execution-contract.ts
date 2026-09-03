import { RewardType } from "../types/rewards"
import type { PlannedItemOverflowDisposition } from "../item-overflow"

export type RewardGrantItemCommand = Readonly<{
    readonly type: RewardType.ITEM | RewardType.ELEMENT | RewardType.AETHER
    readonly id: number
    readonly count: number
}>

export type RewardGrantEquipmentCommand = Readonly<{
    readonly type: RewardType.EQUIPMENT
    readonly id: number
    readonly count: number
}>

export type RewardGrantCharacterCommand = Readonly<{
    readonly type: RewardType.CHARACTER
    readonly id: number
}>

export type RewardGrantCurrencyCommand = Readonly<{
    readonly type: RewardType.BEADS | RewardType.MANA | RewardType.EXP
    readonly count: number
}>

export type RewardGrantCommand =
    | RewardGrantItemCommand
    | RewardGrantEquipmentCommand
    | RewardGrantCharacterCommand
    | RewardGrantCurrencyCommand

export interface RewardGrantExecutionPlan {
    readonly entries: readonly RewardGrantCommand[]
}

export interface RewardGrantItemOverflowPolicy {
    readonly playerId: number
    readonly maxCount: (itemId: number) => number
    readonly planOverflow: (
        itemId: number,
        overflowAmount: number,
        currentFreeMana: number,
    ) => PlannedItemOverflowDisposition
    readonly finalizeOverflow: (disposition: PlannedItemOverflowDisposition) => void
    /** Temporary compatibility for direct Inventory callers; removed in D18b Task 4. */
    readonly writeOverflow: (itemId: number, amount: number) => void
}

export interface RewardGrantExecutionOptions {
    readonly itemOverflow?: RewardGrantItemOverflowPolicy
}

export interface RewardGrantKnownPlayerState {
    readonly playerId: number
    readonly freeMana: number
    readonly freeVmoney: number
    readonly expPool: number
}

export interface RewardGrantItemOutcome {
    readonly itemId: number
    readonly requestedAmount: number
    readonly acceptedAmount: number
    readonly overflowAmount: number
    readonly beforeAmount: number
    readonly afterAmount: number
    readonly overflowDispositions?: readonly PlannedItemOverflowDisposition[]
}

export type RewardGrantSnapshot =
    | null
    | boolean
    | number
    | string
    | readonly RewardGrantSnapshot[]
    | RewardGrantObjectSnapshot

export type RewardGrantObjectSnapshot = Readonly<{
    [key: string]: RewardGrantSnapshot
}>

export type RewardGrantCurrencyKind = "freeMana" | "freeVmoney" | "expPool"

export type RewardGrantEntryOutcome = Readonly<
    | {
        readonly kind: "item"
        readonly item: RewardGrantItemOutcome
    }
    | {
        readonly kind: "character"
        readonly characterId: number
        readonly isNew: boolean
        readonly after: RewardGrantObjectSnapshot
        readonly compensationItem: RewardGrantItemOutcome | null
    }
    | {
        readonly kind: "equipment"
        readonly equipmentId: number
        readonly requestedAmount: number
        readonly after: RewardGrantObjectSnapshot
    }
    | {
        readonly kind: "currency"
        readonly currency: RewardGrantCurrencyKind
        readonly requestedAmount: number
        readonly beforeAmount: number
        readonly afterAmount: number
    }
>

export interface RewardGrantExecutionEntryResult {
    readonly index: number
    readonly reward: RewardGrantCommand
    readonly outcome: RewardGrantEntryOutcome
}

export interface RewardGrantFinalCharacter {
    readonly characterId: number
    readonly joined: boolean
    readonly after: RewardGrantObjectSnapshot
}

export interface RewardGrantFinalEquipment {
    readonly equipmentId: number
    readonly requestedAmount: number
    readonly after: RewardGrantObjectSnapshot
}

export interface RewardGrantFinalCurrency {
    readonly currency: RewardGrantCurrencyKind
    readonly requestedAmount: number
    readonly beforeAmount: number
    readonly afterAmount: number
}

export interface RewardGrantAssetResult {
    readonly items: readonly RewardGrantItemOutcome[]
    readonly characters: readonly RewardGrantFinalCharacter[]
    readonly equipment: readonly RewardGrantFinalEquipment[]
    readonly currencies: readonly RewardGrantFinalCurrency[]
}

export interface RewardGrantExecutionResult {
    readonly entries: readonly RewardGrantExecutionEntryResult[]
    readonly assets: RewardGrantAssetResult
    readonly playerAfter: RewardGrantKnownPlayerState
}

export type RewardGrantContractField =
    | "plan"
    | "entries"
    | "entry"
    | "type"
    | "id"
    | "count"
    | "index"
    | "reward"
    | "outcome"
    | "item"
    | "requestedAmount"
    | "acceptedAmount"
    | "overflowAmount"
    | "beforeAmount"
    | "afterAmount"
    | "snapshot"
    | "playerAfter"
    | "playerId"
    | "assets"

export class RewardGrantContractValidationError extends Error {
    readonly entryIndex: number
    readonly field: RewardGrantContractField

    constructor(entryIndex: number, field: RewardGrantContractField, message?: string) {
        super(message ?? `Invalid RewardGrant contract at entry ${entryIndex}: ${field}`)
        this.name = "RewardGrantContractValidationError"
        this.entryIndex = entryIndex
        this.field = field
    }
}
