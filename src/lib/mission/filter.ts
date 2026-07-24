// ─── Active mission ID filter (C8601 prevention) ────────────────────────

import { getActiveMissionMasterDefinitions } from "./active-master-data"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"

const activeMissionIdSet: Set<number> = new Set(
    getActiveMissionMasterDefinitions().map(definition => definition.missionId)
)

function getActiveMissionIdSet(repository?: ReadonlyContentRepository): ReadonlySet<number> {
    return repository
        ? new Set(getActiveMissionMasterDefinitions(repository).map(definition => definition.missionId))
        : activeMissionIdSet
}

export function isActiveMissionId(
    id: number | string,
    repository?: ReadonlyContentRepository,
): boolean {
    return getActiveMissionIdSet(repository).has(Number(id))
}

export function filterToActiveMissions<T>(
    missions: Record<string, T>,
    repository?: ReadonlyContentRepository,
): Record<string, T> {
    const missionIds = getActiveMissionIdSet(repository)
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(missions)) {
        if (missionIds.has(Number(id))) out[id] = value
    }
    return out
}
