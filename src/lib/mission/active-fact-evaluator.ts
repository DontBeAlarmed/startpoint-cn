import type { PlannedActiveMissionDefinition } from "./active-plan"
import {
    matchesActiveMissionQuestRange,
    resolveActiveMissionQuestRangeIds,
} from "./active-quest-range"

const CHARACTER_EXP_CAPS: Readonly<Record<number, readonly number[]>> = Object.freeze({
    1: Object.freeze([11416, 15820, 21477, 28538, 37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043]),
    2: Object.freeze([21477, 28538, 37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043]),
    3: Object.freeze([37241, 49481, 66600, 91180, 125223, 170928, 216633, 262338, 308043]),
    4: Object.freeze([76272, 102829, 139190, 189995, 240800, 291605, 342410]),
    5: Object.freeze([153988, 210488, 266988, 323488, 379988]),
})

const PATTERN_TOTAL_LOGIN_DAYS = 0
const PATTERN_CHARACTERS_COUNT = 4
const PATTERN_CHARACTER_LEVEL_ACHIEVEMENT = 5
const PATTERN_TOTAL_RELEASED_MANA_NODE_COUNT = 7
const PATTERN_TOTAL_OBTAINED_BOND_TOKEN_COUNT = 8
const PATTERN_OVER_LIMIT_TOTAL_COUNT = 9
const PATTERN_TARGET_MISSION_CLEAR = 13
const PATTERN_EPISODE_CLEAR_COUNT = 21
const PATTERN_BATTLE_CLEAR_COUNT = 23
const PATTERN_SS_RANK_COUNT = 26
const PATTERN_UPGRADE_EQUIPMENT_COUNT = 34
const PATTERN_SET_SOUL_SPHERE_COUNT = 35
const PATTERN_LEVEL_MAX_EQUIPMENT_COUNT = 36
const PATTERN_USED_STAMINA_COUNT = 39
const PATTERN_TREASURE_SHOP_BOUGHT_ITEM_COUNT = 45
const PATTERN_TOTAL_USED_MANA_COUNT = 46
const PATTERN_MANA_BOARD_2ND_COMPLETE_COUNT = 48
const PATTERN_QUEST_CLEAR = 57
const PATTERN_EQUIPPED_FIRST_TIME = 58
const PATTERN_SET_UNISON_FIRST_TIME = 59
const PATTERN_SET_PARTY_CHARACTER = 60
const PATTERN_EVOLVED_CHARACTER_COUNT = 61
const PATTERN_TOTAL_RELEASED_ABILITY_NODE_COUNT = 62
const PATTERN_INJECTED_EXP_FIRST_TIME = 63
const PATTERN_TRADED_COUNT_TO_EQUIPMENT_BY_BOSS_COIN = 64
const PATTERN_QUEST_CHALLENGE = 65
const PATTERN_CHAPTER_COMPLETE = 66
const PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_PARTY = 70
const PATTERN_BATTLE_CLEAR_WITH_MANA_BOARD_2ND = 71
const PATTERN_BATTLE_CLEAR_WITH_LEVEL_80_CHARACTER = 72
const PATTERN_BATTLE_CLEAR_WITH_LEVEL_100_CHARACTER = 73
const PATTERN_CONTENTS_GUIDE_START = 74
const PATTERN_TOTAL_GACHA_CHARACTER_COUNT = 78
const PATTERN_GACHA_CAMPAIGN = 83
const PATTERN_BOSS_COIN_EXCHANGE = 84
const PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_CHARACTER = 89
const PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_SKILL = 90
const PATTERN_BATTLE_CLEAR_WITH_FULL_SKILL_START = 91

export interface ActiveMissionFactCharacter {
    readonly rarity?: number
    readonly exp: number
    readonly evolutionLevel: number
    readonly overLimitStep: number
    readonly bondTokenList: readonly { readonly status: number }[]
}

export interface ActiveMissionFactQuestProgress {
    readonly category: number
    readonly questId: number
    readonly finished: boolean
    readonly clearRank?: number
    readonly leaderCharacterId?: number
    readonly multiClearCount: number
}

export interface ActiveMissionFactState {
    readonly player: Readonly<{ readonly totalLoginDays: number, readonly totalStaminaUsed: number }>
    readonly battleCounters: Readonly<{
        readonly singleClearCount: number
        readonly multiClearCount: number
        readonly multiHostClearCount: number
        readonly singleRankSsCount: number
        readonly rankSsCount: number
    }>
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

export interface ActiveMissionFactProgressState {
    readonly progress: number
    readonly stages?: Readonly<Record<string, boolean>>
}

function parseInteger(value: unknown, field: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`Invalid Active Mission ${field}.`)
    }
    return parsed
}

function countBattleClearFacts(
    definition: Pick<PlannedActiveMissionDefinition, "row" | "questRange">,
    progress: readonly ActiveMissionFactQuestProgress[],
): number {
    const battleKind = parseInteger(definition.row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) {
        throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    }
    let count = 0
    for (const quest of progress) {
        if (!matchesActiveMissionQuestRange(definition.questRange, quest.category, quest.questId)) continue
        if (battleKind === 1) count += quest.finished ? 1 : 0
        else if (battleKind === 2) count += quest.multiClearCount
        else count += Math.max(quest.finished ? 1 : 0, quest.multiClearCount)
    }
    return count
}

function countSsRankFacts(
    definition: Pick<PlannedActiveMissionDefinition, "row" | "questRange">,
    state: ActiveMissionFactState,
): number | null {
    const battleKind = parseInteger(definition.row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) {
        throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    }
    if (definition.questRange !== null) return null
    if (battleKind === 1) return state.battleCounters.singleRankSsCount
    if (battleKind === 2) {
        return Math.max(0, state.battleCounters.rankSsCount - state.battleCounters.singleRankSsCount)
    }
    return state.battleCounters.rankSsCount
}

function normalizeQuestId(category: number, questId: number): number {
    return category === 4 && questId < 10_000_000 ? questId + 10_000_000 : questId
}

function computeChapterCompleteFact(
    definition: Pick<PlannedActiveMissionDefinition, "questRange">,
    state: ActiveMissionFactState,
): number | null {
    const range = definition.questRange
    const category = range?.kind === 0 ? 1 : range?.kind === 1 ? 4 : null
    if (category === null) return null
    const targetQuestIds = (state.chapterQuestIds[String(category)] ?? []).filter(questId => (
        matchesActiveMissionQuestRange(range, category, questId)
    ))
    if (targetQuestIds.length === 0) return null
    const clearRankByQuestId = new Map(state.questProgress
        .filter(progress => progress.category === category)
        .map(progress => [normalizeQuestId(category, progress.questId), progress.clearRank]))
    return targetQuestIds.every(questId => clearRankByQuestId.get(questId) === 5) ? 1 : 0
}

function computeSpecificPartyClearFact(
    definition: Pick<PlannedActiveMissionDefinition, "row" | "questRange">,
    state: ActiveMissionFactState,
): number | null {
    const characterId = parseInteger(definition.row[46], "specific leader character id")
    const battleKind = parseInteger(definition.row[32], "battle kind")
    if (![1, 2, 3].includes(battleKind)) {
        throw new TypeError(`Unsupported Active Mission battle kind ${battleKind}.`)
    }
    if (definition.questRange === null) {
        const clears = state.leaderClearCounts[String(characterId)] ?? { all: 0, multi: 0 }
        if (battleKind === 1) return Math.max(0, clears.all - clears.multi)
        if (battleKind === 2) return clears.multi
        return clears.all
    }
    if (battleKind !== 1) return null
    return state.questProgress.filter(progress => (
        progress.finished
        && progress.leaderCharacterId === characterId
        && matchesActiveMissionQuestRange(definition.questRange, progress.category, progress.questId)
    )).length
}

export function estimateActiveMissionCharacterLevel(character: ActiveMissionFactCharacter): number {
    const rarity = character.rarity
    if (rarity === undefined) return 0
    const caps = CHARACTER_EXP_CAPS[rarity]
    if (!caps || caps.length === 0) return 0
    const baseLevel = 40 + (rarity - 1) * 10
    let level = baseLevel - 1
    for (let index = 0; index < caps.length; index++) {
        if (character.exp < caps[index]) break
        level = baseLevel + index * 5
    }
    return level
}

export function evaluateStaticActiveMissionFact(
    definition: Pick<PlannedActiveMissionDefinition, "pattern" | "row" | "questRange">
        & { readonly missionId?: number },
    state: ActiveMissionFactState,
): number | null {
    const characters = Object.entries(state.characters)
    switch (definition.pattern) {
        case PATTERN_TOTAL_LOGIN_DAYS: return Math.max(0, state.player.totalLoginDays)
        case PATTERN_USED_STAMINA_COUNT: return Math.max(0, state.player.totalStaminaUsed)
        case PATTERN_TOTAL_USED_MANA_COUNT: return state.totalUsedManaCount
        case PATTERN_TOTAL_GACHA_CHARACTER_COUNT: return state.totalGachaCharacterCount
        case 14: return state.battleCounters.singleClearCount
        case 16: return state.battleCounters.multiClearCount
        case 17: return state.battleCounters.multiHostClearCount
        case PATTERN_EQUIPPED_FIRST_TIME: return state.totalEquipmentEquipCount
        case PATTERN_SET_UNISON_FIRST_TIME: return state.totalUnisonSetCount
        case PATTERN_SET_PARTY_CHARACTER: return state.totalPartyCharacterSetCount
        case PATTERN_INJECTED_EXP_FIRST_TIME: return state.totalInjectedExpCount
        case PATTERN_GACHA_CAMPAIGN: return state.totalGachaCampaignCount
        case PATTERN_BATTLE_CLEAR_COUNT: return countBattleClearFacts(definition, state.questProgress)
        case PATTERN_SS_RANK_COUNT: return countSsRankFacts(definition, state)
        case PATTERN_CHAPTER_COMPLETE: return computeChapterCompleteFact(definition, state)
        case PATTERN_QUEST_CHALLENGE:
            return definition.questRange?.kind === 11 ? state.practiceQuestChallengeCount : null
        case PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_PARTY: return computeSpecificPartyClearFact(definition, state)
        case PATTERN_BATTLE_CLEAR_WITH_MANA_BOARD_2ND:
        case PATTERN_BATTLE_CLEAR_WITH_LEVEL_80_CHARACTER:
        case PATTERN_BATTLE_CLEAR_WITH_LEVEL_100_CHARACTER: {
            const characterId = parseInteger(definition.row[43], "conditional battle character id")
            return state.conditionalBattleFacts[`${definition.pattern}:${characterId}`] ?? 0
        }
        case PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_CHARACTER:
        case PATTERN_BATTLE_CLEAR_WITH_SPECIFIC_SKILL:
        case PATTERN_BATTLE_CLEAR_WITH_FULL_SKILL_START:
            return definition.missionId === undefined
                ? null
                : state.loadoutBattleFacts[String(definition.missionId)] ?? 0
        case PATTERN_EPISODE_CLEAR_COUNT: {
            const storyQuestIds = new Set(characters.flatMap(
                ([characterId]) => state.characterStoryQuestIds[characterId] ?? [],
            ))
            return [...storyQuestIds].filter(questId => state.finishedQuestIds.has(questId)).length
        }
        case PATTERN_CHARACTER_LEVEL_ACHIEVEMENT:
            return characters.reduce((maximum, [, character]) => (
                Math.max(maximum, estimateActiveMissionCharacterLevel(character))
            ), 0)
        case PATTERN_CHARACTERS_COUNT: {
            const targetCharacterId = definition.row[43]
            return targetCharacterId === undefined || targetCharacterId === null || targetCharacterId === "(None)"
                ? characters.length
                : state.characters[String(targetCharacterId)] === undefined ? 0 : 1
        }
        case PATTERN_EVOLVED_CHARACTER_COUNT:
            return characters.filter(([, character]) => character.evolutionLevel > 0).length
        case PATTERN_LEVEL_MAX_EQUIPMENT_COUNT:
            return state.equipment.filter(equipment => equipment.level >= equipment.maxLevel).length
        case PATTERN_UPGRADE_EQUIPMENT_COUNT:
            return state.equipment.reduce((total, equipment) => total + Math.max(0, equipment.level - 1), 0)
        case PATTERN_SET_SOUL_SPHERE_COUNT: return state.partyAbilitySoulCount
        case PATTERN_TREASURE_SHOP_BOUGHT_ITEM_COUNT: return state.treasureShopPurchaseCount
        case PATTERN_TRADED_COUNT_TO_EQUIPMENT_BY_BOSS_COIN: return state.bossCoinEquipmentShopPurchaseCount
        case PATTERN_BOSS_COIN_EXCHANGE: return state.bossCoinShopPurchaseCount
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
        default: return null
    }
}

export function evaluateActiveMissionFact(
    definition: PlannedActiveMissionDefinition,
    state: ActiveMissionFactState,
    activeMissions: Readonly<Record<string, ActiveMissionFactProgressState>>,
): number | null {
    if (definition.evaluator === null) return null
    if (definition.pattern === PATTERN_QUEST_CLEAR) {
        if (definition.questRange === null) return null
        return resolveActiveMissionQuestRangeIds(definition.questRange)
            .filter(questId => state.finishedQuestIds.has(questId)).length
    }
    if (definition.pattern === PATTERN_TARGET_MISSION_CLEAR) {
        return definition.targetMissionRequirements.reduce((count, requirement) => {
            const progress = activeMissions[String(requirement.missionId)]?.progress ?? 0
            return count + (requirement.completionProgress !== null
                && progress >= requirement.completionProgress ? 1 : 0)
        }, 0)
    }
    if (definition.pattern === PATTERN_CONTENTS_GUIDE_START) {
        return null
    }
    return evaluateStaticActiveMissionFact(definition, state)
}
