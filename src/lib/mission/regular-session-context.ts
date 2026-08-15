import type { DegreeBattleStats } from "../../data/domains/degree_battle_stats"
import type { PlayerQuestProgress } from "../../data/types"
import { buildCategoryFactPlan, getFactLoadPlanKey } from "./category-session-plan"
import {
    DEFAULT_CRAFT_POINT_ITEM_ID,
    getMissionCatalogContentTable,
    getMissionCatalogCraftPointItemId,
} from "./mission-catalog"
import { deriveRegularStateFacts } from "./regular-state-facts"
import type { MissionEvaluationSession } from "./evaluation-session"
import type { CategoryContext, PlayerQuestProgressEntry } from "./types"

const EMPTY_DEGREE_BATTLE_STATS: DegreeBattleStats = Object.freeze({
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

interface QuestSummary {
    readonly questProgress: Record<string, PlayerQuestProgressEntry[]>
    readonly totalQuestClears: number
    readonly totalStories: number
    readonly exRankSsCount: number
    readonly rankCounts: Record<string, number>
}

function summarizeQuestProgress(
    progress: Record<string, PlayerQuestProgress[]>,
): QuestSummary {
    let totalQuestClears = 0
    let totalStories = 0
    let exRankSsCount = 0
    const rankCounts = { rank_ss: 0, rank_s: 0, rank_a: 0, rank_b: 0 }
    const questProgress: Record<string, PlayerQuestProgressEntry[]> = {}
    for (const [section, quests] of Object.entries(progress)) {
        questProgress[section] = quests.map(quest => {
            if (quest.finished) {
                totalQuestClears++
                if (section === "3") totalStories++
                if (quest.clearRank === 5) rankCounts.rank_ss++
                else if (quest.clearRank === 4) rankCounts.rank_s++
                else if (quest.clearRank === 3) rankCounts.rank_a++
                else if (quest.clearRank === 2) rankCounts.rank_b++
                if (section === "4" && quest.clearRank === 5) exRankSsCount++
            }
            return {
                questId: quest.questId,
                finished: quest.finished,
                clearRank: quest.clearRank,
                bestElapsedTimeMs: quest.bestElapsedTimeMs,
                leaderCharacterId: quest.leaderCharacterId,
                multiClearCount: quest.multiClearCount,
            }
        })
    }
    return { questProgress, totalQuestClears, totalStories, exRankSsCount, rankCounts }
}

export function buildRegularCategoryContextFromSession(
    session: MissionEvaluationSession,
    missionIds: readonly number[],
): CategoryContext {
    const plan = buildCategoryFactPlan(session, 1, missionIds)
    const questKey = getFactLoadPlanKey(plan, "questProgress")
    const charactersKey = getFactLoadPlanKey(plan, "characters")
    const manaNodesKey = getFactLoadPlanKey(plan, "characterManaNodes")
    const equipmentKey = getFactLoadPlanKey(plan, "equipment")
    const collectedKey = getFactLoadPlanKey(plan, "collectedItems")
    const degreeKey = getFactLoadPlanKey(plan, "degreeBattleStats")
    const battleKey = getFactLoadPlanKey(plan, "missionBattleCounters")
    const characters = charactersKey
        ? session.getFactFromPlan(charactersKey, plan)
        : undefined
    const questSummary = summarizeQuestProgress(
        questKey ? session.getFactFromPlan(questKey, plan) : {},
    )
    const state = deriveRegularStateFacts({
        characters,
        characterManaNodes: manaNodesKey
            ? session.getFactFromPlan(manaNodesKey, plan)
            : undefined,
        equipment: equipmentKey
            ? session.getFactFromPlan(equipmentKey, plan)
            : undefined,
        collectedItemTotals: collectedKey
            ? session.getFactFromPlan(collectedKey, plan)
            : undefined,
        characterTable: charactersKey
            ? getMissionCatalogContentTable(session.catalog, "character.json")
            : undefined,
        manaBoardTable: charactersKey
            ? getMissionCatalogContentTable(session.catalog, "mana_board.json")
            : undefined,
        craftPointItemId: collectedKey
            ? getMissionCatalogCraftPointItemId(session.catalog)
            : DEFAULT_CRAFT_POINT_ITEM_ID,
    })

    return {
        category: 1,
        playerId: session.playerId,
        player: session.getFact({ kind: "player" }),
        questProgress: questSummary.questProgress,
        totalQuestClears: questSummary.totalQuestClears,
        totalStories: questSummary.totalStories,
        rankCounts: questSummary.rankCounts,
        regularStats: {
            exRankSsCount: questSummary.exRankSsCount,
            degreeBattleStats: degreeKey
                ? session.getFactFromPlan(degreeKey, plan)
                : EMPTY_DEGREE_BATTLE_STATS,
            state,
        },
        ...(battleKey ? { battleCounters: session.getFactFromPlan(battleKey, plan) } : {}),
    }
}
