import eventQuestMap from "../../../assets/mission_event_quest_map.json"
import { cloneAndFreeze, readonlyMap } from "./degree-immutable"
import {
    getEventCurrentStateRule,
    type EventCurrentStateRule,
} from "./event-current-state-rules"
import {
    getMissionCatalogContentTable,
    type MissionCatalog,
    type MissionMasterDefinition,
} from "./mission-catalog"

const GET_ITEM_COUNT_PATTERN_TYPE = 37
const TARGET_MISSION_CLEAR_PATTERN_TYPE = 13
const SINGLE_BATTLE_CLEAR_PATTERN_TYPE = 14
const CARNIVAL_BATTLE_PATTERN_TYPE = 23
const TIME_CLEAR_PATTERN_TYPE = 15
const HISTORICAL_SINGLE_CLEAR_MISSION_IDS = new Set([
    1213, 1214, 1215, 1221, 1222, 1300, 1303, 1304,
])

interface EventQuestMapping {
    readonly questIds: readonly number[]
    readonly categories: readonly number[]
}

export type EventRule =
    | Readonly<{ kind: "currentState"; rule: EventCurrentStateRule }>
    | Readonly<{
        kind: "historicalSingleClear"
        categories: readonly number[]
        questIds: "all" | readonly number[]
    }>
    | Readonly<{ kind: "collectedItem"; itemId: number }>
    | Readonly<EventQuestMapping & { kind: "questMapping" }>
    | Readonly<{
        kind: "timeClear"
        questCategory: number
        questId: number
        targetTimeMs: number
    }>
    | Readonly<{ kind: "challengeClear"; questIds: readonly number[] }>
    | Readonly<{ kind: "aggregate"; missionIds: readonly number[] }>
    | Readonly<{ kind: "carnivalClear"; questId: number }>

type RawTable = Readonly<Record<string, unknown>>
type RawEventRewardTable = Readonly<Record<string, Record<string, unknown[]>>>

const rulesByCatalog = new WeakMap<MissionCatalog, ReadonlyMap<number, EventRule>>()
const tablesByCatalog = new WeakMap<MissionCatalog, Map<string, RawTable | null>>()

function readTable(catalog: MissionCatalog, tableName: string): RawTable | null {
    let tables = tablesByCatalog.get(catalog)
    if (!tables) {
        tables = new Map()
        tablesByCatalog.set(catalog, tables)
    }
    if (tables.has(tableName)) return tables.get(tableName) ?? null
    try {
        const table = getMissionCatalogContentTable<unknown>(catalog, tableName)
        const parsed = table !== null && typeof table === "object" && !Array.isArray(table)
            ? table as RawTable
            : null
        tables.set(tableName, parsed)
        return parsed
    } catch {
        tables.set(tableName, null)
        return null
    }
}

function parsePositiveIntegerList(value: unknown): readonly number[] | null {
    if (typeof value !== "string" || value.trim() === "") return null
    const values = value.split(",").map(entry => Number(entry.trim()))
    return values.length > 0
        && values.every(entry => Number.isSafeInteger(entry) && entry > 0)
        ? values
        : null
}

function parseStrictPositiveIntegerList(value: unknown): readonly number[] | null {
    if (typeof value !== "string" || value === "" || value === "(None)") return null
    const values = value.split(",").map(Number)
    return values.length > 0 && values.every((entry, index) => (
        Number.isSafeInteger(entry)
        && entry > 0
        && (index === 0 || entry > values[index - 1])
    )) ? values : null
}

function getQuestMapping(definition: MissionMasterDefinition): EventQuestMapping | undefined {
    if (Number(definition.row[2]) !== TARGET_MISSION_CLEAR_PATTERN_TYPE) return undefined
    const raw = (eventQuestMap as Readonly<Record<string, unknown>>)[definition.pattern]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const mapping = raw as Record<string, unknown>
    if (mapping.countMode !== "single"
        || !Array.isArray(mapping.categories)
        || !Array.isArray(mapping.questIds)) return undefined
    const categories = mapping.categories.filter(value => Number.isSafeInteger(value) && value > 0)
    const questIds = mapping.questIds.filter(value => Number.isSafeInteger(value) && value > 0)
    return categories.length === mapping.categories.length
        && questIds.length === mapping.questIds.length
        && categories.length > 0
        && questIds.length > 0
        ? { categories, questIds }
        : undefined
}

function getHistoricalSingleClearRule(
    catalog: MissionCatalog,
    definition: MissionMasterDefinition,
): EventRule | undefined {
    if (!HISTORICAL_SINGLE_CLEAR_MISSION_IDS.has(definition.missionId)
        || Number(definition.row[2]) !== SINGLE_BATTLE_CLEAR_PATTERN_TYPE
        || definition.row[11] !== "(None)") return undefined
    const stages = catalog.getRewardStages(3, definition.missionId)
    if (stages.length !== 1 || stages[0].stage !== 1 || stages[0].targetProgress !== 1) {
        return undefined
    }

    const rangeKind = Number(definition.row[7])
    if ((rangeKind === 1 || rangeKind === 12)
        && definition.row[8] === ""
        && definition.row[10] === "") {
        return {
            kind: "historicalSingleClear",
            categories: rangeKind === 1 ? [4] : [6, 13, 14, 20],
            questIds: "all",
        }
    }
    if (rangeKind !== 7) return undefined
    const eventId = Number(definition.row[8])
    const suffixes = parseStrictPositiveIntegerList(definition.row[10])
    const quests = readTable(catalog, "challenge_dungeon_event_quest.json")
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || suffixes === null || quests === null) {
        return undefined
    }
    const questIds = suffixes.map(suffix => eventId * 1000 + suffix)
    return questIds.every(questId => quests[String(questId)] !== undefined)
        ? { kind: "historicalSingleClear", categories: [13], questIds }
        : undefined
}

function getEventTargetTimeMs(
    catalog: MissionCatalog,
    missionId: number,
): number | undefined {
    const rewards = readTable(catalog, "mission_event_reward.json") as RawEventRewardTable | null
    const stages = rewards?.[String(missionId)]
    const firstStage = stages && Object.values(stages)[0]
    const row = Array.isArray(firstStage) && Array.isArray(firstStage[0])
        ? firstStage[0]
        : undefined
    const seconds = Number(row?.[2])
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

function getTimeClearRule(
    catalog: MissionCatalog,
    definition: MissionMasterDefinition,
): EventRule | undefined {
    if (Number(definition.row[2]) !== TIME_CLEAR_PATTERN_TYPE) return undefined
    const rangeKind = Number(definition.row[7])
    if (rangeKind !== 8 && rangeKind !== 17) return undefined
    const eventId = Number(definition.row[8])
    const questSuffix = Number(definition.row[10])
    if (!Number.isSafeInteger(eventId) || eventId <= 0
        || !Number.isSafeInteger(questSuffix) || questSuffix <= 0) return undefined
    const questId = eventId * 1000 + questSuffix
    let questCategory: number
    if (rangeKind === 8) {
        const quests = readTable(catalog, "ranking_event_single_quest.json")
        const raw = (eventQuestMap as Readonly<Record<string, unknown>>)[definition.pattern]
        const mapping = raw && typeof raw === "object" && !Array.isArray(raw)
            ? raw as Record<string, unknown>
            : undefined
        if (quests === null || quests[String(questId)] === undefined
            || mapping?.countMode !== "finish"
            || !Array.isArray(mapping.categories)
            || mapping.categories.length !== 1 || mapping.categories[0] !== 11
            || !Array.isArray(mapping.questIds)
            || mapping.questIds.length !== 1 || mapping.questIds[0] !== questId) return undefined
        questCategory = 11
    } else {
        const quests = readTable(catalog, "rush_event_quest.json")
        const quest = quests?.[String(questId)]
        if (!quest || typeof quest !== "object" || Array.isArray(quest)
            || Number((quest as { rushEventId?: unknown }).rushEventId) !== eventId) return undefined
        questCategory = 24
    }
    const targetTimeMs = getEventTargetTimeMs(catalog, definition.missionId)
    return targetTimeMs === undefined
        ? undefined
        : { kind: "timeClear", questCategory, questId, targetTimeMs }
}

function getChallengeClearRule(
    catalog: MissionCatalog,
    definition: MissionMasterDefinition,
): EventRule | undefined {
    if (Number(definition.row[2]) !== SINGLE_BATTLE_CLEAR_PATTERN_TYPE
        || !definition.pattern.startsWith("challenge_renewal_")) return undefined
    const eventId = Number(definition.row[8])
    const quests = readTable(catalog, "challenge_dungeon_event_quest.json")
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || quests === null) return undefined
    const rawSuffix = String(definition.row[10] ?? "").trim()
    const questIds = rawSuffix === ""
        ? Object.keys(quests).map(Number)
        : (parsePositiveIntegerList(rawSuffix) ?? []).map(suffix => eventId * 1000 + suffix)
    return questIds.length > 0 && questIds.every(questId => quests[String(questId)] !== undefined)
        ? { kind: "challengeClear", questIds }
        : undefined
}

function getCarnivalClearRule(
    catalog: MissionCatalog,
    definition: MissionMasterDefinition,
): EventRule | undefined {
    if (Number(definition.row[2]) !== CARNIVAL_BATTLE_PATTERN_TYPE
        || !definition.pattern.startsWith("haniwa_carnival_mission_")) return undefined
    const eventId = Number(definition.row[8])
    const questSuffix = Number(definition.row[10])
    if (!Number.isSafeInteger(eventId) || eventId <= 0
        || !Number.isSafeInteger(questSuffix) || questSuffix <= 0) return undefined
    const questId = eventId * 1000 + questSuffix
    const quests = readTable(catalog, "carnival_event_quest.json")
    const quest = quests?.[String(questId)]
    return quest && typeof quest === "object" && !Array.isArray(quest)
        && Number((quest as { eventId?: unknown }).eventId) === eventId
        ? { kind: "carnivalClear", questId }
        : undefined
}

function buildRules(catalog: MissionCatalog): ReadonlyMap<number, EventRule> {
    const rules = new Map<number, EventRule>()
    const resolving = new Set<number>()
    const resolved = new Set<number>()

    const resolve = (missionId: number): EventRule | undefined => {
        if (resolved.has(missionId)) return rules.get(missionId)
        if (resolving.has(missionId)) return undefined
        const definition = catalog.getDefinition(3, missionId)
        if (!definition) return undefined
        resolving.add(missionId)
        let rule: EventRule | undefined
        const currentState = getEventCurrentStateRule(
            definition,
            catalog.getRewardStages(3, missionId),
        )
        if (currentState) {
            rule = { kind: "currentState", rule: currentState }
        } else {
            rule = getHistoricalSingleClearRule(catalog, definition)
            const patternType = Number(definition.row[2])
            if (!rule && patternType === GET_ITEM_COUNT_PATTERN_TYPE) {
                const itemId = Number(definition.row[12])
                if (Number.isSafeInteger(itemId) && itemId > 0) {
                    rule = { kind: "collectedItem", itemId }
                }
            }
            rule ??= getTimeClearRule(catalog, definition)
            rule ??= getChallengeClearRule(catalog, definition)
            if (!rule && patternType === TARGET_MISSION_CLEAR_PATTERN_TYPE) {
                const missionIds = parsePositiveIntegerList(definition.row[17])
                if (missionIds) {
                    if (missionIds.every(dependencyId => resolve(dependencyId) !== undefined)) {
                        rule = { kind: "aggregate", missionIds }
                    }
                } else {
                    const mapping = getQuestMapping(definition)
                    if (mapping) rule = { kind: "questMapping", ...mapping }
                }
            }
            rule ??= getCarnivalClearRule(catalog, definition)
        }
        resolving.delete(missionId)
        resolved.add(missionId)
        if (rule) rules.set(missionId, cloneAndFreeze(rule))
        return rule
    }

    for (const definition of catalog.getDefinitions(3)) resolve(definition.missionId)
    return readonlyMap(rules)
}

export function getEventRuleCatalog(catalog: MissionCatalog): ReadonlyMap<number, EventRule> {
    const cached = rulesByCatalog.get(catalog)
    if (cached) return cached
    const rules = buildRules(catalog)
    rulesByCatalog.set(catalog, rules)
    return rules
}

export function selectEventRules(
    catalog: MissionCatalog,
    missionIds: readonly number[],
): ReadonlyMap<number, EventRule> {
    const allRules = getEventRuleCatalog(catalog)
    const selected = new Map<number, EventRule>()
    const include = (missionId: number): void => {
        if (selected.has(missionId)) return
        const rule = allRules.get(missionId)
        if (!rule) return
        selected.set(missionId, rule)
        if (rule.kind === "aggregate") {
            for (const dependencyId of rule.missionIds) include(dependencyId)
        }
    }
    for (const missionId of missionIds) include(missionId)
    return readonlyMap(selected)
}
