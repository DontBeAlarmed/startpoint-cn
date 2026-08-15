import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import {
    getMissionCatalog,
    isMissionCatalogCategory,
    isMissionMasterDefinitionEnabledAt,
    type MissionMasterDefinition,
} from "./mission-catalog"

export type { MissionMasterDefinition } from "./mission-catalog"

export const MISSION_CATEGORIES: readonly number[] = Object.freeze([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
])

function assertSupportedCategory(category: number): void {
    if (!isMissionCatalogCategory(category)) {
        throw new Error(`unsupported mission category: ${category}`)
    }
}

export function getMissionMasterDefinitions(
    category: number,
    repository?: ReadonlyContentRepository,
): readonly MissionMasterDefinition[] {
    assertSupportedCategory(category)
    return getMissionCatalog(repository).getDefinitions(category)
}

export function getMissionMasterDefinition(
    category: number,
    missionId: number,
    repository?: ReadonlyContentRepository,
): MissionMasterDefinition | undefined {
    assertSupportedCategory(category)
    return getMissionCatalog(repository).getDefinition(category, missionId)
}

export function isMissionDefinitionEnabledAt(
    definition: MissionMasterDefinition,
    at: Date,
    eventId?: number,
): boolean {
    return isMissionMasterDefinitionEnabledAt(definition, at, eventId)
}
