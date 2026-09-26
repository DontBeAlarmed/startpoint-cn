import type { FinishContext } from "../quest/finish/types"
import {
    translateMissionQuestRange,
    STANDARD_MISSION_RANGE_LAYOUT,
    type MissionQuestRangeLayout,
    type TranslatedMissionQuestRange,
} from "./quest-range-translator"

/**
 * Shared matcher for battle-count mission conditions (clear counts, host/
 * guest, SS rank, ranking clear phase) across mission table families. The
 * battle-kind column defaults per condition type when the row leaves it
 * blank; range containment goes through the shared translator.
 */
export const BATTLE_COUNT_CONDITION_TYPES: ReadonlySet<number> = new Set([
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

export interface BattleCountConditionContext {
    readonly questCategory: number
    readonly questId: number
    readonly isMulti?: boolean
    readonly isMultiHost?: boolean
    readonly clearRank: number | null
    readonly statistics?: { clear_phase?: number }
}

export function matchesBattleCountCondition(
    row: readonly unknown[],
    conditionType: number,
    context: BattleCountConditionContext,
    layout: MissionQuestRangeLayout = STANDARD_MISSION_RANGE_LAYOUT,
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
        if (typeof cleared !== "number" || !Number.isSafeInteger(cleared) || cleared < phase) {
            return false
        }
    }

    const range: TranslatedMissionQuestRange | null = translateMissionQuestRange(row, layout)
    if (range === null) return false
    return range.matches(context.questCategory, context.questId)
}
