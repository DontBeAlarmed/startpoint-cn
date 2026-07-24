import activeMissions from "../../../assets/mission_active.json"
import activeMissionEvents from "../../../assets/mission_active_event.json"

export interface ActiveMissionMasterDefinition {
    readonly missionId: number
    readonly row: readonly unknown[]
}

export interface ActiveMissionEventMasterDefinition {
    readonly eventId: number
    readonly row: readonly unknown[]
}

function buildDefinitions<T extends { readonly row: readonly unknown[] }>(
    table: Record<string, unknown>,
    create: (id: number, row: readonly unknown[]) => T,
): readonly T[] {
    return Object.entries(table).flatMap(([rawId, rawRows]) => {
        const id = Number(rawId)
        if (!Number.isSafeInteger(id)
            || id <= 0
            || String(id) !== rawId
            || !Array.isArray(rawRows)
            || !Array.isArray(rawRows[0])) return []
        return [create(id, rawRows[0])]
    })
}

const missionDefinitions = buildDefinitions(
    activeMissions as Record<string, unknown>,
    (missionId, row): ActiveMissionMasterDefinition => ({ missionId, row }),
)
const eventDefinitions = buildDefinitions(
    activeMissionEvents as Record<string, unknown>,
    (eventId, row): ActiveMissionEventMasterDefinition => ({ eventId, row }),
)

const missionById = new Map(missionDefinitions.map(definition => [definition.missionId, definition]))
const eventById = new Map(eventDefinitions.map(definition => [definition.eventId, definition]))

export function getActiveMissionMasterDefinitions(): readonly ActiveMissionMasterDefinition[] {
    return missionDefinitions
}

export function getActiveMissionMasterDefinition(
    missionId: number,
): ActiveMissionMasterDefinition | undefined {
    return missionById.get(missionId)
}

export function getActiveMissionEventMasterDefinitions(): readonly ActiveMissionEventMasterDefinition[] {
    return eventDefinitions
}

export function getActiveMissionEventMasterDefinition(
    eventId: number,
): ActiveMissionEventMasterDefinition | undefined {
    return eventById.get(eventId)
}
