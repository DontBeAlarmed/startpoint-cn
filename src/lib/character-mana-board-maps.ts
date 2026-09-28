// Pure mana-board awake map helpers shared by the data layer and character
// route helpers. This module is a dependency leaf: it must stay free of
// database, Content, route, and response-projector imports so that
// src/data can use it without loading protocol projection code (D28 C6-3).

/** Merges mission-unlocked and persisted mana-board awake levels. */
export function mergeManaBoardAwakeMaps(
    ...maps: Map<string, Record<number, number>>[]
): Map<string, Record<number, number>> {
    const merged = new Map<string, Record<number, number>>()

    for (const map of maps) {
        for (const [characterId, boardLevels] of map) {
            const current = merged.get(characterId) ?? {}
            for (const [boardIndex, awakeLevel] of Object.entries(boardLevels)) {
                const index = Number(boardIndex)
                current[index] = Math.max(current[index] ?? 0, awakeLevel)
            }
            merged.set(characterId, current)
        }
    }

    return merged
}

/** Computes persisted mana-board awake levels from node state. */
export function computeManaBoardAwakeFromNodes(
    characterManaNodeAwakeLevels: Record<string, Record<number, number>>
): Map<string, Record<number, number>> {
    const result = new Map<string, Record<number, number>>()
    for (const [charId, nodeLevels] of Object.entries(characterManaNodeAwakeLevels)) {
        let maxLevel = 0
        for (const awakeLevel of Object.values(nodeLevels)) {
            if (awakeLevel > maxLevel) maxLevel = awakeLevel
        }
        if (maxLevel > 0) {
            result.set(charId, { 1: maxLevel })
        }
    }
    return result
}
