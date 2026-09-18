import type { OrderedMapTextRow } from "../../sync/ordered-map"
import type { ShopItem, ShopItems } from "../../../lib/types/shop"
import {
    resolveContentConverterContext,
    type ContentConverterContext,
} from "../context"
import { parseCsvLine } from "../csv"

const INTEGER_PATTERN = /^(?:0|-?[1-9]\d*)$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

export interface ShopLayout {
    readonly tableName: string
    readonly columnCount: number
    readonly priceStart?: number
    readonly costScheduleId?: number
    readonly costStarts: readonly number[]
    readonly availableFrom: number
    readonly availableUntil: number
    readonly stock: {
        readonly column: number
        readonly emptyValue?: number
    }
    readonly maxFrequency?: number
    readonly dailyStock?: number
    readonly specifiedMonths?: number
    readonly monthlyStock?: number
    readonly rewardStarts: readonly number[]
}

export type ParsedShopRow = readonly [string, string[]]

export function invalidShop(reason: string): never {
    throw new Error(`invalid shop content: ${reason}`)
}

function compareCanonicalIds(left: string, right: string): number {
    const lengthDifference = left.length - right.length
    if (lengthDifference !== 0) return lengthDifference
    return left < right ? -1 : left > right ? 1 : 0
}

export function requireShopRows(
    rows: readonly OrderedMapTextRow[],
    tableName: string,
    columnCount: number,
): ParsedShopRow[] {
    const seen = new Set<string>()
    return [...rows]
        .sort((left, right) => compareCanonicalIds(left.key, right.key))
        .map(row => {
            const numericKey = Number(row.key)
            if (!POSITIVE_INTEGER_PATTERN.test(row.key)
                || !Number.isSafeInteger(numericKey)
                || numericKey <= 0) {
                invalidShop(`${tableName} key must be a canonical positive integer: ${row.key}`)
            }
            if (seen.has(row.key)) invalidShop(`${tableName} has duplicate key: ${row.key}`)
            seen.add(row.key)
            const parsed = parseCsvLine(row.text, `${tableName}[${row.key}]`, invalidShop)
            if (parsed.length !== columnCount) {
                invalidShop(
                    `${tableName}[${row.key}] must have ${columnCount} columns, got ${parsed.length}`,
                )
            }
            return [row.key, parsed] as const
        })
}

export function parseShopInteger(value: string, subject: string): number {
    if (!INTEGER_PATTERN.test(value)) invalidShop(`${subject} must be an integer: ${value}`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidShop(`${subject} must be a safe integer: ${value}`)
    return parsed
}

export function parseOptionalShopInteger(value: string, subject: string): number | undefined {
    return value === "" || value === "(None)" ? undefined : parseShopInteger(value, subject)
}

function parseOptionalMonths(value: string, subject: string): number[] | undefined {
    if (value === "" || value === "(None)") return undefined
    const months = value.split(",").map((part, index) => {
        const month = parseShopInteger(part, `${subject}[${index}]`)
        if (month < 1 || month > 12) invalidShop(`${subject}[${index}] must be 1 through 12`)
        return month
    })
    if (new Set(months).size !== months.length) invalidShop(`${subject} contains duplicates`)
    if (months.some((month, index) => index > 0 && month <= months[index - 1])) {
        invalidShop(`${subject} must be strictly ascending`)
    }
    return months
}

export function parseShopDate(
    value: string,
    subject: string,
    context?: ContentConverterContext,
): string {
    const { gameCalendar } = resolveContentConverterContext(context)
    try {
        gameCalendar.parseMasterTimestamp(value)
    } catch {
        invalidShop(`${subject} must be a valid CN date-time: ${value}`)
    }
    return value
}

export function parseOptionalShopDate(
    value: string,
    subject: string,
    context?: ContentConverterContext,
): string | null {
    return value === "" || value === "(None)" ? null : parseShopDate(value, subject, context)
}

export function parseShopCosts(
    fields: readonly string[],
    starts: readonly number[],
    subject: string,
) {
    return starts.flatMap(start => {
        const id = parseOptionalShopInteger(fields[start], `${subject}.cost[${start}].id`)
        const amount = parseOptionalShopInteger(fields[start + 1], `${subject}.cost[${start}].amount`)
        if (id === undefined && amount === undefined) return []
        if (id === undefined || amount === undefined) {
            return invalidShop(`${subject}.cost[${start}] must contain both id and amount`)
        }
        if (id <= 0 || amount <= 0) {
            return invalidShop(`${subject}.cost[${start}] must be positive`)
        }
        return [{ id, amount }]
    })
}

export function parseShopRewards(
    fields: readonly string[],
    starts: readonly number[],
    subject: string,
) {
    return starts.flatMap(start => {
        const type = parseOptionalShopInteger(fields[start], `${subject}.reward[${start}].type`)
        const id = parseOptionalShopInteger(fields[start + 1], `${subject}.reward[${start}].id`)
        const count = parseOptionalShopInteger(fields[start + 2], `${subject}.reward[${start}].count`)
        if (type === undefined && id === undefined && count === undefined) return []
        if (type === undefined || count === undefined || count <= 0 || type < 0 || type > 4) {
            return invalidShop(`${subject}.reward[${start}] has an invalid type/count shape`)
        }
        if (type === 1 || type === 2) {
            if (id !== undefined) invalidShop(`${subject}.reward[${start}] currency id must be empty`)
            return [{ type, count }]
        }
        if (id === undefined || id <= 0) invalidShop(`${subject}.reward[${start}] id must be present`)
        return [{ type, id, count }]
    })
}

export function parseShopUserCost(
    fields: readonly string[],
    start: number | undefined,
    subject: string,
) {
    if (start === undefined) return undefined
    const type = parseOptionalShopInteger(fields[start], `${subject}.userCost.type`)
    const amount = parseOptionalShopInteger(fields[start + 1], `${subject}.userCost.amount`)
    if (type === undefined && amount === undefined) return undefined
    if (type === undefined || amount === undefined || amount <= 0 || type < 0 || type > 2) {
        return invalidShop(`${subject}.userCost has an invalid type/amount shape`)
    }
    return { type, amount }
}

function parseStock(fields: readonly string[], layout: ShopLayout, subject: string): number {
    const value = fields[layout.stock.column]
    if ((value === "" || value === "(None)") && layout.stock.emptyValue !== undefined) {
        return layout.stock.emptyValue
    }
    return parseShopInteger(value, `${subject}.stock`)
}

export function parseShopItem(
    fields: readonly string[],
    layout: ShopLayout,
    id: string,
    context?: ContentConverterContext,
): ShopItem {
    const subject = `${layout.tableName}[${id}]`
    const item: ShopItem = {
        costs: parseShopCosts(fields, layout.costStarts, subject),
        rewards: parseShopRewards(fields, layout.rewardStarts, subject),
        availableFrom: parseShopDate(fields[layout.availableFrom], `${subject}.availableFrom`, context),
        availableUntil: parseOptionalShopDate(
            fields[layout.availableUntil],
            `${subject}.availableUntil`,
            context,
        ),
        stock: parseStock(fields, layout, subject),
    }
    const userCost = parseShopUserCost(fields, layout.priceStart, subject)
    if (userCost !== undefined) item.userCost = userCost
    if (layout.costScheduleId !== undefined) {
        const costScheduleId = fields[layout.costScheduleId]
        if (costScheduleId !== "" && costScheduleId !== "(None)") {
            item.costScheduleId = costScheduleId
        }
    }
    for (const [fieldName, column] of [
        ["maxFrequency", layout.maxFrequency],
        ["dailyStock", layout.dailyStock],
        ["monthlyStock", layout.monthlyStock],
    ] as const) {
        if (column === undefined) continue
        const value = parseOptionalShopInteger(fields[column], `${subject}.${fieldName}`)
        if (value !== undefined) item[fieldName] = value
    }
    if (layout.specifiedMonths !== undefined) {
        const specifiedMonths = parseOptionalMonths(
            fields[layout.specifiedMonths],
            `${subject}.specifiedMonths`,
        )
        if (specifiedMonths !== undefined) item.specifiedMonths = specifiedMonths
    }
    return item
}

export function convertFlatShop(
    rows: readonly ParsedShopRow[],
    layout: ShopLayout,
    context?: ContentConverterContext,
): ShopItems {
    return Object.fromEntries(rows.map(([id, fields]) => [
        id,
        parseShopItem(fields, layout, id, context),
    ]))
}
