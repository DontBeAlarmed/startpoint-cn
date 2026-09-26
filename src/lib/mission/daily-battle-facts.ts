import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionCatalog, isMissionMasterDefinitionEnabledAt } from "./mission-catalog"
import { getMissionRequirementDraft } from "./requirements/providers"
import {
    translateMissionQuestRange,
    type TranslatedMissionQuestRange,
} from "./quest-range-translator"

/**
 * Daily battle facts are routed by condition number through the shared
 * quest-range translator. The kind table, selector semantics (including the
 * empty-selector wildcard), and the battle-kind column are client-verified;
 * the historical per-mission whitelist and special cases (score-attack 10075,
 * advent 800115.., all-boss 800124.., any-battle 800392, weekevent patterns)
 * are all subsumed by this routing.
 */
const BATTLE_COUNT_CONDITION_TYPES: ReadonlySet<number> = new Set([
    14, 16, 17, 18, 23, 26, 49, 50, 51, 52,
])

const SINGLE_MODE = 1
const MULTI_MODE = 2
const ANY_MODE = 3

function battleMode(row: readonly unknown[], conditionType: number): number {
    const explicit = Number(row[5])
    if (explicit === SINGLE_MODE || explicit === MULTI_MODE || explicit === ANY_MODE) {
        return explicit
    }
    if (conditionType === 14 || (conditionType >= 49 && conditionType <= 52)) return SINGLE_MODE
    if (conditionType === 16 || conditionType === 17 || conditionType === 18) return MULTI_MODE
    return ANY_MODE
}

export function matchesDailyBattleCondition(
    row: readonly unknown[],
    conditionType: number,
    context: Pick<FinishContext, "questCategory" | "questId" | "isMulti" | "isMultiHost" | "clearRank"> & {
        statistics: { clear_phase: number }
    },
): boolean {
    const mode = battleMode(row, conditionType)
    if (mode === SINGLE_MODE && context.isMulti === true) return false
    if (mode === MULTI_MODE && context.isMulti !== true) return false
    if (conditionType === 17 && context.isMultiHost !== true) return false
    if (conditionType === 18 && context.isMultiHost !== false) return false
    if (conditionType === 26 && context.clearRank !== 5) return false
    if (conditionType >= 49 && conditionType <= 52) {
        const phase = conditionType - 48
        const cleared = context.statistics?.clear_phase
        if (!Number.isSafeInteger(cleared) || cleared < phase) return false
    }

    const range: TranslatedMissionQuestRange | null = translateMissionQuestRange(row)
    if (range === null) return false
    return range.matches(context.questCategory, context.questId)
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
        if (!BATTLE_COUNT_CONDITION_TYPES.has(conditionType)) continue
        // Computed shapes (core play/dash/stamina patterns) are served by the
        // periodic computer; producers only own persisted-mode rows.
        if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime)) continue
        if (!matchesDailyBattleCondition(definition.row, conditionType, context)) continue

        incrementPlayerCategoryMissionSync(context.playerId, 2, definition.missionId, 1)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
