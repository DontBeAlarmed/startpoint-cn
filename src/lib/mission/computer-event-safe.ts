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
import {
    getMissionMasterDefinition,
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
} from "./master-data"
import { exactEventSingleClearRules } from "./event-single-clear-rules"
import questMap from "../../../assets/mission_event_quest_map.json"
import carnivalEventQuests from "../../../assets/carnival_event_quest.json"
import challengeDungeonEventQuests from "../../../assets/challenge_dungeon_event_quest.json"
import rankingEventSingleQuests from "../../../assets/ranking_event_single_quest.json"
import rushEventQuests from "../../../assets/rush_event_quest.json"
import eventRewards from "../../../assets/mission_event_reward.json"
import bundledCharacters from "../../../assets/character.json"
import bundledCharacterQuests from "../../../assets/character_quest_lookup.json"
import bundledEquipmentDissolve from "../../../assets/equipment_dissolve.json"
import bundledItemSale from "../../../assets/item_sale.json"
import bundledMainQuests from "../../../assets/main_quest.json"
import bundledManaBoard from "../../../assets/mana_board.json"
import type { CategoryContext, MissionComputer } from "./types"

const GET_ITEM_COUNT_PATTERN_TYPE = 37
const TARGET_MISSION_CLEAR_PATTERN_TYPE = 13
const SINGLE_BATTLE_CLEAR_PATTERN_TYPE = 14
const CARNIVAL_BATTLE_PATTERN_TYPE = 23
const TIME_CLEAR_PATTERN_TYPE = 15

type EventCurrentStateFact =
    | "maxCharacterLevel"
    | "manaBoardNodeCount"
    | "overLimitCount"
    | "characterEpisodeClearCount"
    | "mainChapterClear"
    | "equipmentAwakeningCount"
    | "hasEquippedAbilitySoul"

interface EventCurrentStateRule {
    readonly patternType: number
    readonly targets: readonly number[]
    readonly fact: EventCurrentStateFact
    readonly mainChapter?: number
}

const EVENT_CURRENT_STATE_RULES: Readonly<Record<number, EventCurrentStateRule>> = Object.freeze({
    1201: { patternType: 22, targets: [1], fact: "mainChapterClear", mainChapter: 1 },
    1202: { patternType: 22, targets: [1], fact: "mainChapterClear", mainChapter: 2 },
    1203: { patternType: 22, targets: [1], fact: "mainChapterClear", mainChapter: 3 },
    1204: { patternType: 21, targets: [1], fact: "characterEpisodeClearCount" },
    1205: { patternType: 7, targets: [3], fact: "manaBoardNodeCount" },
    1206: { patternType: 7, targets: [3], fact: "manaBoardNodeCount" },
    1207: { patternType: 7, targets: [3], fact: "manaBoardNodeCount" },
    1212: { patternType: 34, targets: [1], fact: "equipmentAwakeningCount" },
    1217: { patternType: 7, targets: [15], fact: "manaBoardNodeCount" },
    1218: { patternType: 7, targets: [15], fact: "manaBoardNodeCount" },
    1219: { patternType: 7, targets: [15], fact: "manaBoardNodeCount" },
    1220: { patternType: 35, targets: [1], fact: "hasEquippedAbilitySoul" },
    1305: { patternType: 5, targets: [50, 60, 70], fact: "maxCharacterLevel" },
    1306: { patternType: 9, targets: [1], fact: "overLimitCount" },
    1307: { patternType: 34, targets: [1, 2, 3, 4], fact: "equipmentAwakeningCount" },
})

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

type RawCharacterTable = Record<string, { readonly rarity?: unknown }>
type RawEquipmentDissolveTable = Record<string, { readonly max_level?: number }>
type RawItemSaleTable = Record<string, { readonly category?: number }>
type RawMainQuestTable = Record<string, unknown>
type RawManaBoardTable = Record<string, Record<string, Record<string, readonly unknown[][]>>>

interface EventCharacterStaticFact {
    readonly rarity: number
    readonly maxOverLimitStep: number
    readonly experienceThresholds: readonly number[]
}

interface EventCurrentStateStaticIndex {
    readonly characters: ReadonlyMap<string, EventCharacterStaticFact> | null
    readonly characterStoryQuestIds: ReadonlyMap<string, readonly number[]> | null
    readonly equipmentMaxLevels: ReadonlyMap<string, number> | null
    readonly abilitySoulItemIds: ReadonlySet<number> | null
    readonly mainQuestIdsByChapter: ReadonlyMap<number, readonly number[]> | null
    readonly manaNodeIdsByCharacter: ReadonlyMap<string, ReadonlySet<number>> | null
}

const staticIndexByRepository = new WeakMap<object, EventCurrentStateStaticIndex>()
let bundledStaticIndex: EventCurrentStateStaticIndex | undefined

function hasExpectedEventTargets(missionId: number, expected: readonly number[]): boolean {
    const stages = (eventRewards as Record<string, Record<string, unknown[]>>)[String(missionId)]
    if (!stages) return false
    const stageIds = Object.keys(stages).map(Number).sort((left, right) => left - right)
    if (stageIds.length !== expected.length
        || stageIds.some((stageId, index) => stageId !== index + 1)) return false
    return stageIds.every((stageId, index) => {
        const rows = stages[String(stageId)]
        if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0])) return false
        const target = Number(rows[0][1])
        return Number.isSafeInteger(target) && target > 0 && target === expected[index]
    })
}

function getEventCurrentStateRule(missionId: number): EventCurrentStateRule | undefined {
    const rule = EVENT_CURRENT_STATE_RULES[missionId]
    const definition = getMissionMasterDefinition(3, missionId)
    if (!rule || !definition || Number(definition.row[2]) !== rule.patternType) return undefined
    if (!hasExpectedEventTargets(missionId, rule.targets)) return undefined
    if (definition.row[11] !== "(None)") return undefined
    if (rule.fact !== "mainChapterClear") {
        return definition.row[7] === "(None)" ? rule : undefined
    }
    return Number(definition.row[7]) === 0
        && Number(definition.row[8]) === rule.mainChapter
        && definition.row[9] === "(None)"
        && definition.row[10] === "(None)"
        ? rule
        : undefined
}

export function getEventCurrentStateMissionIds(): readonly number[] {
    return Object.keys(EVENT_CURRENT_STATE_RULES)
        .map(Number)
        .filter(missionId => getEventCurrentStateRule(missionId) !== undefined)
        .sort((left, right) => left - right)
}

function hasEnabledEventCurrentStateMission(evaluationTime: Date): boolean {
    if (!Number.isFinite(evaluationTime.getTime())) return false
    return getEventCurrentStateMissionIds().some(missionId => {
        const definition = getMissionMasterDefinition(3, missionId)
        return definition !== undefined
            && isMissionDefinitionEnabledAt(definition, evaluationTime)
    })
}

function getProvenCharacterLevel(
    fact: EventCharacterStaticFact,
    experience: number,
): number | null {
    if (!Number.isSafeInteger(experience) || experience < 0) return null
    const baseLevel = 40 + (fact.rarity - 1) * 10
    let provenLevel = 0
    for (let index = 0; index < fact.experienceThresholds.length; index++) {
        const threshold = fact.experienceThresholds[index]
        if (experience >= threshold) provenLevel = baseLevel + index * 5
    }
    return provenLevel
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
    return nodeIds
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
        facts.set(characterId, {
            rarity: rarity as number,
            maxOverLimitStep: maxOverLimitStep!,
            experienceThresholds: thresholds,
        })
    }
    return facts
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
    return facts
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
    return facts
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
    return itemIds
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
    return questIdsByChapter
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
    return {
        characters: safely(() => buildCharacterStaticFacts(table("character.json"))),
        characterStoryQuestIds: safely(() => buildCharacterStoryQuestIndex(
            table("character_quest_lookup.json"),
        )),
        equipmentMaxLevels: safely(() => buildEquipmentStaticFacts(
            table("equipment_dissolve.json"),
        )),
        abilitySoulItemIds: safely(() => buildAbilitySoulStaticFacts(table("item_sale.json"))),
        mainQuestIdsByChapter: safely(() => buildMainChapterStaticFacts(table("main_quest.json"))),
        manaNodeIdsByCharacter: safely(() => buildManaNodeStaticFacts(table("mana_board.json"))),
    }
}

function getEventCurrentStateStaticIndex(): EventCurrentStateStaticIndex {
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
            return {
                characters: null,
                characterStoryQuestIds: null,
                equipmentMaxLevels: null,
                abilitySoulItemIds: null,
                mainQuestIdsByChapter: null,
                manaNodeIdsByCharacter: null,
            }
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

function buildEventCurrentState(
    playerId: number,
    questProgress: ReturnType<typeof getPlayerQuestProgressSync>,
    staticIndex: EventCurrentStateStaticIndex,
): NonNullable<CategoryContext["eventCurrentState"]> {
    const characters = getPlayerCharactersSync(playerId)
    let maxCharacterLevel: number | null = staticIndex.characters === null ? null : 0
    if (staticIndex.characters !== null) {
        for (const [characterId, character] of Object.entries(characters)) {
            const fact = staticIndex.characters.get(characterId)
            if (!fact) continue
            const provenLevel = getProvenCharacterLevel(fact, character.exp)
            if (provenLevel !== null) {
                maxCharacterLevel = Math.max(maxCharacterLevel!, provenLevel)
            }
        }
    }

    const manaNodes = getPlayerCharactersManaNodesSync(playerId)
    let manaBoardNodeCount: number | null = staticIndex.manaNodeIdsByCharacter === null ? null : 0
    if (staticIndex.manaNodeIdsByCharacter !== null) {
        for (const [characterId, nodes] of Object.entries(manaNodes)) {
            if (characters[characterId] === undefined || !Array.isArray(nodes)) continue
            const officialNodeIds = staticIndex.manaNodeIdsByCharacter.get(characterId)
            if (!officialNodeIds) continue
            const verifiedNodes = new Set(nodes.filter(nodeId => (
                Number.isSafeInteger(nodeId) && nodeId > 0 && officialNodeIds.has(nodeId)
            )))
            const next = manaBoardNodeCount! + verifiedNodes.size
            if (Number.isSafeInteger(next)) manaBoardNodeCount = next
        }
    }

    let overLimitCount: number | null = staticIndex.characters === null ? null : 0
    if (staticIndex.characters !== null) {
        for (const [characterId, character] of Object.entries(characters)) {
            const fact = staticIndex.characters.get(characterId)
            if (!fact
                || !Number.isSafeInteger(character.overLimitStep)
                || character.overLimitStep < 0
                || character.overLimitStep > fact.maxOverLimitStep) continue
            const next = overLimitCount! + character.overLimitStep
            if (Number.isSafeInteger(next)) overLimitCount = next
        }
    }

    const finishedCharacterQuestIds = new Set((questProgress["3"] ?? [])
        .filter(progress => progress.finished)
        .map(progress => progress.questId))
    let characterEpisodeClearCount: number | null = null
    if (staticIndex.characterStoryQuestIds !== null) {
        const storyQuestIds = new Set(Object.keys(characters).flatMap(characterId => (
            staticIndex.characterStoryQuestIds!.get(characterId) ?? []
        )))
        let count = 0
        for (const questId of storyQuestIds) {
            if (finishedCharacterQuestIds.has(questId)) count++
        }
        characterEpisodeClearCount = count
    }

    const finishedMainQuestIds = new Set((questProgress["1"] ?? [])
        .filter(progress => progress.finished)
        .map(progress => progress.questId))
    const clearedMainChapters: Set<number> | null = staticIndex.mainQuestIdsByChapter === null
        ? null
        : new Set<number>()
    if (clearedMainChapters !== null) {
        for (const rule of Object.values(EVENT_CURRENT_STATE_RULES)) {
            if (rule.mainChapter === undefined) continue
            const questIds = staticIndex.mainQuestIdsByChapter!.get(rule.mainChapter) ?? []
            if (questIds.length > 0 && questIds.every(questId => finishedMainQuestIds.has(questId))) {
                clearedMainChapters.add(rule.mainChapter)
            }
        }
    }

    const equipment = getPlayerEquipmentListSync(playerId)
    let equipmentAwakeningCount: number | null = staticIndex.equipmentMaxLevels === null ? null : 0
    if (staticIndex.equipmentMaxLevels !== null) {
        for (const [equipmentId, item] of Object.entries(equipment)) {
            const maxLevel = staticIndex.equipmentMaxLevels.get(equipmentId)
            if (maxLevel === undefined
                || !Number.isSafeInteger(item.level) || item.level < 1
                || item.level > maxLevel) continue
            const next = equipmentAwakeningCount! + item.level - 1
            if (Number.isSafeInteger(next)) equipmentAwakeningCount = next
        }
    }

    const ownedItems = getPlayerItemsSync(playerId)
    let hasEquippedAbilitySoul: boolean | null = staticIndex.abilitySoulItemIds === null
        ? null
        : false
    if (staticIndex.abilitySoulItemIds !== null) {
        partySearch:
        for (const group of Object.values(getPlayerPartyGroupListSync(playerId))) {
            for (const party of Object.values(group.list ?? {})) {
                if (!Array.isArray(party.abilitySoulIds)) continue
                const useCounts = new Map<number, number>()
                let validParty = false
                for (const abilitySoulId of party.abilitySoulIds) {
                    if (abilitySoulId === null || abilitySoulId === undefined) continue
                    if (!Number.isSafeInteger(abilitySoulId) || abilitySoulId <= 0
                        || !staticIndex.abilitySoulItemIds.has(abilitySoulId)) {
                        validParty = false
                        useCounts.clear()
                        break
                    }
                    validParty = true
                    useCounts.set(abilitySoulId, (useCounts.get(abilitySoulId) ?? 0) + 1)
                }
                if (!validParty) continue
                for (const [abilitySoulId, useCount] of useCounts) {
                    const ownedCount = ownedItems[String(abilitySoulId)]
                    if (!Number.isSafeInteger(ownedCount) || ownedCount < useCount) {
                        validParty = false
                        break
                    }
                }
                if (validParty) {
                    hasEquippedAbilitySoul = true
                    break partySearch
                }
            }
        }
    }

    return {
        maxCharacterLevel,
        manaBoardNodeCount,
        overLimitCount,
        characterEpisodeClearCount,
        clearedMainChapters,
        equipmentAwakeningCount,
        hasEquippedAbilitySoul,
    }
}

function computeEventCurrentState(
    missionId: number,
    ctx: CategoryContext,
): number | undefined {
    const rule = getEventCurrentStateRule(missionId)
    const state = ctx.eventCurrentState
    if (!rule || !state) return undefined
    if (rule.fact === "mainChapterClear") {
        return state.clearedMainChapters === null || rule.mainChapter === undefined
            ? undefined
            : state.clearedMainChapters.has(rule.mainChapter) ? 1 : 0
    }
    if (rule.fact === "hasEquippedAbilitySoul") {
        return typeof state.hasEquippedAbilitySoul === "boolean"
            ? state.hasEquippedAbilitySoul ? 1 : 0
            : undefined
    }
    const progress = state[rule.fact]
    return typeof progress === "number"
        && Number.isSafeInteger(progress)
        && progress >= 0
        ? progress
        : undefined
}

function hasSingleCompletionReward(missionId: number): boolean {
    const stages = (eventRewards as Record<string, Record<string, unknown[]>>)[String(missionId)]
    if (!stages || Object.keys(stages).length !== 1) return false
    const stage = Object.values(stages)[0]
    const row = Array.isArray(stage) && Array.isArray(stage[0]) ? stage[0] : undefined
    return Number(row?.[1]) === 1
}

function getHistoricalSingleClearRule(missionId: number) {
    if (!hasSingleCompletionReward(missionId)) return undefined
    return exactEventSingleClearRules.find(rule => rule.missionId === missionId)
}

function computeHistoricalSingleClear(
    missionId: number,
    ctx: CategoryContext,
): number | undefined {
    const rule = getHistoricalSingleClearRule(missionId)
    if (!rule) return undefined
    return rule.categories.some(category => (
        ctx.questProgress[String(category)] ?? []
    ).some(progress => (
        progress.finished
        && (rule.questIds === "all" || rule.questIds.includes(progress.questId))
    ))) ? 1 : 0
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
    if (getEventCurrentStateRule(missionId) !== undefined
        || getHistoricalSingleClearRule(missionId) !== undefined
        || getEventItemMissionItemId(missionId) !== undefined
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
        const includeCurrentState = hasEnabledEventCurrentStateMission(evaluationTime)
        return {
            category,
            playerId,
            player,
            questProgress: buildEventSafeQuestProgress(rawProgress),
            totalQuestClears: 0,
            totalStories: 0,
            rankCounts: {},
            collectedItemTotals: getPlayerCollectedItemTotalsSync(playerId),
            eventMissionProgress: new Map(
                Object.entries(getPlayerCategoryMissionsSync(playerId, 3))
                    .map(([missionId, mission]) => [Number(missionId), mission.progress] as const),
            ),
            ...(includeCurrentState ? {
                eventCurrentState: buildEventCurrentState(
                    playerId,
                    rawProgress,
                    getEventCurrentStateStaticIndex(),
                ),
            } : {}),
        }
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const currentStateProgress = computeEventCurrentState(missionId, ctx)
        if (currentStateProgress !== undefined) {
            return Math.max(dbProgress, currentStateProgress)
        }
        const historicalSingleClear = computeHistoricalSingleClear(missionId, ctx)
        if (historicalSingleClear !== undefined) {
            return Math.max(dbProgress, historicalSingleClear)
        }
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
