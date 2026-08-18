import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getDb } from "../../data/db"
import {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
} from "../../data/domains/mission"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerShopPurchasesMapSync } from "../../data/domains/shopPurchase"
import { getPlayerPartyGroupListSync } from "../../data/domains/party"
import { getActiveMissionCountersSync } from "../../data/domains/active_mission_counters"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import { getPlayerCharacterClearsSync } from "../../data/domains/character_clear"
import { ShopType } from "../types"
import { getActiveMissionConditionalBattleFactsSync } from "../../data/domains/active_mission_battle_condition_facts"
import { getActiveMissionBattleFactsSync } from "../../data/domains/active_mission_battle_facts"
import {
    getActiveMissionEventMasterDefinition,
    getActiveMissionMasterDefinitions,
} from "./active-master-data"
import {
    ActiveMissionProgressDelta,
    ActiveMissionProgressState,
    getActiveMissionRewardStageIds,
    isActiveMissionAvailable,
    parseActiveMissionDefinition,
    parseActiveMissionEventDefinition,
    settleActiveMissionProgress,
} from "./active-core"
import { getMissionRewardStageDefinition } from "./rewards"
import { getCharacterStoryQuestIds } from "./character-queries"
import { characterExpCaps } from "../character"
import { getCharacterManaNodesSync } from "../assets"

const PATTERN_TOTAL_LOGIN_DAYS = 0
const PATTERN_CHARACTERS_COUNT = 4
const PATTERN_CHARACTER_LEVEL_ACHIEVEMENT = 5
const PATTERN_TOTAL_OBTAINED_BOND_TOKEN_COUNT = 8
const PATTERN_OVER_LIMIT_TOTAL_COUNT = 9
const PATTERN_TARGET_MISSION_CLEAR = 13
const PATTERN_USED_STAMINA_COUNT = 39
const PATTERN_EPISODE_CLEAR_COUNT = 21
const PATTERN_LEVEL_MAX_EQUIPMENT_COUNT = 36
const PATTERN_TOTAL_RELEASED_MANA_NODE_COUNT = 7
const PATTERN_TOTAL_RELEASED_ABILITY_NODE_COUNT = 62
const PATTERN_MANA_BOARD_2ND_COMPLETE_COUNT = 48
const PATTERN_QUEST_CLEAR = 57
const PATTERN_EVOLVED_CHARACTER_COUNT = 61
const PATTERN_UPGRADE_EQUIPMENT_COUNT = 34
const PATTERN_SET_SOUL_SPHERE_COUNT = 35
const PATTERN_TREASURE_SHOP_BOUGHT_ITEM_COUNT = 45
const PATTERN_TRADED_COUNT_TO_EQUIPMENT_BY_BOSS_COIN = 64
const PATTERN_BOSS_COIN_EXCHANGE = 84
const PATTERN_TOTAL_USED_MANA_COUNT = 46
const PATTERN_TOTAL_GACHA_CHARACTER_COUNT = 78
const PATTERN_EQUIPPED_FIRST_TIME = 58
const PATTERN_SET_UNISON_FIRST_TIME = 59
const PATTERN_SET_PARTY_CHARACTER = 60
const PATTERN_INJECTED_EXP_FIRST_TIME = 63
const PATTERN_GACHA_CAMPAIGN = 83
const PATTERN_BATTLE_CLEAR_COUNT = 23
const PATTERN_SS_RANK_COUNT = 26
const PATTERN_CHAPTER_COMPLETE = 66
const PATTERN_QUEST_CHALLENGE = 65
const PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_PARTY = 70
const PATTERN_BATTLE_CLEAR_WITH_MANA_BOARD_2ND = 71
const PATTERN_BATTLE_CLEAR_WITH_LEVEL_80_CHARACTER = 72
const PATTERN_BATTLE_CLEAR_WITH_LEVEL_100_CHARACTER = 73
const PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_CHARACTER = 89
const PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_SKILL = 90
const PATTERN_BATTLE_CLEAR_WITH_FULL_SKILL_START = 91
const COME_BACK_EVENT_STRING_ID = "come_back_mission"

const QUEST_CATEGORY_BY_RANGE_KIND: Readonly<Record<number, number | readonly number[]>> = Object.freeze({
    0: 1,
    1: 4,
    2: 2,
    3: 6,
    4: 14,
    5: 7,
    6: 10,
    7: 13,
    8: 11,
    9: 18,
    10: 19,
    11: 15,
    12: [6, 14, 13, 20],
    13: 20,
    14: 21,
    15: 22,
    16: 23,
    17: 24,
    18: 25,
    19: 26,
    20: 27,
})

export interface ActiveMissionEventEligibilityContext {
    readonly playerId: number
    readonly eventId: number
    readonly eventStringId: string
    readonly eventKind: number
}

export interface ReconcileActiveMissionFactsInput {
    readonly playerId: number
    readonly repository: ReadonlyContentRepository
    readonly now: number | Date
    readonly isEventEligible?: (context: ActiveMissionEventEligibilityContext) => boolean
}

export interface ActiveMissionFactCharacter {
    readonly rarity?: number
    readonly exp: number
    readonly evolutionLevel: number
    readonly overLimitStep: number
    readonly bondTokenList: readonly { readonly status: number }[]
}

export interface ActiveMissionFactState {
    readonly player: Readonly<{ readonly totalLoginDays: number, readonly totalStaminaUsed: number }>
    readonly battleCounters: Readonly<ReturnType<typeof getMissionBattleCountersSync>>
    readonly finishedQuestIds: ReadonlySet<number>
    readonly questProgress: readonly ActiveMissionFactQuestProgress[]
    readonly chapterQuestIds: Readonly<Record<string, readonly number[]>>
    readonly practiceQuestChallengeCount: number
    readonly leaderClearCounts: Readonly<Record<string, Readonly<{ readonly all: number, readonly multi: number }>>>
    readonly conditionalBattleFacts: Readonly<Record<string, number>>
    readonly loadoutBattleFacts: Readonly<Record<string, number>>
    readonly characterStoryQuestIds: Readonly<Record<string, readonly number[]>>
    readonly characters: Readonly<Record<string, ActiveMissionFactCharacter>>
    readonly equipment: readonly { readonly level: number, readonly maxLevel: number, readonly enhancementLevel?: number }[]
    readonly manaNodes: Readonly<Record<string, readonly number[]>>
    readonly manaBoardNodes: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>
    readonly manaNodeSlots: Readonly<Record<string, Readonly<Record<string, number>>>>
    readonly partyAbilitySoulCount: number
    readonly treasureShopPurchaseCount: number
    readonly bossCoinShopPurchaseCount: number
    readonly bossCoinEquipmentShopPurchaseCount: number
    readonly totalUsedManaCount: number
    readonly totalGachaCharacterCount: number
    readonly totalEquipmentEquipCount: number
    readonly totalUnisonSetCount: number
    readonly totalPartyCharacterSetCount: number
    readonly totalInjectedExpCount: number
    readonly totalGachaCampaignCount: number
}

export interface ActiveMissionFactQuestProgress {
    readonly category: number
    readonly questId: number
    readonly finished: boolean
    readonly clearRank?: number
    readonly leaderCharacterId?: number
    readonly multiClearCount: number
}

function parseInteger(value: unknown, field: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    return parsed
}

function parseIntegerList(value: unknown, field: string): number[] {
    if (value === "(None)" || value === undefined || value === null) return []
    if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    const text = String(value)
    if (text.length === 0) return []
    return text.split(",").map(item => parseInteger(item, field))
}

function parseOptionalIntegerList(value: unknown, field: string): readonly number[] | null {
    if (value === undefined || value === null || value === "(None)") return null
    if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    if (String(value).length === 0) return []
    return String(value).split(",").map(item => parseInteger(item, field))
}

function requireNonEmpty(values: readonly number[], field: string): readonly number[] {
    if (values.length === 0) throw new TypeError(`Missing Active Mission ${field}.`)
    return values
}

function cartesianQuestIds(
    worlds: readonly number[],
    chapters: readonly number[],
    quests: readonly number[],
    base: number,
): number[] {
    const ids: number[] = []
    for (const world of worlds) {
        for (const chapter of chapters) {
            for (const quest of quests) {
                ids.push(base + world * 1_000_000 + chapter * 1_000 + quest)
            }
        }
    }
    return ids
}

function matchesOptionalSelector(selector: readonly number[] | null, value: number): boolean {
    return selector === null || selector.includes(value)
}

function matchesQuestIdRange(
    rangeKind: number,
    row: readonly unknown[],
    category: number,
    questId: number,
): boolean {
    const rangeCategories = QUEST_CATEGORY_BY_RANGE_KIND[rangeKind]
    if (rangeCategories === undefined) return false
    const categories = Array.isArray(rangeCategories) ? rangeCategories : [rangeCategories]
    if (!categories.includes(category)) return false

    if (rangeKind === 0 || rangeKind === 1 || rangeKind === 2) {
        const normalizedQuestId = rangeKind === 1 && questId < 10_000_000
            ? questId + 10_000_000
            : questId
        const rangeQuestId = rangeKind === 1 ? normalizedQuestId - 10_000_000 : normalizedQuestId
        const first = Math.floor(rangeQuestId / 1_000_000)
        const remainder = rangeQuestId % 1_000_000
        const second = Math.floor(remainder / 1_000)
        const third = remainder % 1_000
        return matchesOptionalSelector(parseOptionalIntegerList(row[35], "quest range first"), first)
            && matchesOptionalSelector(parseOptionalIntegerList(row[36], "quest range second"), second)
            && matchesOptionalSelector(parseOptionalIntegerList(row[37], "quest range third"), third)
    }

    if (rangeKind === 12) return true

    const eventId = parseOptionalIntegerList(row[35], "quest event id")
    const questNumbers = parseOptionalIntegerList(row[37], "quest numbers")
    const encodedEventId = Math.floor(questId / 1_000)
    const questNumber = questId % 1_000
    return matchesOptionalSelector(eventId, encodedEventId)
        && matchesOptionalSelector(questNumbers, questNumber)
}

/** 判断一条存档关卡记录是否属于 Active Mission 的 QuestRange。 */
export function matchesActiveMissionQuestRange(
    row: readonly unknown[],
    category: number,
    questId: number,
): boolean {
    const rawKind = row[34]
    if (rawKind === undefined || rawKind === null || rawKind === "(None)") return true
    const rangeKind = parseInteger(rawKind, "quest range kind")
    return matchesQuestIdRange(rangeKind, row, category, questId)
}

function countBattleClearFacts(
    row: readonly unknown[],
    progress: readonly ActiveMissionFactQuestProgress[],
): number {
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    let count = 0
    for (const quest of progress) {
        if (!matchesActiveMissionQuestRange(row, quest.category, quest.questId)) continue
        if (battleKind === 1) {
            count += quest.finished ? 1 : 0
        } else if (battleKind === 2) {
            count += quest.multiClearCount
        } else {
            // `finished` is the durable any-clear bit; multi_clear_count preserves
            // repeated co-op clears without counting the first clear twice.
            count += Math.max(quest.finished ? 1 : 0, quest.multiClearCount)
        }
    }
    return count
}

function countSsRankFacts(
    row: readonly unknown[],
    state: ActiveMissionFactState,
): number | null {
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    const hasRange = row[34] !== undefined && row[34] !== null && row[34] !== "(None)"
    if (hasRange) return null
    if (battleKind === 1) return state.battleCounters.singleRankSsCount
    if (battleKind === 2) {
        return Math.max(0, state.battleCounters.rankSsCount - state.battleCounters.singleRankSsCount)
    }
    return state.battleCounters.rankSsCount
}

function normalizeActiveMissionQuestId(category: number, questId: number): number {
    return category === 4 && questId < 10_000_000 ? questId + 10_000_000 : questId
}

function computeChapterCompleteFact(
    row: readonly unknown[],
    state: ActiveMissionFactState,
): number | null {
    const rangeKind = parseInteger(row[34], "quest range kind")
    const category = rangeKind === 0 ? 1 : rangeKind === 1 ? 4 : null
    if (category === null) return null
    const targetQuestIds = (state.chapterQuestIds[String(category)] ?? []).filter(questId => (
        matchesActiveMissionQuestRange(row, category, questId)
    ))
    if (targetQuestIds.length === 0) return null

    const clearRankByQuestId = new Map(state.questProgress
        .filter(progress => progress.category === category)
        .map(progress => [normalizeActiveMissionQuestId(category, progress.questId), progress.clearRank]))
    return targetQuestIds.every(questId => clearRankByQuestId.get(questId) === 5) ? 1 : 0
}

function computeSpecificPartyClearFact(
    row: readonly unknown[],
    state: ActiveMissionFactState,
): number | null {
    const characterId = parseInteger(row[46], "specific leader character id")
    const battleKind = parseInteger(row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    const hasRange = row[34] !== undefined && row[34] !== null && row[34] !== "(None)"
    if (!hasRange) {
        const clears = state.leaderClearCounts[String(characterId)] ?? { all: 0, multi: 0 }
        if (battleKind === 1) return Math.max(0, clears.all - clears.multi)
        if (battleKind === 2) return clears.multi
        return clears.all
    }

    if (battleKind !== 1) return null
    return state.questProgress.filter(progress => (
        progress.finished
        && progress.leaderCharacterId === characterId
        && matchesActiveMissionQuestRange(row, progress.category, progress.questId)
    )).length
}

/** 按 CN 1.8.1 ActiveMissionValues 的 row[34..37] 解析 QuestRangeReferenceIdKind。 */
export function resolveActiveMissionQuestIds(row: readonly unknown[]): number[] {
    const kind = parseInteger(row[34], "quest range kind")
    if (kind === 0 || kind === 1) {
        const worlds = requireNonEmpty(parseIntegerList(row[35], "quest worlds"), "quest worlds")
        const chapters = requireNonEmpty(parseIntegerList(row[36], "quest chapters"), "quest chapters")
        const quests = requireNonEmpty(parseIntegerList(row[37], "quest numbers"), "quest numbers")
        return [...new Set(cartesianQuestIds(worlds, chapters, quests, kind === 1 ? 10_000_000 : 0))]
    }
    if (kind === 9) {
        const eventId = parseInteger(row[35], "world story event id")
        const questNumbers = requireNonEmpty(
            parseIntegerList(row[37], "world story event quest numbers"),
            "world story event quest numbers",
        )
        return [...new Set(questNumbers.map(questNumber => eventId * 1_000 + questNumber))]
    }
    throw new TypeError(`Unsupported Active Mission quest range kind ${kind}.`)
}

function normalizeActiveMissions(
    activeMissions: ReturnType<typeof getPlayerActiveMissionsSync>,
): Record<string, ActiveMissionProgressState> {
    return Object.fromEntries(Object.entries(activeMissions).map(([missionId, mission]) => [
        missionId,
        {
            progress: mission.progress,
            stages: mission.stages && !Array.isArray(mission.stages) ? mission.stages : {},
        },
    ]))
}

function isMissionComplete(
    missionId: number,
    activeMissions: Readonly<Record<string, ActiveMissionProgressState>>,
    repository: ReadonlyContentRepository,
): boolean {
    const stageIds = getActiveMissionRewardStageIds(missionId, repository)
    if (stageIds.length === 0) return false
    const progress = activeMissions[String(missionId)]?.progress ?? 0
    return stageIds.every(stageId => {
        const reward = getMissionRewardStageDefinition(missionId, stageId, repository)
        return reward !== null && progress >= reward.targetProgress
    })
}

export function estimateActiveMissionCharacterLevel(character: ActiveMissionFactCharacter): number {
    const rarity = character.rarity
    if (rarity === undefined) return 0
    const caps = characterExpCaps[rarity]
    if (!caps || caps.length === 0) return 0
    const baseLevel = 40 + (rarity - 1) * 10
    let level = baseLevel - 1
    for (let index = 0; index < caps.length; index++) {
        if (character.exp < caps[index]) break
        level = baseLevel + index * 5
    }
    return level
}

/** 根据存档状态重算官方 Active Mission 的可证明事实；未知 pattern 返回 null。 */
export function computeActiveMissionFactProgress(
    pattern: number,
    row: readonly unknown[],
    state: ActiveMissionFactState,
    missionId?: number,
): number | null {
    const characters = Object.entries(state.characters)
    switch (pattern) {
        case PATTERN_TOTAL_LOGIN_DAYS:
            return Math.max(0, state.player.totalLoginDays)
        case PATTERN_USED_STAMINA_COUNT:
            return Math.max(0, state.player.totalStaminaUsed)
        case PATTERN_TOTAL_USED_MANA_COUNT:
            return state.totalUsedManaCount
        case PATTERN_TOTAL_GACHA_CHARACTER_COUNT:
            return state.totalGachaCharacterCount
        case 14:
            return state.battleCounters.singleClearCount
        case 16:
            return state.battleCounters.multiClearCount
        case 17:
            return state.battleCounters.multiHostClearCount
        case PATTERN_EQUIPPED_FIRST_TIME:
            return state.totalEquipmentEquipCount
        case PATTERN_SET_UNISON_FIRST_TIME:
            return state.totalUnisonSetCount
        case PATTERN_SET_PARTY_CHARACTER:
            return state.totalPartyCharacterSetCount
        case PATTERN_INJECTED_EXP_FIRST_TIME:
            return state.totalInjectedExpCount
        case PATTERN_GACHA_CAMPAIGN:
            return state.totalGachaCampaignCount
        case PATTERN_BATTLE_CLEAR_COUNT:
            return countBattleClearFacts(row, state.questProgress)
        case PATTERN_SS_RANK_COUNT:
            return countSsRankFacts(row, state)
        case PATTERN_CHAPTER_COMPLETE:
            return computeChapterCompleteFact(row, state)
        case PATTERN_QUEST_CHALLENGE:
            return row[34] === "11" ? state.practiceQuestChallengeCount : null
        case PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_PARTY:
            return computeSpecificPartyClearFact(row, state)
        case PATTERN_BATTLE_CLEAR_WITH_MANA_BOARD_2ND:
        case PATTERN_BATTLE_CLEAR_WITH_LEVEL_80_CHARACTER:
        case PATTERN_BATTLE_CLEAR_WITH_LEVEL_100_CHARACTER: {
            const characterId = parseInteger(row[43], "conditional battle character id")
            return state.conditionalBattleFacts[`${pattern}:${characterId}`] ?? 0
        }
        case PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_CHARACTER:
        case PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_SKILL:
        case PATTERN_BATTLE_CLEAR_WITH_FULL_SKILL_START:
            return missionId === undefined ? null : state.loadoutBattleFacts[String(missionId)] ?? 0
        case PATTERN_EPISODE_CLEAR_COUNT: {
            const storyQuestIds = new Set(
                characters.flatMap(([characterId]) => state.characterStoryQuestIds[characterId] ?? []),
            )
            let count = 0
            for (const questId of storyQuestIds) {
                if (state.finishedQuestIds.has(questId)) count++
            }
            return count
        }
        case PATTERN_CHARACTER_LEVEL_ACHIEVEMENT:
            return characters.reduce((maximum, [, character]) => (
                Math.max(maximum, estimateActiveMissionCharacterLevel(character))
            ), 0)
        case PATTERN_CHARACTERS_COUNT: {
            const targetCharacterId = row[43]
            if (targetCharacterId === undefined || targetCharacterId === null || targetCharacterId === "(None)") {
                return characters.length
            }
            return state.characters[String(targetCharacterId)] === undefined ? 0 : 1
        }
        case PATTERN_EVOLVED_CHARACTER_COUNT:
            return characters.filter(([, character]) => character.evolutionLevel > 0).length
        case PATTERN_LEVEL_MAX_EQUIPMENT_COUNT:
            return state.equipment.filter(equipment => equipment.level >= equipment.maxLevel).length
        case PATTERN_UPGRADE_EQUIPMENT_COUNT:
            return state.equipment.reduce((total, equipment) => total + Math.max(0, equipment.level - 1), 0)
        case PATTERN_SET_SOUL_SPHERE_COUNT:
            return state.partyAbilitySoulCount
        case PATTERN_TREASURE_SHOP_BOUGHT_ITEM_COUNT:
            return state.treasureShopPurchaseCount
        case PATTERN_TRADED_COUNT_TO_EQUIPMENT_BY_BOSS_COIN:
            return state.bossCoinEquipmentShopPurchaseCount
        case PATTERN_BOSS_COIN_EXCHANGE:
            return state.bossCoinShopPurchaseCount
        case PATTERN_OVER_LIMIT_TOTAL_COUNT:
            return characters.reduce((total, [, character]) => total + Math.max(0, character.overLimitStep), 0)
        case PATTERN_TOTAL_OBTAINED_BOND_TOKEN_COUNT:
            return characters.reduce((total, [, character]) => (
                total + character.bondTokenList.filter(token => token.status >= 1).length
            ), 0)
        case PATTERN_TOTAL_RELEASED_MANA_NODE_COUNT:
            return Object.values(state.manaNodes).reduce((total, nodes) => total + nodes.length, 0)
        case PATTERN_TOTAL_RELEASED_ABILITY_NODE_COUNT:
            return Object.entries(state.manaNodes).reduce((total, [characterId, nodes]) => {
                const slots = state.manaNodeSlots[characterId] ?? {}
                return total + nodes.filter(nodeId => {
                    const slot = slots[String(nodeId)]
                    return slot !== undefined && slot >= 1 && slot <= 3
                }).length
            }, 0)
        case PATTERN_MANA_BOARD_2ND_COMPLETE_COUNT:
            return Object.entries(state.manaBoardNodes).filter(([characterId, boards]) => {
                const secondBoard = boards["2"] ?? []
                const unlocked = new Set(state.manaNodes[characterId] ?? [])
                return secondBoard.length > 0 && secondBoard.every(nodeId => unlocked.has(nodeId))
            }).length
        default:
            return null
    }
}

function buildActiveMissionFactState(
    playerId: number,
    player: NonNullable<ReturnType<typeof getPlayerSync>>,
    finishedQuestIds: ReadonlySet<number>,
    questProgress: readonly ActiveMissionFactQuestProgress[],
    repository: ReadonlyContentRepository,
): ActiveMissionFactState {
    const characterList = getPlayerCharactersSync(playerId)
    const mainQuestTable = readRepositoryTable<Record<string, unknown>>(repository, "main_quest.json")
    const exQuestTable = readRepositoryTable<Record<string, unknown>>(repository, "ex_quest.json")
    const battleQuestIds = (table: Readonly<Record<string, unknown>>, offset: number): number[] => (
        Object.entries(table).flatMap(([questId, quest]) => {
            const parsedQuestId = Number(questId)
            if (!Number.isSafeInteger(parsedQuestId)
                || quest === null
                || typeof quest !== "object"
                || !("rankPointReward" in quest)) return []
            return [parsedQuestId + offset]
        })
    )
    const characterTable = readRepositoryTable<Record<string, { readonly rarity?: number }>>(
        repository,
        "character.json",
    )
    const characters = Object.fromEntries(Object.entries(characterList).map(([characterId, character]) => [
        characterId,
        {
            ...character,
            rarity: characterTable[characterId]?.rarity,
        },
    ]))
    const manaNodes = getPlayerCharactersManaNodesSync(playerId)
    const manaBoardNodes: Record<string, Record<string, number[]>> = {}
    const manaNodeSlots: Record<string, Record<string, number>> = {}
    for (const characterId of Object.keys(characters)) {
        const boards: Record<string, number[]> = {}
        const slots: Record<string, number> = {}
        for (let level = 1; level <= 2; level++) {
            const board = getCharacterManaNodesSync(characterId, level)
            if (!board) continue
            boards[String(level)] = Object.keys(board).map(Number)
            for (const [nodeId, node] of Object.entries(board)) {
                const slot = node.field6 === "1" ? 1 : node.field6 === "2" ? 2 : node.field6 === "3" ? 3 : 4
                slots[nodeId] = slot
            }
        }
        manaBoardNodes[characterId] = boards
        manaNodeSlots[characterId] = slots
    }
    const equipment = Object.entries(getPlayerEquipmentListSync(playerId)).map(([equipmentId, item]) => ({
        level: item.level,
        enhancementLevel: item.enhancementLevel,
        maxLevel: (() => {
            const row = readRepositoryTable<Record<string, { readonly max_level?: number }>>(
                repository,
                "equipment_dissolve.json",
            )[equipmentId]
            return row?.max_level ?? 5
        })(),
    }))
    const treasurePurchases = getPlayerShopPurchasesMapSync(playerId, ShopType.TREASURE)
    const bossCoinPurchases = getPlayerShopPurchasesMapSync(playerId, ShopType.BOSS_COIN)
    const counters = getActiveMissionCountersSync(playerId)
    const characterClears = getPlayerCharacterClearsSync(playerId)
    const battleCounters = getMissionBattleCountersSync(playerId)
    const treasureShopItemIds = new Set(Object.keys(readRepositoryTable<Record<string, unknown>>(
        repository,
        "treasure_shop.json",
    )))
    const bossCoinShopItemIds = new Set(Object.keys(readRepositoryTable<Record<string, unknown>>(
        repository,
        "boss_coin_shop_item_category_map.json",
    )))
    const bossCoinShopItems = readRepositoryTable<Record<string, Record<string, {
        readonly rewards?: readonly { readonly type?: number }[]
    }>>>(repository, "boss_coin_shop.json")
    const bossCoinEquipmentShopItemIds = new Set<string>()
    for (const category of Object.values(bossCoinShopItems)) {
        for (const [itemId, item] of Object.entries(category ?? {})) {
            if (item.rewards?.some(reward => reward.type === 4)) {
                bossCoinEquipmentShopItemIds.add(itemId)
            }
        }
    }
    const partyAbilitySoulCount = Object.values(getPlayerPartyGroupListSync(playerId)).reduce((total, group) => (
        total + Object.values(group.list ?? {}).reduce((partyTotal, party) => (
            partyTotal + (party.abilitySoulIds ?? []).filter(id => id !== null && id !== undefined).length
        ), 0)
    ), 0)
    return {
        player,
        battleCounters,
        finishedQuestIds,
        questProgress,
        chapterQuestIds: {
            "1": battleQuestIds(mainQuestTable, 0),
            "4": battleQuestIds(exQuestTable, 10_000_000),
        },
        practiceQuestChallengeCount: counters.practiceQuestChallengeCount,
        leaderClearCounts: Object.fromEntries(Object.keys(characters).map(characterId => {
            const clears = characterClears[characterId]
            return [characterId, {
                all: Math.max(0, clears?.leader_clear_count ?? 0),
                multi: Math.max(0, clears?.leader_multi_count ?? 0),
            }]
        })),
        conditionalBattleFacts: getActiveMissionConditionalBattleFactsSync(playerId),
        loadoutBattleFacts: getActiveMissionBattleFactsSync(playerId),
        characterStoryQuestIds: Object.fromEntries(Object.keys(characters).map(characterId => [
            characterId,
            getCharacterStoryQuestIds(characterId),
        ])),
        characters,
        equipment,
        manaNodes,
        manaBoardNodes,
        manaNodeSlots,
        partyAbilitySoulCount,
        treasureShopPurchaseCount: Object.entries(treasurePurchases).reduce((total, [itemId, count]) => (
            treasureShopItemIds.has(itemId) ? total + Math.max(0, count) : total
        ), 0),
        bossCoinShopPurchaseCount: Object.entries(bossCoinPurchases).reduce((total, [itemId, count]) => (
            bossCoinShopItemIds.has(itemId) ? total + Math.max(0, count) : total
        ), 0),
        bossCoinEquipmentShopPurchaseCount: Object.entries(bossCoinPurchases).reduce((total, [itemId, count]) => (
            bossCoinEquipmentShopItemIds.has(itemId) ? total + Math.max(0, count) : total
        ), 0),
        totalUsedManaCount: counters.totalUsedManaCount,
        totalGachaCharacterCount: counters.totalGachaCharacterCount,
        totalEquipmentEquipCount: counters.totalEquipmentEquipCount,
        totalUnisonSetCount: counters.totalUnisonSetCount,
        totalPartyCharacterSetCount: counters.totalPartyCharacterSetCount,
        totalInjectedExpCount: counters.totalInjectedExpCount,
        totalGachaCampaignCount: counters.totalGachaCampaignCount,
    }
}

function readRepositoryTable<T>(
    repository: ReadonlyContentRepository,
    tableName: string,
): T {
    try {
        return repository.table<T>(tableName)
    } catch {
        return {} as T
    }
}

function computeAuthoritativeProgress(
    missionId: number,
    row: readonly unknown[],
    player: NonNullable<ReturnType<typeof getPlayerSync>>,
    finishedQuestIds: ReadonlySet<number>,
    activeMissions: Readonly<Record<string, ActiveMissionProgressState>>,
    repository: ReadonlyContentRepository,
    factState: ActiveMissionFactState,
): number | null {
    const pattern = parseInteger(row[29], "mission pattern")
    const factProgress = computeActiveMissionFactProgress(pattern, row, factState, missionId)
    if (factProgress !== null) return factProgress
    if (pattern === PATTERN_QUEST_CLEAR) {
        return resolveActiveMissionQuestIds(row).filter(questId => finishedQuestIds.has(questId)).length
    }
    if (pattern === PATTERN_TARGET_MISSION_CLEAR) {
        const missionIds = parseIntegerList(row[55], "target mission ids")
        if (missionIds.length === 0) return 0
        return missionIds.reduce((completedCount, targetMissionId) => (
            completedCount + (isMissionComplete(
                targetMissionId,
                activeMissions,
                repository,
            ) ? 1 : 0)
        ), 0)
    }
    return null
}

function isEligibleEvent(
    input: ReconcileActiveMissionFactsInput,
    eventId: number,
): boolean {
    const master = getActiveMissionEventMasterDefinition(eventId, input.repository)
    if (!master) return false
    const eventStringId = master.row[0]
    const event = parseActiveMissionEventDefinition(eventId, master.row)
    if (typeof eventStringId !== "string") return false
    if (!eventStringId.includes(COME_BACK_EVENT_STRING_ID)) return true
    return input.isEventEligible?.({
        playerId: input.playerId,
        eventId,
        eventStringId,
        eventKind: event.kind,
    }) === true
}

function mergeDelta(
    deltas: Map<number, { progress: number, stages: Set<number> }>,
    delta: ActiveMissionProgressDelta,
): void {
    const current = deltas.get(delta.mission_id) ?? {
        progress: delta.progress_value,
        stages: new Set<number>(),
    }
    current.progress = delta.progress_value
    for (const stage of delta.stages) current.stages.add(stage.stage)
    deltas.set(delta.mission_id, current)
}

export function reconcileActiveMissionFacts(
    input: ReconcileActiveMissionFactsInput,
): ActiveMissionProgressDelta[] {
    return getDb().transaction(() => {
        const player = getPlayerSync(input.playerId)
        if (!player) throw new Error(`Player ${input.playerId} does not exist.`)

        const questProgress = getPlayerQuestProgressSync(input.playerId)
        const questProgressFacts = Object.entries(questProgress).flatMap(([category, progressList]) => progressList.map(progress => ({
            category: Number(category),
            questId: progress.questId,
            finished: progress.finished,
            clearRank: progress.clearRank,
            leaderCharacterId: progress.leaderCharacterId,
            multiClearCount: Math.max(0, progress.multiClearCount ?? 0),
        })))
        const finishedQuestIds = new Set(Object.values(questProgress).flatMap(progressList => (
            progressList.filter(progress => progress.finished).map(progress => progress.questId)
        )))
        const activeMissions = normalizeActiveMissions(getPlayerActiveMissionsSync(input.playerId))
        const factState = buildActiveMissionFactState(
            input.playerId,
            player,
            finishedQuestIds,
            questProgressFacts,
            input.repository,
        )
        const definitions = [...getActiveMissionMasterDefinitions(input.repository)]
            .sort((left, right) => left.missionId - right.missionId)
        const deltas = new Map<number, { progress: number, stages: Set<number> }>()

        // 事实只会单调增加；固定点确保同一次 /load 内 phase 与目标任务依赖可继续推进。
        for (let pass = 0; pass <= definitions.length; pass++) {
            let changed = false
            for (const definition of definitions) {
                let authoritativeProgress: number | null
                try {
                    const mission = parseActiveMissionDefinition(definition.missionId, definition.row)
                    if (!isEligibleEvent(input, mission.eventId)) continue
                    if (!isActiveMissionAvailable(definition.missionId, {
                        repository: input.repository,
                        now: input.now,
                        activeMissions,
                        questProgress,
                    })) continue
                    authoritativeProgress = computeAuthoritativeProgress(
                        definition.missionId,
                        definition.row,
                        player,
                        finishedQuestIds,
                        activeMissions,
                        input.repository,
                        factState,
                    )
                } catch {
                    continue
                }
                if (authoritativeProgress === null) continue
                if (activeMissions[String(definition.missionId)] === undefined
                    && authoritativeProgress <= 0) continue

                const settlement = settleActiveMissionProgress(
                    definition.missionId,
                    activeMissions[String(definition.missionId)],
                    authoritativeProgress,
                    { repository: input.repository },
                )
                if (settlement.delta === null) continue

                updatePlayerActiveMissionSync(
                    input.playerId,
                    definition.missionId,
                    settlement.state.progress,
                )
                for (const stage of settlement.delta.stages) {
                    updatePlayerActiveMissionStageSync(
                        input.playerId,
                        stage.stage,
                        definition.missionId,
                        false,
                    )
                }
                activeMissions[String(definition.missionId)] = settlement.state
                mergeDelta(deltas, settlement.delta)
                changed = true
            }
            if (!changed) break
            if (pass === definitions.length) {
                throw new Error("Active Mission reconciliation did not converge.")
            }
        }

        return [...deltas.entries()]
            .sort(([left], [right]) => left - right)
            .map(([missionId, delta]) => ({
                mission_id: missionId,
                progress_value: delta.progress,
                stages: [...delta.stages]
                    .sort((left, right) => left - right)
                    .map(stage => ({ stage, received: false as const })),
            }))
    })()
}
