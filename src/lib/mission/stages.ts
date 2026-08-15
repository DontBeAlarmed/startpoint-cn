import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getMissionCatalog, isMissionCatalogCategory } from "./mission-catalog"

export function getMissionIdsByCategory(
    category: number,
    repository?: ReadonlyContentRepository,
): number[] {
    if (!isMissionCatalogCategory(category)) return []
    return [...getMissionCatalog(repository).getMissionIds(category)]
}

export function getCurrentStage(
    category: number,
    missionId: number,
    progress: number,
    repository?: ReadonlyContentRepository,
): number {
    if (!isMissionCatalogCategory(category)) return 1
    const stages = getMissionCatalog(repository).getRewardStages(category, missionId)
    if (stages.length === 0) return 1
    let current = stages[stages.length - 1].stage
    for (const stage of stages) {
        if (progress < stage.targetProgress) {
            current = stage.stage
            break
        }
    }
    return current
}

export function getCompletedStageNumbers(
    category: number,
    missionId: number,
    progress: number,
    repository?: ReadonlyContentRepository,
): number[] {
    if (!isMissionCatalogCategory(category)) return []
    return getMissionCatalog(repository)
        .getRewardStages(category, missionId)
        .filter(stage => progress >= stage.targetProgress)
        .map(stage => stage.stage)
}

export function isMissionProgressComplete(
    category: number,
    missionId: number,
    progress: number,
    repository?: ReadonlyContentRepository,
): boolean {
    if (!isMissionCatalogCategory(category)) return false
    const stages = getMissionCatalog(repository).getRewardStages(category, missionId)
    return stages.length > 0 && stages.every(stage => progress >= stage.targetProgress)
}

export function getMissionStageIds(
    category: number,
    missionId: number,
    repository?: ReadonlyContentRepository,
): number[] {
    if (!isMissionCatalogCategory(category)) return []
    return getMissionCatalog(repository)
        .getRewardStages(category, missionId)
        .map(stage => stage.stage)
}
