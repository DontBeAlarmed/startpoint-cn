import { getCharacterGrowthContentFactsSync } from "../content-facts"
import type { BondTokenStatus, CharacterGrowthContentFacts } from "../model"
import { validateCharacterGrowthTerminalState } from "../validate-terminal-state"
import type { CharacterGrowthSaveTableProjection } from "./project-growth-state"

export interface GrowthSaveValidationError {
    readonly table: string
    readonly characterId?: number
    readonly field: string
    readonly reason: string
}

export interface GrowthSaveValidationResult {
    readonly valid: boolean
    readonly errors: readonly GrowthSaveValidationError[]
}

export interface ValidateCharacterGrowthSaveStateOptions {
    readonly contentFactsLoader?: (characterId: number) => CharacterGrowthContentFacts
}

interface CharacterValidationFacts {
    readonly content: CharacterGrowthContentFacts
    readonly nodeBoards: ReadonlyMap<number, number>
}

function safeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value)
}

function positiveInteger(value: unknown): value is number {
    return safeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
    return safeInteger(value) && value >= 0
}

export function validateCharacterGrowthSaveState(
    projection: CharacterGrowthSaveTableProjection,
    options: ValidateCharacterGrowthSaveStateOptions = {},
): GrowthSaveValidationResult {
    const errors: GrowthSaveValidationError[] = []
    const contentFactsLoader = options.contentFactsLoader ?? getCharacterGrowthContentFactsSync
    const characterFacts = new Map<number, CharacterValidationFacts>()
    const characterIds = new Set<number>()

    const add = (
        table: string,
        field: string,
        reason: string,
        characterId?: number,
    ) => errors.push({ table, ...(characterId === undefined ? {} : { characterId }), field, reason })

    for (const [index, row] of projection.players_characters.entries()) {
        const table = "players_characters"
        const characterId = row.id
        if (!positiveInteger(characterId)) {
            add(table, `rows[${index}].id`, "must be a positive safe integer")
            continue
        }
        if (characterIds.has(characterId)) {
            add(table, "id", "duplicate character identity", characterId)
            continue
        }
        characterIds.add(characterId)
        const numericFields = [
            ["entry_count", row.entry_count],
            ["exp", row.exp],
            ["stack", row.stack],
            ["over_limit_step", row.over_limit_step],
            ["evolution_level", row.evolution_level],
        ] as const
        for (const [field, value] of numericFields) {
            if (!nonNegativeInteger(value)) {
                add(table, field, "must be a non-negative safe integer", characterId)
            }
        }
        if (row.protection !== 0 && row.protection !== 1) {
            add(table, "protection", "must be 0 or 1", characterId)
        }
        if (!positiveInteger(row.mana_board_index)) {
            add(table, "mana_board_index", "must be a positive safe integer", characterId)
        }

        try {
            const content = contentFactsLoader(characterId)
            if (!positiveInteger(content.boardCount)) {
                add(table, "id", "character Content has no supported mana board", characterId)
                continue
            }
            if (positiveInteger(row.mana_board_index) && row.mana_board_index > content.boardCount) {
                add(
                    table,
                    "mana_board_index",
                    `exceeds Content board count ${content.boardCount}`,
                    characterId,
                )
            }
            const nodeBoards = new Map<number, number>()
            for (const [boardIndex, nodeIds] of content.boardNodeIds) {
                if (!positiveInteger(boardIndex) || boardIndex > content.boardCount) {
                    add(table, "id", "character Content has an invalid board index", characterId)
                    continue
                }
                for (const nodeId of nodeIds) {
                    if (!positiveInteger(nodeId)) {
                        add(table, "id", "character Content has an invalid mana node", characterId)
                        continue
                    }
                    if (nodeBoards.has(nodeId)) {
                        add(table, "id", `Content node ${nodeId} belongs to multiple boards`, characterId)
                        continue
                    }
                    nodeBoards.set(nodeId, boardIndex)
                }
            }
            characterFacts.set(characterId, { content, nodeBoards })
        } catch (error) {
            add(
                table,
                "id",
                `character Content is unavailable: ${error instanceof Error ? error.message : String(error)}`,
                characterId,
            )
        }
    }

    const tokenIdentities = new Set<string>()
    for (const [index, row] of projection.players_characters_bond_tokens.entries()) {
        const table = "players_characters_bond_tokens"
        const characterId = row.character_id
        if (!positiveInteger(characterId)) {
            add(table, `rows[${index}].character_id`, "must be a positive safe integer")
            continue
        }
        if (!characterIds.has(characterId)) {
            add(table, "character_id", "references an unknown character", characterId)
        }
        const boardIndex = row.mana_board_index
        if (!positiveInteger(boardIndex)) {
            add(table, "mana_board_index", "must be a positive safe integer", characterId)
        } else {
            const identity = `${characterId}:${boardIndex}`
            if (tokenIdentities.has(identity)) {
                add(table, "mana_board_index", "duplicate character/board identity", characterId)
            }
            tokenIdentities.add(identity)
            const facts = characterFacts.get(characterId)
            if (facts !== undefined && boardIndex > facts.content.boardCount) {
                add(
                    table,
                    "mana_board_index",
                    `exceeds Content board count ${facts.content.boardCount}`,
                    characterId,
                )
            }
        }
        if (row.status !== 0 && row.status !== 1 && row.status !== 2) {
            add(table, "status", "must be 0, 1, or 2", characterId)
        }
    }

    const nodeIdentities = new Set<string>()
    for (const [index, row] of projection.players_characters_mana_nodes.entries()) {
        const table = "players_characters_mana_nodes"
        const characterId = row.character_id
        if (!positiveInteger(characterId)) {
            add(table, `rows[${index}].character_id`, "must be a positive safe integer")
            continue
        }
        if (!characterIds.has(characterId)) {
            add(table, "character_id", "references an unknown character", characterId)
        }
        const nodeId = row.value
        if (!positiveInteger(nodeId)) {
            add(table, "value", "must be a positive safe integer", characterId)
            continue
        }
        const identity = `${characterId}:${nodeId}`
        if (nodeIdentities.has(identity)) {
            add(table, "value", "duplicate character/node identity", characterId)
        }
        nodeIdentities.add(identity)
        const awakeLevel = row.awake_level ?? 0
        if (!nonNegativeInteger(awakeLevel)) {
            add(table, "awake_level", "must be a non-negative safe integer", characterId)
        }
        const nodeBoard = characterFacts.get(characterId)?.nodeBoards.get(nodeId)
        if (nodeBoard === undefined) {
            add(table, "value", "does not belong to this character Content", characterId)
        } else if (nonNegativeInteger(awakeLevel) && awakeLevel > 0 && nodeBoard !== 1) {
            add(table, "awake_level", "positive Awake progress is only supported on board 1", characterId)
        }
    }

    const awakeIdentities = new Set<string>()
    for (const [index, row] of projection.players_character_awake_unlocks.entries()) {
        const table = "players_character_awake_unlocks"
        const characterId = row.character_id
        if (!positiveInteger(characterId)) {
            add(table, `rows[${index}].character_id`, "must be a positive safe integer")
            continue
        }
        if (!characterIds.has(characterId)) {
            add(table, "character_id", "references an unknown character", characterId)
        }
        const boardIndex = row.board_index
        if (!positiveInteger(boardIndex)) {
            add(table, "board_index", "must be a positive safe integer", characterId)
        } else {
            const identity = `${characterId}:${boardIndex}`
            if (awakeIdentities.has(identity)) {
                add(table, "board_index", "duplicate character/board identity", characterId)
            }
            awakeIdentities.add(identity)
            if (boardIndex !== 1) {
                add(table, "board_index", "only CharacterAwake board 1 is supported", characterId)
            }
            const facts = characterFacts.get(characterId)
            if (facts !== undefined && boardIndex > facts.content.boardCount) {
                add(
                    table,
                    "board_index",
                    `exceeds Content board count ${facts.content.boardCount}`,
                    characterId,
                )
            }
        }
        if (!positiveInteger(row.awake_level)) {
            add(table, "awake_level", "must be a positive safe integer", characterId)
        }
    }

    for (const row of projection.players_characters) {
        if (!positiveInteger(row.id)) continue
        const characterId = row.id
        const facts = characterFacts.get(characterId)
        if (facts === undefined
            || !nonNegativeInteger(row.entry_count)
            || !nonNegativeInteger(row.exp)
            || !nonNegativeInteger(row.over_limit_step)
            || !positiveInteger(row.mana_board_index)) continue

        const bondTokens = new Map<number, BondTokenStatus>()
        for (const token of projection.players_characters_bond_tokens) {
            if (token.character_id !== characterId
                || !positiveInteger(token.mana_board_index)
                || (token.status !== 0 && token.status !== 1 && token.status !== 2)) continue
            bondTokens.set(token.mana_board_index, token.status)
        }
        const normalManaNodes = new Map<number, number>()
        for (const node of projection.players_characters_mana_nodes) {
            const awakeLevel = node.awake_level ?? 0
            if (node.character_id !== characterId
                || !positiveInteger(node.value)
                || !nonNegativeInteger(awakeLevel)) continue
            normalManaNodes.set(node.value, awakeLevel)
        }
        const awakeUnlocks = new Map<number, number>()
        for (const unlock of projection.players_character_awake_unlocks) {
            if (unlock.character_id !== characterId
                || !positiveInteger(unlock.board_index)
                || !positiveInteger(unlock.awake_level)) continue
            awakeUnlocks.set(unlock.board_index, unlock.awake_level)
        }

        for (const issue of validateCharacterGrowthTerminalState({
            characterId,
            entryCount: row.entry_count,
            rarity: facts.content.rarity,
            exp: row.exp,
            overLimitStep: row.over_limit_step,
            manaBoardIndex: row.mana_board_index,
            bondTokens,
            normalManaNodes,
            awakeUnlocks,
        }, facts.content)) {
            const table = issue.section === "core"
                ? "players_characters"
                : issue.section === "bondTokens"
                    ? "players_characters_bond_tokens"
                    : issue.section === "normalManaNodes"
                        ? "players_characters_mana_nodes"
                        : "players_character_awake_unlocks"
            add(table, issue.field, issue.reason, characterId)
        }
    }

    return { valid: errors.length === 0, errors }
}

export function assertValidCharacterGrowthSaveState(
    projection: CharacterGrowthSaveTableProjection,
    options: ValidateCharacterGrowthSaveStateOptions = {},
): void {
    const validation = validateCharacterGrowthSaveState(projection, options)
    if (validation.valid) return
    const summary = validation.errors.slice(0, 8).map(error => (
        `${error.table}${error.characterId === undefined ? "" : `[${error.characterId}]`}`
        + `.${error.field}: ${error.reason}`
    )).join("; ")
    const remaining = validation.errors.length > 8
        ? `; ${validation.errors.length - 8} more error(s)`
        : ""
    throw new Error(`Character Growth save is invalid: ${summary}${remaining}`)
}
