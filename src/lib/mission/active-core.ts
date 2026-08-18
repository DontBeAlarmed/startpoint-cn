import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import {
    getActiveMissionPlan,
    getActiveMissionPlanRewardStages,
    type ActiveMissionStageReference,
} from "./active-plan"

export {
    parseActiveMissionDefinition,
    parseActiveMissionEventDefinition,
    parseCnMasterDateTime,
    parseJstDateTime,
} from "./active-plan"
export type {
    ActiveMissionStageReference,
    ParsedActiveMissionDefinition,
    ParsedActiveMissionEventDefinition,
} from "./active-plan"

export interface ActiveMissionProgressState {
    readonly progress: number
    readonly stages?: Readonly<Record<string, boolean>>
}

export interface ActiveMissionQuestProgress {
    readonly questId: number
    readonly finished: boolean
}

export interface ActiveMissionAvailabilityContext {
    readonly repository: ReadonlyContentRepository
    readonly now: number | Date
    readonly activeMissions: Readonly<Record<string, ActiveMissionProgressState>>
    readonly questProgress: Readonly<Record<string, readonly ActiveMissionQuestProgress[]>>
}

export interface ActiveMissionProgressDelta {
    readonly mission_id: number
    readonly progress_value: number
    readonly stages: readonly { readonly stage: number, readonly received: false }[]
}

export interface ActiveMissionProgressSettlement {
    readonly state: {
        readonly progress: number
        readonly stages: Record<string, boolean>
    }
    readonly delta: ActiveMissionProgressDelta | null
}

export interface ActiveMissionProgressSettlementOptions {
    readonly repository?: ReadonlyContentRepository
    readonly clearSeconds?: number
}

export function getActiveMissionRewardStageIds(
    missionId: number,
    repository: ReadonlyContentRepository,
): number[] {
    return getActiveMissionPlanRewardStages(getActiveMissionPlan(repository), missionId)
        .map(stage => stage.stage)
}

function isMissionCurrentStageComplete(
    missionId: number,
    state: ActiveMissionProgressState | undefined,
    repository: ReadonlyContentRepository,
): boolean {
    const stageIds = getActiveMissionRewardStageIds(missionId, repository)
    if (stageIds.length === 0) return false
    const rewardStages = getActiveMissionPlanRewardStages(getActiveMissionPlan(repository), missionId)
    const progress = state?.progress ?? 0
    for (const stage of stageIds) {
        const definition = rewardStages.find(candidate => candidate.stage === stage)
        if (!definition || progress < definition.targetProgress) return false
    }
    return true
}

export function getActiveMissionEventReleasePhase(
    eventId: number,
    activeMissions: Readonly<Record<string, ActiveMissionProgressState>>,
    repository: ReadonlyContentRepository,
): number {
    const plan = getActiveMissionPlan(repository)
    const maxPhase = plan.getEvent(eventId)?.maxPhase
    if (maxPhase === undefined || maxPhase <= 0) return 0

    const missions = plan.definitions
        .map(definition => definition.mission)
        .filter(mission => mission.eventId === eventId)
    let releasedPhase = 1
    for (let phase = 1; phase < maxPhase; phase++) {
        const phaseMissions = missions.filter(mission => mission.phase === phase)
        if (!phaseMissions.every(mission => isMissionCurrentStageComplete(
            mission.missionId,
            activeMissions[String(mission.missionId)],
            repository,
        ))) break
        releasedPhase = phase + 1
    }
    return Math.min(releasedPhase, maxPhase)
}

function isStageReceivedAndComplete(
    activeMissions: Readonly<Record<string, ActiveMissionProgressState>>,
    reference: ActiveMissionStageReference | undefined,
    repository: ReadonlyContentRepository,
): boolean {
    if (!reference) return true
    const state = activeMissions[String(reference.missionId)]
    const definition = getActiveMissionPlanRewardStages(
        getActiveMissionPlan(repository),
        reference.missionId,
    ).find(stage => stage.stage === reference.stage)
    return state?.stages?.[String(reference.stage)] === true
        && definition !== undefined
        && state.progress >= definition.targetProgress
}

function isQuestFinished(
    questProgress: Readonly<Record<string, readonly ActiveMissionQuestProgress[]>>,
    questId: number | undefined,
): boolean {
    if (questId === undefined) return true
    return Object.values(questProgress).some(progressList => progressList.some(
        progress => progress.questId === questId && progress.finished === true,
    ))
}

function isActiveMissionUsable(
    missionId: number,
    context: ActiveMissionAvailabilityContext,
    period: "enable" | "show",
): boolean {
    try {
        const plan = getActiveMissionPlan(context.repository)
        const mission = plan.getMission(missionId)?.mission
        if (!mission) return false
        const event = plan.getEvent(mission.eventId)
        if (!event) return false
        const now = context.now instanceof Date ? context.now.getTime() : context.now
        const missionStartTime = period === "enable"
            ? mission.enableStartTime
            : mission.showStartTime
        const missionEndTime = period === "enable"
            ? mission.enableEndTime
            : mission.showEndTime
        if (!Number.isFinite(now)
            || now < event.startTime
            || (event.endTime !== undefined && now > event.endTime)
            || !isQuestFinished(context.questProgress, event.needQuestMultipliedId)
            || (missionStartTime !== undefined && now < missionStartTime)
            || (missionEndTime !== undefined && now > missionEndTime)
            || (mission.phase !== undefined && mission.phase > getActiveMissionEventReleasePhase(
                mission.eventId,
                context.activeMissions,
                context.repository,
            ))
            || !isStageReceivedAndComplete(context.activeMissions, mission.need, context.repository)
            || !isStageReceivedAndComplete(context.activeMissions, mission.show, context.repository)) {
            return false
        }
        return true
    } catch {
        return false
    }
}

export function isActiveMissionAvailable(
    missionId: number,
    context: ActiveMissionAvailabilityContext,
): boolean {
    return isActiveMissionUsable(missionId, context, "enable")
}

export function isActiveMissionClaimable(
    missionId: number,
    context: ActiveMissionAvailabilityContext,
): boolean {
    return isActiveMissionUsable(missionId, context, "show")
}

export function settleActiveMissionProgress(
    missionId: number,
    currentState: ActiveMissionProgressState | undefined,
    authoritativeProgress: number,
    options: ActiveMissionProgressSettlementOptions = {},
): ActiveMissionProgressSettlement {
    if (!Number.isFinite(authoritativeProgress) || authoritativeProgress < 0) {
        throw new TypeError("Active Mission absolute progress must be a finite non-negative number.")
    }
    const mission = getActiveMissionPlan(options.repository).getMission(missionId)
    if (!mission) {
        throw new TypeError(`Unknown Active Mission ${missionId}.`)
    }

    const settledProgress = Math.max(currentState?.progress ?? 0, authoritativeProgress)
    const stages: Record<string, boolean> = { ...(currentState?.stages ?? {}) }
    const completedStages: { stage: number, received: false }[] = []
    for (const definition of mission.rewardStages) {
        const stage = definition.stage
        const stageKey = String(stage)
        if (stages[stageKey] !== undefined) continue
        if (settledProgress < definition.targetProgress) continue
        if (definition.targetClearSeconds !== undefined
            && (!Number.isFinite(options.clearSeconds)
                || options.clearSeconds === undefined
                || options.clearSeconds > definition.targetClearSeconds)) continue
        stages[stageKey] = false
        completedStages.push({ stage, received: false })
    }

    const changed = currentState?.progress !== settledProgress || completedStages.length > 0
    return {
        state: { progress: settledProgress, stages },
        delta: changed ? {
            mission_id: missionId,
            progress_value: settledProgress,
            stages: completedStages,
        } : null,
    }
}
