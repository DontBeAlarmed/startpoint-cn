import {
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
    MISSION_CATEGORIES,
    MissionMasterDefinition,
} from "./master-data"

const CLIENT_REPORTED_PATTERNS = new Set([
    "character_detail_zoom_illust_for_1min_count",
    "character_detail_play_dot_sp_motion_count",
    "home_tap_town_character_count",
    "home_change_voice_count",
    "twitter_check",
])

export interface ClientProgressTarget {
    category: number
    missionId: number
    eventId?: number
}

function matchesClientPattern(masterPattern: string, clientPattern: string): boolean {
    return masterPattern === clientPattern || masterPattern.startsWith(`${clientPattern}_`)
}

export function resolveClientProgressTargetsFromDefinitions(
    clientPattern: string,
    evaluationTime: Date,
    definitions: readonly MissionMasterDefinition[],
): ClientProgressTarget[] {
    if (!CLIENT_REPORTED_PATTERNS.has(clientPattern)) return []

    const targets: ClientProgressTarget[] = []
    for (const definition of definitions) {
        if (!matchesClientPattern(definition.pattern, clientPattern)) continue
        if (definition.eventId !== undefined) continue
        if (!isMissionDefinitionEnabledAt(definition, evaluationTime)) continue
        targets.push({ category: definition.category, missionId: definition.missionId })
    }
    return targets
}

export function resolveClientProgressTargets(
    clientPattern: string,
    evaluationTime: Date,
): ClientProgressTarget[] {
    const definitions: MissionMasterDefinition[] = []
    for (const category of MISSION_CATEGORIES) {
        definitions.push(...getMissionMasterDefinitions(category))
    }
    return resolveClientProgressTargetsFromDefinitions(clientPattern, evaluationTime, definitions)
}
