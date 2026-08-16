import bundledRegularDefinitions from "../../../assets/mission_regular.json"
import bundledDailyDefinitions from "../../../assets/mission_daily.json"
import bundledEventDefinitions from "../../../assets/mission_event.json"
import bundledCollectDefinitions from "../../../assets/mission_collect_item.json"
import bundledDegreeDefinitions from "../../../assets/mission_degree.json"
import bundledPassDailyDefinitions from "../../../assets/mission_pass_daily.json"
import bundledPassWeekDefinitions from "../../../assets/mission_pass_week.json"
import bundledPassEventDefinitions from "../../../assets/mission_pass_event.json"
import bundledAwakeDefinitions from "../../../assets/mission_char_awake.json"
import bundledWeeklyDefinitions from "../../../assets/mission_weekly_def.json"
import bundledRegularRewards from "../../../assets/mission_regular_reward.json"
import bundledDailyRewards from "../../../assets/mission_daily_reward.json"
import bundledEventRewards from "../../../assets/mission_event_reward.json"
import bundledCollectRewards from "../../../assets/mission_collect_item_reward.json"
import bundledDegreeRewards from "../../../assets/mission_degree_reward.json"
import bundledPassDailyRewards from "../../../assets/mission_pass_daily_reward.json"
import bundledPassWeekRewards from "../../../assets/mission_pass_week_reward.json"
import bundledPassEventRewards from "../../../assets/mission_pass_event_reward.json"
import bundledAwakeRewards from "../../../assets/mission_char_awake_reward.json"
import bundledWeeklyRewards from "../../../assets/mission_weekly_reward.json"
import bundledCharacters from "../../../assets/character.json"
import bundledCharacterQuests from "../../../assets/character_quest_lookup.json"
import bundledManaBoard from "../../../assets/mana_board.json"
import bundledConfig from "../../../assets/config.json"
import bundledMainQuests from "../../../assets/main_quest.json"
import bundledExQuests from "../../../assets/ex_quest.json"
import bundledTreasureShop from "../../../assets/treasure_shop.json"
import bundledBossBattleQuests from "../../../assets/boss_battle_quest.json"
import bundledExpertSingleEventQuests from "../../../assets/expert_single_event_quest.json"
import bundledWorldStoryEventQuests from "../../../assets/world_story_event_quest.json"
import bundledAdventEventQuests from "../../../assets/advent_event_quest.json"
import bundledCarnivalEventQuests from "../../../assets/carnival_event_quest.json"
import bundledHardMultiEventQuests from "../../../assets/hard_multi_event_quest.json"
import bundledChallengeDungeonEventQuests from "../../../assets/challenge_dungeon_event_quest.json"
import bundledRankingEventSingleQuests from "../../../assets/ranking_event_single_quest.json"
import bundledRushEventQuests from "../../../assets/rush_event_quest.json"
import bundledEquipmentDissolve from "../../../assets/equipment_dissolve.json"
import bundledItemSale from "../../../assets/item_sale.json"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import type {
    MissionCatalogReward,
    MissionCatalogStage,
    MissionMasterDefinition,
} from "./mission-catalog"

type RawTable = Record<string, unknown>

interface CategorySource {
    readonly category: number
    readonly definitionTable: string
    readonly rewardTable: string
    readonly patternIndex: number
    readonly startIndex: number
    readonly endIndex: number
    readonly targetProgressIndex: number
    readonly firstRewardKindIndex: number
    readonly eventIdIndex?: number
    readonly patternTypeIndex?: number
    readonly requiresEventScope?: boolean
    readonly awake?: boolean
}

export interface MissionCatalogSourceEntry {
    readonly definition: MissionMasterDefinition
    readonly stages: readonly MissionCatalogStage[]
    readonly awakeCharacterId?: number
}

const CATEGORY_SOURCES: readonly CategorySource[] = Object.freeze([
    { category: 1, definitionTable: "mission_regular.json", rewardTable: "mission_regular_reward.json", patternIndex: 0, startIndex: 25, endIndex: 26, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 2, definitionTable: "mission_daily.json", rewardTable: "mission_daily_reward.json", patternIndex: 0, startIndex: 25, endIndex: 26, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 3, definitionTable: "mission_event.json", rewardTable: "mission_event_reward.json", patternIndex: 0, startIndex: 25, endIndex: 26, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 4, definitionTable: "mission_collect_item.json", rewardTable: "mission_collect_item_reward.json", eventIdIndex: 0, patternIndex: 2, startIndex: 27, endIndex: 28, targetProgressIndex: 2, firstRewardKindIndex: 6, requiresEventScope: true },
    { category: 5, definitionTable: "mission_degree.json", rewardTable: "mission_degree_reward.json", patternIndex: 1, startIndex: 26, endIndex: 27, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 6, definitionTable: "mission_pass_daily.json", rewardTable: "mission_pass_daily_reward.json", eventIdIndex: 0, patternIndex: 1, patternTypeIndex: 3, startIndex: 26, endIndex: 27, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 7, definitionTable: "mission_pass_week.json", rewardTable: "mission_pass_week_reward.json", eventIdIndex: 0, patternIndex: 1, patternTypeIndex: 3, startIndex: 26, endIndex: 27, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 8, definitionTable: "mission_pass_event.json", rewardTable: "mission_pass_event_reward.json", eventIdIndex: 0, patternIndex: 1, patternTypeIndex: 3, startIndex: 26, endIndex: 27, targetProgressIndex: 1, firstRewardKindIndex: 5 },
    { category: 9, definitionTable: "mission_char_awake.json", rewardTable: "mission_char_awake_reward.json", patternIndex: 2, startIndex: 27, endIndex: 28, targetProgressIndex: 5, firstRewardKindIndex: 9, awake: true },
    { category: 10, definitionTable: "mission_weekly_def.json", rewardTable: "mission_weekly_reward.json", patternIndex: 0, startIndex: 25, endIndex: 26, targetProgressIndex: 1, firstRewardKindIndex: 5 },
])

const BUNDLED_TABLES: Readonly<Record<string, unknown>> = Object.freeze({
    "mission_regular.json": bundledRegularDefinitions,
    "mission_daily.json": bundledDailyDefinitions,
    "mission_event.json": bundledEventDefinitions,
    "mission_collect_item.json": bundledCollectDefinitions,
    "mission_degree.json": bundledDegreeDefinitions,
    "mission_pass_daily.json": bundledPassDailyDefinitions,
    "mission_pass_week.json": bundledPassWeekDefinitions,
    "mission_pass_event.json": bundledPassEventDefinitions,
    "mission_char_awake.json": bundledAwakeDefinitions,
    "mission_weekly_def.json": bundledWeeklyDefinitions,
    "mission_regular_reward.json": bundledRegularRewards,
    "mission_daily_reward.json": bundledDailyRewards,
    "mission_event_reward.json": bundledEventRewards,
    "mission_collect_item_reward.json": bundledCollectRewards,
    "mission_degree_reward.json": bundledDegreeRewards,
    "mission_pass_daily_reward.json": bundledPassDailyRewards,
    "mission_pass_week_reward.json": bundledPassWeekRewards,
    "mission_pass_event_reward.json": bundledPassEventRewards,
    "mission_char_awake_reward.json": bundledAwakeRewards,
    "mission_weekly_reward.json": bundledWeeklyRewards,
    "character.json": bundledCharacters,
    "character_quest_lookup.json": bundledCharacterQuests,
    "mana_board.json": bundledManaBoard,
    "config.json": bundledConfig,
    "main_quest.json": bundledMainQuests,
    "ex_quest.json": bundledExQuests,
    "treasure_shop.json": bundledTreasureShop,
    "boss_battle_quest.json": bundledBossBattleQuests,
    "expert_single_event_quest.json": bundledExpertSingleEventQuests,
    "world_story_event_quest.json": bundledWorldStoryEventQuests,
    "advent_event_quest.json": bundledAdventEventQuests,
    "carnival_event_quest.json": bundledCarnivalEventQuests,
    "hard_multi_event_quest.json": bundledHardMultiEventQuests,
    "challenge_dungeon_event_quest.json": bundledChallengeDungeonEventQuests,
    "ranking_event_single_quest.json": bundledRankingEventSingleQuests,
    "rush_event_quest.json": bundledRushEventQuests,
    "equipment_dissolve.json": bundledEquipmentDissolve,
    "item_sale.json": bundledItemSale,
})

const bundledInfo = Object.freeze({
    source: "bundled" as const,
    assetVersion: "mission-catalog",
    generatorVersion: 0,
    releaseDigest: null,
    contentDigest: "sha256:mission-catalog" as const,
    multiBattleContentDigest: "sha256:mission-catalog" as const,
})

export const bundledMissionContentRepository: ReadonlyContentRepository = Object.freeze({
    info: () => bundledInfo,
    table<T>(tableName: string): T {
        if (!Object.prototype.hasOwnProperty.call(BUNDLED_TABLES, tableName)) {
            throw new Error(`unsupported bundled mission table: ${tableName}`)
        }
        return BUNDLED_TABLES[tableName] as T
    },
})

function asTable(value: unknown): RawTable | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as RawTable
        : undefined
}

function isEmptyMasterValue(value: unknown): boolean {
    return value === undefined || value === null || value === "" || value === "(None)"
}

function parseExactSafeInteger(value: unknown): number | undefined {
    if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined
    if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseExactFiniteNumber(value: unknown): number | undefined {
    let parsed: number
    if (typeof value === "number") {
        parsed = value
    } else {
        if (typeof value !== "string"
            || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined
        parsed = Number(value)
    }
    if (!Number.isFinite(parsed)
        || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) return undefined
    return parsed
}

function positiveSafeInteger(value: unknown): number | undefined {
    const parsed = parseExactSafeInteger(value)
    return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
    const parsed = parseExactSafeInteger(value)
    return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function optionalMasterString(value: unknown): string | undefined {
    if (isEmptyMasterValue(value)) return undefined
    return String(value)
}

function parsePattern(value: unknown): string | undefined {
    if (typeof value !== "string" || value === "(None)" || value.trim() === "") return undefined
    return value
}

function cloneAndFreeze(value: unknown): unknown {
    if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze))
    if (value !== null && typeof value === "object") {
        return Object.freeze(Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, cloneAndFreeze(child)]),
        ))
    }
    return value
}

interface NormalizedEntries {
    readonly values: ReadonlyMap<number, unknown>
    readonly invalid: boolean
}

function normalizeEntries(table: RawTable): NormalizedEntries {
    const values = new Map<number, unknown>()
    const invalidIds = new Set<number>()
    let invalid = false
    for (const [rawId, value] of Object.entries(table)) {
        const id = positiveSafeInteger(rawId)
        if (id === undefined) {
            invalid = true
            continue
        }
        if (invalidIds.has(id)) continue
        if (values.has(id)) {
            values.delete(id)
            invalidIds.add(id)
            invalid = true
            continue
        }
        values.set(id, value)
    }
    return { values, invalid }
}

function parseDefinition(
    source: CategorySource,
    missionId: number,
    rawRows: unknown,
): { definition: MissionMasterDefinition; awakeCharacterId?: number } | undefined {
    if (!Array.isArray(rawRows) || rawRows.length !== 1 || !Array.isArray(rawRows[0])) return undefined
    const row = rawRows[0]
    const pattern = parsePattern(row[source.patternIndex])
    if (pattern === undefined) return undefined

    const eventId = source.eventIdIndex === undefined
        ? undefined
        : positiveSafeInteger(row[source.eventIdIndex])
    const patternType = source.patternTypeIndex !== undefined
        && !isEmptyMasterValue(row[source.patternTypeIndex])
        ? nonnegativeSafeInteger(row[source.patternTypeIndex])
        : undefined
    const awakeCharacterId = source.awake ? positiveSafeInteger(row[1]) : undefined
    if (source.eventIdIndex !== undefined && eventId === undefined) return undefined
    if (source.patternTypeIndex !== undefined
        && !isEmptyMasterValue(row[source.patternTypeIndex])
        && patternType === undefined) return undefined
    if (source.awake && awakeCharacterId === undefined) return undefined

    const definition = Object.freeze({
        category: source.category,
        missionId,
        pattern,
        ...(eventId === undefined ? {} : { eventId }),
        ...(patternType === undefined ? {} : { patternType }),
        ...(source.requiresEventScope ? { requiresEventScope: true } : {}),
        enableStart: optionalMasterString(row[source.startIndex]),
        enableEnd: optionalMasterString(row[source.endIndex]),
        row: cloneAndFreeze(row) as readonly unknown[],
    })
    return { definition, ...(awakeCharacterId === undefined ? {} : { awakeCharacterId }) }
}

function parseRewards(
    row: readonly unknown[],
    firstKindIndex: number,
): readonly MissionCatalogReward[] | undefined {
    const result: MissionCatalogReward[] = []
    for (let slot = 0; slot < 4; slot++) {
        const base = firstKindIndex + slot * 6
        const kindIsEmpty = isEmptyMasterValue(row[base])
        const kind = kindIsEmpty ? undefined : nonnegativeSafeInteger(row[base])
        if (!kindIsEmpty && kind === undefined) return undefined

        const amount = isEmptyMasterValue(row[base + 1])
            ? 0
            : nonnegativeSafeInteger(row[base + 1])
        if (amount === undefined) return undefined
        const optionalIds = [2, 3, 4, 5].map(offset => {
            const value = row[base + offset]
            return isEmptyMasterValue(value) ? undefined : positiveSafeInteger(value)
        })
        for (let offset = 2; offset <= 5; offset++) {
            if (!isEmptyMasterValue(row[base + offset])
                && optionalIds[offset - 2] === undefined) return undefined
        }
        if (kind === undefined) continue
        const [itemId, characterId, equipmentId, degreeId] = optionalIds
        if (amount === 0 && kind !== 6) continue
        if (kind === 1 && itemId === undefined) return undefined
        if (kind === 2 && equipmentId === undefined) return undefined
        if (kind === 4 && characterId === undefined) return undefined
        if (kind === 6 && degreeId === undefined) return undefined

        result.push(Object.freeze({
            kind,
            amount,
            ...(itemId === undefined ? {} : { itemId }),
            ...(characterId === undefined ? {} : { characterId }),
            ...(equipmentId === undefined ? {} : { equipmentId }),
            ...(degreeId === undefined ? {} : { degreeId }),
        }))
    }
    return Object.freeze(result)
}

function parseStages(source: CategorySource, rawStages: unknown): readonly MissionCatalogStage[] | undefined {
    const stageTable = asTable(rawStages)
    if (!stageTable) return undefined
    const normalized = normalizeEntries(stageTable)
    if (normalized.invalid || normalized.values.size === 0) return undefined

    const stages: MissionCatalogStage[] = []
    for (const [stage, rawRows] of normalized.values) {
        if (!Array.isArray(rawRows) || rawRows.length !== 1 || !Array.isArray(rawRows[0])) return undefined
        const row = rawRows[0]
        const missionRewardId = positiveSafeInteger(row[0])
        const targetProgress = parseExactFiniteNumber(row[source.targetProgressIndex])
        if (missionRewardId === undefined
            || targetProgress === undefined
            || targetProgress < 0) return undefined

        let specialReward: MissionCatalogStage["specialReward"]
        const specialKind = source.awake && !isEmptyMasterValue(row[1])
            ? nonnegativeSafeInteger(row[1])
            : undefined
        if (source.awake && !isEmptyMasterValue(row[1])
            && specialKind === undefined) return undefined
        if (specialKind === 0) {
            const characterId = positiveSafeInteger(row[2])
            const boardIndex = positiveSafeInteger(row[3])
            const awakeLevel = positiveSafeInteger(row[4])
            if (characterId === undefined || boardIndex === undefined || awakeLevel === undefined) return undefined
            specialReward = Object.freeze({ characterId, boardIndex, awakeLevel })
        }
        const targetClearSeconds = source.awake && !isEmptyMasterValue(row[6])
            ? nonnegativeSafeInteger(row[6])
            : undefined
        if (source.awake && !isEmptyMasterValue(row[6])
            && targetClearSeconds === undefined) return undefined
        const parsedRewards = parseRewards(row, source.firstRewardKindIndex)
        if (!parsedRewards) return undefined
        stages.push(Object.freeze({
            stage,
            missionRewardId,
            targetProgress,
            ...(targetClearSeconds === undefined ? {} : { targetClearSeconds }),
            rewards: parsedRewards,
            ...(specialReward === undefined ? {} : { specialReward }),
        }))
    }
    stages.sort((left, right) => (
        left.targetProgress - right.targetProgress || left.stage - right.stage
    ))
    return Object.freeze(stages)
}

export function parseMissionCatalogSource(
    repository: ReadonlyContentRepository,
): readonly MissionCatalogSourceEntry[] {
    const result: MissionCatalogSourceEntry[] = []
    for (const source of CATEGORY_SOURCES) {
        const definitionTable = asTable(repository.table(source.definitionTable))
        const rewardTable = asTable(repository.table(source.rewardTable))
        if (!definitionTable || !rewardTable) continue
        const definitions = normalizeEntries(definitionTable)
        const rewards = normalizeEntries(rewardTable)

        for (const [missionId, rawDefinition] of definitions.values) {
            const rawStages = rewards.values.get(missionId)
            if (rawStages === undefined) continue
            const parsedDefinition = parseDefinition(source, missionId, rawDefinition)
            const stages = parseStages(source, rawStages)
            if (!parsedDefinition || !stages) continue
            result.push(Object.freeze({ ...parsedDefinition, stages }))
        }
    }
    return Object.freeze(result)
}
