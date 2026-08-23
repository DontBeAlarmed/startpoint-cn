export function collectAwakeCandidateCharacterIds(
    explicitCharacterIds: readonly number[],
    characterLists: readonly (readonly Record<string, unknown>[])[] = [],
): number[] {
    const candidateIds = new Set<number>()
    for (const characterId of explicitCharacterIds) {
        if (Number.isSafeInteger(characterId) && characterId > 0) candidateIds.add(characterId)
    }
    for (const characterList of characterLists) {
        for (const character of characterList) {
            const characterId = character.character_id
            if (typeof characterId === "number"
                && Number.isSafeInteger(characterId)
                && characterId > 0) {
                candidateIds.add(characterId)
            }
        }
    }
    return [...candidateIds].sort((left, right) => left - right)
}
