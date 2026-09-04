import type { GachaPeriod } from "./model"

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export class GachaPeriodError extends Error {
    readonly resultCode = 1351
}

export function parseGachaJstTimestamp(value: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) throw new TypeError(`Invalid Gacha period: ${value}.`)
    const parts = match.slice(1).map(Number)
    const [year, month, day, hour, minute, second] = parts
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, 0)
    const normalized = [
        date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
        date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
    ]
    if (parts.some((part, index) => part !== normalized[index])) {
        throw new TypeError(`Invalid Gacha period: ${value}.`)
    }
    return date.getTime() - JST_OFFSET_MS
}

export function isGachaPeriodAvailable(period: GachaPeriod, nowMs: number): boolean {
    return Number.isFinite(nowMs)
        && nowMs >= parseGachaJstTimestamp(period.availableFrom)
        && nowMs <= parseGachaJstTimestamp(period.availableUntil)
}
