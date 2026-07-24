// ─── Active mission ID filter (C8601 prevention) ────────────────────────

import { getActiveMissionMasterDefinitions } from "./active-master-data"

const activeMissionIdSet: Set<number> = new Set(
    getActiveMissionMasterDefinitions().map(definition => definition.missionId)
)

export function isActiveMissionId(id: number | string): boolean {
    return activeMissionIdSet.has(Number(id))
}

export function filterToActiveMissions<T>(missions: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(missions)) {
        if (activeMissionIdSet.has(Number(id))) out[id] = value
    }
    return out
}
