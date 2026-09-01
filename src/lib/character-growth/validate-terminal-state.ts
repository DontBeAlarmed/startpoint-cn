import { characterExpCaps } from "./exp-caps"
import { characterMaxOverLimits } from "./limits"
import { isNormalBoardComplete } from "./invariants"
import type { BondTokenStatus, CharacterGrowthContentFacts } from "./model"

export type CharacterGrowthTerminalSection =
    | "core"
    | "bondTokens"
    | "normalManaNodes"
    | "awakeUnlocks"

export interface CharacterGrowthTerminalIssue {
    readonly section: CharacterGrowthTerminalSection
    readonly field: string
    readonly reason: string
}

export interface CharacterGrowthTerminalState {
    readonly characterId: number
    readonly entryCount: number
    readonly rarity: number
    readonly exp: number
    readonly overLimitStep: number
    readonly manaBoardIndex: number
    readonly bondTokens: ReadonlyMap<number, BondTokenStatus>
    readonly normalManaNodes: ReadonlyMap<number, number>
    readonly awakeUnlocks: ReadonlyMap<number, number>
}

function positiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validates only terminal relationships that the official client and the
 * current Growth commands can form. Historical evolution values are not
 * derived or lowered here; the outer load repair remains monotonic-upward.
 */
export function validateCharacterGrowthTerminalState(
    state: CharacterGrowthTerminalState,
    content: CharacterGrowthContentFacts,
): readonly CharacterGrowthTerminalIssue[] {
    const issues: CharacterGrowthTerminalIssue[] = []
    const add = (
        section: CharacterGrowthTerminalSection,
        field: string,
        reason: string,
    ) => issues.push({ section, field, reason })

    if (!positiveSafeInteger(state.entryCount)) {
        add("core", "entry_count", "owned character entry count must be at least 1")
    }
    if (!positiveSafeInteger(content.rarity) || state.rarity !== content.rarity) {
        add("core", "id", "character rarity does not match Content")
    }

    const maxOverLimit = characterMaxOverLimits[state.rarity]
    if (maxOverLimit === undefined) {
        add("core", "over_limit_step", "character rarity has no supported over-limit boundary")
    } else if (!nonNegativeSafeInteger(state.overLimitStep) || state.overLimitStep > maxOverLimit) {
        add("core", "over_limit_step", `exceeds rarity ${state.rarity} limit ${maxOverLimit}`)
    }

    const expCap = characterExpCaps[state.rarity]?.[state.overLimitStep]
    if (expCap === undefined) {
        add("core", "exp", "character rarity/over-limit step has no EXP cap")
    } else if (!nonNegativeSafeInteger(state.exp) || state.exp > expCap) {
        add("core", "exp", `exceeds current EXP cap ${expCap}`)
    }

    if (!positiveSafeInteger(content.boardCount)) {
        add("core", "mana_board_index", "Content has no available mana board")
        return issues
    }
    const currentBoardValid = positiveSafeInteger(state.manaBoardIndex)
        && state.manaBoardIndex <= content.boardCount
    if (!currentBoardValid) {
        add("core", "mana_board_index", "does not identify an available Content board")
    }

    const nodeBoards = new Map<number, number>()
    for (const [boardIndex, nodeIds] of content.boardNodeIds) {
        for (const nodeId of nodeIds) nodeBoards.set(nodeId, boardIndex)
    }
    const learnedNodeIds = new Set(state.normalManaNodes.keys())
    for (const [nodeId, awakeLevel] of state.normalManaNodes) {
        const boardIndex = nodeBoards.get(nodeId)
        if (boardIndex === undefined) {
            add("normalManaNodes", "value", `node ${nodeId} does not belong to this character Content`)
            continue
        }
        if (currentBoardValid && boardIndex > state.manaBoardIndex) {
            add("normalManaNodes", "value", `node ${nodeId} belongs to unopened board ${boardIndex}`)
        }
        if (awakeLevel > 0 && boardIndex !== 1) {
            add("normalManaNodes", "awake_level", "positive Awake progress is only supported on board 1")
        }
    }

    const boardComplete = new Map<number, boolean>()
    for (let boardIndex = 1; boardIndex <= content.boardCount; boardIndex++) {
        const nodeIds = content.boardNodeIds.get(boardIndex)
        boardComplete.set(
            boardIndex,
            nodeIds !== undefined && nodeIds.size > 0 && isNormalBoardComplete(learnedNodeIds, nodeIds),
        )
    }
    if (currentBoardValid) {
        for (let boardIndex = 1; boardIndex < state.manaBoardIndex; boardIndex++) {
            if (boardComplete.get(boardIndex) !== true) {
                add("core", "mana_board_index", `previous board ${boardIndex} is incomplete`)
            }
        }
    }

    for (const [boardIndex, status] of state.bondTokens) {
        if (boardIndex > content.boardCount) {
            add("bondTokens", "mana_board_index", `board ${boardIndex} exceeds Content board count`)
            continue
        }
        if (status >= 1 && (!currentBoardValid
            || boardIndex > state.manaBoardIndex
            || boardComplete.get(boardIndex) !== true)) {
            add("bondTokens", "status", `earned/received token for board ${boardIndex} requires a completed open board`)
        }
    }
    for (const [boardIndex, awakeLevel] of state.awakeUnlocks) {
        if (boardIndex !== 1 || !content.boardNodeIds.has(boardIndex)) {
            add("awakeUnlocks", "board_index", "CharacterAwake unlock is only supported on Content board 1")
        } else if (boardComplete.get(1) !== true) {
            add("awakeUnlocks", "board_index", "CharacterAwake unlock requires completed board 1")
        }
        if (!positiveSafeInteger(awakeLevel)) {
            add("awakeUnlocks", "awake_level", "must be a positive safe integer")
        }
    }
    const boardOneUnlockLevel = state.awakeUnlocks.get(1) ?? 0
    for (const [nodeId, awakeLevel] of state.normalManaNodes) {
        if (awakeLevel <= 0) continue
        if (boardOneUnlockLevel <= 0) {
            add("normalManaNodes", "awake_level", `Awake node ${nodeId} requires a board 1 unlock`)
        } else if (awakeLevel > boardOneUnlockLevel) {
            add(
                "normalManaNodes",
                "awake_level",
                `Awake node ${nodeId} exceeds board 1 unlock level ${boardOneUnlockLevel}`,
            )
        }
    }

    return issues
}
