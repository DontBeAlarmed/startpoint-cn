import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import {
    getActiveMissionPlan,
    getActiveMissionPlanEventRow,
    getActiveMissionPlanEventRows,
    getActiveMissionPlanMissionRows,
} from "./active-plan"

export interface ActiveMissionMasterDefinition {
    readonly missionId: number
    readonly row: readonly unknown[]
}

export interface ActiveMissionEventMasterDefinition {
    readonly eventId: number
    readonly row: readonly unknown[]
}

function projectMissionDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionMasterDefinition[] {
    return getActiveMissionPlanMissionRows(getActiveMissionPlan(repository))
}

function projectEventDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionEventMasterDefinition[] {
    const plan = getActiveMissionPlan(repository)
    return getActiveMissionPlanEventRows(plan)
}

export function getActiveMissionMasterDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionMasterDefinition[] {
    return projectMissionDefinitions(repository)
}

export function getActiveMissionMasterDefinition(
    missionId: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionMasterDefinition | undefined {
    const definition = getActiveMissionPlan(repository).getMission(missionId)
    return definition ? { missionId: definition.missionId, row: definition.row } : undefined
}

export function getActiveMissionEventMasterDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionEventMasterDefinition[] {
    // Event rows are kept as a compatibility surface; the parsed event is the plan authority.
    return projectEventDefinitions(repository)
}

export function getActiveMissionEventMasterDefinition(
    eventId: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionEventMasterDefinition | undefined {
    const plan = getActiveMissionPlan(repository)
    if (!plan.getEvent(eventId)) return undefined
    const row = getActiveMissionPlanEventRow(plan, eventId)
    return row ? { eventId, row } : undefined
}
