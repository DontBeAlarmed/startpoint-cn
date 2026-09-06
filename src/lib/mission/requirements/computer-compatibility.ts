import { getMissionCatalog, type MissionMasterDefinition } from "../mission-catalog"

/** Compatibility guard until MissionComputer lookups are migrated to an injected Catalog. */
export function matchesCurrentMissionComputerDefinition(
    definition: MissionMasterDefinition,
): boolean {
    const current = getMissionCatalog().getDefinition(definition.category, definition.missionId)
    return current !== undefined
        && current.pattern === definition.pattern
        && current.eventId === definition.eventId
        && current.patternType === definition.patternType
        && current.enableStart === definition.enableStart
        && current.enableEnd === definition.enableEnd
        && JSON.stringify(current.row) === JSON.stringify(definition.row)
}
