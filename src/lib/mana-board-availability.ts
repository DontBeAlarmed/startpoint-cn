import bundledOpenConditions from "../../assets/mana_board2_open_condition.json"

import { getRuntimeContentTableSync } from "../content/runtime/table-access"
import { getServerDate } from "../utils"
import { getCharacterDataSync } from "./assets"

type RawOpenConditionTable = Record<string, unknown>

export interface ManaBoard2OpenCondition {
    readonly startTime: Date
    readonly endTime: Date
}

const JST_OFFSET_HOURS = 9
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

function parseJstDate(value: unknown, field: string): Date {
    if (typeof value !== "string") throw new Error(`${field} must be a JST date string`)
    const match = DATE_PATTERN.exec(value)
    if (!match) throw new Error(`${field} has an invalid JST date format`)
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
    const year = Number(yearText)
    const month = Number(monthText)
    const day = Number(dayText)
    const hour = Number(hourText)
    const minute = Number(minuteText)
    const second = Number(secondText)
    const utc = new Date(Date.UTC(
        year,
        month - 1,
        day,
        hour - JST_OFFSET_HOURS,
        minute,
        second,
    ))
    const jst = new Date(utc.getTime() + JST_OFFSET_HOURS * 60 * 60 * 1000)
    if (jst.getUTCFullYear() !== year
        || jst.getUTCMonth() + 1 !== month
        || jst.getUTCDate() !== day
        || jst.getUTCHours() !== hour
        || jst.getUTCMinutes() !== minute
        || jst.getUTCSeconds() !== second) {
        throw new Error(`${field} is not a real JST calendar time`)
    }
    return utc
}

export function parseManaBoard2OpenConditionTable(
    table: RawOpenConditionTable,
): ReadonlyMap<number, ManaBoard2OpenCondition> {
    if (!table || typeof table !== "object" || Array.isArray(table)) {
        throw new Error("mana_board2_open_condition table must be an object")
    }
    const result = new Map<number, ManaBoard2OpenCondition>()
    for (const [characterIdText, rawRows] of Object.entries(table)) {
        const characterId = Number(characterIdText)
        if (!Number.isSafeInteger(characterId) || characterId <= 0
            || !Array.isArray(rawRows) || rawRows.length !== 1
            || !Array.isArray(rawRows[0]) || rawRows[0].length !== 2) {
            throw new Error(`mana_board2_open_condition row ${characterIdText} is malformed`)
        }
        const startTime = parseJstDate(rawRows[0][0], `row ${characterIdText} start_time`)
        const endTime = parseJstDate(rawRows[0][1], `row ${characterIdText} end_time`)
        if (startTime.getTime() > endTime.getTime()) {
            throw new Error(`mana_board2_open_condition row ${characterIdText} has an inverted range`)
        }
        result.set(characterId, Object.freeze({ startTime, endTime }))
    }
    return result
}

let cachedSource: RawOpenConditionTable | null = null
let cachedConditions: ReadonlyMap<number, ManaBoard2OpenCondition> | null = null

function getOpenConditions(): ReadonlyMap<number, ManaBoard2OpenCondition> {
    const source = getRuntimeContentTableSync(
        "mana_board2_open_condition.json",
        bundledOpenConditions as RawOpenConditionTable,
    )
    if (source !== cachedSource || cachedConditions === null) {
        cachedSource = source
        cachedConditions = parseManaBoard2OpenConditionTable(source)
    }
    return cachedConditions
}

export function isSecondManaBoardAvailable(
    characterId: number,
    rarity: number,
    evaluationTime: Date,
    conditions: ReadonlyMap<number, ManaBoard2OpenCondition> = getOpenConditions(),
): boolean {
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || rarity <= 2) return false
    const condition = conditions.get(characterId)
    if (!condition || !Number.isFinite(evaluationTime.getTime())) return false
    const timestamp = evaluationTime.getTime()
    return condition.startTime.getTime() <= timestamp && timestamp <= condition.endTime.getTime()
}

export function isCharacterSecondManaBoardAvailable(
    characterId: number,
    evaluationTime: Date = getServerDate(),
): boolean {
    const character = getCharacterDataSync(characterId)
    return character !== null && isSecondManaBoardAvailable(
        characterId,
        character.rarity,
        evaluationTime,
    )
}

export function getVisibleManaBoardIndex(
    persistedIndex: number,
    characterId: number,
    rarity: number,
    evaluationTime: Date,
    conditions: ReadonlyMap<number, ManaBoard2OpenCondition> = getOpenConditions(),
): number {
    if (!Number.isSafeInteger(persistedIndex) || persistedIndex <= 1) return 1
    return isSecondManaBoardAvailable(characterId, rarity, evaluationTime, conditions) ? 2 : 1
}

export function getCharacterVisibleManaBoardIndex(
    persistedIndex: number,
    characterId: number,
    evaluationTime: Date = getServerDate(),
): number {
    const character = getCharacterDataSync(characterId)
    if (character === null) return 1
    return getVisibleManaBoardIndex(
        persistedIndex,
        characterId,
        character.rarity,
        evaluationTime,
    )
}
