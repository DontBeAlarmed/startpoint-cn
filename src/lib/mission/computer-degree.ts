// Degree mission computer (category 5)

import { getRankDegree } from "../stamina"
import { buildDegreeCategoryContextFromSession } from "./degree-session-context"
import type { DegreeMetric, DegreeRule } from "./degree-rule-catalog"
import { MissionEvaluationSession } from "./evaluation-session"
import { getMissionCatalog } from "./mission-catalog"
import { createProductionMissionFactLoaderRegistry } from "./production-fact-loaders"
import { getMissionFactRequirementRegistry } from "./requirements/registry"
import type { CategoryContext, MissionComputer } from "./types"

export {
    getBossBattleSuperQuestId,
    getDegreeComputedMissionIds,
    getDegreeMissionCoverageReport,
    getTargetDegree,
} from "./degree-coverage"
export { getSpecificCharacterBondId } from "./degree-context-requirements"

function metricValue(metric: DegreeMetric, ctx: CategoryContext): number {
    const stats = ctx.degreeStats
    if (!stats) return 0
    switch (metric) {
        case "staminaUseCount": return ctx.player.totalStaminaUsed ?? 0
        case "loginCount": return ctx.player.totalLoginDays ?? 0
        case "dashUseCount": return ctx.player.totalDashes ?? 0
        case "comboMax": return ctx.player.maxComboAchieved ?? 0
        case "feverCount": return stats.degreeBattleStats.feverCount
        case "feverMs": return stats.degreeBattleStats.feverMs
        case "debuffEnemyCount": return stats.degreeBattleStats.debuffEnemyCount
        case "clearEnemyBuffCount": return stats.degreeBattleStats.clearEnemyBuffCount
        case "clearSelfDebuffCount": return stats.degreeBattleStats.clearSelfDebuffCount
        case "buffPartyCount": return stats.degreeBattleStats.buffPartyCount
        case "healPartyCount": return stats.degreeBattleStats.healPartyCount
        case "emotionCount": return stats.degreeBattleStats.emotionCount
        case "enemyKillCount": return stats.degreeBattleStats.enemyKillCount
        case "weakPointAttackCount": return stats.degreeBattleStats.weakPointAttackCount
        case "powerFlipLv3Count": return stats.degreeBattleStats.powerFlipLv3Count
        case "coffinReducedCount": return stats.degreeBattleStats.coffinReducedCount
        case "damageDealMax": return stats.degreeBattleStats.damageDealMax
        case "revivalCoffinMax": return stats.degreeBattleStats.revivalCoffinMax
        case "partyPowerMax": return stats.degreeBattleStats.partyPowerMax
        case "skillChainMax": return stats.degreeBattleStats.skillChainMax
        default: return stats[metric]
    }
}

function finishedQuestIds(ctx: CategoryContext, section: number): ReadonlySet<number> {
    return ctx.degreeStats?.finishedQuestIdsBySection[section] ?? new Set()
}

export function computeDegreeProgress(
    rule: DegreeRule | undefined,
    ctx: CategoryContext,
    dbProgress: number,
): number {
    if (!rule || rule.kind === "persisted" || rule.kind === "unsupported") return dbProgress
    if (rule.kind === "playerRank") return getRankDegree(ctx.player.rankPoint)
    const stats = ctx.degreeStats
    if (!stats) return dbProgress
    switch (rule.kind) {
        case "maxCharacterLevel":
            return Math.max(dbProgress, stats.maxCharacterLevel)
        case "specificCharacterBond": {
            const level = (stats.characterLevels.get(rule.characterId) ?? 0) >= 100 ? 1 : 0
            const bond = stats.bondedCharacterIds.has(rule.characterId) ? 1 : 0
            return Math.max(dbProgress, level + bond)
        }
        case "secondManaBoardCharacter":
            return Math.max(dbProgress, stats.secondManaBoardCompletedCharacterIds.has(rule.characterId) ? 1 : 0)
        case "secondManaBoardAggregate":
            return Math.max(dbProgress, stats.secondManaBoardNodeCount)
        case "episodeChapter":
            return Math.max(dbProgress, stats.episodeCompletedChapters.has(rule.chapter) ? 1 : 0)
        case "practiceSs":
            return Math.max(dbProgress, rule.questIds.every(id => stats.practiceSsQuestIds.has(id)) ? 1 : 0)
        case "treasureShopPurchases":
            return Math.max(dbProgress, stats.treasureShopPurchaseCount)
        case "finishedQuest":
            return Math.max(dbProgress, finishedQuestIds(ctx, rule.section).has(rule.questId) ? 1 : 0)
        case "collectedItem":
            return Math.max(dbProgress, stats.collectedItemTotals[String(rule.itemId)] ?? 0)
        case "maxLevelEquipment":
            return Math.max(dbProgress, stats.maxLevelEquipmentCount)
        case "singleClearTime":
            return stats.singleClearTimeMin <= 0
                ? dbProgress
                : Math.max(dbProgress, stats.singleClearTimeMin <= rule.targetMs ? 1 : 0)
        case "metric": {
            const value = metricValue(rule.metric, ctx)
            return rule.replace ? value : Math.max(dbProgress, value)
        }
        default:
            return dbProgress
    }
}

function buildLegacyContext(
    playerId: number,
    category: number,
    evaluationTime: Date,
    missionIds?: readonly number[],
): CategoryContext {
    if (category !== 5) throw new Error("Degree context only supports category 5")
    const catalog = getMissionCatalog()
    const requestedIds = missionIds ?? catalog.getMissionIds(5)
    const candidateIds = [...new Set(requestedIds)].filter(id => catalog.getDefinition(5, id))
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime: evaluationTime instanceof Date ? evaluationTime : new Date(0),
        catalog,
        requirementRegistry: getMissionFactRequirementRegistry(catalog),
        candidates: candidateIds.map(missionId => ({ category: 5, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
    return buildDegreeCategoryContextFromSession(session, 5, candidateIds)
}

export const DegreeComputer: MissionComputer = {
    name: "Degree",
    buildContext: buildLegacyContext,
    buildContextFromSession: buildDegreeCategoryContextFromSession,
    compute(missionId, ctx, dbProgress) {
        return computeDegreeProgress(ctx.degreeRules?.get(missionId), ctx, dbProgress)
    },
}
