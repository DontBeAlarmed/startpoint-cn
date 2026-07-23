import regularDefinitions from "../../../assets/mission_regular.json"
import dailyDefinitions from "../../../assets/mission_daily.json"
import eventDefinitions from "../../../assets/mission_event.json"
import collectItemDefinitions from "../../../assets/mission_collect_item.json"
import degreeDefinitions from "../../../assets/mission_degree.json"
import characterAwakeDefinitions from "../../../assets/mission_char_awake.json"
import weeklyDefinitions from "../../../assets/mission_weekly_def.json"

interface CategoryLayout {
    pattern: number
    start: number
    end: number
    eventId?: number
}

const CATEGORY_LAYOUT: Readonly<Record<number, CategoryLayout>> = {
    1: { pattern: 0, start: 25, end: 26 },
    2: { pattern: 0, start: 25, end: 26 },
    3: { pattern: 0, start: 25, end: 26 },
    4: { eventId: 0, pattern: 2, start: 27, end: 28 },
    5: { pattern: 1, start: 26, end: 27 },
    9: { pattern: 2, start: 27, end: 28 },
    10: { pattern: 0, start: 25, end: 26 },
}

type RawMissionTable = Record<string, unknown>

const TABLE_BY_CATEGORY: Readonly<Record<number, RawMissionTable>> = {
    1: regularDefinitions,
    2: dailyDefinitions,
    3: eventDefinitions,
    4: collectItemDefinitions,
    5: degreeDefinitions,
    9: characterAwakeDefinitions,
    10: weeklyDefinitions,
}

export interface MissionMasterDefinition {
    category: number
    missionId: number
    pattern: string
    eventId?: number
    enableStart?: string
    enableEnd?: string
    row: readonly unknown[]
}

const definitionCache = new Map<number, readonly MissionMasterDefinition[]>()

function optionalMasterString(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    return String(value)
}

function getFirstRow(value: unknown): readonly unknown[] | undefined {
    if (!Array.isArray(value) || !Array.isArray(value[0])) return undefined
    return value[0]
}

function parseMasterJstTime(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    return Date.parse(`${value.replace(" ", "T")}+09:00`)
}

export function getMissionMasterDefinitions(category: number): readonly MissionMasterDefinition[] {
    const table = TABLE_BY_CATEGORY[category]
    const layout = CATEGORY_LAYOUT[category]
    if (!table || !layout) throw new Error(`unsupported mission category: ${category}`)
    const cached = definitionCache.get(category)
    if (cached) return cached

    const definitions: MissionMasterDefinition[] = []
    for (const [missionIdValue, rows] of Object.entries(table)) {
        const row = getFirstRow(rows)
        if (!row) continue

        const missionId = Number(missionIdValue)
        const pattern = optionalMasterString(row[layout.pattern])
        if (!Number.isInteger(missionId) || pattern === undefined) continue

        const eventIdValue = layout.eventId === undefined ? undefined : Number(row[layout.eventId])
        definitions.push(Object.freeze({
            category,
            missionId,
            pattern,
            ...(Number.isInteger(eventIdValue) ? { eventId: eventIdValue } : {}),
            enableStart: optionalMasterString(row[layout.start]),
            enableEnd: optionalMasterString(row[layout.end]),
            row,
        }))
    }
    const frozen = Object.freeze(definitions)
    definitionCache.set(category, frozen)
    return frozen
}

export function getMissionMasterDefinition(
    category: number,
    missionId: number,
): MissionMasterDefinition | undefined {
    return getMissionMasterDefinitions(category).find(definition => definition.missionId === missionId)
}

export function isMissionDefinitionEnabledAt(
    definition: MissionMasterDefinition,
    at: Date,
    eventId?: number,
): boolean {
    if (definition.eventId !== undefined && definition.eventId !== eventId) return false

    const now = at.getTime()
    const start = parseMasterJstTime(definition.enableStart)
    const end = parseMasterJstTime(definition.enableEnd)
    if (!Number.isFinite(now)) return false
    if (start !== undefined && (!Number.isFinite(start) || start > now)) return false
    if (end !== undefined && (!Number.isFinite(end) || now > end)) return false
    return true
}

export const MISSION_CATEGORIES = Object.freeze(
    Object.keys(CATEGORY_LAYOUT).map(Number),
)
