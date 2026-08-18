import { buildManaBoardParentIndex } from "../content/mana-board-parent-index"
import type { ManaBoardParentIndex } from "../content/mana-board-parent-index"
import {
    parseLevelRequiredManaNodeTable,
    type LevelRequiredManaNodeTable,
} from "../content/character-mana-admission"
import type { ManaNodes } from "./types"
import {
    ManaNodeMutationValidationError,
    type CharacterManaMutationContent,
} from "./character-mana-mutation-types"

export interface CharacterManaMutationContentSources {
    readonly manaNodes: ManaNodes
    readonly manaBoard: unknown
    readonly levelRequirements: unknown
}

const parentIndexCache = new WeakMap<object, ManaBoardParentIndex>()
const levelRequirementCache = new WeakMap<object, LevelRequiredManaNodeTable>()

function invalid(message: string): never {
    throw new ManaNodeMutationValidationError("CONTENT_INVALID", message)
}

function cacheKey(value: unknown, subject: string): object {
    if (value === null || typeof value !== "object") invalid(`${subject} must be an object`)
    return value
}

function getParentIndex(value: unknown): ManaBoardParentIndex {
    const key = cacheKey(value, "mana board table")
    const cached = parentIndexCache.get(key)
    if (cached) return cached
    let index: ManaBoardParentIndex
    try {
        index = buildManaBoardParentIndex(value)
    } catch (error) {
        invalid(error instanceof Error ? error.message : String(error))
    }
    parentIndexCache.set(key, index)
    return index
}

function getLevelRequirements(value: unknown): LevelRequiredManaNodeTable {
    const key = cacheKey(value, "level requirement table")
    const cached = levelRequirementCache.get(key)
    if (cached) return cached
    const table = parseLevelRequiredManaNodeTable(value)
    levelRequirementCache.set(key, table)
    return table
}

export function buildCharacterManaMutationContent(
    characterId: number,
    boardId: number,
    sources: CharacterManaMutationContentSources,
): CharacterManaMutationContent {
    const character = sources.manaNodes[String(characterId)]
    const nodes = character?.[String(boardId)]
    if (!nodes) invalid(`character ${characterId} board ${boardId} has no mana nodes`)

    const parentIndex = getParentIndex(sources.manaBoard)
    const parents = parentIndex[String(characterId)]?.[String(boardId)]
    if (!parents) invalid(`character ${characterId} board ${boardId} has no parent index`)

    let levelRequirements
    try {
        levelRequirements = getLevelRequirements(sources.levelRequirements)
    } catch (error) {
        invalid(error instanceof Error ? error.message : String(error))
    }

    return {
        characterId,
        boardId,
        nodes,
        parents,
        levelRequirements,
    }
}
