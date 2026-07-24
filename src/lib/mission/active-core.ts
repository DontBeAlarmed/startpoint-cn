import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import {
    getActiveMissionEventMasterDefinition,
    getActiveMissionMasterDefinition,
    getActiveMissionMasterDefinitions,
} from "./active-master-data"
import { getMissionRewardStageDefinition } from "./rewards"

// CN keeps the upstream JST symbol name but initializes its offset to UTC+8.
const CN_MASTER_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000
const NONE_VALUES = new Set<unknown>([undefined, null, "", "(None)"])

export interface ActiveMissionStageReference {
    readonly missionId: number
    readonly stage: number
}

export interface ParsedActiveMissionDefinition {
    readonly missionId: number
    readonly eventId: number
    readonly phase?: number
    readonly stringId: string
    readonly need?: ActiveMissionStageReference
    readonly show?: ActiveMissionStageReference
    readonly enableStartTime?: number
    readonly enableEndTime?: number
    readonly showStartTime?: number
    readonly showEndTime?: number
}

export interface ParsedActiveMissionEventDefinition {
    readonly eventId: number
    readonly kind: number
    readonly maxPhase?: number
    readonly startTime: number
    readonly endTime?: number
    readonly needQuestMultipliedId?: number
}

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

function parseRequiredInteger(value: unknown, field: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) throw new TypeError(`Invalid Active Mission ${field}.`)
    return parsed
}

function parseOptionalInteger(value: unknown, field: string): number | undefined {
    return NONE_VALUES.has(value) ? undefined : parseRequiredInteger(value, field)
}

function parseStageReference(
    missionIdValue: unknown,
    stageValue: unknown,
    field: string,
): ActiveMissionStageReference | undefined {
    if (NONE_VALUES.has(missionIdValue)) return undefined
    const missionId = parseRequiredInteger(missionIdValue, `${field} mission id`)
    const stage = parseRequiredInteger(stageValue, `${field} stage`)
    if (missionId <= 0 || stage <= 0) throw new TypeError(`Invalid Active Mission ${field}.`)
    return { missionId, stage }
}

export function parseCnMasterDateTime(value: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (!match) throw new TypeError(`Invalid CN master date time: ${value}`)

    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
    const year = Number(yearText)
    const month = Number(monthText)
    const day = Number(dayText)
    const hour = Number(hourText)
    const minute = Number(minuteText)
    const second = Number(secondText)
    if (year < 1970 || year > 2200
        || month < 1 || month > 12
        || day < 1 || day > 31
        || hour > 23 || minute > 59 || second > 59) {
        throw new TypeError(`Invalid CN master date time: ${value}`)
    }

    const utcWithoutOffset = Date.UTC(year, month - 1, day, hour, minute, second)
    const normalized = new Date(utcWithoutOffset)
    if (normalized.getUTCFullYear() !== year
        || normalized.getUTCMonth() !== month - 1
        || normalized.getUTCDate() !== day
        || normalized.getUTCHours() !== hour
        || normalized.getUTCMinutes() !== minute
        || normalized.getUTCSeconds() !== second) {
        throw new TypeError(`Invalid CN master date time: ${value}`)
    }
    return utcWithoutOffset - CN_MASTER_OFFSET_MILLISECONDS
}

export const parseJstDateTime = parseCnMasterDateTime

function parseOptionalCnMasterDateTime(value: unknown, field: string): number | undefined {
    if (NONE_VALUES.has(value)) return undefined
    if (typeof value !== "string") throw new TypeError(`Invalid Active Mission ${field}.`)
    return parseCnMasterDateTime(value)
}

export function parseActiveMissionDefinition(
    missionId: number,
    row: readonly unknown[],
): ParsedActiveMissionDefinition {
    const eventId = parseRequiredInteger(row[0], "event id")
    const phase = parseOptionalInteger(row[1], "phase")
    const stringId = row[3]
    if (typeof stringId !== "string" || stringId.length === 0) {
        throw new TypeError("Invalid Active Mission string id.")
    }
    const need = parseStageReference(row[56], row[57], "need")
    const show = parseStageReference(row[58], row[59], "show")
    const enableStartTime = parseOptionalCnMasterDateTime(row[60], "enable start time")
    const enableEndTime = parseOptionalCnMasterDateTime(row[61], "enable end time")
    const showStartTime = parseOptionalCnMasterDateTime(row[62], "show start time")
    const showEndTime = parseOptionalCnMasterDateTime(row[63], "show end time")
    return {
        missionId,
        eventId,
        ...(phase !== undefined ? { phase } : {}),
        stringId,
        ...(need ? { need } : {}),
        ...(show ? { show } : {}),
        ...(enableStartTime !== undefined ? { enableStartTime } : {}),
        ...(enableEndTime !== undefined ? { enableEndTime } : {}),
        ...(showStartTime !== undefined ? { showStartTime } : {}),
        ...(showEndTime !== undefined ? { showEndTime } : {}),
    }
}

export function parseActiveMissionEventDefinition(
    eventId: number,
    row: readonly unknown[],
): ParsedActiveMissionEventDefinition {
    const maxPhase = parseOptionalInteger(row[3], "event max phase")
    const startTime = parseOptionalCnMasterDateTime(row[14], "event start time")
    if (startTime === undefined) throw new TypeError("Invalid Active Mission event start time.")
    const endTime = parseOptionalCnMasterDateTime(row[15], "event end time")
    const needQuestMultipliedId = parseOptionalInteger(row[22], "event prerequisite quest")
    return {
        eventId,
        kind: parseRequiredInteger(row[2], "event kind"),
        ...(maxPhase !== undefined ? { maxPhase } : {}),
        startTime,
        ...(endTime !== undefined ? { endTime } : {}),
        ...(needQuestMultipliedId !== undefined ? { needQuestMultipliedId } : {}),
    }
}

export function getActiveMissionRewardStageIds(
    missionId: number,
    repository: ReadonlyContentRepository,
): number[] {
    const table = repository.table<Record<string, Record<string, unknown>>>("mission_active_reward.json")
    const stageTable = table[String(missionId)]
    if (!stageTable) return []
    return Object.keys(stageTable)
        .map(Number)
        .filter(stage => Number.isSafeInteger(stage) && stage > 0)
        .sort((left, right) => left - right)
}

function isMissionCurrentStageComplete(
    missionId: number,
    state: ActiveMissionProgressState | undefined,
    repository: ReadonlyContentRepository,
): boolean {
    const stageIds = getActiveMissionRewardStageIds(missionId, repository)
    if (stageIds.length === 0) return false
    const progress = state?.progress ?? 0
    for (const stage of stageIds) {
        const definition = getMissionRewardStageDefinition(missionId, stage, repository)
        if (!definition || progress < definition.targetProgress) return false
    }
    return true
}

export function getActiveMissionEventReleasePhase(
    eventId: number,
    activeMissions: Readonly<Record<string, ActiveMissionProgressState>>,
    repository: ReadonlyContentRepository,
): number {
    const eventMaster = getActiveMissionEventMasterDefinition(eventId, repository)
    if (!eventMaster) return 0
    const maxPhase = parseActiveMissionEventDefinition(eventId, eventMaster.row).maxPhase
    if (maxPhase === undefined || maxPhase <= 0) return 0

    const missions = getActiveMissionMasterDefinitions(repository)
        .map(definition => parseActiveMissionDefinition(definition.missionId, definition.row))
        .filter(definition => definition.eventId === eventId)
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
    const definition = getMissionRewardStageDefinition(
        reference.missionId,
        reference.stage,
        repository,
    )
    return state?.stages?.[String(reference.stage)] === true
        && definition !== null
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
        const missionMaster = getActiveMissionMasterDefinition(missionId, context.repository)
        if (!missionMaster) return false
        const mission = parseActiveMissionDefinition(missionId, missionMaster.row)
        const eventMaster = getActiveMissionEventMasterDefinition(mission.eventId, context.repository)
        if (!eventMaster) return false
        const event = parseActiveMissionEventDefinition(mission.eventId, eventMaster.row)
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
    if (!getActiveMissionMasterDefinition(missionId, options.repository)) {
        throw new TypeError(`Unknown Active Mission ${missionId}.`)
    }

    const settledProgress = Math.max(currentState?.progress ?? 0, authoritativeProgress)
    const stages: Record<string, boolean> = { ...(currentState?.stages ?? {}) }
    const completedStages: { stage: number, received: false }[] = []
    const stageIds = options.repository
        ? getActiveMissionRewardStageIds(missionId, options.repository)
        : Object.keys(requireBundledRewardStages(missionId)).map(Number).sort((a, b) => a - b)
    for (const stage of stageIds) {
        const stageKey = String(stage)
        if (stages[stageKey] !== undefined) continue
        const definition = getMissionRewardStageDefinition(missionId, stage, options.repository)
        if (!definition || settledProgress < definition.targetProgress) continue
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

function requireBundledRewardStages(missionId: number): Record<string, unknown> {
    const stages: Record<string, unknown> = {}
    for (let stage = 1; ; stage++) {
        if (!getMissionRewardStageDefinition(missionId, stage)) break
        stages[String(stage)] = true
    }
    return stages
}
