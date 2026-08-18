import type { LevelRequiredManaNodeTable } from "../content/character-mana-admission"

export type ManaNodeMutationErrorCode =
    | "INVALID_REQUEST"
    | "DUPLICATE_NODE"
    | "CONTENT_SCOPE_MISMATCH"
    | "CONTENT_INVALID"
    | "SNAPSHOT_INVALID"
    | "UNKNOWN_NODE"
    | "PARENT_NOT_LEARNED"
    | "LEVEL_REQUIRED"
    | "ALREADY_LEARNED"
    | "NOT_LEARNED"
    | "INVALID_AWAKE_TARGET"
    | "AWAKE_COST_MISSING"
    | "INSUFFICIENT_MANA"
    | "INSUFFICIENT_ITEM"
    | "COST_OVERFLOW"

export class ManaNodeMutationValidationError extends Error {
    readonly code: ManaNodeMutationErrorCode

    constructor(code: ManaNodeMutationErrorCode, message: string) {
        super(`${code}: ${message}`)
        this.name = "ManaNodeMutationValidationError"
        this.code = code
    }
}

export interface ManaNodeMutationCost {
    readonly manaCost: number
    readonly items: Readonly<Record<string, number>>
}

export interface ManaNodeMutationNode extends ManaNodeMutationCost {
    readonly field1: string
    readonly field5: string
    readonly field6: string
}

export interface CharacterManaMutationContent {
    readonly characterId: number
    readonly boardId: number
    readonly nodes: Readonly<Record<string, ManaNodeMutationNode>>
    readonly parents: Readonly<Record<string, number | null>>
    readonly levelRequirements: LevelRequiredManaNodeTable
}

export interface CharacterManaMutationSnapshot {
    readonly mana: number
    readonly items: Readonly<Record<string, number>>
    readonly nodeAwakeLevels: Readonly<Record<string, number>>
}

export interface BaseManaNodeMutationInput {
    readonly characterId: number
    readonly boardId: number
    readonly characterRarity: number
    readonly characterLevel: number
    readonly requestedNodeIds: readonly number[]
    readonly content: CharacterManaMutationContent
    readonly snapshot: CharacterManaMutationSnapshot
}

export interface LearnManaNodeMutationInput extends BaseManaNodeMutationInput {}

export interface AwakeManaNodeMutationInput extends BaseManaNodeMutationInput {
    readonly targetAwakeLevel: number
    readonly awakeCosts: Readonly<Record<string, ManaNodeMutationCost>>
}

export interface ManaNodeMutationPlan {
    readonly kind: "learn" | "awake"
    readonly nodeUpdates: readonly { readonly nodeId: number; readonly awakeLevel: number }[]
    readonly finalLearnedNodeIds: readonly number[]
    readonly finalAwakeLevels: Readonly<Record<string, number>>
    readonly totalManaCost: number
    readonly totalItemCosts: Readonly<Record<string, number>>
    readonly remainingMana: number
    readonly remainingItems: Readonly<Record<string, number>>
    readonly responseNodeEntries: readonly {
        readonly multiplied_id: number
        readonly awake_level: number
    }[]
    readonly hasResourceWrites: boolean
}
