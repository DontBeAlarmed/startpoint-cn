import { getMissionRewardStageDefinition } from "./rewards"
import type { ActiveMissionReward } from "./rewards"

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

export function validateMissionRewardClaims(
    activeMissions: Record<string, MissionClaimState>,
    requestList: unknown
): MissionRewardClaimValidation {
    if (!Array.isArray(requestList)) return { ok: false, message: "Invalid active mission claim." }

    const claims: ValidatedMissionRewardClaim[] = []
    const seenClaims = new Set<string>()

    for (const rawEntry of requestList) {
        if (!rawEntry || typeof rawEntry !== "object") {
            return { ok: false, message: "Invalid active mission claim." }
        }

        const entry = rawEntry as { mission_id?: unknown; stages?: unknown }
        const missionId = Number(entry.mission_id)
        if (!Number.isInteger(missionId) || missionId <= 0 || !Array.isArray(entry.stages)) {
            return { ok: false, message: "Invalid active mission claim." }
        }

        const currentMission = activeMissions[String(missionId)]
        if (!currentMission) return { ok: false, message: "Mission is not active." }

        const existingStages = currentMission.stages && !Array.isArray(currentMission.stages)
            ? currentMission.stages
            : {}

        for (const rawStage of entry.stages) {
            const stage = Number(rawStage)
            if (!Number.isInteger(stage) || stage <= 0) {
                return { ok: false, message: "Invalid mission stage." }
            }

            const claimKey = `${missionId}:${stage}`
            if (seenClaims.has(claimKey)) continue
            seenClaims.add(claimKey)

            const stageState = existingStages[String(stage)]
            if (stageState === true) continue

            const definition = getMissionRewardStageDefinition(missionId, stage)
            if (!definition) return { ok: false, message: "Unknown mission reward stage." }

            const explicitlyClaimable = stageState === false
            if (!explicitlyClaimable && (
                currentMission.progress < definition.targetProgress || definition.targetClearSeconds !== undefined
            )) {
                return { ok: false, message: "Mission stage is not complete." }
            }

            claims.push({
                missionId,
                stage,
                progress: currentMission.progress,
                rewards: definition.rewards,
            })
        }
    }

    return { ok: true, claims }
}
