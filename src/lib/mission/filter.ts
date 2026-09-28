// ─── Active mission ID filter (C8601 prevention) ────────────────────────

import { getActiveMissionMasterDefinitions } from "./active-master-data"
import { getActiveMissionPlan, type ActiveMissionPlan } from "./active-plan"

const activeMissionIdSetByPlan = new WeakMap<ActiveMissionPlan, ReadonlySet<number>>()

function getActiveMissionIdSet(plan?: ActiveMissionPlan): ReadonlySet<number> {
    const resolvedPlan = plan ?? getActiveMissionPlan()
    const cached = activeMissionIdSetByPlan.get(resolvedPlan)
    if (cached) return cached
    const missionIds = new Set(
        getActiveMissionMasterDefinitions(resolvedPlan).map(definition => definition.missionId),
    )
    activeMissionIdSetByPlan.set(resolvedPlan, missionIds)
    return missionIds
}

export function isActiveMissionId(
    id: number | string,
    plan?: ActiveMissionPlan,
): boolean {
    return getActiveMissionIdSet(plan).has(Number(id))
}

export function filterToActiveMissions<T>(
    missions: Record<string, T>,
    plan?: ActiveMissionPlan,
): Record<string, T> {
    const missionIds = getActiveMissionIdSet(plan)
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(missions)) {
        if (missionIds.has(Number(id))) out[id] = value
    }
    return out
}
