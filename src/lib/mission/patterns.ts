// Pattern → mission_id reverse index (for update_mission_progress)

import {
    getMissionMasterDefinition,
    getMissionMasterDefinitions,
    isMissionDefinitionEnabledAt,
    MISSION_CATEGORIES,
} from "./master-data"

export interface PatternMatch {
    missionId: number
    category: number
}

const patternIndex: Record<string, PatternMatch[]> = {}
const missionPatternLookup: Record<string, string> = {}
const missionDefinitionLookup: Record<string, any[]> = {}

function indexPatterns(category: number) {
    for (const definition of getMissionMasterDefinitions(category)) {
        const { missionId, pattern, row } = definition
        missionDefinitionLookup[`${category}_${missionId}`] = [...row]
        if (!patternIndex[pattern]) patternIndex[pattern] = []
        patternIndex[pattern].push({ missionId, category })
        missionPatternLookup[`${category}_${missionId}`] = pattern
    }
}

for (const category of MISSION_CATEGORIES) indexPatterns(category)

export function getMissionsByPattern(pattern: string): PatternMatch[] {
    return patternIndex[pattern] || []
}

export function getMissionPattern(category: number, missionId: number): string {
    return missionPatternLookup[`${category}_${missionId}`] || ''
}

export function getMissionDefinition(category: number, missionId: number): any[] | undefined {
    return missionDefinitionLookup[`${category}_${missionId}`]
}

export function isMissionEnabledAt(
    category: number,
    missionId: number,
    at: Date,
    eventId?: number
): boolean {
    const definition = getMissionMasterDefinition(category, missionId)
    if (!definition) return false
    return isMissionDefinitionEnabledAt(definition, at, eventId)
}

export function isComputablePattern(pattern: string): boolean {
    if (!pattern) return false
    if (pattern.startsWith('single_battle_play') || pattern.startsWith('single_battle_clear_count')) return true
    if (pattern.startsWith('used_stamina_count') || pattern.includes('stamina_use')) return true
    return pattern.startsWith('rank_ss') || pattern.startsWith('rank_s') || pattern.startsWith('rank_a') || pattern.startsWith('rank_b')
}
