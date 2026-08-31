export type CharacterGrowthErrorCode =
    | "CHARACTER_NOT_OWNED"
    | "BOARD_NOT_AVAILABLE"
    | "LEVEL_REQUIRED"
    | "OVER_LIMIT_REQUIRED"
    | "PREVIOUS_BOARD_INCOMPLETE"
    | "BOND_TOKEN_NOT_EARNED"
    | "UNKNOWN_NODE"
    | "PARENT_NOT_LEARNED"
    | "ALREADY_LEARNED"
    | "INSUFFICIENT_ITEM"
    | "INSUFFICIENT_MANA"
    | "INVALID_GROWTH_STATE"
    | "CONTENT_INVALID"

export class CharacterGrowthError extends Error {
    readonly code: CharacterGrowthErrorCode

    constructor(code: CharacterGrowthErrorCode, message: string) {
        super(`${code}: ${message}`)
        this.name = "CharacterGrowthError"
        this.code = code
    }
}

export function growthError(
    code: CharacterGrowthErrorCode,
    message: string,
): CharacterGrowthError {
    return new CharacterGrowthError(code, message)
}

