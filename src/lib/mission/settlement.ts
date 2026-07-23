import { getPlayerCategoryMissionsSync, updatePlayerCategoryMissionStageSync, updatePlayerCategoryMissionSync } from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import { getDb } from "../../data/db"
import { getComputer } from "./registry"
import { getCategoryMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers, getMissionIdsByCategory, isMissionProgressComplete } from "./stages"
import { getMissionPattern, isMissionEnabledAt } from "./patterns"
import { MissionRewardGranter } from "./grants"

export interface MissionSettlementInfo {
    mission_category_id: number
    mission_id: number
    mission_reward_id: number
}

export interface MissionSettlementResult {
    missionInfo: MissionSettlementInfo[]
    itemList: Record<string, number>
    characterList: Object[]
    equipmentList: Object[]
    degreeIds: number[]
    userInfo?: Record<string, number>
}

export interface MissionSettlementScope {
    category: number
    eventId?: number
}

interface EvaluatedMission {
    category: number
    missionId: number
    progress: number
    receivedStages: Record<string, boolean> | unknown[]
    dbProgress: number
}

function isDailyCoreMission(pattern: string): boolean {
    return /^single_battle_play(?:_[23])?$/.test(pattern)
        || /^multi_battle_play(?:_[23])?$/.test(pattern)
        || /^use_dash(?:_[23])?$/.test(pattern)
        || pattern === "daily_quest_stamina_use_2024_02"
}

function applyDailyCompletionProgress(missions: EvaluatedMission[]): void {
    const dailyMissions = missions.filter(mission => mission.category === 2)
    if (dailyMissions.length === 0) return

    const completedCoreCount = dailyMissions.filter(mission => {
        const pattern = getMissionPattern(2, mission.missionId)
        return isDailyCoreMission(pattern)
            && isMissionProgressComplete(2, mission.missionId, mission.progress)
    }).length

    for (const mission of dailyMissions) {
        if (!getMissionPattern(2, mission.missionId).startsWith("daily_quest_all_clear")) continue
        mission.progress = Math.max(mission.dbProgress, completedCoreCount)
    }
}

export function settleMissionCategories(
    playerId: number,
    categories: readonly (number | MissionSettlementScope)[],
    evaluationTime: Date,
): MissionSettlementResult {
    return getDb().transaction(() => {
        const player = getPlayerSync(playerId)
        if (!player) throw new Error(`Player ${playerId} not found during mission settlement.`)

        const evaluatedMissions: EvaluatedMission[] = []
        const evaluatedMissionKeys = new Set<string>()
        const scopes = new Map<string, MissionSettlementScope>()
        for (const entry of categories) {
            const scope = typeof entry === "number" ? { category: entry } : entry
            scopes.set(`${scope.category}:${scope.eventId ?? ""}`, scope)
        }
        for (const { category, eventId } of scopes.values()) {
            const computer = getComputer(category)
            const context = computer.buildContext(playerId, category)
            const persisted = getPlayerCategoryMissionsSync(playerId, category)
            for (const missionId of getMissionIdsByCategory(category)) {
                if (!isMissionEnabledAt(category, missionId, evaluationTime, eventId)) continue
                const missionKey = `${category}:${missionId}`
                if (evaluatedMissionKeys.has(missionKey)) continue
                evaluatedMissionKeys.add(missionKey)
                const current = persisted[String(missionId)]
                const dbProgress = current?.progress ?? 0
                const computed = computer.compute(missionId, context, dbProgress)
                evaluatedMissions.push({
                    category,
                    missionId,
                    progress: Math.max(0, dbProgress, Number.isFinite(computed) ? computed : 0),
                    receivedStages: current?.stages ?? [],
                    dbProgress,
                })
            }
        }
        applyDailyCompletionProgress(evaluatedMissions)

        const granter = new MissionRewardGranter(playerId, player)
        const missionInfo: MissionSettlementInfo[] = []
        for (const mission of evaluatedMissions) {
            if (mission.progress === mission.dbProgress) continue
            updatePlayerCategoryMissionSync(
                playerId,
                mission.category,
                mission.missionId,
                mission.progress,
            )
        }

        for (const mission of evaluatedMissions) {
            for (const stage of getCompletedStageNumbers(
                mission.category,
                mission.missionId,
                mission.progress,
            )) {
                if (!Array.isArray(mission.receivedStages)
                    && mission.receivedStages[String(stage)] === true) continue

                const definition = getCategoryMissionRewardStageDefinition(
                    mission.category,
                    mission.missionId,
                    stage,
                )
                if (!definition) continue
                updatePlayerCategoryMissionStageSync(
                    playerId,
                    mission.category,
                    stage,
                    mission.missionId,
                    true,
                )
                granter.grant(definition.rewards)
                missionInfo.push({
                    mission_category_id: mission.category,
                    mission_id: mission.missionId,
                    mission_reward_id: definition.missionRewardId,
                })
            }
        }
        granter.persistPlayer()
        return {
            missionInfo,
            itemList: granter.itemList,
            characterList: granter.characterList,
            equipmentList: granter.equipmentList,
            degreeIds: granter.degreeList,
            ...(granter.hasPlayerChanges() ? { userInfo: granter.getUserInfo() } : {}),
        }
    })()
}
