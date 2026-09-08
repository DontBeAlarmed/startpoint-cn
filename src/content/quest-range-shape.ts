export const QUEST_CATEGORIES_BY_RANGE_KIND: readonly (readonly number[])[] = Object.freeze([
    Object.freeze([1]), Object.freeze([4]), Object.freeze([2]),
    Object.freeze([6]), Object.freeze([14]), Object.freeze([7]),
    Object.freeze([10]), Object.freeze([13]), Object.freeze([11]),
    Object.freeze([18]), Object.freeze([19]), Object.freeze([15]),
    Object.freeze([6, 14, 13, 20]), Object.freeze([20]), Object.freeze([21]),
    Object.freeze([22]), Object.freeze([23]), Object.freeze([24]),
    Object.freeze([25]), Object.freeze([26]), Object.freeze([27]),
])

function expectedQueryArity(rangeKind: number): number {
    if (rangeKind <= 2) return 3
    if (rangeKind === 11) return 1
    if (rangeKind === 12) return 0
    return 2
}

export function hasValidQuestRangeShape(
    categories: readonly number[],
    keyQueryCount: number,
): boolean {
    return QUEST_CATEGORIES_BY_RANGE_KIND.some((expectedCategories, rangeKind) => (
        keyQueryCount === expectedQueryArity(rangeKind)
        && categories.length === expectedCategories.length
        && categories.every((category, index) => category === expectedCategories[index])
    ))
}
