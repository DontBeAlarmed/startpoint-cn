import type { DegreeBattleStats } from "../../data/domains/degree_battle_stats"
import type { MissionBattleCounters } from "../../data/domains/mission_battle_facts"
import type {
    PlayerCharacter,
    PlayerEquipment,
    PlayerQuestProgress,
} from "../../data/types"
import { characterExpCaps } from "../character"
import type { DegreeContentTables } from "./degree-content-tables"
import { readonlyMap, readonlySet } from "./degree-immutable"
import type { DegreeRule } from "./degree-rule-catalog"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"
import type { CategoryContext } from "./types"

export const EMPTY_BATTLE_COUNTERS: Readonly<MissionBattleCounters> = Object.freeze({
    singlePlayCount: 0,
    singleClearCount: 0,
    multiPlayCount: 0,
    multiClearCount: 0,
    multiHostClearCount: 0,
    multiGuestClearCount: 0,
    singleRankSsCount: 0,
    rankSsCount: 0,
    rankSCount: 0,
    rankACount: 0,
    rankBCount: 0,
    challengeDungeonClearCount: 0,
    singleScoreMax: 0,
    singleClearTimeMin: 0,
    bossBattleClearCount: 0,
    skillUseCount: 0,
})

export const EMPTY_DEGREE_BATTLE_STATS: Readonly<DegreeBattleStats> = Object.freeze({
    feverCount: 0,
    feverMs: 0,
    debuffEnemyCount: 0,
    clearEnemyBuffCount: 0,
    clearSelfDebuffCount: 0,
    buffPartyCount: 0,
    healPartyCount: 0,
    emotionCount: 0,
    enemyKillCount: 0,
    weakPointAttackCount: 0,
    powerFlipLv3Count: 0,
    coffinReducedCount: 0,
    damageDealMax: 0,
    revivalCoffinMax: 0,
    partyPowerMax: 0,
    skillChainMax: 0,
})

export interface DegreeLoadedFacts {
    readonly characters?: Record<string, Pick<PlayerCharacter, "overLimitStep" | "exp" | "bondTokenList">>
    readonly characterManaNodes?: Record<string, number[]>
    readonly missionBattleCounters?: MissionBattleCounters
    readonly degreeBattleStats?: DegreeBattleStats
    readonly questProgress?: Record<string, Pick<PlayerQuestProgress, "questId" | "finished" | "clearRank">[]>
    readonly shopPurchases?: Record<string, number>
    readonly collectedItems?: Record<string, number>
    readonly equipment?: Record<string, Pick<PlayerEquipment, "level">>
}

type DegreeCharacter = NonNullable<DegreeLoadedFacts["characters"]>[string]
type DegreeQuestProgress = NonNullable<DegreeLoadedFacts["questProgress"]>[string]

type RawTable = Record<string, unknown>
type CharacterTable = Record<string, { readonly rarity?: unknown }>
type ManaBoardTable = Record<string, Record<string, Record<string, readonly unknown[][]>>>
type EquipmentTable = Record<string, { readonly max_level?: unknown }>

function asTable(value: unknown): RawTable | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as RawTable
        : undefined
}

function provenCharacterLevel(rarity: number, experience: number): number | null {
    const thresholds = characterExpCaps[rarity]
    if (!Array.isArray(thresholds) || !Number.isSafeInteger(experience) || experience < 0) return null
    const baseLevel = 40 + (rarity - 1) * 10
    let level = 0
    for (let index = 0; index < thresholds.length; index++) {
        if (experience >= thresholds[index]) level = baseLevel + index * 5
    }
    return level
}

function secondBoardNodeIds(raw: unknown, characterId: string): ReadonlySet<number> | null {
    const table = asTable(raw) as ManaBoardTable | undefined
    const board = table?.[characterId]?.["2"]
    if (!board || Object.keys(board).length === 0) return null
    const nodeIds = new Set<number>()
    for (const rows of Object.values(board)) {
        const nodeId = parsePositiveSafeIntegerMasterValue(rows[0]?.[0])
        if (nodeId === undefined) return null
        nodeIds.add(nodeId)
    }
    return nodeIds.size > 0 ? nodeIds : null
}

function secondBoardStats(
    characters: Record<string, DegreeCharacter>,
    manaNodes: Record<string, number[]>,
    raw: unknown,
    rules: ReadonlyMap<number, DegreeRule>,
): { nodeCount: number; completed: ReadonlySet<number> } {
    let nodeCount = 0
    const completed = new Set<number>()
    const selectedIds = new Set<number>()
    let aggregate = false
    for (const rule of rules.values()) {
        if (rule.kind === "secondManaBoardAggregate") aggregate = true
        if (rule.kind === "secondManaBoardCharacter") selectedIds.add(rule.characterId)
    }
    const characterIds = aggregate
        ? Object.keys(characters)
        : [...selectedIds].map(String).filter(characterId => characters[characterId] !== undefined)
    for (const characterId of characterIds) {
        const nodeIds = secondBoardNodeIds(raw, characterId)
        if (nodeIds === null) continue
        const learned = new Set(manaNodes[characterId] ?? [])
        let count = 0
        for (const nodeId of nodeIds) if (learned.has(nodeId)) count++
        nodeCount += count
        const numericId = parsePositiveSafeIntegerMasterValue(characterId)
        if (count === nodeIds.size && numericId !== undefined) completed.add(numericId)
    }
    return { nodeCount, completed: readonlySet(completed) }
}

function finishedQuestIds(progress: Record<string, DegreeQuestProgress>): Record<number, ReadonlySet<number>> {
    const result: Record<number, ReadonlySet<number>> = {}
    for (const [rawSection, quests] of Object.entries(progress)) {
        const section = Number(rawSection)
        if (!Number.isSafeInteger(section)) continue
        result[section] = readonlySet(
            quests.filter(quest => quest.finished).map(quest => quest.questId),
        )
    }
    return Object.freeze(result)
}

function completedEpisodeChapters(
    progress: Record<string, DegreeQuestProgress>,
    tables: DegreeContentTables,
): ReadonlySet<number> {
    const main = asTable(tables.mainQuest)
    const ex = asTable(tables.exQuest)
    if (!main || !ex) return readonlySet()
    const finished = finishedQuestIds(progress)
    const chapters = new Set<number>()
    for (const questId of [...Object.keys(main), ...Object.keys(ex)].map(Number)) {
        const chapter = Math.floor(questId / 1_000_000)
        if (Number.isSafeInteger(questId) && chapter >= 1 && chapter <= 12) chapters.add(chapter)
    }
    const completed = new Set<number>()
    for (const chapter of chapters) {
        const mainIds = Object.keys(main).map(Number).filter(id => Math.floor(id / 1_000_000) === chapter)
        const exIds = Object.keys(ex).map(Number).filter(id => Math.floor(id / 1_000_000) === chapter)
        if (mainIds.length > 0 && exIds.length > 0
            && mainIds.every(id => finished[1]?.has(id))
            && exIds.every(id => finished[4]?.has(id))) completed.add(chapter)
    }
    return readonlySet(completed)
}

function craftPointItemId(rules: ReadonlyMap<number, DegreeRule>): number | undefined {
    const ids = new Set<number>()
    for (const rule of rules.values()) {
        if (rule.kind !== "metric" || rule.metric !== "craftPointObtainedCount") continue
        for (const fact of rule.facts) {
            if (fact.kind === "collectedItems" && fact.itemIds !== "all") {
                for (const itemId of fact.itemIds) ids.add(itemId)
            }
        }
    }
    return ids.size === 1 ? [...ids][0] : undefined
}

export function deriveDegreeStats(
    facts: DegreeLoadedFacts,
    rules: ReadonlyMap<number, DegreeRule>,
    tables: DegreeContentTables,
): NonNullable<CategoryContext["degreeStats"]> {
    const characters = facts.characters ?? {}
    const manaNodes = facts.characterManaNodes ?? {}
    const battle = facts.missionBattleCounters ?? EMPTY_BATTLE_COUNTERS
    const questProgress = facts.questProgress ?? {}
    const finishedBySection = finishedQuestIds(questProgress)
    const characterTable = asTable(tables.character) as CharacterTable | undefined
    let maxCharacterLevel = 0
    const characterLevels = new Map<number, number>()
    if (characterTable) {
        for (const [characterId, character] of Object.entries(characters)) {
            const rarity = Number(characterTable[characterId]?.rarity)
            if (!Number.isSafeInteger(rarity) || rarity <= 0) continue
            const level = provenCharacterLevel(rarity, character.exp)
            const numericId = Number(characterId)
            if (level === null || !Number.isSafeInteger(numericId)) continue
            maxCharacterLevel = Math.max(maxCharacterLevel, level)
            characterLevels.set(numericId, level)
        }
    }
    const secondBoard = secondBoardStats(characters, manaNodes, tables.manaBoard, rules)
    const treasureShop = asTable(tables.treasureShop)
    const treasureShopPurchaseCount = treasureShop
        ? Object.entries(facts.shopPurchases ?? {}).reduce((total, [itemId, count]) => (
            treasureShop[itemId] === undefined || !Number.isFinite(count)
                ? total
                : total + Math.max(0, count)
        ), 0)
        : 0
    const equipmentTable = asTable(tables.equipmentDissolve) as EquipmentTable | undefined
    const maxLevelEquipmentCount = equipmentTable
        ? Object.entries(facts.equipment ?? {}).reduce((count, [equipmentId, equipment]) => {
            const maxLevel = Number(equipmentTable[equipmentId]?.max_level)
            return Number.isSafeInteger(maxLevel) && maxLevel > 0 && equipment.level >= maxLevel
                ? count + 1
                : count
        }, 0)
        : 0
    const bossBattleSuperQuestByMission = new Map<number, number>()
    for (const rule of rules.values()) {
        if (rule.kind === "finishedQuest" && rule.section === 2
            && rule.pattern.startsWith("degree_boss_battle_ex_clear_single_")) {
            bossBattleSuperQuestByMission.set(rule.missionId, rule.questId)
        }
    }
    const bondedCharacterIds = readonlySet(Object.entries(characters)
        .filter(([, character]) => character.bondTokenList.some(token => token.manaBoardIndex === 1 && token.status >= 1))
        .map(([characterId]) => Number(characterId)))
    const practiceSsQuestIds = readonlySet((questProgress["15"] ?? [])
        .filter(quest => quest.finished && quest.clearRank === 5)
        .map(quest => quest.questId))
    const craftItemId = craftPointItemId(rules)
    const collectedItemTotals = facts.collectedItems ?? {}

    return Object.freeze({
        maxCharacterLevel,
        companionCount: Object.keys(characters).length,
        overLimitCount: Object.values(characters).reduce((sum, character) => sum + character.overLimitStep, 0),
        manaBoardCount: Object.values(manaNodes).reduce((sum, nodes) => sum + nodes.length, 0),
        bondTokenCount: Object.values(characters).reduce((sum, character) => (
            sum + character.bondTokenList.filter(token => token.status >= 1).length
        ), 0),
        singleSsCount: battle.singleRankSsCount,
        multiClearCount: battle.multiClearCount,
        multiHostClearCount: battle.multiHostClearCount,
        episodeClearCount: (questProgress["3"] ?? []).filter(quest => quest.finished).length,
        characterLevels: readonlyMap(characterLevels),
        bondedCharacterIds,
        secondManaBoardNodeCount: secondBoard.nodeCount,
        secondManaBoardCompletedCharacterIds: secondBoard.completed,
        episodeCompletedChapters: completedEpisodeChapters(questProgress, tables),
        practiceSsQuestIds,
        treasureShopPurchaseCount,
        bossBattleSuperQuestByMission: readonlyMap(bossBattleSuperQuestByMission),
        bossBattleClearQuestIds: finishedBySection[2] ?? readonlySet(),
        expertSingleFinishedQuestIds: finishedBySection[21] ?? readonlySet(),
        worldStoryFinishedQuestIds: finishedBySection[18] ?? readonlySet(),
        adventFinishedQuestIds: finishedBySection[7] ?? readonlySet(),
        carnivalFinishedQuestIds: finishedBySection[22] ?? readonlySet(),
        hardMultiFinishedQuestIds: finishedBySection[26] ?? readonlySet(),
        finishedQuestIdsBySection: finishedBySection,
        challengeDungeonClearCount: battle.challengeDungeonClearCount,
        singleScoreMax: battle.singleScoreMax,
        singleClearTimeMin: battle.singleClearTimeMin,
        bossBattleClearCount: battle.bossBattleClearCount,
        craftPointObtainedCount: craftItemId === undefined ? 0 : collectedItemTotals[String(craftItemId)] ?? 0,
        collectedItemTotals,
        maxLevelEquipmentCount,
        skillUseCount: battle.skillUseCount,
        degreeBattleStats: facts.degreeBattleStats ?? EMPTY_DEGREE_BATTLE_STATS,
    })
}
