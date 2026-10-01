import type { MissionCatalog, MissionMasterDefinition } from "./mission-catalog"

const DEPENDENCY_PATTERN_TYPE = 13

export interface MissionCompletionDependenciesLayout {
    /** Column holding the condition type. */
    readonly typeCol: number
    /** Column holding the comma-separated dependency mission ids. */
    readonly depsCol: number
    readonly category: number
}

/** Daily tables: type at 2, dependency list at 17. */
export const DAILY_DEPENDENCY_LAYOUT: MissionCompletionDependenciesLayout = Object.freeze({
    typeCol: 2,
    depsCol: 17,
    category: 2,
})

/** Collect tables: type at 4, dependency list at 19. */
export const COLLECT_DEPENDENCY_LAYOUT: MissionCompletionDependenciesLayout = Object.freeze({
    typeCol: 4,
    depsCol: 19,
    category: 4,
})

export interface DailyCompletionMission {
    readonly category: number
    readonly missionId: number
    readonly dbProgress: number
    finalProgress: number
}

function getDependencyIds(
    definition: MissionMasterDefinition,
    layout: MissionCompletionDependenciesLayout,
): readonly number[] {
    if (Number(definition.row[layout.typeCol]) !== DEPENDENCY_PATTERN_TYPE) return []
    const raw = definition.row[layout.depsCol]
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

export function getDailyCompletionDependencies(
    definition: MissionMasterDefinition,
): readonly number[] {
    return getDependencyIds(definition, DAILY_DEPENDENCY_LAYOUT)
}

export function getCollectCompletionDependencies(
    definition: MissionMasterDefinition,
): readonly number[] {
    return getDependencyIds(definition, COLLECT_DEPENDENCY_LAYOUT)
}

const DEPENDENCY_LAYOUTS: readonly MissionCompletionDependenciesLayout[] = Object.freeze([
    DAILY_DEPENDENCY_LAYOUT,
    COLLECT_DEPENDENCY_LAYOUT,
])

/**
 * Complete-all missions (condition type 13) derive progress from their own
 * dependency list: how many of the listed missions have reached every reward
 * stage. Persisted progress stays a floor.
 */
export function applyDailyDependencyCompletion(
    missions: readonly DailyCompletionMission[],
    catalog: MissionCatalog,
): void {
    for (const layout of DEPENDENCY_LAYOUTS) {
        const categoryMissions = missions.filter(mission => mission.category === layout.category)
        if (categoryMissions.length === 0) continue
        const missionsById = new Map(categoryMissions.map(mission => [
            mission.missionId,
            mission,
        ]))
        for (const mission of categoryMissions) {
            const definition = catalog.getDefinition(layout.category, mission.missionId)
            const dependencies = definition === undefined
                ? []
                : getDependencyIds(definition, layout)
            if (dependencies.length === 0) continue
            const completedCount = dependencies.filter(missionId => {
                const dependency = missionsById.get(missionId)
                if (dependency === undefined) return false
                const stages = catalog.getRewardStages(layout.category, missionId)
                return stages.length > 0
                    && stages.every(stage => dependency.finalProgress >= stage.targetProgress)
            }).length
            mission.finalProgress = Math.max(mission.dbProgress, completedCount)
        }
    }
}
