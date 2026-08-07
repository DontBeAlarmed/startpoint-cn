import bundledRegularDefinitions from "../../../assets/mission_regular.json"
import bundledDailyDefinitions from "../../../assets/mission_daily.json"
import bundledEventDefinitions from "../../../assets/mission_event.json"
import bundledCollectItemDefinitions from "../../../assets/mission_collect_item.json"
import bundledDegreeDefinitions from "../../../assets/mission_degree.json"
import bundledCharacterAwakeDefinitions from "../../../assets/mission_char_awake.json"
import bundledWeeklyDefinitions from "../../../assets/mission_weekly_def.json"
import bundledPassDailyDefinitions from "../../../assets/mission_pass_daily.json"
import bundledPassWeekDefinitions from "../../../assets/mission_pass_week.json"
import bundledPassEventDefinitions from "../../../assets/mission_pass_event.json"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"

interface CategoryLayout {
    pattern: number
    start: number
    end: number
    eventId?: number
    patternType?: number
    requiresEventScope?: boolean
}

const CATEGORY_LAYOUT: Readonly<Record<number, CategoryLayout>> = {
    1: { pattern: 0, start: 25, end: 26 },
    2: { pattern: 0, start: 25, end: 26 },
    3: { pattern: 0, start: 25, end: 26 },
    4: { eventId: 0, pattern: 2, start: 27, end: 28, requiresEventScope: true },
    5: { pattern: 1, start: 26, end: 27 },
    6: { eventId: 0, pattern: 1, patternType: 3, start: 26, end: 27 },
    7: { eventId: 0, pattern: 1, patternType: 3, start: 26, end: 27 },
    8: { eventId: 0, pattern: 1, patternType: 3, start: 26, end: 27 },
    9: { pattern: 2, start: 27, end: 28 },
    10: { pattern: 0, start: 25, end: 26 },
}

type RawMissionTable = Record<string, unknown>

interface MissionTableSource {
    readonly tableName: string
    readonly bundledBeforeInitialization: RawMissionTable
}

const TABLE_BY_CATEGORY: Readonly<Record<number, MissionTableSource>> = {
    1: { tableName: "mission_regular.json", bundledBeforeInitialization: bundledRegularDefinitions },
    2: { tableName: "mission_daily.json", bundledBeforeInitialization: bundledDailyDefinitions },
    3: { tableName: "mission_event.json", bundledBeforeInitialization: bundledEventDefinitions },
    4: { tableName: "mission_collect_item.json", bundledBeforeInitialization: bundledCollectItemDefinitions },
    5: { tableName: "mission_degree.json", bundledBeforeInitialization: bundledDegreeDefinitions },
    6: { tableName: "mission_pass_daily.json", bundledBeforeInitialization: bundledPassDailyDefinitions },
    7: { tableName: "mission_pass_week.json", bundledBeforeInitialization: bundledPassWeekDefinitions },
    8: { tableName: "mission_pass_event.json", bundledBeforeInitialization: bundledPassEventDefinitions },
    9: { tableName: "mission_char_awake.json", bundledBeforeInitialization: bundledCharacterAwakeDefinitions },
    10: { tableName: "mission_weekly_def.json", bundledBeforeInitialization: bundledWeeklyDefinitions },
}

export interface MissionMasterDefinition {
    category: number
    missionId: number
    pattern: string
    eventId?: number
    patternType?: number
    requiresEventScope?: boolean
    enableStart?: string
    enableEnd?: string
    row: readonly unknown[]
}

const definitionCache = new WeakMap<
    RawMissionTable,
    Map<number, readonly MissionMasterDefinition[]>
>()

function optionalMasterString(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    return String(value)
}

function getFirstRow(value: unknown): readonly unknown[] | undefined {
    if (!Array.isArray(value) || !Array.isArray(value[0])) return undefined
    return value[0]
}

function parseMasterCnTime(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    return Date.parse(`${value.replace(" ", "T")}+08:00`)
}

function getMissionTable(
    source: MissionTableSource,
    repository?: ReadonlyContentRepository,
): RawMissionTable {
    return repository
        ? repository.table<RawMissionTable>(source.tableName)
        : getRuntimeContentTableSync(
            source.tableName,
            source.bundledBeforeInitialization,
        )
}

export function getMissionMasterDefinitions(
    category: number,
    repository?: ReadonlyContentRepository,
): readonly MissionMasterDefinition[] {
    const source = TABLE_BY_CATEGORY[category]
    const layout = CATEGORY_LAYOUT[category]
    if (!source || !layout) throw new Error(`unsupported mission category: ${category}`)
    const table = getMissionTable(source, repository)
    let definitionsByCategory = definitionCache.get(table)
    const cached = definitionsByCategory?.get(category)
    if (cached) return cached

    const definitions: MissionMasterDefinition[] = []
    for (const [missionIdValue, rows] of Object.entries(table)) {
        const row = getFirstRow(rows)
        if (!row) continue

        const missionId = Number(missionIdValue)
        const pattern = optionalMasterString(row[layout.pattern])
        if (!Number.isInteger(missionId) || pattern === undefined) continue

        const eventIdValue = layout.eventId === undefined ? undefined : Number(row[layout.eventId])
        const patternTypeValue = layout.patternType === undefined ? undefined : Number(row[layout.patternType])
        definitions.push(Object.freeze({
            category,
            missionId,
            pattern,
            ...(Number.isInteger(eventIdValue) ? { eventId: eventIdValue } : {}),
            ...(Number.isInteger(patternTypeValue) ? { patternType: patternTypeValue } : {}),
            ...(layout.requiresEventScope ? { requiresEventScope: true } : {}),
            enableStart: optionalMasterString(row[layout.start]),
            enableEnd: optionalMasterString(row[layout.end]),
            row,
        }))
    }
    const frozen = Object.freeze(definitions)
    if (!definitionsByCategory) {
        definitionsByCategory = new Map()
        definitionCache.set(table, definitionsByCategory)
    }
    definitionsByCategory.set(category, frozen)
    return frozen
}

export function getMissionMasterDefinition(
    category: number,
    missionId: number,
    repository?: ReadonlyContentRepository,
): MissionMasterDefinition | undefined {
    return getMissionMasterDefinitions(category, repository)
        .find(definition => definition.missionId === missionId)
}

export function isMissionDefinitionEnabledAt(
    definition: MissionMasterDefinition,
    at: Date,
    eventId?: number,
): boolean {
    if (definition.requiresEventScope && definition.eventId !== eventId) return false

    const now = at.getTime()
    const start = parseMasterCnTime(definition.enableStart)
    const end = parseMasterCnTime(definition.enableEnd)
    if (!Number.isFinite(now)) return false
    if (start !== undefined && (!Number.isFinite(start) || start > now)) return false
    if (end !== undefined && (!Number.isFinite(end) || now > end)) return false
    return true
}

export const MISSION_CATEGORIES = Object.freeze(
    Object.keys(CATEGORY_LAYOUT).map(Number),
)
