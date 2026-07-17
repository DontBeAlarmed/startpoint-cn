export function mergeOwnedDegreeIds(
    currentDegreeId: number,
    persistedDegreeIds: number[],
): number[] {
    return [...new Set([1, currentDegreeId, ...persistedDegreeIds])]
}
