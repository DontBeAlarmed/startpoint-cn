import bundledActiveMissions from "../../../assets/mission_active.json"
import bundledActiveMissionEvents from "../../../assets/mission_active_event.json"
import bundledActiveRewards from "../../../assets/mission_active_reward.json"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import {
    buildActiveMissionPlanSource,
    type ActiveMissionPlanSource,
} from "./active-plan-builder"
import type { ActiveMissionQuestRange } from "./active-quest-range"

export {
    parseActiveMissionDefinition,
    parseActiveMissionEventDefinition,
    parseCnMasterDateTime,
    parseJstDateTime,
} from "./active-plan-builder"
export type { ActiveMissionQuestRange } from "./active-quest-range"

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

export interface PlannedActiveMissionDefinition {
    readonly missionId: number
    readonly pattern: number
    readonly mission: ParsedActiveMissionDefinition
    readonly row: readonly unknown[]
    readonly rewardStages: readonly PlannedActiveMissionRewardStage[]
    readonly questRange: ActiveMissionQuestRange | null
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
const plansByMissionTable = new WeakMap<object, WeakMap<object, WeakMap<object, ActiveMissionPlan>>>()

function buildPlan(missions: unknown, events: unknown, rewards: unknown): ActiveMissionPlan {
    return new SnapshotActiveMissionPlan(buildActiveMissionPlanSource(missions, events, rewards))
}

function getTableCachedPlan(
    missions: object,
    events: object,
    rewards: object,
): ActiveMissionPlan {
    let byEvent = plansByMissionTable.get(missions)
    if (!byEvent) {
        byEvent = new WeakMap()
        plansByMissionTable.set(missions, byEvent)
    }
    let byReward = byEvent.get(events)
    if (!byReward) {
        byReward = new WeakMap()
        byEvent.set(events, byReward)
    }
    const cached = byReward.get(rewards)
    if (cached) return cached
    const plan = buildPlan(missions, events, rewards)
    byReward.set(rewards, plan)
    return plan
}

function runtimeTable<T>(tableName: string, bundled: T): T {
    return getRuntimeContentTableSync(tableName, bundled)
}

export function getActiveMissionPlan(repository?: ReadonlyContentRepository): ActiveMissionPlan {
    if (repository) {
        const cached = plansByRepository.get(repository)
        if (cached) return cached
        const plan = buildPlan(
            repository.table("mission_active.json"),
            repository.table("mission_active_event.json"),
            repository.table("mission_active_reward.json"),
        )
        plansByRepository.set(repository, plan)
        return plan
    }

    const missions = runtimeTable("mission_active.json", bundledActiveMissions)
    const events = runtimeTable("mission_active_event.json", bundledActiveMissionEvents)
    const rewards = runtimeTable("mission_active_reward.json", bundledActiveRewards)
    if (typeof missions === "object" && missions !== null
        && typeof events === "object" && events !== null
        && typeof rewards === "object" && rewards !== null) {
        return getTableCachedPlan(missions, events, rewards)
    }
    return buildPlan(missions, events, rewards)
}
