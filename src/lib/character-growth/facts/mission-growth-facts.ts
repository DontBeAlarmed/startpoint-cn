import type { FactKey } from "../../mission/facts/fact-key"

export interface CharacterGrowthFactPublication {
    readonly playerId: number
    readonly candidateCharacterIds: readonly number[]
    readonly source: string
    readonly evaluationTime: Date
    readonly invalidatedFactKeys: readonly FactKey[]
}

export function normalizeCharacterGrowthCandidateIds(
    explicitCharacterIds: readonly number[],
    characterLists: readonly (readonly Record<string, unknown>[])[],
): number[] {
    const ids = new Set<number>()
    for (const id of explicitCharacterIds) {
        if (Number.isSafeInteger(id) && id > 0) ids.add(id)
    }
    for (const list of characterLists) {
        for (const character of list) {
            const id = character.character_id
            if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ids.add(id)
            if (typeof id === "string" && /^\d+$/.test(id)) {
                const numericId = Number(id)
                if (Number.isSafeInteger(numericId) && numericId > 0) ids.add(numericId)
            }
        }
    }
    return [...ids].sort((left, right) => left - right)
}
