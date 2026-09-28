// Compute awake mission summary for /load response
// Returns active_mission_list (Array format for data.active_mission_list)

import {
    assertAwakeRequestContext,
    createAwakeRequestContext,
    readAwakeRequestContextCategoryMissions,
    type AwakeRequestContext,
} from "./awake-request-context"
import { getMissionStageIds } from "./mission-catalog"

export interface AwakeMissionEntry {
    mission_id: number
    progress_value: number
    stages: { stage: number; received: boolean }[]
}

export interface AwakeSummary {
    activeMissionList: AwakeMissionEntry[]
    manaBoardAwakeMap: Map<string, Record<number, number>>
}

export function computeAwakeSummary(
    playerId: number,
    context?: AwakeRequestContext,
): AwakeSummary {
    context ??= createAwakeRequestContext({ playerId })
    assertAwakeRequestContext(context, playerId)
    const activeMissions = readAwakeRequestContextCategoryMissions(context)
    const activeMissionList = context.evaluate().map(entry => {
        const persistedStages = activeMissions[String(entry.missionId)]?.stages
        return {
            mission_id: entry.missionId,
            progress_value: entry.progress,
            stages: getMissionStageIds(9, entry.missionId).map(stage => ({
                stage,
                received: !Array.isArray(persistedStages)
                    && persistedStages?.[String(stage)] === true,
            })),
        }
    })
    return {
        activeMissionList,
        manaBoardAwakeMap: context.readUnlocks(),
    }
}
