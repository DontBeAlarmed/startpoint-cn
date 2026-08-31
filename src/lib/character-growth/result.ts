import type { BondTokenStatus, CharacterGrowthCoreFact } from "./model"

export interface CharacterGrowthObservedState extends CharacterGrowthCoreFact {
    readonly bondTokens?: ReadonlyMap<number, BondTokenStatus>
    readonly normalManaNodes?: ReadonlyMap<number, number>
    readonly awakeUnlocks?: ReadonlyMap<number, number>
}

export interface CharacterGrowthResourceState {
    readonly items?: ReadonlyMap<number, number>
    readonly mana?: number
    readonly freeMana?: number
    readonly paidMana?: number
}

export interface CharacterGrowthCommandResult {
    readonly command: string
    readonly before: CharacterGrowthObservedState
    readonly after: CharacterGrowthObservedState
    readonly changedNodeIds: readonly number[]
    readonly resourceState?: CharacterGrowthResourceState
    readonly missionSettlement?: unknown
    readonly replayed: boolean
}
