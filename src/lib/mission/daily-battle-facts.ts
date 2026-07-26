import adventEventQuests from "../../../assets/advent_event_quest.json"
import scoreAttackEventQuests from "../../../assets/score_attack_event_quest.json"
import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionMasterDefinitions, isMissionDefinitionEnabledAt } from "./master-data"

const ACTIVE_DAILY_BATTLE_MISSION_IDS = new Set([
    10075,
    800115,
    800116,
    800117,
    800124,
    800125,
    800126,
    800392,
])

const ADVENT_EVENT_RANGE_KIND = 5
const BOSS_BATTLE_RANGE_KIND = 2
const SCORE_ATTACK_EVENT_RANGE_KIND = 20
const SINGLE_BATTLE_CLEAR_PATTERN_TYPE = 14
const MULTI_BATTLE_CLEAR_PATTERN_TYPE = 16
const BATTLE_CLEAR_PATTERN_TYPE = 23
const ANY_BATTLE_KIND = 3
const SCORE_ATTACK_DAILY_MISSION_ID = 10075
const ANY_BATTLE_DAILY_MISSION_ID = 800392

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

function matchesScoreAttackDailyMission(
    row: readonly unknown[],
    context: FinishContext,
): boolean {
    if (Number(row[2]) !== SINGLE_BATTLE_CLEAR_PATTERN_TYPE
        || Number(row[7]) !== SCORE_ATTACK_EVENT_RANGE_KIND
        // Official mission 10075 says "any stage" but stores an empty local
        // stage selector. Keep this exception scoped to the exact mission ID.
        || row[10] !== ""
        || row[11] !== "(None)"
        || context.isMulti === true
        || context.questCategory !== 27) return false

    const eventId = Number(row[8])
    const quest = (scoreAttackEventQuests as Record<string, { eventId?: number }>)[String(context.questId)]
    return Number.isSafeInteger(eventId)
        && eventId > 0
        && quest?.eventId === eventId
}

function matchesAnyBattleDailyMission(
    row: readonly unknown[],
    context: FinishContext,
): boolean {
    return Number(row[2]) === BATTLE_CLEAR_PATTERN_TYPE
        && Number(row[5]) === ANY_BATTLE_KIND
        && row[7] === "(None)"
        && (context.isMulti === true || context.isMulti === false || context.isMulti === undefined)
}

export function recordDailyMissionBattleFacts(
    context: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []

    const matchedMissionIds: number[] = []
    for (const definition of getMissionMasterDefinitions(2)) {
        if (!ACTIVE_DAILY_BATTLE_MISSION_IDS.has(definition.missionId)
            || !isMissionDefinitionEnabledAt(definition, evaluationTime)) continue

        let matches = false
        if (definition.missionId === SCORE_ATTACK_DAILY_MISSION_ID) {
            matches = matchesScoreAttackDailyMission(definition.row, context)
        } else if (definition.missionId === ANY_BATTLE_DAILY_MISSION_ID) {
            matches = matchesAnyBattleDailyMission(definition.row, context)
        } else {
            matches = context.isMulti === true
                && Number(definition.row[2]) === MULTI_BATTLE_CLEAR_PATTERN_TYPE
                && matchesQuestRange(definition.row, context.questCategory, context.questId)
        }
        if (!matches) continue

        incrementPlayerCategoryMissionSync(context.playerId, 2, definition.missionId, 1)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
