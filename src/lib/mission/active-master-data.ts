import bundledActiveMissions from "../../../assets/mission_active.json"
import bundledActiveMissionEvents from "../../../assets/mission_active_event.json"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"

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

type ActiveMasterTable = Record<string, unknown>

const missionDefinitionsByTable = new WeakMap<
    ActiveMasterTable,
    readonly ActiveMissionMasterDefinition[]
>()
const eventDefinitionsByTable = new WeakMap<
    ActiveMasterTable,
    readonly ActiveMissionEventMasterDefinition[]
>()

function getMissionTable(repository?: ReadonlyContentRepository): ActiveMasterTable {
    return repository
        ? repository.table<ActiveMasterTable>("mission_active.json")
        : getRuntimeContentTableSync(
            "mission_active.json",
            bundledActiveMissions as ActiveMasterTable,
        )
}

function getEventTable(repository?: ReadonlyContentRepository): ActiveMasterTable {
    return repository
        ? repository.table<ActiveMasterTable>("mission_active_event.json")
        : getRuntimeContentTableSync(
            "mission_active_event.json",
            bundledActiveMissionEvents as ActiveMasterTable,
        )
}

function getMissionDefinitions(
    table: ActiveMasterTable,
): readonly ActiveMissionMasterDefinition[] {
    const cached = missionDefinitionsByTable.get(table)
    if (cached) return cached
    const definitions = buildDefinitions(
        table,
        (missionId, row): ActiveMissionMasterDefinition => ({ missionId, row }),
    )
    missionDefinitionsByTable.set(table, definitions)
    return definitions
}

function getEventDefinitions(
    table: ActiveMasterTable,
): readonly ActiveMissionEventMasterDefinition[] {
    const cached = eventDefinitionsByTable.get(table)
    if (cached) return cached
    const definitions = buildDefinitions(
        table,
        (eventId, row): ActiveMissionEventMasterDefinition => ({ eventId, row }),
    )
    eventDefinitionsByTable.set(table, definitions)
    return definitions
}

export function getActiveMissionMasterDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionMasterDefinition[] {
    return getMissionDefinitions(getMissionTable(repository))
}

export function getActiveMissionMasterDefinition(
    missionId: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionMasterDefinition | undefined {
    return getActiveMissionMasterDefinitions(repository)
        .find(definition => definition.missionId === missionId)
}

export function getActiveMissionEventMasterDefinitions(
    repository?: ReadonlyContentRepository,
): readonly ActiveMissionEventMasterDefinition[] {
    return getEventDefinitions(getEventTable(repository))
}

export function getActiveMissionEventMasterDefinition(
    eventId: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionEventMasterDefinition | undefined {
    return getActiveMissionEventMasterDefinitions(repository)
        .find(definition => definition.eventId === eventId)
}
