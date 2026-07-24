import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionMasterDefinitions, isMissionDefinitionEnabledAt } from "./master-data"
import ruleAsset from "../../../assets/mission_event_battle_rules.json"
import bossBattleQuests from "../../../assets/boss_battle_quest.json"
import adventEventQuests from "../../../assets/advent_event_quest.json"
import worldStoryBossQuests from "../../../assets/world_story_event_boss_battle_quest.json"

type MultiRole = "any" | "host" | "guest"
type QuestRange = "All" | "BossBattle" | "AdventEvent" | "WorldStoryEventBossBattle"

interface KeyQuery {
    readonly kind: "All" | "Within"
    readonly values?: readonly number[]
}

interface ExactSelector {
    readonly range: QuestRange
    readonly keys: readonly KeyQuery[]
}

interface ExactMultiRule {
    readonly missionId: number
    readonly patternType: 16 | 17 | 18
    readonly role: MultiRole
    readonly categories: "all" | ReadonlySet<number>
    readonly questIds: "all" | ReadonlySet<number>
    readonly definition: ReturnType<typeof getMissionMasterDefinitions>[number]
}

const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "rules"])
const RULE_FIELDS = new Set([
    "missionId",
    "patternType",
    "role",
    "categories",
    "selector",
    "questIds",
    "rank",
    "compatibility",
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
    const keys = Object.keys(value)
    return keys.length === fields.size && keys.every(key => fields.has(key))
}

function isStrictPositiveIntegerList(value: unknown): value is number[] {
    if (!Array.isArray(value) || value.length === 0) return false
    return value.every((entry, index) => (
        Number.isSafeInteger(entry)
        && entry > 0
        && (index === 0 || entry > value[index - 1])
    ))
}

function isKnownKeyQuery(value: unknown): boolean {
    if (!isPlainRecord(value)) return false
    const query = value
    if (query.kind === "All") return Object.keys(query).length === 1
    return query.kind === "Within"
        && Object.keys(query).length === 2
        && isStrictPositiveIntegerList(query.values)
}

function isKnownSelector(value: unknown): value is ExactSelector {
    if (!isPlainRecord(value)) return false
    const selector = value
    if (Object.keys(selector).length !== 2 || !Array.isArray(selector.keys)) return false
    const keyCountByRange: Record<string, number> = {
        All: 0,
        BossBattle: 3,
        AdventEvent: 2,
        WorldStoryEventBossBattle: 2,
    }
    if (typeof selector.range !== "string") return false
    const expectedKeyCount = keyCountByRange[selector.range]
    return expectedKeyCount !== undefined
        && selector.keys.length === expectedKeyCount
        && selector.keys.every(isKnownKeyQuery)
}

function parseMasterQuery(value: unknown, single: boolean = false): KeyQuery | null {
    if (value === "(None)") return { kind: "All" }
    const entries = value === "" ? [] : String(value).split(",")
    if (single && entries.length > 1) return null
    const values = entries.map(entry => Number(entry))
    if (values.some(entry => !Number.isSafeInteger(entry) || entry <= 0)) return null
    return { kind: "Within", values }
}

function selectorFromDefinition(row: readonly unknown[]): ExactSelector | null {
    const questKind = String(row[7])
    if (questKind === "(None)") return { range: "All", keys: [] }

    const rangeByQuestKind: Record<string, QuestRange> = {
        "2": "BossBattle",
        "5": "AdventEvent",
        "10": "WorldStoryEventBossBattle",
    }
    const range = rangeByQuestKind[questKind]
    if (!range) return null
    const keys = range === "BossBattle"
        ? [parseMasterQuery(row[8]), parseMasterQuery(row[9]), parseMasterQuery(row[10])]
        : [parseMasterQuery(row[8], true), parseMasterQuery(row[10])]
    if (keys.some(query => query === null)) return null
    return { range, keys: keys as KeyQuery[] }
}

function selectorsEqual(left: ExactSelector, right: ExactSelector): boolean {
    if (left.range !== right.range || left.keys.length !== right.keys.length) return false
    return left.keys.every((query, index) => {
        const other = right.keys[index]
        if (query.kind !== other.kind) return false
        if (query.kind === "All") return true
        return query.values!.length === other.values!.length
            && query.values!.every((value, valueIndex) => value === other.values![valueIndex])
    })
}

function queryMatches(query: KeyQuery, value: number): boolean {
    return query.kind === "All" || query.values!.includes(value)
}

function questIdValues(range: QuestRange, questId: number): number[] | null {
    if (range === "BossBattle") {
        return [
            Math.trunc(questId / 1_000_000),
            Math.trunc(questId / 1_000) % 1_000,
            questId % 1_000,
        ]
    }
    if (range === "AdventEvent" || range === "WorldStoryEventBossBattle") {
        return [Math.trunc(questId / 1_000), questId % 1_000]
    }
    return null
}

function trackedQuestIds(table: Record<string, unknown>): readonly number[] | null {
    const ids = Object.keys(table).map(key => {
        const id = Number(key)
        return Number.isSafeInteger(id) && id > 0 && String(id) === key ? id : null
    })
    if (ids.some(id => id === null)) return null
    return (ids as number[]).sort((left, right) => left - right)
}

const TRACKED_QUEST_IDS: Record<Exclude<QuestRange, "All">, readonly number[] | null> = {
    BossBattle: trackedQuestIds(bossBattleQuests),
    AdventEvent: trackedQuestIds(adventEventQuests),
    WorldStoryEventBossBattle: trackedQuestIds(worldStoryBossQuests),
}

function hasMatchingRangeData(
    selector: ExactSelector,
    categories: unknown,
    questIds: unknown,
): categories is number[] | "all" {
    if (selector.range === "All") {
        return categories === "all" && questIds === "all" && selector.keys.length === 0
    }

    const categoryByRange: Record<Exclude<QuestRange, "All">, number> = {
        BossBattle: 2,
        AdventEvent: 7,
        WorldStoryEventBossBattle: 19,
    }
    if (!isStrictPositiveIntegerList(categories)
        || categories.length !== 1
        || categories[0] !== categoryByRange[selector.range]
        || !isStrictPositiveIntegerList(questIds)) return false

    const sourceQuestIds = TRACKED_QUEST_IDS[selector.range]
    if (sourceQuestIds === null) return false
    const expectedQuestIds = sourceQuestIds.filter(questId => {
        const values = questIdValues(selector.range, questId)
        return values !== null
            && values.length === selector.keys.length
            && values.every((value, index) => queryMatches(selector.keys[index], value))
    })
    return questIds.length === expectedQuestIds.length
        && questIds.every((questId, index) => questId === expectedQuestIds[index])
}

function hasMatchingRole(patternType: number, role: unknown): role is MultiRole {
    return patternType === 16 && role === "any"
        || patternType === 17 && role === "host"
        || patternType === 18 && role === "guest"
}

export function loadExactEventBattleRules(assetValue: unknown): readonly ExactMultiRule[] {
    if (!isPlainRecord(assetValue)
        || !hasOnlyFields(assetValue, TOP_LEVEL_FIELDS)
        || assetValue.schemaVersion !== 1
        || !Array.isArray(assetValue.rules)) return []
    const rawRules = assetValue.rules

    const missionIds = new Set<number>()
    for (const value of rawRules) {
        if (!isPlainRecord(value)) continue
        const missionId = value.missionId
        if (!Number.isSafeInteger(missionId) || (missionId as number) <= 0) continue
        if (missionIds.has(missionId as number)) return []
        missionIds.add(missionId as number)
    }

    const definitions = new Map(
        getMissionMasterDefinitions(3).map(definition => [definition.missionId, definition]),
    )
    const rules: ExactMultiRule[] = []

    for (const value of rawRules) {
        if (!isPlainRecord(value) || !hasOnlyFields(value, RULE_FIELDS)) continue
        const raw = value
        if (!Number.isSafeInteger(raw.missionId)
            || (raw.missionId as number) <= 0
            || !Number.isSafeInteger(raw.patternType)) continue
        const missionId = raw.missionId as number
        const patternType = raw.patternType as number
        if (!hasMatchingRole(patternType, raw.role)) continue
        if (raw.compatibility !== null || raw.rank !== null || !isKnownSelector(raw.selector)) continue
        if (!hasMatchingRangeData(raw.selector, raw.categories, raw.questIds)) continue

        const definition = definitions.get(missionId)
        if (!definition
            || Number(definition.row[2]) !== patternType
            || definition.row[11] !== "(None)") continue
        const masterSelector = selectorFromDefinition(definition.row)
        if (masterSelector === null || !selectorsEqual(raw.selector, masterSelector)) continue
        rules.push({
            missionId,
            patternType: patternType as 16 | 17 | 18,
            role: raw.role,
            categories: raw.categories === "all" ? "all" : new Set(raw.categories as number[]),
            questIds: raw.questIds === "all" ? "all" : new Set(raw.questIds as number[]),
            definition,
        })
    }
    return Object.freeze(rules)
}

const exactMultiRules = loadExactEventBattleRules(ruleAsset)

function matchesRole(role: MultiRole, isMultiHost: boolean | undefined): boolean {
    if (role === "any") return true
    if (role === "host") return isMultiHost === true
    if (role === "guest") return isMultiHost === false
    return false
}

export function getExactEventBattleRuleCoverage() {
    const roles = exactMultiRules.reduce((counts, rule) => {
        counts[rule.role]++
        return counts
    }, { any: 0, host: 0, guest: 0 })
    return {
        totalEventMissions: getMissionMasterDefinitions(3).length,
        exactMultiRules: exactMultiRules.length,
        roles,
    }
}

export function recordEventMissionBattleFacts(
    ctx: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!ctx.questAccomplished || ctx.isMulti !== true) return []

    const matchedMissionIds: number[] = []
    for (const rule of exactMultiRules) {
        if (!matchesRole(rule.role, ctx.isMultiHost)) continue
        if (rule.categories !== "all" && !rule.categories.has(ctx.questCategory)) continue
        if (rule.questIds !== "all" && !rule.questIds.has(ctx.questId)) continue
        if (!isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
        incrementPlayerCategoryMissionSync(ctx.playerId, 3, rule.missionId, 1)
        matchedMissionIds.push(rule.missionId)
    }
    return matchedMissionIds
}
