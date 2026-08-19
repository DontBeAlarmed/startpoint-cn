const QUEST_CATEGORY_BY_RANGE_KIND: Readonly<Record<number, number | readonly number[]>> = Object.freeze({
    0: 1,
    1: 4,
    2: 2,
    3: 6,
    4: 14,
    5: 7,
    6: 10,
    7: 13,
    8: 11,
    9: 18,
    10: 19,
    11: 15,
    12: [6, 14, 13, 20],
    13: 20,
    14: 21,
    15: 22,
    16: 23,
    17: 24,
    18: 25,
    19: 26,
    20: 27,
})

export interface ActiveMissionQuestRange {
    readonly kind: number
    readonly categories: readonly number[]
    readonly first?: readonly number[] | null
    readonly second?: readonly number[] | null
    readonly third?: readonly number[] | null
    readonly eventIds?: readonly number[] | null
    readonly questNumbers?: readonly number[] | null
}

function parseExactInteger(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) throw new TypeError(`Invalid Active Mission ${field}.`)
    return parsed
}

function parseOptionalIntegerList(value: unknown, field: string): readonly number[] | null {
    if (value === undefined || value === null || value === "(None)") return null
    if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    if (String(value).length === 0) return []
    return Object.freeze(String(value).split(",").map(item => {
        const parsed = parseExactInteger(item, field)
        if (parsed === undefined || parsed < 0) {
            throw new TypeError(`Invalid Active Mission ${field}.`)
        }
        return parsed
    }))
}

export function parseActiveMissionQuestRange(
    row: readonly unknown[],
): ActiveMissionQuestRange | null {
    const rawKind = row[34]
    if (rawKind === undefined || rawKind === null || rawKind === "(None)") return null
    const kind = parseExactInteger(rawKind, "quest range kind")
    if (kind === undefined || QUEST_CATEGORY_BY_RANGE_KIND[kind] === undefined) {
        throw new TypeError(`Unsupported Active Mission quest range kind ${String(rawKind)}.`)
    }
    const rawCategories = QUEST_CATEGORY_BY_RANGE_KIND[kind]
    const categories = Object.freeze(Array.isArray(rawCategories)
        ? [...rawCategories]
        : [rawCategories])
    if (kind === 0 || kind === 1 || kind === 2) {
        return Object.freeze({
            kind,
            categories,
            first: parseOptionalIntegerList(row[35], "quest range first"),
            second: parseOptionalIntegerList(row[36], "quest range second"),
            third: parseOptionalIntegerList(row[37], "quest range third"),
        })
    }
    if (kind === 12) return Object.freeze({ kind, categories })
    return Object.freeze({
        kind,
        categories,
        eventIds: parseOptionalIntegerList(row[35], "quest event id"),
        questNumbers: parseOptionalIntegerList(row[37], "quest numbers"),
    })
}

function matchesOptionalSelector(
    selector: readonly number[] | null | undefined,
    value: number,
): boolean {
    return selector === null || selector === undefined || selector.includes(value)
}

export function matchesActiveMissionQuestRange(
    range: ActiveMissionQuestRange | null,
    category: number,
    questId: number,
): boolean {
    if (range === null) return true
    if (!range.categories.includes(category)) return false
    if (range.kind === 12) return true
    if (range.kind === 0 || range.kind === 1 || range.kind === 2) {
        const normalizedQuestId = range.kind === 1 && questId < 10_000_000
            ? questId + 10_000_000
            : questId
        const rangeQuestId = range.kind === 1 ? normalizedQuestId - 10_000_000 : normalizedQuestId
        const first = Math.floor(rangeQuestId / 1_000_000)
        const remainder = rangeQuestId % 1_000_000
        const second = Math.floor(remainder / 1_000)
        const third = remainder % 1_000
        return matchesOptionalSelector(range.first, first)
            && matchesOptionalSelector(range.second, second)
            && matchesOptionalSelector(range.third, third)
    }
    return matchesOptionalSelector(range.eventIds, Math.floor(questId / 1_000))
        && matchesOptionalSelector(range.questNumbers, questId % 1_000)
}

/** 兼容 34.3 已发布的命名；新代码统一使用 matchesActiveMissionQuestRange。 */
export const matchesPlannedActiveMissionQuestRange = matchesActiveMissionQuestRange

/** Normalize only the legacy raw-row empty kind; the planned parser remains strict. */
export function normalizeRawActiveMissionQuestRangeRow(
    row: readonly unknown[],
): readonly unknown[] {
    if (row[34] !== "") return row
    const normalizedRow = [...row]
    normalizedRow[34] = "0"
    return normalizedRow
}

/** 兼容仍接收 raw master row 的 collector。 */
export function matchesRawActiveMissionQuestRange(
    row: readonly unknown[],
    category: number,
    questId: number,
): boolean {
    const rawKind = row[34]
    if (rawKind === undefined || rawKind === null || rawKind === "(None)") return true
    const kind = Number(rawKind)
    if (Number.isSafeInteger(kind) && kind >= 0 && QUEST_CATEGORY_BY_RANGE_KIND[kind] === undefined) {
        return false
    }
    return matchesActiveMissionQuestRange(
        parseActiveMissionQuestRange(normalizeRawActiveMissionQuestRangeRow(row)),
        category,
        questId,
    )
}

function requireSelector(
    selector: readonly number[] | null | undefined,
    field: string,
): readonly number[] {
    if (!selector || selector.length === 0) {
        throw new TypeError(`Missing Active Mission ${field}.`)
    }
    return selector
}

function cartesianQuestIds(
    first: readonly number[],
    second: readonly number[],
    third: readonly number[],
    base: number,
): number[] {
    const ids: number[] = []
    for (const firstId of first) {
        for (const secondId of second) {
            for (const thirdId of third) {
                ids.push(base + firstId * 1_000_000 + secondId * 1_000 + thirdId)
            }
        }
    }
    return ids
}

export function resolveActiveMissionQuestRangeIds(range: ActiveMissionQuestRange): number[] {
    if (range.kind === 0 || range.kind === 1) {
        return [...new Set(cartesianQuestIds(
            requireSelector(range.first, "quest worlds"),
            requireSelector(range.second, "quest chapters"),
            requireSelector(range.third, "quest numbers"),
            range.kind === 1 ? 10_000_000 : 0,
        ))]
    }
    if (range.kind === 9) {
        const eventIds = requireSelector(range.eventIds, "world story event id")
        const questNumbers = requireSelector(range.questNumbers, "world story event quest numbers")
        return [...new Set(eventIds.flatMap(eventId => (
            questNumbers.map(questNumber => eventId * 1_000 + questNumber)
        )))]
    }
    throw new TypeError(`Unsupported Active Mission quest range kind ${range.kind}.`)
}

/** 兼容旧调用方的 raw row Quest ID 解析入口。 */
export function resolveRawActiveMissionQuestIds(row: readonly unknown[]): number[] {
    const range = parseActiveMissionQuestRange(normalizeRawActiveMissionQuestRangeRow(row))
    if (range === null) throw new TypeError("Missing Active Mission quest range kind.")
    return resolveActiveMissionQuestRangeIds(range)
}
