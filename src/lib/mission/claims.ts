import type { ActiveMissionReward } from "./rewards"
import { getActiveMissionPlan } from "./active-plan"
import {
    isActiveMissionClaimable,
    type ActiveMissionAvailabilityContext,
    type ActiveMissionProgressState,
} from "./active-core"

interface MissionClaimState {
    progress: number
    stages?: Record<string, boolean> | unknown[]
}

export interface ValidatedMissionRewardClaim {
    missionId: number
    stage: number
    progress: number
    rewards: ActiveMissionReward[]
}

export type MissionRewardClaimValidation =
    | { ok: true; claims: ValidatedMissionRewardClaim[] }
    | { ok: false; message: string }

export type MissionRewardClaimContext = Omit<ActiveMissionAvailabilityContext, "activeMissions">

function normalizeAvailabilityMissions(
    activeMissions: Record<string, MissionClaimState>,
): Record<string, ActiveMissionProgressState> {
    return Object.fromEntries(Object.entries(activeMissions).map(([missionId, mission]) => [
        missionId,
        {
            progress: mission.progress,
            stages: mission.stages && !Array.isArray(mission.stages) ? mission.stages : {},
        },
    ]))
}

export function validateMissionRewardClaims(
    activeMissions: Record<string, MissionClaimState>,
    requestList: unknown,
    context?: MissionRewardClaimContext,
): MissionRewardClaimValidation {
    if (!Array.isArray(requestList)) return { ok: false, message: "Invalid active mission claim." }

    const claims: ValidatedMissionRewardClaim[] = []
    const seen = new Set<string>()
    const plan = getActiveMissionPlan(context?.repository)
    const availabilityMissions = context
        ? normalizeAvailabilityMissions(activeMissions)
        : null

    for (const rawEntry of requestList) {
        if (!rawEntry || typeof rawEntry !== "object") {
            return { ok: false, message: "Invalid active mission claim." }
        }
        const entry = rawEntry as { mission_id?: unknown, stages?: unknown }
        const missionId = Number(entry.mission_id)
        if (!Number.isInteger(missionId) || missionId <= 0 || !Array.isArray(entry.stages)) {
            return { ok: false, message: "Invalid active mission claim." }
        }

        const plannedMission = plan.getMission(missionId)
        if (!plannedMission) {
            return { ok: false, message: "Unknown active mission." }
        }

        if (context && availabilityMissions && !isActiveMissionClaimable(missionId, {
            ...context,
            activeMissions: availabilityMissions,
        })) return { ok: false, message: "Active mission is not available." }

        const mission = activeMissions[String(missionId)]
        if (!mission) return { ok: false, message: "Mission is not active." }
        const existingStages = mission.stages && !Array.isArray(mission.stages) ? mission.stages : {}

        for (const rawStage of entry.stages) {
            const stage = Number(rawStage)
            if (!Number.isInteger(stage) || stage <= 0) {
                return { ok: false, message: "Invalid mission stage." }
            }
            const key = `${missionId}:${stage}`
            if (seen.has(key)) continue
            seen.add(key)
            if (existingStages[String(stage)] === true) continue

            const definition = plannedMission.rewardStages.find(candidate => candidate.stage === stage)
            if (!definition) return { ok: false, message: "Unknown mission reward stage." }
            if (existingStages[String(stage)] !== false && (
                mission.progress < definition.targetProgress || definition.targetClearSeconds !== undefined
            )) {
                return { ok: false, message: "Mission stage is not complete." }
            }
            claims.push({
                missionId,
                stage,
                progress: mission.progress,
                rewards: definition.rewards.map(reward => ({ ...reward })),
            })
        }
    }

    return { ok: true, claims }
}
