import {
    getActiveMissionPlan,
    getActiveMissionPlanEventRow,
    getActiveMissionPlanEventRows,
    getActiveMissionPlanMissionRows,
    type ActiveMissionPlan,
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
    plan: ActiveMissionPlan,
): readonly ActiveMissionMasterDefinition[] {
    return getActiveMissionPlanMissionRows(plan)
}

function projectEventDefinitions(
    plan: ActiveMissionPlan,
): readonly ActiveMissionEventMasterDefinition[] {
    return getActiveMissionPlanEventRows(plan)
}

export function getActiveMissionMasterDefinitions(
    plan?: ActiveMissionPlan,
): readonly ActiveMissionMasterDefinition[] {
    return projectMissionDefinitions(plan ?? getActiveMissionPlan())
}

export function getActiveMissionMasterDefinition(
    missionId: number,
    plan?: ActiveMissionPlan,
): ActiveMissionMasterDefinition | undefined {
    const definition = (plan ?? getActiveMissionPlan()).getMission(missionId)
    return definition ? { missionId: definition.missionId, row: definition.row } : undefined
}

export function getActiveMissionEventMasterDefinitions(
    plan?: ActiveMissionPlan,
): readonly ActiveMissionEventMasterDefinition[] {
    // Event rows are kept as a compatibility surface; the parsed event is the plan authority.
    return projectEventDefinitions(plan ?? getActiveMissionPlan())
}

export function getActiveMissionEventMasterDefinition(
    eventId: number,
    plan?: ActiveMissionPlan,
): ActiveMissionEventMasterDefinition | undefined {
    const resolvedPlan = plan ?? getActiveMissionPlan()
    if (!resolvedPlan.getEvent(eventId)) return undefined
    const row = getActiveMissionPlanEventRow(resolvedPlan, eventId)
    return row ? { eventId, row } : undefined
}
