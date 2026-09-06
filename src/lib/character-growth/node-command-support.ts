import { getCharacterGrowthContent } from "../character-growth-content"
import { ManaNodeMutationValidationError } from "../character-mana-mutation-types"
import type { CharacterManaMutationContent } from "../character-mana-mutation-types"
import { growthError, CharacterGrowthError } from "./errors"

export function validateNodeCommandIds(
    value: unknown,
): readonly number[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw growthError("INVALID_REQUEST", "node ids must not be empty.")
    }
    const ids: number[] = []
    const seen = new Set<number>()
    for (const nodeId of value) {
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
            throw growthError("INVALID_REQUEST", "node ids must be positive safe integers.")
        }
        if (seen.has(nodeId)) throw growthError("DUPLICATE_NODE", `node ${nodeId} is duplicated.`)
        seen.add(nodeId)
        ids.push(nodeId)
    }
    return ids
}

export function validateEvaluationTime(value: unknown): asserts value is Date {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw growthError("INVALID_GROWTH_STATE", "evaluationTime must be a valid Date.")
    }
}

export function mutationContent(characterId: number, boardId: number): CharacterManaMutationContent {
    const content = getCharacterGrowthContent()
    try {
        return content.buildManaMutationContent(characterId, boardId)
    } catch (error) {
        return growthMutationError(error)
    }
}

export function characterLevelFromContent(
    characterId: number,
    characterRarity: number,
    experience: number,
): number {
    const content = getCharacterGrowthContent()
    try {
        return content.getLevelByExperience(characterRarity, experience)
    } catch (error) {
        throw growthError(
            "CONTENT_INVALID",
            `character ${characterId} level content is invalid: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

export function requiredItemIds(
    content: CharacterManaMutationContent,
    nodeIds: readonly number[],
    extraCosts: Readonly<Record<string, { readonly items: Readonly<Record<string, number>> }>> = {},
): number[] {
    const ids = new Set<number>()
    for (const nodeId of nodeIds) {
        for (const itemId of Object.keys(content.nodes[String(nodeId)]?.items ?? {})) ids.add(Number(itemId))
        for (const itemId of Object.keys(extraCosts[String(nodeId)]?.items ?? {})) ids.add(Number(itemId))
    }
    return [...ids].sort((left, right) => left - right)
}

export function growthMutationError(error: unknown): never {
    if (error instanceof CharacterGrowthError) throw error
    if (error instanceof ManaNodeMutationValidationError) {
        const code = error.code === "CONTENT_SCOPE_MISMATCH"
            || error.code === "CONTENT_INVALID"
            || error.code === "SNAPSHOT_INVALID"
            || error.code === "AWAKE_COST_MISSING"
            || error.code === "COST_OVERFLOW"
            ? "CONTENT_INVALID"
            : error.code
        throw growthError(code as Parameters<typeof growthError>[0], error.message)
    }
    throw error
}

export function snapshotItems(
    itemBalances: ReadonlyMap<number, number>,
): Record<string, number> {
    return Object.fromEntries([...itemBalances].map(([id, amount]) => [String(id), amount]))
}
