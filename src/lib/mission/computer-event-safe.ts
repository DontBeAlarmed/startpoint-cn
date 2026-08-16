import { getPlayerCollectedItemTotalsSync, getPlayerItemsSync } from "../../data/domains/item"
import { getPlayerCategoryMissionsSync } from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerPartyGroupListSync } from "../../data/domains/party"
import {
    ContentSnapshotError,
    getContentSnapshot,
} from "../../content/runtime/content-snapshot"
import { buildCharacterStoryQuestIndex } from "./character-queries"
import { characterExpCaps } from "../character"
import { readonlyMap, readonlySet } from "./degree-immutable"
import bundledCharacters from "../../../assets/character.json"
import bundledCharacterQuests from "../../../assets/character_quest_lookup.json"
import bundledEquipmentDissolve from "../../../assets/equipment_dissolve.json"
import bundledItemSale from "../../../assets/item_sale.json"
import bundledMainQuests from "../../../assets/main_quest.json"
import bundledManaBoard from "../../../assets/mana_board.json"
import {
    getMissionCatalog,
    getMissionCatalogContentTable,
    type MissionCatalog,
} from "./mission-catalog"
import {
    getEventRuleCatalog,
    type EventRule,
} from "./event-rule-catalog"
import {
    deriveEventCurrentState,
    type EventCharacterStaticFact,
    type EventCurrentStateStaticIndex,
} from "./event-static-state"
import type { CategoryContext, MissionComputer } from "./types"

type RawCharacterTable = Record<string, { readonly rarity?: unknown }>
type RawEquipmentDissolveTable = Record<string, { readonly max_level?: number }>
type RawItemSaleTable = Record<string, { readonly category?: number }>
type RawMainQuestTable = Record<string, unknown>
type RawManaBoardTable = Record<string, Record<string, Record<string, readonly unknown[][]>>>

const staticIndexByRepository = new WeakMap<object, EventCurrentStateStaticIndex>()
const staticIndexByCatalog = new WeakMap<MissionCatalog, EventCurrentStateStaticIndex>()
let bundledStaticIndex: EventCurrentStateStaticIndex | undefined

function unavailableStaticIndex(): EventCurrentStateStaticIndex {
    return Object.freeze({
        characters: null,
        characterStoryQuestIds: null,
        equipmentMaxLevels: null,
        abilitySoulItemIds: null,
        mainQuestIdsByChapter: null,
        manaNodeIdsByCharacter: null,
    })
}

export function getEventCurrentStateMissionIds(): readonly number[] {
    return [...getEventRuleCatalog(getMissionCatalog())]
        .filter(([, rule]) => rule.kind === "currentState")
        .map(([missionId]) => missionId)
        .sort((left, right) => left - right)
}

function getEnabledEventCurrentStateMissionIds(
    catalog: MissionCatalog,
    evaluationTime: Date,
): readonly number[] {
    if (!Number.isFinite(evaluationTime.getTime())) return []
    return [...getEventRuleCatalog(catalog)]
        .filter(([missionId, rule]) => (
            rule.kind === "currentState" && catalog.isEnabledAt(3, missionId, evaluationTime)
        ))
        .map(([missionId]) => missionId)
}

function getOfficialManaNodeIds(
    boards: RawManaBoardTable[string] | undefined,
): ReadonlySet<number> | null {
    if (!boards || typeof boards !== "object" || Array.isArray(boards)) return null
    const nodeIds = new Set<number>()
    for (const board of Object.values(boards)) {
        if (!board || typeof board !== "object" || Array.isArray(board)) return null
        for (const rows of Object.values(board)) {
            if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0])) return null
            const nodeId = Number(rows[0][0])
            if (!Number.isSafeInteger(nodeId) || nodeId <= 0 || nodeIds.has(nodeId)) return null
            nodeIds.add(nodeId)
        }
    }
    return readonlySet(nodeIds)
}

function buildCharacterStaticFacts(
    table: RawCharacterTable,
): ReadonlyMap<string, EventCharacterStaticFact> | null {
    if (!table || typeof table !== "object" || Array.isArray(table)) return null
    const facts = new Map<string, EventCharacterStaticFact>()
    for (const [characterId, row] of Object.entries(table)) {
        const numericCharacterId = Number(characterId)
        const rarity = row?.rarity
        const thresholds = typeof rarity === "number" ? characterExpCaps[rarity] : undefined
        const maxOverLimitStep = thresholds === undefined ? undefined : thresholds.length - 1
        if (!Number.isSafeInteger(numericCharacterId) || numericCharacterId <= 0
            || !row || typeof row !== "object" || Array.isArray(row)
            || !Number.isSafeInteger(rarity) || (rarity as number) <= 0
            || !Array.isArray(thresholds) || thresholds.length === 0
            || thresholds.some(threshold => !Number.isSafeInteger(threshold) || threshold < 0)
            || !Number.isSafeInteger(maxOverLimitStep)
            || maxOverLimitStep! < 0 || maxOverLimitStep! > 12) return null
        facts.set(characterId, Object.freeze({
            rarity: rarity as number,
            maxOverLimitStep: maxOverLimitStep!,
            experienceThresholds: Object.freeze([...thresholds]),
        }))
    }
    return readonlyMap(facts)
}

function buildManaNodeStaticFacts(
    table: RawManaBoardTable,
): ReadonlyMap<string, ReadonlySet<number>> | null {
    if (!table || typeof table !== "object" || Array.isArray(table)) return null
    const facts = new Map<string, ReadonlySet<number>>()
    for (const [characterId, boards] of Object.entries(table)) {
        const numericCharacterId = Number(characterId)
        const nodeIds = getOfficialManaNodeIds(boards)
        if (!Number.isSafeInteger(numericCharacterId) || numericCharacterId <= 0
            || nodeIds === null) return null
        facts.set(characterId, nodeIds)
    }
    return readonlyMap(facts)
}

function buildEquipmentStaticFacts(
    table: RawEquipmentDissolveTable,
): ReadonlyMap<string, number> | null {
    if (!table || typeof table !== "object" || Array.isArray(table)) return null
    const facts = new Map<string, number>()
    for (const [equipmentId, row] of Object.entries(table)) {
        const numericEquipmentId = Number(equipmentId)
        const maxLevel = row?.max_level
        if (!Number.isSafeInteger(numericEquipmentId) || numericEquipmentId <= 0
            || !row || typeof row !== "object" || Array.isArray(row)
            || !Number.isSafeInteger(maxLevel) || (maxLevel ?? 0) <= 0) return null
        facts.set(equipmentId, maxLevel!)
    }
    return readonlyMap(facts)
}

function buildAbilitySoulStaticFacts(
    table: RawItemSaleTable,
): ReadonlySet<number> | null {
    if (!table || typeof table !== "object" || Array.isArray(table)) return null
    const itemIds = new Set<number>()
    for (const [itemId, row] of Object.entries(table)) {
        const numericItemId = Number(itemId)
        const category = row?.category
        if (!Number.isSafeInteger(numericItemId) || numericItemId <= 0
            || !row || typeof row !== "object" || Array.isArray(row)
            || !Number.isSafeInteger(category) || (category ?? -1) < 0) return null
        if (category === 5) itemIds.add(numericItemId)
    }
    return readonlySet(itemIds)
}

function buildMainChapterStaticFacts(
    table: RawMainQuestTable,
): ReadonlyMap<number, readonly number[]> | null {
    if (!table || typeof table !== "object" || Array.isArray(table)) return null
    const questIdsByChapter = new Map<number, number[]>()
    for (const [questIdText, row] of Object.entries(table)) {
        const questId = Number(questIdText)
        const chapter = Math.floor(questId / 1_000_000)
        if (!Number.isSafeInteger(questId) || questId <= 0
            || !Number.isSafeInteger(chapter) || chapter <= 0
            || !row || typeof row !== "object" || Array.isArray(row)) return null
        const questIds = questIdsByChapter.get(chapter) ?? []
        questIds.push(questId)
        questIdsByChapter.set(chapter, questIds)
    }
    return readonlyMap([...questIdsByChapter].map(([chapter, questIds]) => [
        chapter,
        Object.freeze([...questIds]),
    ]))
}

function immutableQuestIndex<Key>(
    index: ReadonlyMap<Key, readonly number[]> | null,
): ReadonlyMap<Key, readonly number[]> | null {
    return index === null ? null : readonlyMap([...index].map(([key, questIds]) => [
        key,
        Object.freeze([...questIds]),
    ]))
}

function buildStaticIndex(
    table: <T>(tableName: string) => T,
): EventCurrentStateStaticIndex {
    const safely = <T>(builder: () => T | null): T | null => {
        try {
            return builder()
        } catch {
            return null
        }
    }
    return Object.freeze({
        characters: safely(() => buildCharacterStaticFacts(table("character.json"))),
        characterStoryQuestIds: safely(() => immutableQuestIndex(
            buildCharacterStoryQuestIndex(table("character_quest_lookup.json")),
        )),
        equipmentMaxLevels: safely(() => buildEquipmentStaticFacts(
            table("equipment_dissolve.json"),
        )),
        abilitySoulItemIds: safely(() => buildAbilitySoulStaticFacts(table("item_sale.json"))),
        mainQuestIdsByChapter: safely(() => buildMainChapterStaticFacts(table("main_quest.json"))),
        manaNodeIdsByCharacter: safely(() => buildManaNodeStaticFacts(table("mana_board.json"))),
    })
}

export function getEventCurrentStateStaticIndex(
    catalog?: MissionCatalog,
): EventCurrentStateStaticIndex {
    if (catalog !== undefined) {
        const cached = staticIndexByCatalog.get(catalog)
        if (cached) return cached
        try {
            const built = buildStaticIndex(<T>(tableName: string) => (
                getMissionCatalogContentTable<T>(catalog, tableName)
            ))
            staticIndexByCatalog.set(catalog, built)
            return built
        } catch {
            const unavailable = unavailableStaticIndex()
            staticIndexByCatalog.set(catalog, unavailable)
            return unavailable
        }
    }
    try {
        const repository = getContentSnapshot().repository
        const cached = staticIndexByRepository.get(repository)
        if (cached) return cached
        const built = buildStaticIndex(<T>(tableName: string) => repository.table<T>(tableName))
        staticIndexByRepository.set(repository, built)
        return built
    } catch (error) {
        if (!(error instanceof ContentSnapshotError)
            || error.code !== "CONTENT_SNAPSHOT_NOT_INITIALIZED") {
            return unavailableStaticIndex()
        }
        if (!bundledStaticIndex) {
            const tables: Readonly<Record<string, unknown>> = {
                "character.json": bundledCharacters,
                "character_quest_lookup.json": bundledCharacterQuests,
                "equipment_dissolve.json": bundledEquipmentDissolve,
                "item_sale.json": bundledItemSale,
                "main_quest.json": bundledMainQuests,
                "mana_board.json": bundledManaBoard,
            }
            bundledStaticIndex = buildStaticIndex(<T>(tableName: string) => tables[tableName] as T)
        }
        return bundledStaticIndex
    }
}

function computeEventCurrentState(
    rule: Extract<EventRule, { kind: "currentState" }>,
    ctx: CategoryContext,
): number | undefined {
    const state = ctx.eventCurrentState
    if (!state) return undefined
    if (rule.rule.fact === "mainChapterClear") {
        return state.clearedMainChapters === null || rule.rule.mainChapter === undefined
            ? undefined
            : state.clearedMainChapters.has(rule.rule.mainChapter) ? 1 : 0
    }
    if (rule.rule.fact === "hasEquippedAbilitySoul") {
        return typeof state.hasEquippedAbilitySoul === "boolean"
            ? state.hasEquippedAbilitySoul ? 1 : 0
            : undefined
    }
    const progress = state[rule.rule.fact]
    return typeof progress === "number"
        && Number.isSafeInteger(progress)
        && progress >= 0
        ? progress
        : undefined
}

function computeHistoricalSingleClear(
    rule: Extract<EventRule, { kind: "historicalSingleClear" }>,
    ctx: CategoryContext,
): number {
    return rule.categories.some(category => (
        ctx.questProgress[String(category)] ?? []
    ).some(progress => (
        progress.finished
        && (rule.questIds === "all" || rule.questIds.includes(progress.questId))
    ))) ? 1 : 0
}

function countMappedQuestClears(
    rule: Extract<EventRule, { kind: "questMapping" }>,
    ctx: CategoryContext,
): number {
    const targetIds = new Set(rule.questIds)
    let count = 0
    for (const category of rule.categories) {
        for (const progress of ctx.questProgress[String(category)] ?? []) {
            if (progress.finished && targetIds.has(progress.questId)) count++
        }
    }
    return count
}

function computeEventRule(
    missionId: number,
    ctx: CategoryContext,
    visiting: Set<number>,
): number | undefined {
    if (visiting.has(missionId)) return undefined
    const rule = ctx.eventRules?.get(missionId)
    if (!rule) return undefined
    visiting.add(missionId)
    try {
        if (rule.kind === "currentState") return computeEventCurrentState(rule, ctx)
        if (rule.kind === "historicalSingleClear") {
            return computeHistoricalSingleClear(rule, ctx)
        }
        if (rule.kind === "collectedItem") {
            return ctx.collectedItemTotals?.[String(rule.itemId)] ?? 0
        }
        if (rule.kind === "timeClear") {
            return (ctx.questProgress[String(rule.questCategory)] ?? []).some(progress => (
                progress.questId === rule.questId
                && progress.finished
                && progress.bestElapsedTimeMs !== undefined
                && progress.bestElapsedTimeMs <= rule.targetTimeMs
            )) ? 1 : 0
        }
        if (rule.kind === "challengeClear") {
            const targetIds = new Set(rule.questIds)
            return (ctx.questProgress["13"] ?? [])
                .filter(progress => progress.finished && targetIds.has(progress.questId))
                .length
        }
        if (rule.kind === "aggregate") {
            let completed = 0
            for (const dependencyId of rule.missionIds) {
                const computed = computeEventRule(dependencyId, ctx, visiting)
                const progress = computed ?? ctx.eventMissionProgress?.get(dependencyId) ?? 0
                if (progress > 0) completed++
            }
            return completed
        }
        if (rule.kind === "questMapping") return countMappedQuestClears(rule, ctx)
        return (ctx.questProgress["22"] ?? []).some(progress => (
            progress.questId === rule.questId && progress.finished
        )) ? 1 : 0
    } finally {
        visiting.delete(missionId)
    }
}

export function getEventSafeMissionIds(): readonly number[] {
    return [...getEventRuleCatalog(getMissionCatalog()).keys()]
        .sort((left, right) => left - right)
}

export function getEventItemMissionItemId(missionId: number): number | undefined {
    const rule = getEventRuleCatalog(getMissionCatalog()).get(missionId)
    return rule?.kind === "collectedItem" ? rule.itemId : undefined
}

export function buildEventSafeQuestProgress(
    rawProgress: ReturnType<typeof getPlayerQuestProgressSync>,
): CategoryContext["questProgress"] {
    return Object.fromEntries(Object.entries(rawProgress).map(([category, progress]) => [
        category,
        progress.map(entry => ({
            questId: entry.questId,
            finished: entry.finished,
            clearRank: entry.clearRank,
            bestElapsedTimeMs: entry.bestElapsedTimeMs,
            leaderCharacterId: entry.leaderCharacterId,
            multiClearCount: entry.multiClearCount,
        })),
    ]))
}

export const EventSafeComputer: MissionComputer = {
    name: "EventSafe",

    buildContext(playerId: number, category: number, evaluationTime: Date): CategoryContext {
        const player = getPlayerSync(playerId)
        if (!player) throw new Error(`Player ${playerId} not found during event mission evaluation.`)
        const rawProgress = getPlayerQuestProgressSync(playerId)
        const catalog = getMissionCatalog()
        const eventRules = getEventRuleCatalog(catalog)
        const currentStateMissionIds = [...eventRules]
            .filter(([, rule]) => rule.kind === "currentState")
            .map(([missionId]) => missionId)
        const includeCurrentState = getEnabledEventCurrentStateMissionIds(
            catalog,
            evaluationTime,
        ).length > 0
        return {
            category,
            playerId,
            player,
            questProgress: buildEventSafeQuestProgress(rawProgress),
            totalQuestClears: 0,
            totalStories: 0,
            rankCounts: {},
            eventRules,
            collectedItemTotals: getPlayerCollectedItemTotalsSync(playerId),
            eventMissionProgress: new Map(
                Object.entries(getPlayerCategoryMissionsSync(playerId, 3))
                    .map(([missionId, mission]) => [Number(missionId), mission.progress] as const),
            ),
            ...(includeCurrentState ? {
                eventCurrentState: deriveEventCurrentState(
                    {
                        characters: getPlayerCharactersSync(playerId),
                        characterManaNodes: getPlayerCharactersManaNodesSync(playerId),
                        questProgress: buildEventSafeQuestProgress(rawProgress),
                        equipment: getPlayerEquipmentListSync(playerId),
                        items: getPlayerItemsSync(playerId),
                        partyGroups: getPlayerPartyGroupListSync(playerId),
                    },
                    getEventCurrentStateStaticIndex(catalog),
                    currentStateMissionIds,
                    missionId => {
                        const rule = eventRules.get(missionId)
                        return rule?.kind === "currentState" ? rule.rule : undefined
                    },
                ),
            } : {}),
        }
    },

    buildContextFromSession(session, category, missionIds): CategoryContext {
        const { buildEventCategoryContextFromSession } = require("./event-session-context") as
            typeof import("./event-session-context")
        return buildEventCategoryContextFromSession(session, category, missionIds)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const computed = computeEventRule(missionId, ctx, new Set())
        return computed === undefined
            ? dbProgress
            : Math.max(dbProgress, computed)
    },
}
