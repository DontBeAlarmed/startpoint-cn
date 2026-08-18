const CHARACTER_LEVEL_RARITIES = [1, 2, 3, 4, 5] as const
const CHARACTER_LEVEL_KEYS = Array.from({ length: 100 }, (_, index) => String(index + 1))

function record(value: unknown, subject: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${subject} must be an object`)
    }
    return value as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const sortedExpected = [...expected].sort()
    return actual.length === sortedExpected.length
        && actual.every((key, index) => key === sortedExpected[index])
}

export function validateCharacterLevelCurve(
    value: unknown,
    subject = "character level curve",
): Record<string, number> {
    const source = record(value, subject)
    if (!hasExactKeys(source, CHARACTER_LEVEL_KEYS)) {
        throw new Error(`${subject} must contain exactly levels 1 through 100`)
    }
    const result: Record<string, number> = {}
    let previous = -1
    for (const [index, level] of CHARACTER_LEVEL_KEYS.entries()) {
        const total = source[level]
        if (typeof total !== "number"
            || !Number.isSafeInteger(total)
            || total < 0) {
            throw new Error(`${subject} level ${level} must be a non-negative safe integer`)
        }
        if ((index === 0 && total !== 0) || (index > 0 && total <= previous)) {
            throw new Error(`${subject} must be strictly increasing from zero`)
        }
        result[level] = total
        previous = total
    }
    return result
}

export function validateCharacterLevelTable(value: unknown): Record<
    string,
    Record<string, number>
> {
    const source = record(value, "character level table")
    const expectedRarities = CHARACTER_LEVEL_RARITIES.map(String)
    if (!hasExactKeys(source, expectedRarities)) {
        throw new Error("character level rarity keys must be 1 through 5")
    }
    return Object.fromEntries(CHARACTER_LEVEL_RARITIES.map(rarity => (
        [String(rarity), validateCharacterLevelCurve(source[String(rarity)], `character level rarity ${rarity}`)]
    )))
}

export { CHARACTER_LEVEL_KEYS, CHARACTER_LEVEL_RARITIES }
