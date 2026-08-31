import { CharacterGrowthError, growthError } from "./errors"
import type {
    BondTokenStatus,
    CharacterGrowthAwakeUnlockRow,
    CharacterGrowthBondTokenRow,
} from "./model"

function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a positive safe integer.`)
    }
    return value
}

function nonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw growthError("INVALID_GROWTH_STATE", `${field} must be a non-negative safe integer.`)
    }
    return value
}

export function validateBoardIndex(boardIndex: unknown): number {
    return positiveInteger(boardIndex, "boardIndex")
}

export function validateBondTokenStatus(status: unknown): BondTokenStatus {
    if (status !== 0 && status !== 1 && status !== 2) {
        throw growthError("INVALID_GROWTH_STATE", "bond token status must be 0, 1, or 2.")
    }
    return status
}

export function validateAwakeLevel(awakeLevel: unknown): number {
    return positiveInteger(awakeLevel, "awakeLevel")
}

export function validateBondTokenRows(
    rows: readonly CharacterGrowthBondTokenRow[],
): readonly CharacterGrowthBondTokenRow[] {
    const seen = new Set<string>()
    return rows.map((row, index) => {
        const characterId = positiveInteger(row?.character_id, `bondTokens[${index}].character_id`)
        const boardIndex = positiveInteger(row?.mana_board_index, `bondTokens[${index}].mana_board_index`)
        const status = validateBondTokenStatus(row?.status)
        const key = `${characterId}:${boardIndex}`
        if (seen.has(key)) {
            throw growthError("INVALID_GROWTH_STATE", `duplicate bond token ${key}.`)
        }
        seen.add(key)
        return { character_id: characterId, mana_board_index: boardIndex, status }
    })
}

export function validateAwakeUnlockRows(
    rows: readonly CharacterGrowthAwakeUnlockRow[],
): readonly CharacterGrowthAwakeUnlockRow[] {
    const seen = new Set<string>()
    return rows.map((row, index) => {
        const characterId = positiveInteger(row?.character_id, `awakeUnlocks[${index}].character_id`)
        const boardIndex = positiveInteger(row?.board_index, `awakeUnlocks[${index}].board_index`)
        const awakeLevel = validateAwakeLevel(row?.awake_level)
        const key = `${characterId}:${boardIndex}`
        if (seen.has(key)) {
            throw growthError("INVALID_GROWTH_STATE", `duplicate awake unlock ${key}.`)
        }
        seen.add(key)
        return { character_id: characterId, board_index: boardIndex, awake_level: awakeLevel }
    })
}

export function validateCharacterReference(
    characterId: number,
    existingCharacterIds: ReadonlySet<number>,
): void {
    positiveInteger(characterId, "characterId")
    if (!existingCharacterIds.has(characterId)) {
        throw growthError("CHARACTER_NOT_OWNED", `character ${characterId} is not owned.`)
    }
}

function validateTokenMap(tokens: ReadonlyMap<number, BondTokenStatus>): void {
    for (const [boardIndex, status] of tokens) {
        validateBoardIndex(boardIndex)
        validateBondTokenStatus(status)
    }
}

function validateTokenBoardRange(
    tokens: ReadonlyMap<number, BondTokenStatus>,
    boardCount: number,
): void {
    for (const boardIndex of tokens.keys()) {
        if (boardIndex > boardCount) {
            throw growthError(
                "INVALID_GROWTH_STATE",
                `bond token board ${boardIndex} exceeds content board count ${boardCount}.`,
            )
        }
    }
}

export function getBondTokenStatus(
    tokens: ReadonlyMap<number, BondTokenStatus>,
    boardIndex: number,
): BondTokenStatus | null {
    validateBoardIndex(boardIndex)
    validateTokenMap(tokens)
    return tokens.get(boardIndex) ?? null
}

export function findMissingBondTokenBoards(
    tokens: ReadonlyMap<number, BondTokenStatus>,
    boardCount: number,
): number[] {
    const count = nonNegativeInteger(boardCount, "boardCount")
    validateTokenMap(tokens)
    validateTokenBoardRange(tokens, count)
    return Array.from({ length: count }, (_unused, index) => index + 1)
        .filter(boardIndex => !tokens.has(boardIndex))
}

export function projectSortedBondTokens(
    tokens: ReadonlyMap<number, BondTokenStatus>,
): Array<{ mana_board_index: number; status: BondTokenStatus }> {
    validateTokenMap(tokens)
    return [...tokens.entries()]
        .sort(([left], [right]) => left - right)
        .map(([mana_board_index, status]) => ({ mana_board_index, status }))
}

export function isNormalBoardComplete(
    learnedNodeIds: ReadonlySet<number>,
    boardNodeIds: ReadonlySet<number>,
): boolean {
    for (const nodeId of boardNodeIds) {
        if (!learnedNodeIds.has(nodeId)) return false
    }
    return true
}

export function mergeMonotonicAwakeUnlocks(
    current: ReadonlyMap<number, number>,
    candidates: ReadonlyMap<number, number>,
): ReadonlyMap<number, number> {
    const merged = new Map<number, number>()
    for (const [boardIndex, awakeLevel] of current) {
        merged.set(validateBoardIndex(boardIndex), validateAwakeLevel(awakeLevel))
    }
    for (const [boardIndex, awakeLevel] of candidates) {
        const validBoardIndex = validateBoardIndex(boardIndex)
        const validAwakeLevel = validateAwakeLevel(awakeLevel)
        merged.set(validBoardIndex, Math.max(merged.get(validBoardIndex) ?? 0, validAwakeLevel))
    }
    return merged
}

export function assertMonotonicBondTokenTransition(
    current: BondTokenStatus,
    candidate: BondTokenStatus,
): void {
    validateBondTokenStatus(current)
    validateBondTokenStatus(candidate)
    if (candidate < current || candidate > current + 1) {
        throw new CharacterGrowthError(
            "INVALID_GROWTH_STATE",
            `bond token status cannot transition from ${current} to ${candidate}.`,
        )
    }
}
