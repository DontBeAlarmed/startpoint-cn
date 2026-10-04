import { incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import {
    getAdventEventQuestIdsForBossName,
    getAdventEventQuestIdsForEvent,
    getBossBattleQuestIdsForFamilyStage,
    getBossBattleQuestNameForFamilyStage,
} from "../quest-content"
import { getMissionCatalog, isMissionMasterDefinitionEnabledAt, MissionMasterDefinition } from "./mission-catalog"
interface DegreeBattleFactContext {
    readonly playerId: number
    readonly questCategory: number
    readonly questId: number
    readonly questAccomplished: boolean
    readonly isMulti?: boolean
    readonly isMvp?: boolean
}

interface ExactDegreeQuestClearRule {
    readonly missionId: number
    /** questId → quest category; a boss-series rule spans the resident boss battle and its advent generations. */
    readonly questIdCategories: ReadonlyMap<number, number>
    readonly definition: MissionMasterDefinition
}

const DEGREE_MVP_MISSION_IDS = [26000, 26010, 26020] as const

function isDegreeMvpDefinitionSupported(missionId: number): boolean {
    return getMissionCatalog().getDefinitions(5).some(definition => (
        definition.missionId === missionId
        && definition.pattern === `degree_mvp_get_${missionId === 26000 ? 1 : missionId === 26010 ? 2 : 3}`
        && Number(definition.row[3]) === 19
    ))
}

export function getDegreeMvpMissionIds(): readonly number[] {
    return Object.freeze(DEGREE_MVP_MISSION_IDS.filter(isDegreeMvpDefinitionSupported))
}

export function buildExactDegreeQuestClearRules(): readonly ExactDegreeQuestClearRule[] {
    const rules: ExactDegreeQuestClearRule[] = []
    for (const definition of getMissionCatalog().getDefinitions(5)) {
        if (Number(definition.row[3]) !== 23
            || definition.row[11] !== ""
            || definition.row[12] !== "(None)") continue
        const rangeKind = Number(definition.row[8])

        if (rangeKind === 2) {
            const family = Number(definition.row[9])
            const stageGroup = Number(definition.row[10])
            if (!Number.isSafeInteger(family) || family <= 0
                || !Number.isSafeInteger(stageGroup) || stageGroup <= 0) continue
            const questIds = getBossBattleQuestIdsForFamilyStage(family, stageGroup)
            if (questIds.length === 0) continue
            // 方案B(2026-10-05 拍板):领主战选择子写定于活动期时代,国服常驻化
            // (2021-08/10 起批)让计数对象漂移;同一 BOSS 的降临代次(cat7)与
            // 常驻版(cat2)通关都计数,按派生显示名等值归并(序章/尾声名字不同,自然排除)。
            const questIdCategories = new Map<number, number>()
            for (const questId of questIds) questIdCategories.set(questId, 2)
            const bossName = getBossBattleQuestNameForFamilyStage(family, stageGroup)
            if (bossName !== undefined) {
                for (const questId of getAdventEventQuestIdsForBossName(bossName)) {
                    questIdCategories.set(questId, 7)
                }
            }
            rules.push({
                missionId: definition.missionId,
                questIdCategories,
                definition,
            })
            continue
        }

        if (rangeKind !== 5 || definition.row[10] !== "") continue
        const eventId = Number(definition.row[9])
        if (!Number.isSafeInteger(eventId) || eventId <= 0) continue
        const questIds = getAdventEventQuestIdsForEvent(eventId)
        if (questIds.length === 0) continue
        const questIdCategories = new Map<number, number>()
        for (const questId of questIds) questIdCategories.set(questId, 7)
        rules.push({
            missionId: definition.missionId,
            questIdCategories,
            definition,
        })
    }
    return Object.freeze(rules)
}

export function getExactDegreeQuestClearRuleCount(): number {
    return buildExactDegreeQuestClearRules().length
}

export function getExactDegreeQuestClearMissionIds(): readonly number[] {
    return Object.freeze(buildExactDegreeQuestClearRules().map(rule => rule.missionId))
}

export function recordDegreeMissionBattleFacts(
    context: DegreeBattleFactContext,
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []
    const matchedMissionIds: number[] = []
    if (context.isMulti === true
        && context.isMvp === true) {
        for (const missionId of getDegreeMvpMissionIds()) {
            const definition = getMissionCatalog().getDefinitions(5)
                .find(entry => entry.missionId === missionId)
            if (definition?.pattern === `degree_mvp_get_${missionId === 26000 ? 1 : missionId === 26010 ? 2 : 3}`
                && isMissionMasterDefinitionEnabledAt(definition, evaluationTime)) {
                incrementPlayerCategoryMissionSync(context.playerId, 5, missionId, 1)
                matchedMissionIds.push(missionId)
            }
        }
    }
    for (const rule of buildExactDegreeQuestClearRules()) {
        if (rule.questIdCategories.get(context.questId) !== context.questCategory) continue
        if (!isMissionMasterDefinitionEnabledAt(rule.definition, evaluationTime)) continue
        incrementPlayerCategoryMissionSync(context.playerId, 5, rule.missionId, 1)
        matchedMissionIds.push(rule.missionId)
    }
    return matchedMissionIds
}
