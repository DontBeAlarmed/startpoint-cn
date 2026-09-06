import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"
import {
    buildActiveMissionPlanSource,
    type ActiveMissionPlanSource,
} from "./active-plan-builder"
import type { ActiveMissionQuestRange } from "./active-quest-range"
import type { ActiveMissionFactKind } from "./active-fact-kinds"

export {
    parseActiveMissionDefinition,
    parseActiveMissionEventDefinition,
    parseCnMasterDateTime,
    parseJstDateTime,
} from "./active-plan-builder"
export type { ActiveMissionQuestRange } from "./active-quest-range"
export { ACTIVE_MISSION_FACT_KINDS } from "./active-fact-kinds"
export type { ActiveMissionFactKind } from "./active-fact-kinds"

const UNSUPPORTED_ACTIVE_MISSION_IDS: readonly number[] = Object.freeze([
    21030,
    25009,
    25010,
    25011,
    25012,
    25013,
    25014,
    25017,
    25018,
    25022,
])
const EMPTY_DEFINITIONS: readonly PlannedActiveMissionDefinition[] = Object.freeze([])

export type ActiveMissionEvaluatorKind = "static" | "dependency"

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
    readonly stringId?: string
    readonly kind: number
    readonly maxPhase?: number
    readonly startTime: number
    readonly endTime?: number
    readonly needQuestMultipliedId?: number
}

export interface ActiveMissionReward {
    readonly kind: number
    readonly amount: number
    readonly itemId?: number
    readonly characterId?: number
    readonly equipmentId?: number
    readonly degreeId?: number
}

export interface PlannedActiveMissionRewardStage {
    readonly stage: number
    readonly targetProgress: number
    readonly targetClearSeconds?: number
    readonly rewards: readonly ActiveMissionReward[]
}

export interface PlannedActiveMissionTargetRequirement {
    readonly missionId: number
    readonly completionProgress: number | null
}

export interface PlannedActiveMissionDefinition {
    readonly missionId: number
    readonly pattern: number
    readonly mission: ParsedActiveMissionDefinition
    readonly row: readonly unknown[]
    readonly rewardStages: readonly PlannedActiveMissionRewardStage[]
    readonly questRange: ActiveMissionQuestRange | null
    readonly targetMissionRequirements: readonly PlannedActiveMissionTargetRequirement[]
    readonly factKinds: readonly ActiveMissionFactKind[]
    readonly evaluator: ActiveMissionEvaluatorKind | null
}

export interface ActiveMissionPlan {
    readonly definitions: readonly PlannedActiveMissionDefinition[]
    getMission(missionId: number): PlannedActiveMissionDefinition | undefined
    getEvent(eventId: number): ParsedActiveMissionEventDefinition | undefined
    getDefinitionsByPattern(pattern: number): readonly PlannedActiveMissionDefinition[]
    getUnsupportedMissionIds(): readonly number[]
}

const eventRowsByPlan = new WeakMap<
    ActiveMissionPlan,
    ReadonlyMap<number, readonly unknown[]>
>()
const missionRowsByPlan = new WeakMap<
    ActiveMissionPlan,
    ReadonlyMap<number, readonly unknown[]>
>()
const rewardStagesByPlan = new WeakMap<
    ActiveMissionPlan,
    ReadonlyMap<number, readonly PlannedActiveMissionRewardStage[]>
>()

class SnapshotActiveMissionPlan implements ActiveMissionPlan {
    readonly definitions: readonly PlannedActiveMissionDefinition[]
    readonly #missions: ReadonlyMap<number, PlannedActiveMissionDefinition>
    readonly #events: ReadonlyMap<number, ParsedActiveMissionEventDefinition>
    readonly #patterns: ReadonlyMap<number, readonly PlannedActiveMissionDefinition[]>

    constructor(source: ActiveMissionPlanSource) {
        this.definitions = source.definitions
        this.#missions = new Map(source.definitions.map(definition => [
            definition.missionId,
            definition,
        ]))
        this.#events = source.events
        const patterns = new Map<number, PlannedActiveMissionDefinition[]>()
        for (const definition of source.definitions) {
            const definitions = patterns.get(definition.pattern) ?? []
            definitions.push(definition)
            patterns.set(definition.pattern, definitions)
        }
        this.#patterns = new Map([...patterns].map(([pattern, definitions]) => [
            pattern,
            Object.freeze(definitions),
        ]))
        missionRowsByPlan.set(this, source.missionRows)
        eventRowsByPlan.set(this, source.eventRows)
        rewardStagesByPlan.set(this, source.rewardStages)
    }

    getMission(missionId: number): PlannedActiveMissionDefinition | undefined {
        return this.#missions.get(missionId)
    }

    getEvent(eventId: number): ParsedActiveMissionEventDefinition | undefined {
        return this.#events.get(eventId)
    }

    getDefinitionsByPattern(pattern: number): readonly PlannedActiveMissionDefinition[] {
        return this.#patterns.get(pattern) ?? EMPTY_DEFINITIONS
    }

    getUnsupportedMissionIds(): readonly number[] {
        return UNSUPPORTED_ACTIVE_MISSION_IDS
    }
}

export function getActiveMissionPlanMissionRows(
    plan: ActiveMissionPlan,
): readonly { readonly missionId: number, readonly row: readonly unknown[] }[] {
    return [...(missionRowsByPlan.get(plan) ?? new Map()).entries()].map(([missionId, row]) => ({
        missionId,
        row,
    }))
}

export function getActiveMissionPlanEventRows(
    plan: ActiveMissionPlan,
): readonly { readonly eventId: number, readonly row: readonly unknown[] }[] {
    return [...(eventRowsByPlan.get(plan) ?? new Map()).entries()].map(([eventId, row]) => ({
        eventId,
        row,
    }))
}

export function getActiveMissionPlanEventRow(
    plan: ActiveMissionPlan,
    eventId: number,
): readonly unknown[] | undefined {
    return eventRowsByPlan.get(plan)?.get(eventId)
}

export function getActiveMissionPlanRewardStages(
    plan: ActiveMissionPlan,
    missionId: number,
): readonly PlannedActiveMissionRewardStage[] {
    return rewardStagesByPlan.get(plan)?.get(missionId) ?? []
}

const plansByRepository = new WeakMap<ReadonlyContentRepository, ActiveMissionPlan>()

function buildPlan(missions: unknown, events: unknown, rewards: unknown): ActiveMissionPlan {
    return new SnapshotActiveMissionPlan(buildActiveMissionPlanSource(missions, events, rewards))
}

export function getActiveMissionPlan(repository?: ReadonlyContentRepository): ActiveMissionPlan {
    const source = repository ?? getContentSnapshot().repository
    const cached = plansByRepository.get(source)
    if (cached) return cached
    const plan = buildPlan(
        source.table("mission_active.json"),
        source.table("mission_active_event.json"),
        source.table("mission_active_reward.json"),
    )
    plansByRepository.set(source, plan)
    return plan
}
