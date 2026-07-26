// Degree mission computer (category 5)

import { getPlayerSync } from "../../data/domains/player"
import { getPlayerCharactersManaNodesSync, getPlayerCharactersSync } from "../../data/domains/character"
import { getMissionBattleCountersSync } from "../../data/domains/mission_battle_facts"
import { getDegreeBattleStatsSync } from "../../data/domains/degree_battle_stats"
import { getPlayerShopPurchasesMapSync } from "../../data/domains/shopPurchase"
import {
    getPlayerCollectedItemTotalSync,
    getPlayerCollectedItemTotalsSync,
} from "../../data/domains/item"
import {
    countFinishedPlayerQuestsByCategorySync,
    getFinishedPlayerQuestIdsBySectionsSync,
    getPlayerQuestClearRanksBySectionsSync,
} from "../../data/domains/quest"
import { getRankDegree } from "../stamina"
import { getConfigSync } from "../assets"
import bundledManaBoard from "../../../assets/mana_board.json"
import bundledMainQuests from "../../../assets/main_quest.json"
import bundledExQuests from "../../../assets/ex_quest.json"
import bundledTreasureShop from "../../../assets/treasure_shop.json"
import bundledBossBattleQuests from "../../../assets/boss_battle_quest.json"
import bundledExpertSingleEventQuests from "../../../assets/expert_single_event_quest.json"
import bundledWorldStoryEventQuests from "../../../assets/world_story_event_quest.json"
import bundledAdventEventQuests from "../../../assets/advent_event_quest.json"
import bundledCarnivalEventQuests from "../../../assets/carnival_event_quest.json"
import bundledHardMultiEventQuests from "../../../assets/hard_multi_event_quest.json"
import bundledEquipmentDissolve from "../../../assets/equipment_dissolve.json"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import {
    ContentSnapshotError,
    getContentSnapshot,
} from "../../content/runtime/content-snapshot"
import { getMissionMasterDefinition, getMissionMasterDefinitions } from "./master-data"
import { getMissionPattern } from "./patterns"
import type { MissionComputer, CategoryContext } from "./types"
import { getExactDegreeQuestClearRuleCount } from "./degree-battle-facts"
import { getDegreeOperationRuleCount } from "./degree-operation-facts"

// Degree mission target lookup
const degreeTargetMap: Record<number, number> = {}
const degreeScoreTargetMap: Record<number, number> = {}
const degreeTimeTargetMap: Record<number, number> = {}
const degreeDashTargetMap: Record<number, number> = {}
const degreeComboTargetMap: Record<number, number> = {}
const degreeCraftPointTargetMap: Record<number, number> = {}
{
    // Note: this import is resolved at module load time via the patterns file's data
    // but we use the same degreeDefs. For simplicity, inline the regex.
    const degreeDefs = require("../../../assets/mission_degree.json")
    const descRegex = /玩家(?:达到|级别达到)\s*(\d+)/
    for (const [mid, rows] of Object.entries(degreeDefs as Record<string, any>)) {
        const row = (rows as any[])[0]
        if (!row || !row[2]) continue
        const match = descRegex.exec(String(row[2]))
        if (match) degreeTargetMap[parseInt(mid)] = parseInt(match[1])
        const scoreMatch = /单人战斗获得\s*(\d+)\s*以上的分数/.exec(String(row[2]))
        if (scoreMatch) degreeScoreTargetMap[parseInt(mid)] = parseInt(scoreMatch[1])
        const timeMatch = /单人战斗\s*(\d+)\s*秒以内通关/.exec(String(row[2]))
        if (timeMatch) degreeTimeTargetMap[parseInt(mid)] = parseInt(timeMatch[1]) * 1000
        const dashMatch = /使用\s*(\d+)\s*次冲刺/.exec(String(row[2]))
        if (dashMatch) degreeDashTargetMap[parseInt(mid)] = parseInt(dashMatch[1])
        const comboMatch = /单次战斗中达成\s*(\d+)\s*连击/.exec(String(row[2]))
        if (comboMatch) degreeComboTargetMap[parseInt(mid)] = parseInt(comboMatch[1])
        const craftPointMatch = /累计获得\s*(\d+)\s*个锻造石/.exec(String(row[2]))
        if (craftPointMatch) degreeCraftPointTargetMap[parseInt(mid)] = parseInt(craftPointMatch[1])
    }
}

export function getTargetDegree(missionId: number): number | undefined {
    return degreeTargetMap[missionId]
}

function getTargetScore(missionId: number): number | undefined {
    return degreeScoreTargetMap[missionId]
}

function getTargetTime(missionId: number): number | undefined {
    return degreeTimeTargetMap[missionId]
}

function getTargetDash(missionId: number): number | undefined {
    return degreeDashTargetMap[missionId]
}

function getTargetCombo(missionId: number): number | undefined {
    return degreeComboTargetMap[missionId]
}

function getTargetCraftPoint(missionId: number): number | undefined {
    return degreeCraftPointTargetMap[missionId]
}

type RawManaBoard = Record<string, Record<string, Record<string, readonly unknown[][]>>>

type RawQuestTable = Record<string, unknown>

function getRuntimeTable<T>(tableName: string, bundled: T): T {
    try {
        return getContentSnapshot().repository.table<T>(tableName)
    } catch (error) {
        if (error instanceof ContentSnapshotError
            && error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED") {
            return bundled
        }
        throw error
    }
}

function getManaBoardTable(): RawManaBoard {
    return getRuntimeTable("mana_board.json", bundledManaBoard as RawManaBoard)
}

function getSecondManaBoardNodeIds(characterId: string): ReadonlySet<number> | null {
    const board = getManaBoardTable()[characterId]?.["2"]
    if (!board || Object.keys(board).length === 0) return null

    const nodeIds = new Set<number>()
    for (const rows of Object.values(board)) {
        const row = rows[0]
        const nodeId = Number(row?.[0])
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return null
        nodeIds.add(nodeId)
    }
    return nodeIds.size > 0 ? nodeIds : null
}

function getSecondManaBoardStats(
    characters: Record<string, unknown>,
    manaNodes: Record<string, number[]>,
): {
    nodeCount: number
    completedCharacterIds: ReadonlySet<number>
} {
    let nodeCount = 0
    const completedCharacterIds = new Set<number>()

    for (const characterId of Object.keys(characters)) {
        const nodeIds = getSecondManaBoardNodeIds(characterId)
        if (nodeIds === null) continue

        const learned = new Set(manaNodes[characterId] ?? [])
        let learnedSecondBoardNodes = 0
        for (const nodeId of nodeIds) {
            if (learned.has(nodeId)) learnedSecondBoardNodes++
        }
        nodeCount += learnedSecondBoardNodes
        if (learnedSecondBoardNodes === nodeIds.size) {
            const numericCharacterId = Number(characterId)
            if (Number.isSafeInteger(numericCharacterId)) {
                completedCharacterIds.add(numericCharacterId)
            }
        }
    }

    return { nodeCount, completedCharacterIds }
}

function getCompletedEpisodeChapters(playerId: number): ReadonlySet<number> {
    const mainQuests = getRuntimeTable<RawQuestTable>("main_quest.json", bundledMainQuests)
    const exQuests = getRuntimeTable<RawQuestTable>("ex_quest.json", bundledExQuests)
    const finished = getFinishedPlayerQuestIdsBySectionsSync(playerId, [1, 4])
    const mainFinished = finished[1] ?? new Set<number>()
    const exFinished = finished[4] ?? new Set<number>()
    const chapters = new Set<number>()

    for (const questId of [...Object.keys(mainQuests), ...Object.keys(exQuests)]) {
        const numericQuestId = Number(questId)
        const chapter = Math.floor(numericQuestId / 1_000_000)
        if (Number.isSafeInteger(chapter) && chapter >= 1 && chapter <= 12) chapters.add(chapter)
    }

    const completed = new Set<number>()
    for (const chapter of chapters) {
        const mainIds = Object.keys(mainQuests)
            .map(Number)
            .filter(questId => Math.floor(questId / 1_000_000) === chapter)
        const exIds = Object.keys(exQuests)
            .map(Number)
            .filter(questId => Math.floor(questId / 1_000_000) === chapter)
        if (mainIds.length === 0 || exIds.length === 0) continue
        if (mainIds.every(questId => mainFinished.has(questId))
            && exIds.every(questId => exFinished.has(questId))) {
            completed.add(chapter)
        }
    }
    return completed
}

function getPracticeQuestIds(missionId: number): readonly number[] | null {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition
        || Number(definition.row[3]) !== 26
        || !definition.pattern.startsWith("degree_practice_rank_ss_clear_")) return null
    const value = definition.row[11]
    if (value === undefined || value === null || value === "" || value === "(None)") return null
    const questIds = String(value).split(",").map(Number)
    return questIds.every(questId => Number.isSafeInteger(questId) && questId > 0)
        ? questIds
        : null
}

function getTreasureShopPurchaseCount(playerId: number): number {
    const treasureShop = getRuntimeTable<RawQuestTable>("treasure_shop.json", bundledTreasureShop)
    const purchases = getPlayerShopPurchasesMapSync(playerId)
    return Object.entries(purchases).reduce((total, [itemId, count]) => (
        treasureShop[itemId] === undefined ? total : total + Math.max(0, count)
    ), 0)
}

function getBossBattleSuperQuestId(
    missionId: number,
    bossBattleQuests: RawQuestTable = getRuntimeTable("boss_battle_quest.json", bundledBossBattleQuests),
): number | undefined {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition
        || Number(definition.row[3]) !== 14
        || !definition.pattern.startsWith("degree_boss_battle_ex_clear_single_")) return undefined
    const stageGroup = Number(definition.row[10])
    const difficulty = Number(definition.row[12])
    if (!Number.isSafeInteger(stageGroup) || !Number.isSafeInteger(difficulty)) return undefined
    const questId = Object.keys(bossBattleQuests).map(Number).find(candidate => (
        Math.floor(candidate / 1_000) % 1_000 === stageGroup
        && candidate % 1_000 === difficulty
    ))
    return questId
}

function getExactDegreeQuestId(
    missionId: number,
    missionType: number,
    rangeKind: number,
    tableName: string,
    bundledTable: RawQuestTable,
): number | undefined {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition
        || Number(definition.row[3]) !== missionType
        || Number(definition.row[8]) !== rangeKind) return undefined
    const eventId = Number(definition.row[9])
    const suffix = Number(definition.row[11])
    if (!Number.isSafeInteger(eventId) || eventId <= 0
        || !Number.isSafeInteger(suffix) || suffix <= 0) return undefined
    const questId = eventId * 1000 + suffix
    const quests = getRuntimeTable<RawQuestTable>(tableName, bundledTable)
    return quests[String(questId)] === undefined ? undefined : questId
}

function getExpertSingleQuestId(missionId: number): number | undefined {
    return getExactDegreeQuestId(
        missionId,
        14,
        14,
        "expert_single_event_quest.json",
        bundledExpertSingleEventQuests,
    )
}

function getWorldStoryQuestId(missionId: number): number | undefined {
    return getExactDegreeQuestId(
        missionId,
        14,
        9,
        "world_story_event_quest.json",
        bundledWorldStoryEventQuests,
    )
}

function getAdventQuestId(missionId: number): number | undefined {
    return getExactDegreeQuestId(
        missionId,
        14,
        5,
        "advent_event_quest.json",
        bundledAdventEventQuests,
    )
}

function getDegreeCollectedItemId(missionId: number): number | undefined {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition
        || Number(definition.row[3]) !== 37
        || !definition.pattern.startsWith("degree_collect_item_event_")) return undefined
    const itemId = Number(definition.row[13])
    return Number.isSafeInteger(itemId) && itemId > 0 ? itemId : undefined
}

function getMaxLevelEquipmentCount(playerId: number): number {
    const equipment = getPlayerEquipmentListSync(playerId)
    const definitions = getRuntimeTable<Record<string, { readonly max_level?: number }>>(
        "equipment_dissolve.json",
        bundledEquipmentDissolve,
    )
    return Object.entries(equipment).reduce((count, [equipmentId, item]) => {
        const maxLevel = definitions[equipmentId]?.max_level
        return Number.isSafeInteger(maxLevel) && (maxLevel ?? 0) > 0 && item.level >= maxLevel!
            ? count + 1
            : count
    }, 0)
}

function getCarnivalQuestId(missionId: number): number | undefined {
    return getExactDegreeQuestId(
        missionId,
        23,
        15,
        "carnival_event_quest.json",
        bundledCarnivalEventQuests,
    )
}

function getHardMultiQuestId(missionId: number): number | undefined {
    return getExactDegreeQuestId(
        missionId,
        23,
        19,
        "hard_multi_event_quest.json",
        bundledHardMultiEventQuests,
    )
}

function buildStats(playerId: number, category: number): CategoryContext {
    const player = getPlayerSync(playerId)!
    const characters = getPlayerCharactersSync(playerId)
    const manaNodes = getPlayerCharactersManaNodesSync(playerId)
    const battleCounters = getMissionBattleCountersSync(playerId)
    const episodeCompletedChapters = getCompletedEpisodeChapters(playerId)
    const practiceClearRanks = getPlayerQuestClearRanksBySectionsSync(playerId, [15])[15] ?? new Map()
    const treasureShopPurchaseCount = getTreasureShopPurchaseCount(playerId)
    const craftPointItemId = getConfigSync().craft_point_item_id || 100000
    const craftPointObtainedCount = getPlayerCollectedItemTotalSync(playerId, craftPointItemId)
    const bossBattleQuests = getRuntimeTable<RawQuestTable>("boss_battle_quest.json", bundledBossBattleQuests)
    const bossBattleSuperQuestByMission = new Map<number, number>()
    for (const definition of getMissionMasterDefinitions(5)) {
        const questId = getBossBattleSuperQuestId(definition.missionId, bossBattleQuests)
        if (questId !== undefined) bossBattleSuperQuestByMission.set(definition.missionId, questId)
    }
    const finishedQuestIdsBySection = getFinishedPlayerQuestIdsBySectionsSync(
        playerId,
        [2, 7, 18, 21, 22, 26],
    )
    const finishedQuestIds = finishedQuestIdsBySection[2] ?? new Set()
    return {
        category,
        playerId,
        player,
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
        battleCounters,
        degreeStats: {
            companionCount: Object.keys(characters).length,
            overLimitCount: Object.values(characters)
                .reduce((total, character) => total + character.overLimitStep, 0),
            manaBoardCount: Object.values(manaNodes)
                .reduce((total, nodes) => total + nodes.length, 0),
            bondTokenCount: Object.values(characters)
                .reduce((total, character) => total
                    + character.bondTokenList.filter(token => token.status >= 1).length, 0),
            singleSsCount: battleCounters.singleRankSsCount,
            multiClearCount: battleCounters.multiClearCount,
            multiHostClearCount: battleCounters.multiHostClearCount,
            episodeClearCount: countFinishedPlayerQuestsByCategorySync(playerId, 3),
            bondedCharacterIds: new Set(Object.entries(characters)
                .filter(([, character]) => character.bondTokenList.some(token => token.status >= 1))
                .map(([characterId]) => Number(characterId))),
            ...(() => {
                const secondManaBoard = getSecondManaBoardStats(characters, manaNodes)
                return {
                    secondManaBoardNodeCount: secondManaBoard.nodeCount,
                    secondManaBoardCompletedCharacterIds: secondManaBoard.completedCharacterIds,
                }
            })(),
            episodeCompletedChapters,
            practiceSsQuestIds: new Set(
                [...practiceClearRanks.entries()]
                    .filter(([, clearRank]) => clearRank === 5)
                    .map(([questId]) => questId),
            ),
            treasureShopPurchaseCount,
            bossBattleSuperQuestByMission,
            bossBattleClearQuestIds: finishedQuestIds,
            expertSingleFinishedQuestIds: finishedQuestIdsBySection[21] ?? new Set(),
            worldStoryFinishedQuestIds: finishedQuestIdsBySection[18] ?? new Set(),
            adventFinishedQuestIds: finishedQuestIdsBySection[7] ?? new Set(),
            carnivalFinishedQuestIds: finishedQuestIdsBySection[22] ?? new Set(),
            hardMultiFinishedQuestIds: finishedQuestIdsBySection[26] ?? new Set(),
            challengeDungeonClearCount: battleCounters.challengeDungeonClearCount,
            singleScoreMax: battleCounters.singleScoreMax,
            singleClearTimeMin: battleCounters.singleClearTimeMin,
            bossBattleClearCount: battleCounters.bossBattleClearCount,
            craftPointObtainedCount,
            collectedItemTotals: getPlayerCollectedItemTotalsSync(playerId),
            maxLevelEquipmentCount: getMaxLevelEquipmentCount(playerId),
            skillUseCount: battleCounters.skillUseCount,
            degreeBattleStats: getDegreeBattleStatsSync(playerId),
        },
    }
}

const SUPPORTED_FAMILIES = {
    playerRank: "degree_player_rank_growth_",
    companionCount: "degree_companion_add_",
    overLimitCount: "degree_overlimit_growth_",
    manaBoardCount: "degree_manaboard_growth_",
    bondTokenCount: "degree_proof_of_bond_get_",
    singleSsCount: "degree_rank_ss_clear_single_",
    multiClearCount: "degree_multi_battle_clear_",
    multiHostClearCount: "degree_multi_battle_by_host_clear_",
    episodeClearCount: "degree_character_episode_read_",
    staminaUseCount: "degree_stamina_use_",
    loginCount: "degree_login_count_",
    challengeDungeonClear: "degree_challenge_dungeon_clear_",
    scoreClearSingle: "degree_score_clear_single_",
    timeClearSingle: "degree_time_clear_single_",
    bossBattleClear: "degree_boss_battle_clear_",
    dashUse: "degree_dash_use_",
    comboOneTime: "degree_combo_onetime_",
    craftPointGet: "degree_craft_point_get_",
    skillUse: "degree_skill_use_",
    feverCount: "degree_fever_condition_single_",
    feverTime: "degree_time_fever_elapse_single_",
    debuffEnemy: "degree_weak_enemy_use_single_",
    clearEnemyBuff: "degree_debuff_enemy_use_single_",
    clearSelfDebuff: "degree_deweak_myself_use_single_",
    buffParty: "degree_buff_companion_use_",
    healParty: "degree_recovery_hp_companion_",
    emotionUse: "degree_emotion_multi_battle_use_",
    enemyKill: "degree_kill_enemy_",
    weakPointAttack: "degree_destruction_weak_point_",
    powerFlipLv3: "degree_power_flip_lv3_use_",
    coffinReduced: "degree_coffin_count_sub_",
    damageMax: "degree_damage_onetime_",
    revivalCoffinMax: "degree_return_coffin_count_30over_",
    partyPowerMax: "degree_condition_party_force_",
    skillChainMax: "degree_skill_chain_condition_",
} as const

function getSecondManaBoardCharacterId(missionId: number): number | undefined {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition || Number(definition.row[3]) !== 48) return undefined
    const characterId = Number(definition.row[15])
    return Number.isSafeInteger(characterId) && characterId > 0 ? characterId : undefined
}

function isSecondManaBoardAggregateMission(missionId: number): boolean {
    const definition = getMissionMasterDefinition(5, missionId)
    return Boolean(
        definition
        && Number(definition.row[3]) === 48
        && definition.pattern.startsWith("degree_manaboard_all_growth_"),
    )
}

function getEpisodeChapter(missionId: number): number | undefined {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition
        || Number(definition.row[3]) !== 22
        || !definition.pattern.startsWith("degree_all_episode_quest_clear_")) return undefined
    const chapter = Number(definition.row[9])
    return Number.isSafeInteger(chapter) && chapter > 0 ? chapter : undefined
}

export function getDegreeMissionCoverageReport() {
    const definitions = getMissionMasterDefinitions(5)
    const prefixFamilies = Object.fromEntries(
        Object.entries(SUPPORTED_FAMILIES).map(([name, prefix]) => [
            name,
            definitions.filter(definition => definition.pattern.startsWith(prefix)).length,
        ]),
    ) as Record<keyof typeof SUPPORTED_FAMILIES, number>
    const supportedFamilies = {
        ...prefixFamilies,
        specificCharacterBond: definitions.filter(definition => (
            Number(definition.row[3]) === 44
            && getSpecificCharacterBondId(definition.missionId) !== undefined
        )).length,
        secondManaBoardNodeCount: definitions.filter(definition => (
            isSecondManaBoardAggregateMission(definition.missionId)
        )).length,
        secondManaBoardCompletion: definitions.filter(definition => (
            getSecondManaBoardCharacterId(definition.missionId) !== undefined
        )).length,
        episodeChapterCompletion: definitions.filter(definition => (
            getEpisodeChapter(definition.missionId) !== undefined
        )).length,
        practiceRankSs: definitions.filter(definition => (
            getPracticeQuestIds(definition.missionId) !== null
        )).length,
        treasureShopPurchaseCount: definitions.filter(definition => (
            Number(definition.row[3]) === 45
            && definition.pattern.startsWith("degree_treasure_shop_buy_count_")
        )).length,
        bossBattleExClearSingle: definitions.filter(definition => (
            getBossBattleSuperQuestId(definition.missionId) !== undefined
        )).length,
        expertSingleQuestClear: definitions.filter(definition => (
            getExpertSingleQuestId(definition.missionId) !== undefined
        )).length,
        worldStoryQuestClear: definitions.filter(definition => (
            getWorldStoryQuestId(definition.missionId) !== undefined
        )).length,
        adventQuestClear: definitions.filter(definition => (
            getAdventQuestId(definition.missionId) !== undefined
        )).length,
        carnivalQuestClear: definitions.filter(definition => (
            getCarnivalQuestId(definition.missionId) !== undefined
        )).length,
        hardMultiQuestClear: definitions.filter(definition => (
            getHardMultiQuestId(definition.missionId) !== undefined
        )).length,
        specifiedQuestClearCount: getExactDegreeQuestClearRuleCount(),
        operationFacts: getDegreeOperationRuleCount(),
        eventCollectItem: definitions.filter(definition => (
            getDegreeCollectedItemId(definition.missionId) !== undefined
        )).length,
        maxLevelEquipment: definitions.filter(definition => (
            Number(definition.row[3]) === 36
            && definition.pattern.startsWith("degree_equipment_lv5_get_")
        )).length,
        challengeDungeonClear: definitions.filter(definition => (
            definition.pattern.startsWith(SUPPORTED_FAMILIES.challengeDungeonClear)
        )).length,
        scoreClearSingle: definitions.filter(definition => (
            definition.pattern.startsWith(SUPPORTED_FAMILIES.scoreClearSingle)
            && getTargetScore(definition.missionId) !== undefined
        )).length,
        timeClearSingle: definitions.filter(definition => (
            definition.pattern.startsWith(SUPPORTED_FAMILIES.timeClearSingle)
            && getTargetTime(definition.missionId) !== undefined
        )).length,
        bossBattleClear: definitions.filter(definition => (
            definition.pattern.startsWith(SUPPORTED_FAMILIES.bossBattleClear)
        )).length,
        dashUse: definitions.filter(definition => (
            definition.pattern.startsWith(SUPPORTED_FAMILIES.dashUse)
            && getTargetDash(definition.missionId) !== undefined
        )).length,
        comboOneTime: definitions.filter(definition => (
            definition.pattern.startsWith(SUPPORTED_FAMILIES.comboOneTime)
            && getTargetCombo(definition.missionId) !== undefined
        )).length,
        craftPointGet: definitions.filter(definition => (
            definition.pattern.startsWith(SUPPORTED_FAMILIES.craftPointGet)
            && getTargetCraftPoint(definition.missionId) !== undefined
        )).length,
        skillUse: definitions.filter(definition => (
            definition.pattern.startsWith(SUPPORTED_FAMILIES.skillUse)
        )).length,
    }
    const serverComputed = Object.values(supportedFamilies).reduce((sum, count) => sum + count, 0)
    return {
        total: definitions.length,
        serverComputed,
        unsupported: definitions.length - serverComputed,
        supportedFamilies,
    }
}

export function getSpecificCharacterBondId(missionId: number): number | undefined {
    const definition = getMissionMasterDefinition(5, missionId)
    if (!definition || Number(definition.row[3]) !== 44) return undefined
    const characterId = Number(definition.row[15])
    return Number.isSafeInteger(characterId) && characterId > 0 ? characterId : undefined
}

export const DegreeComputer: MissionComputer = {
    name: "Degree",

    buildContext(playerId: number, category: number): CategoryContext {
        return buildStats(playerId, category)
    },

    compute(missionId: number, ctx: CategoryContext, dbProgress: number): number {
        const pattern = getMissionPattern(5, missionId)
        const stats = ctx.degreeStats
        if (pattern.startsWith(SUPPORTED_FAMILIES.playerRank)) return getRankDegree(ctx.player.rankPoint)
        if (!stats) return dbProgress
        const bondCharacterId = getSpecificCharacterBondId(missionId)
        if (bondCharacterId !== undefined) {
            return Math.max(dbProgress, stats.bondedCharacterIds.has(bondCharacterId) ? 1 : 0)
        }
        const secondManaBoardCharacterId = getSecondManaBoardCharacterId(missionId)
        if (secondManaBoardCharacterId !== undefined) {
            return Math.max(
                dbProgress,
                stats.secondManaBoardCompletedCharacterIds.has(secondManaBoardCharacterId) ? 1 : 0,
            )
        }
        if (isSecondManaBoardAggregateMission(missionId)) {
            return Math.max(dbProgress, stats.secondManaBoardNodeCount)
        }
        const episodeChapter = getEpisodeChapter(missionId)
        if (episodeChapter !== undefined) {
            return Math.max(dbProgress, stats.episodeCompletedChapters.has(episodeChapter) ? 1 : 0)
        }
        const practiceQuestIds = getPracticeQuestIds(missionId)
        if (practiceQuestIds !== null) {
            return Math.max(
                dbProgress,
                practiceQuestIds.every(questId => stats.practiceSsQuestIds.has(questId)) ? 1 : 0,
            )
        }
        if (Number(getMissionMasterDefinition(5, missionId)?.row[3]) === 45
            && pattern.startsWith("degree_treasure_shop_buy_count_")) {
            return Math.max(dbProgress, stats.treasureShopPurchaseCount)
        }
        const bossBattleSuperQuestId = stats.bossBattleSuperQuestByMission.get(missionId)
        if (bossBattleSuperQuestId !== undefined) {
            return Math.max(dbProgress, stats.bossBattleClearQuestIds.has(bossBattleSuperQuestId) ? 1 : 0)
        }
        const expertSingleQuestId = getExpertSingleQuestId(missionId)
        if (expertSingleQuestId !== undefined) {
            return Math.max(
                dbProgress,
                stats.expertSingleFinishedQuestIds.has(expertSingleQuestId) ? 1 : 0,
            )
        }
        const worldStoryQuestId = getWorldStoryQuestId(missionId)
        if (worldStoryQuestId !== undefined) {
            return Math.max(
                dbProgress,
                stats.worldStoryFinishedQuestIds.has(worldStoryQuestId) ? 1 : 0,
            )
        }
        const adventQuestId = getAdventQuestId(missionId)
        if (adventQuestId !== undefined) {
            return Math.max(
                dbProgress,
                stats.adventFinishedQuestIds.has(adventQuestId) ? 1 : 0,
            )
        }
        const carnivalQuestId = getCarnivalQuestId(missionId)
        if (carnivalQuestId !== undefined) {
            return Math.max(
                dbProgress,
                stats.carnivalFinishedQuestIds.has(carnivalQuestId) ? 1 : 0,
            )
        }
        const hardMultiQuestId = getHardMultiQuestId(missionId)
        if (hardMultiQuestId !== undefined) {
            return Math.max(
                dbProgress,
                stats.hardMultiFinishedQuestIds.has(hardMultiQuestId) ? 1 : 0,
            )
        }
        const collectedItemId = getDegreeCollectedItemId(missionId)
        if (collectedItemId !== undefined) {
            return Math.max(
                dbProgress,
                stats.collectedItemTotals[String(collectedItemId)] ?? 0,
            )
        }
        if (Number(getMissionMasterDefinition(5, missionId)?.row[3]) === 36
            && pattern.startsWith("degree_equipment_lv5_get_")) {
            return Math.max(dbProgress, stats.maxLevelEquipmentCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.companionCount)) return stats.companionCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.overLimitCount)) return stats.overLimitCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.manaBoardCount)) return stats.manaBoardCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.bondTokenCount)) return stats.bondTokenCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.singleSsCount)) return stats.singleSsCount
        if (pattern.startsWith(SUPPORTED_FAMILIES.multiClearCount)) {
            return Math.max(dbProgress, stats.multiClearCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.multiHostClearCount)) {
            return Math.max(dbProgress, stats.multiHostClearCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.episodeClearCount)) {
            return Math.max(dbProgress, stats.episodeClearCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.staminaUseCount)) {
            return Math.max(dbProgress, ctx.player.totalStaminaUsed ?? 0)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.loginCount)) {
            return Math.max(dbProgress, ctx.player.totalLoginDays ?? 0)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.challengeDungeonClear)) {
            return Math.max(dbProgress, stats.challengeDungeonClearCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.scoreClearSingle)) {
            const target = getTargetScore(missionId)
            return target === undefined
                ? dbProgress
                : Math.max(dbProgress, stats.singleScoreMax)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.timeClearSingle)) {
            const target = getTargetTime(missionId)
            return target === undefined || stats.singleClearTimeMin <= 0
                ? dbProgress
                : Math.max(dbProgress, stats.singleClearTimeMin <= target ? 1 : 0)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.bossBattleClear)) {
            return Math.max(dbProgress, stats.bossBattleClearCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.dashUse)) {
            return Math.max(dbProgress, ctx.player.totalDashes ?? 0)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.comboOneTime)) {
            return Math.max(dbProgress, ctx.player.maxComboAchieved ?? 0)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.craftPointGet)) {
            return Math.max(dbProgress, stats.craftPointObtainedCount)
        }
        if (pattern.startsWith(SUPPORTED_FAMILIES.skillUse)) {
            return Math.max(dbProgress, stats.skillUseCount)
        }
        const battleStats = stats.degreeBattleStats
        if (pattern.startsWith(SUPPORTED_FAMILIES.feverCount)) return Math.max(dbProgress, battleStats.feverCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.feverTime)) return Math.max(dbProgress, battleStats.feverMs)
        if (pattern.startsWith(SUPPORTED_FAMILIES.debuffEnemy)) return Math.max(dbProgress, battleStats.debuffEnemyCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.clearEnemyBuff)) return Math.max(dbProgress, battleStats.clearEnemyBuffCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.clearSelfDebuff)) return Math.max(dbProgress, battleStats.clearSelfDebuffCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.buffParty)) return Math.max(dbProgress, battleStats.buffPartyCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.healParty)) return Math.max(dbProgress, battleStats.healPartyCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.emotionUse)) return Math.max(dbProgress, battleStats.emotionCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.enemyKill)) return Math.max(dbProgress, battleStats.enemyKillCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.weakPointAttack)) return Math.max(dbProgress, battleStats.weakPointAttackCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.powerFlipLv3)) return Math.max(dbProgress, battleStats.powerFlipLv3Count)
        if (pattern.startsWith(SUPPORTED_FAMILIES.coffinReduced)) return Math.max(dbProgress, battleStats.coffinReducedCount)
        if (pattern.startsWith(SUPPORTED_FAMILIES.damageMax)) return Math.max(dbProgress, battleStats.damageDealMax)
        if (pattern.startsWith(SUPPORTED_FAMILIES.revivalCoffinMax)) return Math.max(dbProgress, battleStats.revivalCoffinMax)
        if (pattern.startsWith(SUPPORTED_FAMILIES.partyPowerMax)) return Math.max(dbProgress, battleStats.partyPowerMax)
        if (pattern.startsWith(SUPPORTED_FAMILIES.skillChainMax)) return Math.max(dbProgress, battleStats.skillChainMax)
        return dbProgress
    },
}
