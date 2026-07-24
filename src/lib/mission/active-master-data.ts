import activeMissions from "../../../assets/mission_active.json"
import activeMissionEvents from "../../../assets/mission_active_event.json"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"

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

function getMissionTable(repository?: ReadonlyContentRepository): Record<string, unknown> {
    return repository
        ? repository.table<Record<string, unknown>>("mission_active.json")
        : activeMissions as Record<string, unknown>
}

function getEventTable(repository?: ReadonlyContentRepository): Record<string, unknown> {
    return repository
        ? repository.table<Record<string, unknown>>("mission_active_event.json")
        : activeMissionEvents as Record<string, unknown>
}

function buildMissionDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionMasterDefinition[] {
    return buildDefinitions(
        getMissionTable(repository),
        (missionId, row): ActiveMissionMasterDefinition => ({ missionId, row }),
    )
}

function buildEventDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionEventMasterDefinition[] {
    return buildDefinitions(
        getEventTable(repository),
        (eventId, row): ActiveMissionEventMasterDefinition => ({ eventId, row }),
    )
}

const missionDefinitions = buildMissionDefinitions()
const eventDefinitions = buildEventDefinitions()

const missionById = new Map(missionDefinitions.map(definition => [definition.missionId, definition]))
const eventById = new Map(eventDefinitions.map(definition => [definition.eventId, definition]))

export function getActiveMissionMasterDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionMasterDefinition[] {
    return repository ? buildMissionDefinitions(repository) : missionDefinitions
}

export function getActiveMissionMasterDefinition(
    missionId: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionMasterDefinition | undefined {
    return repository
        ? buildMissionDefinitions(repository).find(definition => definition.missionId === missionId)
        : missionById.get(missionId)
}

export function getActiveMissionEventMasterDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionEventMasterDefinition[] {
    return repository ? buildEventDefinitions(repository) : eventDefinitions
}

export function getActiveMissionEventMasterDefinition(
    eventId: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionEventMasterDefinition | undefined {
    return repository
        ? buildEventDefinitions(repository).find(definition => definition.eventId === eventId)
        : eventById.get(eventId)
}
