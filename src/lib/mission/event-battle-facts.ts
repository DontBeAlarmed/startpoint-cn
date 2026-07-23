import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionMasterDefinitions, isMissionDefinitionEnabledAt } from "./master-data"
import questMap from "../../../assets/mission_event_quest_map.json"

interface LegacyQuestMapping {
    questIds: number[]
    categories: number[]
    countMode: string
}

interface SafeMultiClearRule {
    missionId: number
    categories: ReadonlySet<number>
    questIds: ReadonlySet<number>
    definition: ReturnType<typeof getMissionMasterDefinitions>[number]
}

function isEmptyMasterValue(value: unknown): boolean {
    return value === undefined || value === null || value === "" || value === "(None)"
}

function hasNoIgnoredQuestRangeFilters(row: readonly unknown[]): boolean {
    const questKind = String(row[7])
    if (!isEmptyMasterValue(row[11])) return false
    if (questKind === "2") return isEmptyMasterValue(row[8]) && isEmptyMasterValue(row[10])
    if (["5", "8", "10", "15", "16", "17"].includes(questKind)) {
        return isEmptyMasterValue(row[10])
    }
    if (questKind === "7") {
        return isEmptyMasterValue(row[8])
            && isEmptyMasterValue(row[9])
            && isEmptyMasterValue(row[10])
    }
    return false
}

const safeMultiClearRules: readonly SafeMultiClearRule[] = Object.freeze(
    getMissionMasterDefinitions(3).flatMap(definition => {
        if (String(definition.row[2]) !== "16") return []
        if (!hasNoIgnoredQuestRangeFilters(definition.row)) return []
        const mapping = (questMap as Record<string, LegacyQuestMapping>)[definition.pattern]
        if (!mapping || mapping.countMode !== "multi") return []
        return [{
            missionId: definition.missionId,
            categories: new Set(mapping.categories),
            questIds: new Set(mapping.questIds),
            definition,
        }]
    }),
)

export function getSafeEventBattleRuleCoverage() {
    return {
        totalEventMissions: getMissionMasterDefinitions(3).length,
        safeMultiClearRules: safeMultiClearRules.length,
    }
}

export function recordEventMissionBattleFacts(
    ctx: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!ctx.questAccomplished || ctx.isMulti !== true) return []

    const matchedMissionIds: number[] = []
    for (const rule of safeMultiClearRules) {
        if (!rule.categories.has(ctx.questCategory) || !rule.questIds.has(ctx.questId)) continue
        if (!isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
        incrementPlayerCategoryMissionSync(ctx.playerId, 3, rule.missionId, 1)
        matchedMissionIds.push(rule.missionId)
    }
    return matchedMissionIds
}
