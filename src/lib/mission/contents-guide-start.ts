import { getDb } from "../../data/db"
import {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
} from "../../data/domains/mission"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import type { ActiveMissionPlan } from "./active-plan"
import { getActiveMissionPlan } from "./active-plan"
import {
    getActiveMissionEventMasterDefinition,
    getActiveMissionMasterDefinitions,
} from "./active-master-data"
import {
    ActiveMissionProgressDelta,
    ActiveMissionProgressState,
    isActiveMissionAvailable,
    parseActiveMissionDefinition,
    parseActiveMissionEventDefinition,
    settleActiveMissionProgress,
} from "./active-core"

const CONTENTS_GUIDE_EVENT_KIND = 2
const CONTENTS_GUIDE_START_STRING_ID = "contents_guide_start"

export interface StartContentsGuideMissionInput {
    readonly playerId: number
    readonly eventId: number
    readonly plan?: ActiveMissionPlan
    readonly now: number | Date
}

export type StartContentsGuideMissionResult =
    | { readonly ok: true, readonly delta: ActiveMissionProgressDelta | null }
    | { readonly ok: false, readonly message: string }

function normalizeActiveMissions(
    activeMissions: ReturnType<typeof getPlayerActiveMissionsSync>,
): Record<string, ActiveMissionProgressState> {
    return Object.fromEntries(Object.entries(activeMissions).map(([missionId, mission]) => [
        missionId,
        {
            progress: mission.progress,
            stages: mission.stages && !Array.isArray(mission.stages) ? mission.stages : {},
        },
    ]))
}

function resolveContentsGuideStartMissionId(
    eventId: number,
    plan: ActiveMissionPlan,
): number | null {
    try {
        const eventMaster = getActiveMissionEventMasterDefinition(eventId, plan)
        if (!eventMaster) return null
        const event = parseActiveMissionEventDefinition(eventId, eventMaster.row)
        if (event.kind !== CONTENTS_GUIDE_EVENT_KIND) return null

        const candidates = getActiveMissionMasterDefinitions(plan).filter(definition => (
            Number(definition.row[0]) === eventId
            && definition.row[3] === CONTENTS_GUIDE_START_STRING_ID
        ))
        if (candidates.length !== 1) return null

        const mission = parseActiveMissionDefinition(candidates[0].missionId, candidates[0].row)
        if (mission.eventId !== eventId || mission.stringId !== CONTENTS_GUIDE_START_STRING_ID) return null
        return mission.missionId
    } catch {
        return null
    }
}

export function startContentsGuideMission(
    input: StartContentsGuideMissionInput,
): StartContentsGuideMissionResult {
    const plan = input.plan ?? getActiveMissionPlan()
    const missionId = resolveContentsGuideStartMissionId(input.eventId, plan)
    if (missionId === null) {
        return { ok: false, message: "Invalid contents guide event." }
    }

    return getDb().transaction((): StartContentsGuideMissionResult => {
        const activeMissions = normalizeActiveMissions(getPlayerActiveMissionsSync(input.playerId))
        const questProgress = getPlayerQuestProgressSync(input.playerId)
        if (!isActiveMissionAvailable(missionId, {
            plan,
            now: input.now,
            activeMissions,
            questProgress,
        })) {
            return { ok: false, message: "Contents guide mission is not available." }
        }

        const settlement = settleActiveMissionProgress(
            missionId,
            activeMissions[String(missionId)],
            1,
            { plan },
        )
        if (settlement.delta === null) return { ok: true, delta: null }

        updatePlayerActiveMissionSync(input.playerId, missionId, settlement.state.progress)
        for (const stage of settlement.delta.stages) {
            updatePlayerActiveMissionStageSync(input.playerId, stage.stage, missionId, false)
        }
        return { ok: true, delta: settlement.delta }
    })()
}
