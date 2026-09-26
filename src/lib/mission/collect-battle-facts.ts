import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionCatalog, isMissionMasterDefinitionEnabledAt } from "./mission-catalog"
import { getMissionRequirementDraft } from "./requirements/providers"
import { matchesBattleCountCondition } from "./battle-count-condition"
import { COLLECT_MISSION_RANGE_LAYOUT } from "./quest-range-translator"

const COLLECT_BATTLE_CONDITION_TYPES: ReadonlySet<number> = new Set([14, 16, 17, 18, 23, 26])
const COLLECT_MANA_CONDITION_TYPE = 46

/**
 * Collect-event battle facts: routed by condition number through the shared
 * matcher with the collect column layout. Event scope is enforced by the
 * catalog's requiresEventScope check against the mission's own event id, and
 * the range containment already pins the event's quests.
 */
export function recordCollectMissionBattleFacts(
    context: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []

    const catalog = getMissionCatalog()
    const matchedMissionIds: number[] = []
    for (const definition of catalog.getDefinitions(4)) {
        const conditionType = Number(definition.row[4])
        if (!COLLECT_BATTLE_CONDITION_TYPES.has(conditionType)) continue
        if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime, definition.eventId)) continue
        if (!matchesBattleCountCondition(definition.row, conditionType, context, COLLECT_MISSION_RANGE_LAYOUT)) continue

        incrementPlayerCategoryMissionSync(context.playerId, 4, definition.missionId, 1)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}

/**
 * Mana spent inside a collect event: the ledger increments carry their own
 * time gate (the mission must be inside its enable window), so they must be
 * called from the same transaction as the mana deduction.
 */
export function recordCollectMissionManaSpend(
    playerId: number,
    amount: number,
    evaluationTime: Date,
): number[] {
    if (!Number.isSafeInteger(amount) || amount <= 0) return []

    const catalog = getMissionCatalog()
    const matchedMissionIds: number[] = []
    for (const definition of catalog.getDefinitions(4)) {
        if (Number(definition.row[4]) !== COLLECT_MANA_CONDITION_TYPE) continue
        if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime, definition.eventId)) continue

        incrementPlayerCategoryMissionSync(playerId, 4, definition.missionId, amount)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
