export type BondTokenStatus = 0 | 1 | 2

export interface CharacterGrowthCoreFact {
    readonly playerId: number
    readonly characterId: number
    readonly rarity: number
    readonly exp: number
    readonly stack: number
    readonly protection: boolean
    readonly overLimitStep: number
    readonly evolutionLevel: number
    readonly manaBoardIndex: number
}

export interface CharacterGrowthContentFacts {
    readonly rarity: number
    readonly boardCount: number
    readonly boardNodeIds: ReadonlyMap<number, ReadonlySet<number>>
    readonly secondBoardAvailable: boolean
    readonly requiredExp?: number
    readonly requiredOverLimitStep?: number
}

export interface CharacterGrowthStoredCore {
    readonly characterId: number
    readonly exp: number
    readonly stack: number
    readonly protection: boolean
    readonly overLimitStep: number
    readonly evolutionLevel: number
    readonly manaBoardIndex: number
}

export interface CharacterGrowthBondTokenRow {
    readonly character_id: number
    readonly mana_board_index: number
    readonly status: number
}

export interface CharacterGrowthAwakeUnlockRow {
    readonly character_id: number
    readonly board_index: number
    readonly awake_level: number
}

export interface CharacterGrowthNormalManaNodeRow {
    readonly character_id: number
    readonly value: number
    readonly awake_level: number
}
