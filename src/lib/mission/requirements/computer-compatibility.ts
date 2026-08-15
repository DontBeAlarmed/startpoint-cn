import { getMissionCatalog, type MissionMasterDefinition } from "../mission-catalog"
import { bundledMissionContentRepository } from "../mission-catalog-source"

const computerCatalog = getMissionCatalog(bundledMissionContentRepository)

/** Compatibility guard until MissionComputer lookups are migrated to an injected Catalog. */
export function matchesCurrentMissionComputerDefinition(
    definition: MissionMasterDefinition,
): boolean {
    const current = computerCatalog.getDefinition(definition.category, definition.missionId)
    return current !== undefined
        && current.pattern === definition.pattern
        && current.eventId === definition.eventId
        && current.patternType === definition.patternType
        && current.enableStart === definition.enableStart
        && current.enableEnd === definition.enableEnd
        && JSON.stringify(current.row) === JSON.stringify(definition.row)
}
