import {
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
    MISSION_CATEGORIES,
    MissionMasterDefinition,
} from "./master-data"

const DEGREE_CLIENT_PROGRESS_PATTERN_BY_SELECTOR: Readonly<Record<string, string>> = Object.freeze({
    "40": "character_detail_zoom_illust_for_1min_count",
    "41": "character_detail_play_dot_sp_motion_count",
    "42": "home_tap_town_character_count",
    "43": "home_change_voice_count",
})

const CLIENT_REPORTED_PATTERNS = new Set([
    ...Object.values(DEGREE_CLIENT_PROGRESS_PATTERN_BY_SELECTOR),
    "twitter_check",
])

export function getDegreeClientProgressPattern(
    definition: MissionMasterDefinition,
): string | undefined {
    if (definition.category !== 5) return undefined
    const selector = definition.row[3]
    if (typeof selector !== "string") return undefined
    return DEGREE_CLIENT_PROGRESS_PATTERN_BY_SELECTOR[selector]
}

export interface ClientProgressTarget {
    category: number
    missionId: number
    eventId?: number
}

function matchesClientPattern(masterPattern: string, clientPattern: string): boolean {
    return masterPattern === clientPattern || masterPattern.startsWith(`${clientPattern}_`)
}

function getClientProgressPattern(definition: MissionMasterDefinition): string {
    return getDegreeClientProgressPattern(definition) ?? definition.pattern
}

export function resolveClientProgressTargetsFromDefinitions(
    clientPattern: string,
    evaluationTime: Date,
    definitions: readonly MissionMasterDefinition[],
): ClientProgressTarget[] {
    if (!CLIENT_REPORTED_PATTERNS.has(clientPattern)) return []

    const targets: ClientProgressTarget[] = []
    for (const definition of definitions) {
        const progressPattern = getClientProgressPattern(definition)
        if (!matchesClientPattern(progressPattern, clientPattern)) continue
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
