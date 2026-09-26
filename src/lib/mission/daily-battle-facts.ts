import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionCatalog, isMissionMasterDefinitionEnabledAt } from "./mission-catalog"
import { getMissionRequirementDraft } from "./requirements/providers"
import {
    matchesBattleCountCondition,
    BATTLE_COUNT_CONDITION_TYPES,
} from "./battle-count-condition"
import { sumCollectZoneStatistic } from "./collect-battle-facts"
import { matchesZoneStatisticsCountCondition } from "./battle-count-condition"

/**
 * Daily battle facts are routed by condition number through the shared
 * quest-range matcher. The historical per-mission whitelist and special
 * cases (score-attack 10075, advent 800115.., all-boss 800124..,
 * any-battle 800392, weekevent patterns) are all subsumed by this routing.
 */
export function matchesDailyBattleCondition(
    row: readonly unknown[],
    conditionType: number,
    context: Parameters<typeof matchesBattleCountCondition>[2],
): boolean {
    return matchesBattleCountCondition(row, conditionType, context)
}

export function recordDailyMissionBattleFacts(
    context: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []

    const catalog = getMissionCatalog()
    const matchedMissionIds: number[] = []
    for (const definition of catalog.getDefinitions(2)) {
        const conditionType = Number(definition.row[2])
        if (conditionType === 28) {
            // Non-dash zone-statistics dailies (statistics code in column 3);
            // dash rows are computed from the periodic dash total.
            if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
            if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime)) continue
            if (!matchesZoneStatisticsCountCondition(definition.row, context)) continue
            const amount = sumCollectZoneStatistic(context, definition.row[3])
            if (amount === null || amount <= 0) continue
            incrementPlayerCategoryMissionSync(context.playerId, 2, definition.missionId, amount)
            matchedMissionIds.push(definition.missionId)
            continue
        }
        if (!BATTLE_COUNT_CONDITION_TYPES.has(conditionType)) continue
        // Computed shapes (core play/dash/stamina patterns) are served by the
        // periodic computer; producers only own persisted-mode rows.
        if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime)) continue
        if (!matchesBattleCountCondition(definition.row, conditionType, context)) continue

        incrementPlayerCategoryMissionSync(context.playerId, 2, definition.missionId, 1)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
