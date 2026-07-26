import { getPlayerCollectedItemTotalsSync } from "../../data/domains/item"
import { getPlayerCategoryMissionsSync } from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getMissionMasterDefinition, getMissionMasterDefinitions } from "./master-data"
import questMap from "../../../assets/mission_event_quest_map.json"
import carnivalEventQuests from "../../../assets/carnival_event_quest.json"
import challengeDungeonEventQuests from "../../../assets/challenge_dungeon_event_quest.json"
import rankingEventSingleQuests from "../../../assets/ranking_event_single_quest.json"
import rushEventQuests from "../../../assets/rush_event_quest.json"
import eventRewards from "../../../assets/mission_event_reward.json"
import type { CategoryContext, MissionComputer } from "./types"

const GET_ITEM_COUNT_PATTERN_TYPE = 37
const TARGET_MISSION_CLEAR_PATTERN_TYPE = 13
const SINGLE_BATTLE_CLEAR_PATTERN_TYPE = 14
const CARNIVAL_BATTLE_PATTERN_TYPE = 23
const TIME_CLEAR_PATTERN_TYPE = 15

interface SafeQuestMapping {
    readonly questIds: readonly number[]
    readonly categories: readonly number[]
    readonly countMode: "single"
}

interface SafeTimeClearMapping {
    readonly questCategory: number
    readonly questId: number
    readonly targetTimeMs: number
}

function parsePositiveIntegerList(value: unknown): number[] | null {
    if (typeof value !== "string" || value.trim() === "") return null
    const values = value.split(",").map(entry => Number(entry.trim()))
    return values.length > 0
        && values.every(entry => Number.isSafeInteger(entry) && entry > 0)
        ? values
        : null
}

function getSafeQuestMapping(missionId: number): SafeQuestMapping | null {
    const definition = getMissionMasterDefinition(3, missionId)
    if (!definition || Number(definition.row[2]) !== TARGET_MISSION_CLEAR_PATTERN_TYPE) return null

    const raw = (questMap as Record<string, unknown>)[definition.pattern]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const mapping = raw as Record<string, unknown>
    if (mapping.countMode !== "single") return null
    if (!Array.isArray(mapping.categories) || !Array.isArray(mapping.questIds)) return null
    const categories = mapping.categories.filter(value => Number.isSafeInteger(value) && value > 0)
    const questIds = mapping.questIds.filter(value => Number.isSafeInteger(value) && value > 0)
    if (categories.length !== mapping.categories.length
        || questIds.length !== mapping.questIds.length
        || categories.length === 0
        || questIds.length === 0) return null
    return { categories, questIds, countMode: "single" }
}

function getSafeTimeClearMapping(missionId: number): SafeTimeClearMapping | null {
    const definition = getMissionMasterDefinition(3, missionId)
    if (!definition || Number(definition.row[2]) !== TIME_CLEAR_PATTERN_TYPE) return null

    const rangeKind = Number(definition.row[7])
    if (rangeKind !== 8 && rangeKind !== 17) return null

    const eventId = Number(definition.row[8])
    const questSuffix = Number(definition.row[10])
    if (!Number.isSafeInteger(eventId) || eventId <= 0
        || !Number.isSafeInteger(questSuffix) || questSuffix <= 0) return null
    const questId = eventId * 1000 + questSuffix
    let questCategory: number
    if (rangeKind === 8) {
        if (!Object.prototype.hasOwnProperty.call(rankingEventSingleQuests, String(questId))) return null
        const raw = (questMap as Record<string, unknown>)[definition.pattern]
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
        const mapping = raw as Record<string, unknown>
        if (mapping.countMode !== "finish"
            || !Array.isArray(mapping.categories)
            || mapping.categories.length !== 1
            || mapping.categories[0] !== 11
            || !Array.isArray(mapping.questIds)
            || mapping.questIds.length !== 1
            || mapping.questIds[0] !== questId) return null
        questCategory = 11
    } else {
        const quest = (rushEventQuests as Record<string, { rushEventId?: unknown }>)[String(questId)]
        if (!quest || Number(quest.rushEventId) !== eventId) return null
        questCategory = 24
    }

    const stages = (eventRewards as Record<string, Record<string, unknown[]>>)[String(missionId)]
    const firstStage = stages && Object.values(stages)[0]
    const row = Array.isArray(firstStage) && Array.isArray(firstStage[0]) ? firstStage[0] : undefined
    const seconds = Number(row?.[2])
    return Number.isFinite(seconds) && seconds >= 0
        ? { questCategory, questId, targetTimeMs: seconds * 1000 }
        : null
}

function getSafeCarnivalQuestId(missionId: number): number | undefined {
    const definition = getMissionMasterDefinition(3, missionId)
    if (!definition || Number(definition.row[2]) !== CARNIVAL_BATTLE_PATTERN_TYPE) return undefined
    if (!definition.pattern.startsWith("haniwa_carnival_mission_")) return undefined

    const eventId = Number(definition.row[8])
    const questSuffix = Number(definition.row[10])
    if (!Number.isSafeInteger(eventId) || eventId <= 0
        || !Number.isSafeInteger(questSuffix) || questSuffix <= 0) return undefined

    const questId = eventId * 1000 + questSuffix
    const quest = (carnivalEventQuests as Record<string, { eventId?: unknown }>)[String(questId)]
    return quest && Number(quest.eventId) === eventId ? questId : undefined
}

function getSafeChallengeDungeonQuestIds(missionId: number): number[] | undefined {
    const definition = getMissionMasterDefinition(3, missionId)
    if (!definition
        || Number(definition.row[2]) !== SINGLE_BATTLE_CLEAR_PATTERN_TYPE
        || !definition.pattern.startsWith("challenge_renewal_")) return undefined

    const eventId = Number(definition.row[8])
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return undefined
    const rawSuffix = String(definition.row[10] ?? "").trim()
    const questIds = rawSuffix === ""
        ? Object.keys(challengeDungeonEventQuests).map(Number)
        : (parsePositiveIntegerList(rawSuffix) ?? []).map(suffix => eventId * 1000 + suffix)
    if (questIds.length === 0) return undefined

    return questIds.every(questId => (
        Object.prototype.hasOwnProperty.call(challengeDungeonEventQuests, String(questId))
    )) ? questIds : undefined
}

function getReferencedMissionIds(definition: ReturnType<typeof getMissionMasterDefinition>): number[] | null {
    if (!definition || Number(definition.row[2]) !== TARGET_MISSION_CLEAR_PATTERN_TYPE) return null
    const values = parsePositiveIntegerList(definition.row[17])
    return values && values.length > 0 ? values : null
}

function countMappedQuestClears(
    mapping: SafeQuestMapping,
    ctx: CategoryContext,
): number {
    const targetIds = new Set(mapping.questIds)
    let count = 0
    for (const category of mapping.categories) {
        for (const progress of ctx.questProgress[String(category)] ?? []) {
            if (progress.finished && targetIds.has(progress.questId)) count++
        }
    }
    return count
}

function computeTargetMissionClear(
    missionId: number,
    ctx: CategoryContext,
    visiting: Set<number>,
): number | undefined {
    if (visiting.has(missionId)) return undefined
    const definition = getMissionMasterDefinition(3, missionId)
    if (!definition) return undefined
    visiting.add(missionId)
    try {
        const timeClearMapping = getSafeTimeClearMapping(missionId)
        if (timeClearMapping !== null) {
            return (ctx.questProgress[String(timeClearMapping.questCategory)] ?? []).some(progress => (
                progress.questId === timeClearMapping.questId
                && progress.finished
                && progress.bestElapsedTimeMs !== undefined
                && progress.bestElapsedTimeMs <= timeClearMapping.targetTimeMs
            )) ? 1 : 0
        }

        const challengeQuestIds = getSafeChallengeDungeonQuestIds(missionId)
        if (challengeQuestIds !== undefined) {
            const targetIds = new Set(challengeQuestIds)
            return (ctx.questProgress["13"] ?? [])
                .filter(progress => progress.finished && targetIds.has(progress.questId))
                .length
        }

        if (Number(definition.row[2]) === TARGET_MISSION_CLEAR_PATTERN_TYPE) {
            const referencedMissionIds = getReferencedMissionIds(definition)
            if (referencedMissionIds) {
                let completed = 0
                for (const referencedMissionId of referencedMissionIds) {
                    const nested = computeTargetMissionClear(referencedMissionId, ctx, visiting)
                    const progress = nested ?? ctx.eventMissionProgress?.get(referencedMissionId) ?? 0
                    if (progress > 0) completed++
                }
                return completed
            }
            const mapping = getSafeQuestMapping(missionId)
            return mapping ? countMappedQuestClears(mapping, ctx) : undefined
        }

        const carnivalQuestId = getSafeCarnivalQuestId(missionId)
        if (carnivalQuestId === undefined) return undefined
        return (ctx.questProgress["22"] ?? [])
            .some(progress => progress.questId === carnivalQuestId && progress.finished)
            ? 1
            : 0
    } finally {
        visiting.delete(missionId)
    }
}

function isSafeEventMission(missionId: number, visiting: Set<number>): boolean {
    if (visiting.has(missionId)) return false
    if (getEventItemMissionItemId(missionId) !== undefined
        || getSafeCarnivalQuestId(missionId) !== undefined
        || getSafeChallengeDungeonQuestIds(missionId) !== undefined
        || getSafeTimeClearMapping(missionId) !== null) return true

    const definition = getMissionMasterDefinition(3, missionId)
    if (!definition || Number(definition.row[2]) !== TARGET_MISSION_CLEAR_PATTERN_TYPE) return false
    const referencedMissionIds = getReferencedMissionIds(definition)
    if (!referencedMissionIds) return getSafeQuestMapping(missionId) !== null

    visiting.add(missionId)
    try {
        return referencedMissionIds.every(referencedMissionId =>
            isSafeEventMission(referencedMissionId, visiting),
        )
    } finally {
        visiting.delete(missionId)
    }
}

export function getEventSafeMissionIds(): readonly number[] {
    return getMissionMasterDefinitions(3)
        .filter(definition => isSafeEventMission(definition.missionId, new Set()))
        .map(definition => definition.missionId)
}

export function getEventItemMissionItemId(missionId: number): number | undefined {
    const row = getMissionMasterDefinition(3, missionId)?.row
    if (!row || Number(row[2]) !== GET_ITEM_COUNT_PATTERN_TYPE) return undefined
    const itemId = Number(row[12])
    return Number.isSafeInteger(itemId) && itemId > 0 ? itemId : undefined
}

export const EventSafeComputer: MissionComputer = {
    name: "EventSafe",

    buildContext(playerId: number, category: number): CategoryContext {
        const player = getPlayerSync(playerId)
        if (!player) throw new Error(`Player ${playerId} not found during event mission evaluation.`)
        const rawProgress = getPlayerQuestProgressSync(playerId)
        const selectProgress = (questCategory: number) => (rawProgress[String(questCategory)] ?? [])
            .map(progress => ({
                questId: progress.questId,
                finished: progress.finished,
                clearRank: progress.clearRank,
                bestElapsedTimeMs: progress.bestElapsedTimeMs,
                leaderCharacterId: progress.leaderCharacterId,
                multiClearCount: progress.multiClearCount,
            }))
        return {
            category,
            playerId,
            player,
            questProgress: {
                "11": selectProgress(11),
                "24": selectProgress(24),
            },
            totalQuestClears: 0,
            totalStories: 0,
            rankCounts: {},
            collectedItemTotals: getPlayerCollectedItemTotalsSync(playerId),
            eventMissionProgress: new Map(
                Object.entries(getPlayerCategoryMissionsSync(playerId, 3))
                    .map(([missionId, mission]) => [Number(missionId), mission.progress] as const),
            ),
        }
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const itemId = getEventItemMissionItemId(missionId)
        if (itemId !== undefined) {
            return Math.max(dbProgress, ctx.collectedItemTotals?.[String(itemId)] ?? 0)
        }

        const targetMissionProgress = computeTargetMissionClear(missionId, ctx, new Set())
        return targetMissionProgress === undefined
            ? dbProgress
            : Math.max(dbProgress, targetMissionProgress)
    },
}
