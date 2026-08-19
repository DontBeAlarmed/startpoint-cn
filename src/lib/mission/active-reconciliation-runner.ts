import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import type { ActiveMissionProgressDelta, ActiveMissionProgressState } from "./active-core"
import { isActiveMissionAvailable, settleActiveMissionProgress } from "./active-core"
import { evaluateActiveMissionFact } from "./active-fact-evaluator"
import type {
    ActiveMissionFactObserver,
    ActiveMissionFactSession,
} from "./active-fact-session"
import type { ActiveMissionPlan, PlannedActiveMissionDefinition } from "./active-plan"

const COME_BACK_EVENT_STRING_ID = "come_back_mission"

export interface ActiveMissionEventEligibilityContext {
    readonly playerId: number
    readonly eventId: number
    readonly eventStringId: string
    readonly eventKind: number
}

export interface ActiveMissionReconciliationRunnerInput {
    readonly playerId: number
    readonly repository: ReadonlyContentRepository
    readonly now: number | Date
    readonly plan: ActiveMissionPlan
    readonly session: ActiveMissionFactSession
    readonly observer?: ActiveMissionFactObserver
    readonly isEventEligible?: (context: ActiveMissionEventEligibilityContext) => boolean
    readonly updateMission: (missionId: number, progress: number) => void
    readonly updateStage: (missionId: number, stage: number) => void
}

export interface ActiveMissionReconciliationRunResult {
    readonly deltas: ActiveMissionProgressDelta[]
    readonly activeMissions: Record<string, ActiveMissionProgressState>
}

interface ActiveMissionDependents {
    readonly availability: ReadonlyMap<number, ReadonlySet<number>>
    readonly targets: ReadonlyMap<number, ReadonlySet<number>>
}

function appendDependent(
    map: Map<number, Set<number>>,
    sourceMissionId: number,
    dependentMissionId: number,
): void {
    if (sourceMissionId === dependentMissionId) return
    const dependents = map.get(sourceMissionId) ?? new Set<number>()
    dependents.add(dependentMissionId)
    map.set(sourceMissionId, dependents)
}

function buildDependents(definitions: readonly PlannedActiveMissionDefinition[]): ActiveMissionDependents {
    const availability = new Map<number, Set<number>>()
    const targets = new Map<number, Set<number>>()
    for (const dependent of definitions) {
        for (const requirement of dependent.targetMissionRequirements) {
            appendDependent(targets, requirement.missionId, dependent.missionId)
        }
        for (const reference of [dependent.mission.need, dependent.mission.show]) {
            if (reference) appendDependent(availability, reference.missionId, dependent.missionId)
        }
    }
    for (const source of definitions) {
        const sourcePhase = source.mission.phase ?? 1
        for (const dependent of definitions) {
            if (dependent.mission.eventId === source.mission.eventId
                && (dependent.mission.phase ?? 1) > sourcePhase) {
                appendDependent(availability, source.missionId, dependent.missionId)
            }
        }
    }
    return { availability, targets }
}

function isEligibleEvent(
    input: ActiveMissionReconciliationRunnerInput,
    definition: PlannedActiveMissionDefinition,
): boolean {
    const event = input.plan.getEvent(definition.mission.eventId)
    if (!event || typeof event.stringId !== "string") return false
    if (!event.stringId.includes(COME_BACK_EVENT_STRING_ID)) return true
    return input.isEventEligible?.({
        playerId: input.playerId,
        eventId: event.eventId,
        eventStringId: event.stringId,
        eventKind: event.kind,
    }) === true
}

function mergeDelta(
    deltas: Map<number, { progress: number, stages: Set<number> }>,
    delta: ActiveMissionProgressDelta,
): void {
    const current = deltas.get(delta.mission_id) ?? {
        progress: delta.progress_value,
        stages: new Set<number>(),
    }
    current.progress = delta.progress_value
    for (const stage of delta.stages) current.stages.add(stage.stage)
    deltas.set(delta.mission_id, current)
}

function orderedDeltas(
    deltas: ReadonlyMap<number, { readonly progress: number, readonly stages: ReadonlySet<number> }>,
): ActiveMissionProgressDelta[] {
    return [...deltas.entries()]
        .sort(([left], [right]) => left - right)
        .map(([missionId, delta]) => ({
            mission_id: missionId,
            progress_value: delta.progress,
            stages: [...delta.stages]
                .sort((left, right) => left - right)
                .map(stage => ({ stage, received: false as const })),
        }))
}

function computeCandidate(
    input: ActiveMissionReconciliationRunnerInput,
    definition: PlannedActiveMissionDefinition,
): number | null {
    input.session.ensureFor([definition.missionId])
    const snapshot = input.session.getInternalSnapshot()
    if (definition.evaluator === "dependency") {
        input.observer?.dependencyComputed?.(definition.missionId)
    } else {
        input.observer?.staticComputed?.(definition.missionId)
    }
    try {
        return evaluateActiveMissionFact(definition, snapshot.facts, snapshot.activeMissions)
    } catch {
        return null
    }
}

function scheduleDependents(
    missionId: number,
    dependents: ActiveMissionDependents,
    remaining: ReadonlySet<number>,
    dirtyDependencies: Set<number>,
    next: Set<number>,
    progressChanged: boolean,
    availabilityChanged: boolean,
): void {
    if (progressChanged) {
        for (const dependentId of dependents.targets.get(missionId) ?? []) {
            dirtyDependencies.add(dependentId)
            if (!remaining.has(dependentId)) next.add(dependentId)
        }
    }
    if (availabilityChanged) {
        for (const dependentId of dependents.availability.get(missionId) ?? []) {
            if (!remaining.has(dependentId)) next.add(dependentId)
        }
    }
}

export function runActiveMissionReconciliation(
    input: ActiveMissionReconciliationRunnerInput,
): ActiveMissionReconciliationRunResult {
    const definitions = [...input.plan.definitions]
        .sort((left, right) => left.missionId - right.missionId)
    input.session.loadKinds(["activeProgress", "questProgress"])
    const snapshot = input.session.getInternalSnapshot()
    const activeMissions = snapshot.activeMissions
    const candidates = new Map<number, number | null>()

    const dependents = buildDependents(definitions)
    const dirtyDependencies = new Set<number>()
    const deltas = new Map<number, { progress: number, stages: Set<number> }>()
    const definitionsById = new Map(definitions.map(definition => [definition.missionId, definition]))
    let pending = definitions.map(definition => definition.missionId)

    for (let pass = 0; pass <= input.plan.definitions.length; pass++) {
        const next = new Set<number>()
        const remaining = new Set(pending)
        for (const missionId of pending) {
            remaining.delete(missionId)
            const definition = definitionsById.get(missionId)
            if (!definition) continue
            input.observer?.definitionVisited?.(missionId)

            let available = false
            try {
                available = isEligibleEvent(input, definition)
                    && isActiveMissionAvailable(missionId, {
                        repository: input.repository,
                        plan: input.plan,
                        now: input.now,
                        activeMissions,
                        questProgress: snapshot.questProgressByCategory,
                    })
            } catch {
                available = false
            }
            if (!available || definition.evaluator === null) continue

            const dependencyDirty = definition.evaluator === "dependency"
                && dirtyDependencies.has(missionId)
            if (!candidates.has(missionId) || dependencyDirty) {
                dirtyDependencies.delete(missionId)
                candidates.set(missionId, computeCandidate(input, definition))
            }
            const authoritativeProgress = candidates.get(missionId) ?? null
            if (authoritativeProgress === null) continue
            if (activeMissions[String(missionId)] === undefined && authoritativeProgress <= 0) continue

            const settlement = settleActiveMissionProgress(
                missionId,
                activeMissions[String(missionId)],
                authoritativeProgress,
                { repository: input.repository, plan: input.plan },
            )
            if (settlement.delta === null) continue

            const currentState = activeMissions[String(missionId)]
            const progressChanged = currentState?.progress !== settlement.state.progress
            const stagesChanged = settlement.delta.stages.length > 0
            input.updateMission(missionId, settlement.state.progress)
            for (const stage of [...settlement.delta.stages].sort((left, right) => left.stage - right.stage)) {
                input.updateStage(missionId, stage.stage)
            }
            activeMissions[String(missionId)] = settlement.state
            mergeDelta(deltas, settlement.delta)
            scheduleDependents(
                missionId,
                dependents,
                remaining,
                dirtyDependencies,
                next,
                progressChanged,
                progressChanged || stagesChanged,
            )
        }
        if (next.size === 0) {
            return { deltas: orderedDeltas(deltas), activeMissions }
        }
        if (pass === input.plan.definitions.length) {
            throw new Error("Active Mission reconciliation did not converge.")
        }
        pending = [...next].sort((left, right) => left - right)
    }
    throw new Error("Active Mission reconciliation did not converge.")
}
