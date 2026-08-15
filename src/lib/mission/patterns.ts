import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getMissionCatalog, isMissionCatalogCategory } from "./mission-catalog"

export interface PatternMatch {
    missionId: number
    category: number
}

export function getMissionsByPattern(
    pattern: string,
    repository?: ReadonlyContentRepository,
): PatternMatch[] {
    return getMissionCatalog(repository)
        .getDefinitionsByPattern(pattern)
        .map(definition => ({
            missionId: definition.missionId,
            category: definition.category,
        }))
}

export function getMissionPattern(
    category: number,
    missionId: number,
    repository?: ReadonlyContentRepository,
): string {
    if (!isMissionCatalogCategory(category)) return ""
    return getMissionCatalog(repository).getDefinition(category, missionId)?.pattern ?? ""
}

export function getMissionDefinition(
    category: number,
    missionId: number,
    repository?: ReadonlyContentRepository,
): any[] | undefined {
    if (!isMissionCatalogCategory(category)) return undefined
    const definition = getMissionCatalog(repository).getDefinition(category, missionId)
    return definition ? [...definition.row] : undefined
}

export function isMissionEnabledAt(
    category: number,
    missionId: number,
    at: Date,
    eventId?: number,
    repository?: ReadonlyContentRepository,
): boolean {
    if (!isMissionCatalogCategory(category)) return false
    return getMissionCatalog(repository).isEnabledAt(category, missionId, at, eventId)
}

export function isComputablePattern(pattern: string): boolean {
    if (!pattern) return false
    if (pattern.startsWith("single_battle_play") || pattern.startsWith("single_battle_clear_count")) return true
    if (pattern.startsWith("used_stamina_count") || pattern.includes("stamina_use")) return true
    return pattern.startsWith("rank_ss") || pattern.startsWith("rank_s") || pattern.startsWith("rank_a") || pattern.startsWith("rank_b")
}
