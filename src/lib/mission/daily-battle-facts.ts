import adventEventQuests from "../../../assets/advent_event_quest.json"
import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionMasterDefinitions, isMissionDefinitionEnabledAt } from "./master-data"

const ACTIVE_DAILY_BATTLE_MISSION_IDS = new Set([
    800115,
    800116,
    800117,
    800124,
    800125,
    800126,
])

const ADVENT_EVENT_RANGE_KIND = 5
const BOSS_BATTLE_RANGE_KIND = 2
const MULTI_BATTLE_CLEAR_PATTERN_TYPE = 16

const adventQuestIds = new Set(
    Object.keys(adventEventQuests).map(Number).filter(Number.isSafeInteger),
)

function matchesAdventEvent(
    row: readonly unknown[],
    questCategory: number,
    questId: number,
): boolean {
    if (questCategory !== 7 || !adventQuestIds.has(questId)) return false
    const eventSelector = Number(row[8])
    return Number.isSafeInteger(eventSelector)
        && eventSelector > 0
        && Math.trunc(questId / 1_000) === eventSelector
}

function matchesQuestRange(
    row: readonly unknown[],
    questCategory: number,
    questId: number,
): boolean {
    const rangeKind = Number(row[7])
    if (rangeKind === ADVENT_EVENT_RANGE_KIND) {
        return matchesAdventEvent(row, questCategory, questId)
    }
    return rangeKind === BOSS_BATTLE_RANGE_KIND && questCategory === 2
}

export function recordDailyMissionBattleFacts(
    context: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished || context.isMulti !== true) return []

    const matchedMissionIds: number[] = []
    for (const definition of getMissionMasterDefinitions(2)) {
        if (!ACTIVE_DAILY_BATTLE_MISSION_IDS.has(definition.missionId)
            || Number(definition.row[2]) !== MULTI_BATTLE_CLEAR_PATTERN_TYPE
            || !isMissionDefinitionEnabledAt(definition, evaluationTime)
            || !matchesQuestRange(definition.row, context.questCategory, context.questId)) continue

        incrementPlayerCategoryMissionSync(context.playerId, 2, definition.missionId, 1)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
