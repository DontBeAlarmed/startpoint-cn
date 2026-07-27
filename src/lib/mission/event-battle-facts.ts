import {
    ensurePlayerCategoryMissionProgressSync,
    incrementPlayerCategoryMissionsIfSafeSync,
    incrementPlayerCategoryMissionIfSafeSync,
    incrementPlayerCategoryMissionSync,
} from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionMasterDefinition, getMissionMasterDefinitions, isMissionDefinitionEnabledAt } from "./master-data"
import { getExactEventSingleClearRules } from "./event-single-clear-rules"
import ruleAsset from "../../../assets/mission_event_battle_rules.json"
import eventMissionRewards from "../../../assets/mission_event_reward.json"
import { completePlayerEventMissionFactSync } from "../../data/domains/event_mission_entry_facts"
import { getQuestContentTableSync } from "../assets"

type MultiRole = "any" | "host" | "guest"
type QuestRange = "All" | "BossBattle" | "AdventEvent" | "WorldStoryEventBossBattle"
const TYPE16_EMPTY_SELECTOR_COMPATIBILITY = "type16-empty-selector-wildcard"

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

interface ExactClearRule {
    readonly missionId: number
    readonly battleKind: 1 | 3
    readonly category: number
    readonly questIds: ReadonlySet<number>
    readonly definition: ReturnType<typeof getMissionMasterDefinitions>[number]
}

interface ExactPhaseRule {
    readonly missionId: number
    readonly questId: number
    readonly requiredPhase: 1 | 2 | 3 | 4
    readonly definition: ReturnType<typeof getMissionMasterDefinitions>[number]
}

interface ExactStatisticsRule {
    readonly missionId: number
    readonly patternType: 26 | 27 | 28
    readonly battleKind: 3
    readonly statisticsCode: 2 | null
    readonly definition: ReturnType<typeof getMissionMasterDefinitions>[number]
}

interface ExactResistanceDebuffRule {
    readonly missionId: number
    readonly battleKind: 2
    readonly category: 26
    readonly questIds: ReadonlySet<number>
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

function type16EmptySelectorFromDefinition(row: readonly unknown[]): ExactSelector | null {
    if (Number(row[2]) !== 16) return null
    const questKind = String(row[7])
    if (questKind === "2") {
        if (row[8] === "" && row[9] === "" && row[10] === "") {
            return {
                range: "BossBattle",
                keys: [{ kind: "All" }, { kind: "All" }, { kind: "All" }],
            }
        }
        if (row[8] !== "" && row[8] !== "(None)"
            && row[9] !== "" && row[9] !== "(None)"
            && row[10] === "") {
            const first = parseMasterQuery(row[8])
            const second = parseMasterQuery(row[9])
            if (first === null || second === null) return null
            return {
                range: "BossBattle",
                keys: [first, second, { kind: "All" }],
            }
        }
        return null
    }
    if ((questKind === "5" || questKind === "10")
        && row[8] !== "" && row[8] !== "(None)"
        && row[10] === "") {
        const eventId = parseMasterQuery(row[8], true)
        if (eventId === null) return null
        return {
            range: questKind === "5" ? "AdventEvent" : "WorldStoryEventBossBattle",
            keys: [eventId, { kind: "All" }],
        }
    }
    return null
}

function selectorFromDefinition(
    row: readonly unknown[],
    compatibility: unknown = null,
): ExactSelector | null {
    if (compatibility === TYPE16_EMPTY_SELECTOR_COMPATIBILITY) {
        return type16EmptySelectorFromDefinition(row)
    }
    if (compatibility !== null) return null
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

function getTrackedQuestIds(): Record<Exclude<QuestRange, "All">, readonly number[] | null> {
    return {
        BossBattle: trackedQuestIds(getQuestContentTableSync("boss_battle_quest.json")),
        AdventEvent: trackedQuestIds(getQuestContentTableSync("advent_event_quest.json")),
        WorldStoryEventBossBattle: trackedQuestIds(
            getQuestContentTableSync("world_story_event_boss_battle_quest.json"),
        ),
    }
}

function hasMatchingRangeData(
    selector: ExactSelector,
    categories: unknown,
    questIds: unknown,
    compatibility: unknown,
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
        || categories[0] !== categoryByRange[selector.range]) return false

    const sourceQuestIds = getTrackedQuestIds()[selector.range]
    if (sourceQuestIds === null || sourceQuestIds.length === 0) return false
    if (compatibility === TYPE16_EMPTY_SELECTOR_COMPATIBILITY
        && selector.range === "BossBattle"
        && selector.keys.every(query => query.kind === "All")) {
        return questIds === "all"
    }
    if (!isStrictPositiveIntegerList(questIds)) return false
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
        if ((raw.compatibility !== null
            && raw.compatibility !== TYPE16_EMPTY_SELECTOR_COMPATIBILITY)
            || raw.rank !== null
            || !isKnownSelector(raw.selector)) continue
        if (!hasMatchingRangeData(
            raw.selector,
            raw.categories,
            raw.questIds,
            raw.compatibility,
        )) continue

        const definition = definitions.get(missionId)
        if (!definition
            || Number(definition.row[2]) !== patternType
            || definition.row[11] !== "(None)") continue
        const masterSelector = selectorFromDefinition(definition.row, raw.compatibility)
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

function getClearRuleSources(): Record<string, {
    readonly category: number
    readonly quests: Record<string, unknown>
}> {
    return {
        "5": { category: 7, quests: getQuestContentTableSync("advent_event_quest.json") },
        "6": { category: 10, quests: getQuestContentTableSync("story_event_single_quest.json") },
        "7": { category: 13, quests: getQuestContentTableSync("challenge_dungeon_event_quest.json") },
        "16": { category: 23, quests: getQuestContentTableSync("raid_event_quest.json") },
        "17": { category: 24, quests: getQuestContentTableSync("rush_event_quest.json") },
    }
}

function parseExactQuestSuffixes(value: unknown): number[] | null {
    if (typeof value !== "string" || value === "" || value === "(None)") return null
    const values = value.split(",").map(Number)
    return values.length > 0 && values.every((entry, index) => (
        Number.isSafeInteger(entry)
        && entry > 0
        && (index === 0 || entry > values[index - 1])
    )) ? values : null
}

function buildExactClearRules(): readonly ExactClearRule[] {
    const rules: ExactClearRule[] = []
    const sources = getClearRuleSources()
    for (const definition of getMissionMasterDefinitions(3)) {
        if (Number(definition.row[2]) !== 23 || definition.row[11] !== "(None)") continue
        const battleKind = Number(definition.row[5])
        if (battleKind !== 1 && battleKind !== 3) continue
        const source = sources[String(definition.row[7])]
        if (!source) continue
        const eventId = Number(definition.row[8])
        const suffixes = parseExactQuestSuffixes(definition.row[10])
        if (!Number.isSafeInteger(eventId) || eventId <= 0 || suffixes === null) continue
        const questIds = suffixes.map(suffix => eventId * 1000 + suffix)
        if (questIds.some(questId => source.quests[String(questId)] === undefined)) continue
        rules.push({
            missionId: definition.missionId,
            battleKind,
            category: source.category,
            questIds: new Set(questIds),
            definition,
        })
    }
    return Object.freeze(rules)
}

function buildExactPhaseRules(): readonly ExactPhaseRule[] {
    const rules: ExactPhaseRule[] = []
    const rankingEventSingleQuests = getQuestContentTableSync(
        "ranking_event_single_quest.json",
    )
    for (const definition of getMissionMasterDefinitions(3)) {
        const patternType = Number(definition.row[2])
        if (patternType < 49 || patternType > 52 || Number(definition.row[7]) !== 8) continue
        const eventId = Number(definition.row[8])
        const suffix = Number(definition.row[10])
        if (!Number.isSafeInteger(eventId) || eventId <= 0
            || !Number.isSafeInteger(suffix) || suffix <= 0) continue
        const questId = eventId * 1000 + suffix
        if ((rankingEventSingleQuests as Record<string, unknown>)[String(questId)] === undefined) continue
        rules.push({
            missionId: definition.missionId,
            questId,
            requiredPhase: (patternType - 48) as 1 | 2 | 3 | 4,
            definition,
        })
    }
    return Object.freeze(rules)
}

const EXACT_EVENT_STATISTICS_MISSION_IDS = Object.freeze([
    1200, 1208, 1209, 1210, 1211, 1216, 1223,
])

const EVENT_STATISTICS_RULES: Readonly<Record<number, {
    readonly patternType: 26 | 27 | 28
    readonly statisticsCode: 2 | null
}>> = {
    1200: { patternType: 28, statisticsCode: 2 },
    1208: { patternType: 26, statisticsCode: null },
    1209: { patternType: 26, statisticsCode: null },
    1210: { patternType: 26, statisticsCode: null },
    1211: { patternType: 28, statisticsCode: 2 },
    1216: { patternType: 27, statisticsCode: null },
    1223: { patternType: 28, statisticsCode: 2 },
}

function buildExactStatisticsRules(): readonly ExactStatisticsRule[] {
    const rules: ExactStatisticsRule[] = []
    for (const missionId of EXACT_EVENT_STATISTICS_MISSION_IDS) {
        const expected = EVENT_STATISTICS_RULES[missionId]
        const definition = getMissionMasterDefinition(3, missionId)
        if (!expected || !definition
            || definition.missionId !== missionId
            || Number(definition.row[2]) !== expected.patternType
            || Number(definition.row[5]) !== 3
            || definition.row[11] !== "(None)"
            || (expected.statisticsCode === null
                ? definition.row[3] !== ""
                : Number(definition.row[3]) !== expected.statisticsCode)) continue
        rules.push({
            missionId,
            patternType: expected.patternType,
            battleKind: 3,
            statisticsCode: expected.statisticsCode,
            definition,
        })
    }
    return Object.freeze(rules)
}

const exactStatisticsRules = buildExactStatisticsRules()

const EXACT_RESISTANCE_DEBUFF_RULES: Readonly<Record<number, {
    readonly eventId: number
    readonly pattern: string
    readonly questId: number
}>> = Object.freeze({
    600001: {
        eventId: 1,
        pattern: "hard_multi_steam_robot_fire_clear_01",
        questId: 1001,
    },
    900809: {
        eventId: 1001,
        pattern: "hard_multi_steam_robot_fire_clear_01_constant",
        questId: 1001001,
    },
})

export function hasSingleEventMissionTarget(value: unknown): boolean {
    if (!isPlainRecord(value) || Object.keys(value).length !== 1) return false
    const rows = value["1"]
    return Array.isArray(rows)
        && rows.length === 1
        && Array.isArray(rows[0])
        && rows[0][1] === "1"
}

function buildExactResistanceDebuffRules(): readonly ExactResistanceDebuffRule[] {
    const hardMultiEventQuests = getQuestContentTableSync("hard_multi_event_quest.json")
    const sourceQuestIds = trackedQuestIds(hardMultiEventQuests)
    if (sourceQuestIds === null) return Object.freeze([])
    const rules: ExactResistanceDebuffRule[] = []
    for (const [missionIdToken, expected] of Object.entries(EXACT_RESISTANCE_DEBUFF_RULES)) {
        const missionId = Number(missionIdToken)
        const definition = getMissionMasterDefinition(3, missionId)
        if (!definition
            || definition.pattern !== expected.pattern
            || Number(definition.row[2]) !== 86
            || Number(definition.row[5]) !== 2
            || Number(definition.row[7]) !== 19
            || Number(definition.row[8]) !== expected.eventId
            || definition.row[10] !== ""
            || definition.row[11] !== "(None)"
            || !hasSingleEventMissionTarget(
                (eventMissionRewards as Record<string, unknown>)[missionIdToken],
            )) continue
        if (!sourceQuestIds.includes(expected.questId)
            || Math.trunc(expected.questId / 1_000) !== expected.eventId) continue
        rules.push({
            missionId,
            battleKind: 2,
            category: 26,
            questIds: new Set([expected.questId]),
            definition,
        })
    }
    return Object.freeze(rules)
}

function matchesRole(role: MultiRole, isMultiHost: boolean | undefined): boolean {
    if (role === "any") return true
    if (role === "host") return isMultiHost === true
    if (role === "guest") return isMultiHost === false
    return false
}

export function getExactEventBattleRuleCoverage() {
    const exactMultiRules = loadExactEventBattleRules(ruleAsset)
    const exactClearRules = buildExactClearRules()
    const exactPhaseRules = buildExactPhaseRules()
    const exactEventSingleClearRules = getExactEventSingleClearRules()
    const exactResistanceDebuffRules = buildExactResistanceDebuffRules()
    const roles = exactMultiRules.reduce((counts, rule) => {
        counts[rule.role]++
        return counts
    }, { any: 0, host: 0, guest: 0 })
    return {
        totalEventMissions: getMissionMasterDefinitions(3).length,
        exactMultiRules: exactMultiRules.length,
        roles,
        exactClearRules: exactClearRules.length,
        clearRulesByCategory: exactClearRules.reduce((counts, rule) => {
            counts[rule.category] = (counts[rule.category] ?? 0) + 1
            return counts
        }, {} as Record<number, number>),
        exactPhaseRules: exactPhaseRules.length,
        exactSingleClearRules: exactEventSingleClearRules.length,
        exactStatisticsRules: exactStatisticsRules.length,
        exactStatisticsRuleMissionIds: exactStatisticsRules.map(rule => rule.missionId),
        exactResistanceDebuffRules: exactResistanceDebuffRules.length,
        exactResistanceDebuffRuleMissionIds: exactResistanceDebuffRules.map(rule => rule.missionId),
    }
}

export function getExactEventBattleMissionIds(): readonly number[] {
    const exactMultiRules = loadExactEventBattleRules(ruleAsset)
    const exactClearRules = buildExactClearRules()
    const exactPhaseRules = buildExactPhaseRules()
    const exactEventSingleClearRules = getExactEventSingleClearRules()
    const exactResistanceDebuffRules = buildExactResistanceDebuffRules()
    return Object.freeze([...new Set([
        ...exactMultiRules.map(rule => rule.missionId),
        ...exactClearRules.map(rule => rule.missionId),
        ...exactPhaseRules.map(rule => rule.missionId),
        ...exactStatisticsRules.map(rule => rule.missionId),
        ...exactResistanceDebuffRules.map(rule => rule.missionId),
        ...exactEventSingleClearRules.map(rule => rule.missionId),
    ])].sort((left, right) => left - right))
}

function hasNoReceivedResistanceDebuff(ctx: FinishContext): boolean {
    const zones = ctx.statistics?.zones
    if (!Array.isArray(zones) || zones.length === 0) return false
    return zones.every(zone => {
        if (!isPlainRecord(zone) || !Array.isArray(zone.members) || zone.members.length === 0) {
            return false
        }
        const members = zone.members.filter(member => member !== null)
        return members.length > 0 && members.every(member => (
            isPlainRecord(member)
            && isSafeNonNegativeInteger(member.debuff_r)
            && member.debuff_r === 0
        ))
    })
}

function recordExactResistanceDebuffRules(
    ctx: FinishContext,
    evaluationTime: Date,
): number[] {
    if (ctx.questAccomplished !== true
        || ctx.isMulti !== true
        || ctx.clearRank !== 5
        || !Number.isSafeInteger(ctx.clearTime)
        || ctx.clearTime <= 0
        || !hasNoReceivedResistanceDebuff(ctx)) return []
    const matchedMissionIds: number[] = []
    for (const rule of buildExactResistanceDebuffRules()) {
        if (rule.battleKind !== 2
            || rule.category !== ctx.questCategory
            || !rule.questIds.has(ctx.questId)
            || !isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
        if (completePlayerEventMissionFactSync(ctx.playerId, rule.missionId)) {
            matchedMissionIds.push(rule.missionId)
        }
    }
    return matchedMissionIds
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

function sumZoneStatistic(
    ctx: FinishContext,
    statisticCode: 2,
): number | null {
    const zones = ctx.statistics?.zones
    if (!Array.isArray(zones)) return null
    let total = 0
    for (const zone of zones) {
        if (!isPlainRecord(zone) || !isSafeNonNegativeInteger(zone.use_dash_count)) return null
        total += zone.use_dash_count
        if (!Number.isSafeInteger(total)) return null
    }
    return total
}

function recordExactStatisticsRule(
    ctx: FinishContext,
    rule: ExactStatisticsRule,
    evaluationTime: Date,
): number | null {
    if (rule.battleKind !== 3
        || (ctx.isMulti !== true && ctx.isMulti !== false && ctx.isMulti !== undefined)
        || !isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) return null
    if (rule.patternType === 26) {
        if (ctx.clearRank !== 5) return null
        return incrementPlayerCategoryMissionIfSafeSync(ctx.playerId, 3, rule.missionId, 1)
            ? rule.missionId
            : null
    }
    if (rule.patternType === 27) {
        if (!isSafeNonNegativeInteger(ctx.statistics?.max_power)) return null
        ensurePlayerCategoryMissionProgressSync(ctx.playerId, 3, rule.missionId, ctx.statistics.max_power)
        return rule.missionId
    }
    return null
}

function recordExactStatisticsRules(
    ctx: FinishContext,
    evaluationTime: Date,
): number[] {
    const matchedMissionIds: number[] = []
    const type28Rules: ExactStatisticsRule[] = []
    for (const rule of exactStatisticsRules) {
        if (rule.battleKind !== 3
            || (ctx.isMulti !== true && ctx.isMulti !== false && ctx.isMulti !== undefined)
            || !isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
        if (rule.patternType === 28) {
            type28Rules.push(rule)
            continue
        }
        const missionId = recordExactStatisticsRule(ctx, rule, evaluationTime)
        if (missionId !== null) matchedMissionIds.push(missionId)
    }

    if (type28Rules.length === 0) return matchedMissionIds
    if (type28Rules.some(rule => rule.statisticsCode !== 2)) return matchedMissionIds
    const dashCount = sumZoneStatistic(ctx, 2)
    if (dashCount === null) return matchedMissionIds
    if (incrementPlayerCategoryMissionsIfSafeSync(ctx.playerId, 3, type28Rules.map(rule => ({
        missionId: rule.missionId,
        delta: dashCount,
    })))) {
        matchedMissionIds.push(...type28Rules.map(rule => rule.missionId))
    }
    return matchedMissionIds
}

export function recordEventMissionBattleFacts(
    ctx: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!ctx.questAccomplished) return []

    const exactMultiRules = loadExactEventBattleRules(ruleAsset)
    const exactClearRules = buildExactClearRules()
    const exactEventSingleClearRules = getExactEventSingleClearRules()
    const exactPhaseRules = buildExactPhaseRules()
    const matchedMissionIds: number[] = []
    if (ctx.isMulti === true) {
        for (const rule of exactMultiRules) {
            if (!matchesRole(rule.role, ctx.isMultiHost)) continue
            if (rule.categories !== "all" && !rule.categories.has(ctx.questCategory)) continue
            if (rule.questIds !== "all" && !rule.questIds.has(ctx.questId)) continue
            if (!isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
            incrementPlayerCategoryMissionSync(ctx.playerId, 3, rule.missionId, 1)
            matchedMissionIds.push(rule.missionId)
        }
    }
    for (const rule of exactClearRules) {
        if (rule.battleKind === 1 && ctx.isMulti) continue
        if (rule.category !== ctx.questCategory || !rule.questIds.has(ctx.questId)) continue
        if (!isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
        incrementPlayerCategoryMissionSync(ctx.playerId, 3, rule.missionId, 1)
        matchedMissionIds.push(rule.missionId)
    }
    if (ctx.isMulti !== true) {
        for (const rule of exactEventSingleClearRules) {
            if (!rule.categories.includes(ctx.questCategory)) continue
            if (rule.questIds !== "all" && !rule.questIds.includes(ctx.questId)) continue
            if (!isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
            incrementPlayerCategoryMissionSync(ctx.playerId, 3, rule.missionId, 1)
            matchedMissionIds.push(rule.missionId)
        }
    }
    const clearPhase = ctx.statistics.clear_phase
    if (ctx.isMulti !== true
        && ctx.questCategory === 11
        && Number.isSafeInteger(clearPhase)
        && clearPhase >= 1
        && clearPhase <= 4) {
        for (const rule of exactPhaseRules) {
            if (rule.questId !== ctx.questId || clearPhase < rule.requiredPhase) continue
            if (!isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
            ensurePlayerCategoryMissionProgressSync(ctx.playerId, 3, rule.missionId, 1)
            matchedMissionIds.push(rule.missionId)
        }
    }
    matchedMissionIds.push(...recordExactStatisticsRules(ctx, evaluationTime))
    matchedMissionIds.push(...recordExactResistanceDebuffRules(ctx, evaluationTime))
    return matchedMissionIds
}
