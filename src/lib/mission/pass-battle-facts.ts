import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionMasterDefinitions, isMissionDefinitionEnabledAt } from "./master-data"

const QUEST_CATEGORY_BY_RANGE_KIND: Readonly<Record<number, number>> = Object.freeze({
    2: 2,
    5: 7,
    7: 13,
    8: 11,
    10: 19,
    15: 22,
    16: 23,
    17: 24,
})

function parseSelector(value: unknown): ReadonlySet<number> | null {
    if (value === undefined || value === null || value === "" || value === "(None)") return null
    const values = String(value).split(",").map(Number)
    if (values.some(value => !Number.isSafeInteger(value))) return new Set()
    return new Set(values)
}

function matchesSelector(selector: ReadonlySet<number> | null, value: number): boolean {
    return selector === null || selector.has(value)
}

function matchesQuestRange(row: readonly unknown[], questCategory: number, questId: number): boolean {
    const rangeKind = Number(row[8])
    if (QUEST_CATEGORY_BY_RANGE_KIND[rangeKind] !== questCategory) return false
    if (row[12] !== undefined && row[12] !== "" && row[12] !== "(None)") return false

    if (rangeKind === 2) {
        const first = Math.floor(questId / 1_000_000)
        const remainder = questId % 1_000_000
        const second = Math.floor(remainder / 1_000)
        const third = remainder % 1_000
        return matchesSelector(parseSelector(row[9]), first)
            && matchesSelector(parseSelector(row[10]), second)
            && matchesSelector(parseSelector(row[11]), third)
    }

    const first = Math.floor(questId / 1_000)
    const second = questId % 1_000
    return matchesSelector(parseSelector(row[9]), first)
        && matchesSelector(parseSelector(row[11]), second)
}

export function recordPassMissionBattleFacts(
    context: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []

    const matchedMissionIds: number[] = []
    for (const definition of getMissionMasterDefinitions(8)) {
        const patternType = definition.patternType
        if (patternType !== 16 && patternType !== 23) continue
        if (patternType === 16 && context.isMulti !== true) continue
        if (patternType === 23) {
            const battleKind = Number(definition.row[6])
            if (battleKind !== 3
                && !(battleKind === 2 && context.isMulti === true)
                && !(battleKind === 1 && context.isMulti !== true)) continue
        }
        if (!isMissionDefinitionEnabledAt(definition, evaluationTime)
            || !matchesQuestRange(definition.row, context.questCategory, context.questId)) continue
        incrementPlayerCategoryMissionSync(context.playerId, 8, definition.missionId, 1)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
