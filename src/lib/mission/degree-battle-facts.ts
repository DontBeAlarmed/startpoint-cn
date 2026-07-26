import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import bossBattleQuests from "../../../assets/boss_battle_quest.json"
import adventEventQuests from "../../../assets/advent_event_quest.json"
import {
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
} from "./master-data"

interface DegreeBattleFactContext {
    readonly playerId: number
    readonly questCategory: number
    readonly questId: number
    readonly questAccomplished: boolean
}

interface ExactDegreeQuestClearRule {
    readonly missionId: number
    readonly category: number
    readonly questIds: ReadonlySet<number>
    readonly definition: ReturnType<typeof getMissionMasterDefinitions>[number]
}

function buildExactDegreeQuestClearRules(): readonly ExactDegreeQuestClearRule[] {
    const rules: ExactDegreeQuestClearRule[] = []
    for (const definition of getMissionMasterDefinitions(5)) {
        if (Number(definition.row[3]) !== 23
            || definition.row[11] !== ""
            || definition.row[12] !== "(None)") continue
        const rangeKind = Number(definition.row[8])

        if (rangeKind === 2) {
            const family = Number(definition.row[9])
            const stageGroup = Number(definition.row[10])
            if (!Number.isSafeInteger(family) || family <= 0
                || !Number.isSafeInteger(stageGroup) || stageGroup <= 0) continue
            const questIds = Object.keys(bossBattleQuests).map(Number).filter(questId => (
                Math.floor(questId / 1_000_000) === family
                && Math.floor(questId / 1_000) % 1_000 === stageGroup
            ))
            if (questIds.length === 0) continue
            rules.push({
                missionId: definition.missionId,
                category: 2,
                questIds: new Set(questIds),
                definition,
            })
            continue
        }

        if (rangeKind !== 5 || definition.row[10] !== "") continue
        const eventId = Number(definition.row[9])
        if (!Number.isSafeInteger(eventId) || eventId <= 0) continue
        const questIds = Object.keys(adventEventQuests).map(Number)
            .filter(questId => Math.floor(questId / 1_000) === eventId)
        if (questIds.length === 0) continue
        rules.push({
            missionId: definition.missionId,
            category: 7,
            questIds: new Set(questIds),
            definition,
        })
    }
    return Object.freeze(rules)
}

const exactDegreeQuestClearRules = buildExactDegreeQuestClearRules()

export function getExactDegreeQuestClearRuleCount(): number {
    return exactDegreeQuestClearRules.length
}

export function recordDegreeMissionBattleFacts(
    context: DegreeBattleFactContext,
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []
    const matchedMissionIds: number[] = []
    for (const rule of exactDegreeQuestClearRules) {
        if (rule.category !== context.questCategory || !rule.questIds.has(context.questId)) continue
        if (!isMissionDefinitionEnabledAt(rule.definition, evaluationTime)) continue
        incrementPlayerCategoryMissionSync(context.playerId, 5, rule.missionId, 1)
        matchedMissionIds.push(rule.missionId)
    }
    return matchedMissionIds
}
