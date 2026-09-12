import type { MissionCatalog, MissionMasterDefinition } from "./mission-catalog"

const DAILY_ALL_CLEAR_PATTERN_TYPE = 13

export interface DailyCompletionMission {
    readonly category: number
    readonly missionId: number
    readonly dbProgress: number
    finalProgress: number
}

export function getDailyCompletionDependencies(
    definition: MissionMasterDefinition,
): readonly number[] {
    if (Number(definition.row[2]) !== DAILY_ALL_CLEAR_PATTERN_TYPE) return []
    const raw = definition.row[17]
    if (typeof raw !== "string" || raw === "" || raw === "(None)") return []
    const seen = new Set<number>()
    const dependencies: number[] = []
    for (const part of raw.split(",")) {
        if (!/^\d+$/.test(part)) return []
        const missionId = Number(part)
        if (missionId <= 0) return []
        if (!seen.has(missionId)) {
            seen.add(missionId)
            dependencies.push(missionId)
        }
    }
    return dependencies
}

export function applyDailyDependencyCompletion(
    missions: readonly DailyCompletionMission[],
    catalog: MissionCatalog,
): void {
    const dailyMissions = missions.filter(mission => mission.category === 2)
    if (dailyMissions.length === 0) return
    const missionsById = new Map(dailyMissions.map(mission => [
        mission.missionId,
        mission,
    ]))
    for (const mission of dailyMissions) {
        const definition = catalog.getDefinition(2, mission.missionId)
        const dependencies = definition ? getDailyCompletionDependencies(definition) : []
        if (dependencies.length === 0) continue
        const completedCount = dependencies.filter(missionId => {
            const dependency = missionsById.get(missionId)
            if (dependency === undefined) return false
            const stages = catalog.getRewardStages(2, missionId)
            return stages.length > 0
                && stages.every(stage => dependency.finalProgress >= stage.targetProgress)
        }).length
        mission.finalProgress = Math.max(mission.dbProgress, completedCount)
    }
}
