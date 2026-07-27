import type {
    ReadonlyCharacterElectionRule,
    ReadonlyCharacterElectionTable,
} from "../content/converters/character-election"

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const MASTER_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
    if (month === 2) return isLeapYear(year) ? 29 : 28
    return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function parseMasterTime(value: unknown): number | null {
    if (typeof value !== "string") return null
    const match = MASTER_TIME_PATTERN.exec(value)
    if (!match) return null
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
    if (year < 1970 || year > 2200 || month < 1 || month > 12
        || day < 1 || day > daysInMonth(year, month)
        || hour > 23 || minute > 59 || second > 59) return null
    return Date.UTC(year, month - 1, day, hour - 8, minute, second)
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export interface ValidatedCharacterElectionRule extends ReadonlyCharacterElectionRule {
    readonly electionId: number
    readonly startAt: number
    readonly endAt: number
    readonly keywordIdSet: ReadonlySet<number>
}

export function getValidatedCharacterElectionRule(
    table: ReadonlyCharacterElectionTable,
    electionId: number,
): ValidatedCharacterElectionRule | null {
    if (!isPositiveSafeInteger(electionId)
        || !table || typeof table !== "object" || Array.isArray(table)) return null
    const rule = table[String(electionId)]
    if (!rule || typeof rule !== "object" || Array.isArray(rule)
        || typeof rule.stringId !== "string"
        || !/^[A-Za-z0-9_]+$/.test(rule.stringId)
        || !Array.isArray(rule.keywordIds)
        || rule.keywordIds.length === 0
        || rule.keywordIds.some(keywordId => !isPositiveSafeInteger(keywordId))) return null
    const startAt = parseMasterTime(rule.startTime)
    const endAt = parseMasterTime(rule.endTime)
    if (startAt === null || endAt === null || startAt > endAt) return null
    const keywordIdSet = new Set(rule.keywordIds)
    if (keywordIdSet.size !== rule.keywordIds.length) return null
    return {
        ...rule,
        electionId,
        startAt,
        endAt,
        keywordIdSet,
    }
}

export function isCharacterElectionOpenAt(
    rule: ValidatedCharacterElectionRule,
    evaluationTime: Date,
): boolean {
    const time = evaluationTime.getTime()
    return Number.isFinite(time) && time >= rule.startAt && time <= rule.endAt
}
