import bundledPlayerHistories from "../../assets/player_history.json"
import bundledPlayerHistoryBackgrounds from "../../assets/player_history_card_background.json"
import bundledPlayerHistoryTopics from "../../assets/player_history_topic.json"

import { getRuntimeContentTableSync } from "../content/runtime/table-access"

type RawFlatTable = Record<string, unknown>
type RawNestedTable = Record<string, unknown>
type NullableValues = Array<number | string | null>

export interface PlayerHistoryTopicValueList {
    int_values: NullableValues | null
    string_values: NullableValues | null
    date_values: NullableValues | null
    character_id_values: NullableValues | null
    equipment_id_values: NullableValues | null
    quest_values: NullableValues | null
    boss_id_values: NullableValues | null
}

export interface PlayerHistoryTopicDefinition {
    readonly index: number
    readonly aggregationTarget: number
    readonly toggleDefault: boolean
}

export interface PlayerHistoryCatalog {
    readonly playerHistoryId: number
    readonly defaultBackgroundId: number
    readonly backgroundIds: ReadonlySet<number>
    readonly topics: readonly PlayerHistoryTopicDefinition[]
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
const JST_OFFSET_HOURS = 9
const EMPTY_FIELDS: PlayerHistoryTopicValueList = Object.freeze({
    int_values: null,
    string_values: null,
    date_values: null,
    character_id_values: null,
    equipment_id_values: null,
    quest_values: null,
    boss_id_values: null,
})

function malformed(subject: string): never {
    throw new Error(`player history master data is malformed: ${subject}`)
}

function parsePositiveInteger(value: unknown, subject: string): number {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
    if (!Number.isSafeInteger(parsed) || parsed <= 0) malformed(subject)
    return parsed
}

function parseNonNegativeInteger(value: unknown, subject: string): number {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
    if (!Number.isSafeInteger(parsed) || parsed < 0) malformed(subject)
    return parsed
}

function parseBoolean(value: unknown, subject: string): boolean {
    if (value === "true" || value === "TRUE" || value === "True") return true
    if (value === "false" || value === "FALSE" || value === "False") return false
    return malformed(subject)
}

function parseSingleRow(value: unknown, length: number, subject: string): readonly string[] {
    if (!Array.isArray(value) || value.length !== 1
        || !Array.isArray(value[0]) || value[0].length !== length
        || !value[0].every(field => typeof field === "string")) {
        malformed(subject)
    }
    return value[0] as string[]
}

function parseJstDate(value: string, subject: string): number {
    const match = DATE_PATTERN.exec(value)
    if (!match) malformed(subject)
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
    const year = Number(yearText)
    const month = Number(monthText)
    const day = Number(dayText)
    const hour = Number(hourText)
    const minute = Number(minuteText)
    const second = Number(secondText)
    const timestamp = Date.UTC(
        year,
        month - 1,
        day,
        hour - JST_OFFSET_HOURS,
        minute,
        second,
    )
    const jst = new Date(timestamp + JST_OFFSET_HOURS * 3600_000)
    if (jst.getUTCFullYear() !== year
        || jst.getUTCMonth() + 1 !== month
        || jst.getUTCDate() !== day
        || jst.getUTCHours() !== hour
        || jst.getUTCMinutes() !== minute
        || jst.getUTCSeconds() !== second) {
        malformed(subject)
    }
    return timestamp
}

function parseCurrentHistoryId(table: RawFlatTable, nowMs: number): number {
    for (const [idText, rawRows] of Object.entries(table)) {
        const id = parsePositiveInteger(idText, `history id ${idText}`)
        const row = parseSingleRow(rawRows, 4, `history ${id}`)
        const startTime = parseJstDate(row[2], `history ${id} start_time`)
        const endTime = parseJstDate(row[3], `history ${id} end_time`)
        if (startTime <= nowMs && nowMs <= endTime) return id
    }
    return malformed("no history period is available at the current server time")
}

function parseBackgrounds(table: RawFlatTable): {
    readonly ids: ReadonlySet<number>
    readonly defaultId: number
} {
    const ids = new Set<number>()
    let defaultId: number | null = null
    for (const [idText, rawRows] of Object.entries(table)) {
        const id = parsePositiveInteger(idText, `background id ${idText}`)
        const row = parseSingleRow(rawRows, 5, `background ${id}`)
        ids.add(id)
        if (parseBoolean(row[4], `background ${id} is_default`)) {
            if (defaultId !== null) malformed("multiple default backgrounds")
            defaultId = id
        }
    }
    if (defaultId === null) malformed("default background is missing")
    return { ids, defaultId }
}

function parseTopics(table: RawNestedTable, historyId: number): readonly PlayerHistoryTopicDefinition[] {
    const rawTopics = table[String(historyId)]
    if (rawTopics === null || typeof rawTopics !== "object" || Array.isArray(rawTopics)) {
        malformed(`topics for history ${historyId}`)
    }
    return Object.entries(rawTopics as Record<string, unknown>)
        .map(([indexText, rawRows]) => {
            const index = parsePositiveInteger(indexText, `topic index ${indexText}`)
            const row = parseSingleRow(rawRows, 5, `topic ${historyId}:${index}`)
            const multipliedId = parsePositiveInteger(row[0], `topic ${historyId}:${index} multiplied_id`)
            if (Math.floor(multipliedId / 1000) !== historyId || multipliedId % 1000 !== index) {
                malformed(`topic ${historyId}:${index} multiplied_id`)
            }
            return Object.freeze({
                index,
                aggregationTarget: parseNonNegativeInteger(
                    row[2],
                    `topic ${historyId}:${index} aggregation_target`,
                ),
                toggleDefault: parseBoolean(row[4], `topic ${historyId}:${index} toggle_default`),
                displayOrder: parsePositiveInteger(row[1], `topic ${historyId}:${index} display_order`),
            })
        })
        .sort((left, right) => left.displayOrder - right.displayOrder)
        .map(({ index, aggregationTarget, toggleDefault }) => Object.freeze({
            index,
            aggregationTarget,
            toggleDefault,
        }))
}

export function loadPlayerHistoryCatalog(nowMs: number): PlayerHistoryCatalog {
    if (!Number.isFinite(nowMs)) malformed("current server time")
    const histories = getRuntimeContentTableSync(
        "player_history.json",
        bundledPlayerHistories as RawFlatTable,
    )
    const historyId = parseCurrentHistoryId(histories, nowMs)
    const backgrounds = parseBackgrounds(getRuntimeContentTableSync(
        "player_history_card_background.json",
        bundledPlayerHistoryBackgrounds as RawFlatTable,
    ))
    const topics = parseTopics(getRuntimeContentTableSync(
        "player_history_topic.json",
        bundledPlayerHistoryTopics as RawNestedTable,
    ), historyId)
    return Object.freeze({
        playerHistoryId: historyId,
        defaultBackgroundId: backgrounds.defaultId,
        backgroundIds: backgrounds.ids,
        topics,
    })
}

function nulls(length: number): null[] {
    return Array.from({ length }, () => null)
}

export function createEmptyPlayerHistoryTopicValues(
    aggregationTarget: number,
): PlayerHistoryTopicValueList {
    const valueList: PlayerHistoryTopicValueList = { ...EMPTY_FIELDS }
    if ([0, 7, 8].includes(aggregationTarget)) valueList.date_values = nulls(1)
    else if ([2, 3].includes(aggregationTarget)) valueList.date_values = nulls(6)
    else if (aggregationTarget === 4) {
        valueList.date_values = nulls(1)
        valueList.character_id_values = nulls(1)
    } else if ([1, 5, 6, 9, 10, 11, 13, 14, 15, 21, 22, 23, 24, 25].includes(aggregationTarget)) {
        valueList.int_values = nulls(1)
    } else if (aggregationTarget === 12) valueList.int_values = nulls(2)
    else if (aggregationTarget === 16) {
        valueList.int_values = nulls(12)
        valueList.equipment_id_values = [5010045, 5040020, 5100011, 5030028, 5010032, 5010056]
    } else if (aggregationTarget === 17) {
        valueList.int_values = nulls(2)
        valueList.character_id_values = nulls(7)
    } else if ([18, 19, 20].includes(aggregationTarget)) valueList.int_values = nulls(2)
    else if (aggregationTarget === 26) {
        valueList.date_values = nulls(1)
        valueList.boss_id_values = nulls(1)
    } else malformed(`unsupported aggregation target ${aggregationTarget}`)
    return valueList
}
