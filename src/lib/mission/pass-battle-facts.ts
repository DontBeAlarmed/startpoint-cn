import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionCatalog, isMissionMasterDefinitionEnabledAt } from "./mission-catalog"
import {
    translateMissionQuestRange,
    PASS_MISSION_RANGE_LAYOUT,
} from "./quest-range-translator"
function matchesQuestRange(row: readonly unknown[], questCategory: number, questId: number): boolean {
    // Shared translator: pass tables use the pass column layout, and the
    // event-id segment of event-kind rows pins the battle to the pass
    // period's own event. Rangeless rows (condition 85 emotion rows carry
    // "(None)") intentionally match any quest — the master data pins no
    // event for them.
    const range = translateMissionQuestRange(row, PASS_MISSION_RANGE_LAYOUT)
    return range !== null && range.matches(questCategory, questId)
}

function getSendEmotionCount(context: FinishContext): number | null {
    if (context.isMulti !== true) return null
    let total = 0
    for (const zone of context.statistics.zones ?? []) {
        const value = zone.send_emotion_count
        if (value === undefined) continue
        if (!Number.isSafeInteger(value) || value < 0) return null
        total += value
        if (!Number.isSafeInteger(total)) return null
    }
    return total
}

export function recordPassMissionBattleFacts(
    context: FinishContext,
    evaluationTime: Date,
): number[] {
    const matchedMissionIds: number[] = []
    const sendEmotionCount = getSendEmotionCount(context)
    if (sendEmotionCount !== null && sendEmotionCount > 0) {
        for (const definition of getMissionCatalog().getDefinitions(7)) {
            if (definition.patternType !== 85
                || !isMissionMasterDefinitionEnabledAt(definition, evaluationTime)) continue
            incrementPlayerCategoryMissionSync(
                context.playerId,
                7,
                definition.missionId,
                sendEmotionCount,
            )
            matchedMissionIds.push(definition.missionId)
        }
    }
    if (!context.questAccomplished) return matchedMissionIds

    for (const definition of getMissionCatalog().getDefinitions(8)) {
        const patternType = definition.patternType
        if (patternType !== 16 && patternType !== 23) continue
        if (patternType === 16 && context.isMulti !== true) continue
        if (patternType === 23) {
            const battleKind = Number(definition.row[6])
            if (battleKind !== 3
                && !(battleKind === 2 && context.isMulti === true)
                && !(battleKind === 1 && context.isMulti !== true)) continue
        }
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime)
            || !matchesQuestRange(definition.row, context.questCategory, context.questId)) continue
        incrementPlayerCategoryMissionSync(context.playerId, 8, definition.missionId, 1)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
