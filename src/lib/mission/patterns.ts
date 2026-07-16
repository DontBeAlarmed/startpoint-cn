// Pattern → mission_id reverse index (for update_mission_progress)

import regularDefs from "../../../assets/mission_regular.json"
import dailyDefs from "../../../assets/mission_daily.json"
import eventDefs from "../../../assets/mission_event.json"
import degreeDefs from "../../../assets/mission_degree.json"
import collectItemDefs from "../../../assets/mission_collect_item.json"
import weeklyDefs from "../../../assets/mission_weekly_def.json"
import charAwakeDefs from "../../../assets/mission_char_awake.json"

export interface PatternMatch {
    missionId: number
    category: number
}

const patternIndex: Record<string, PatternMatch[]> = {}
const missionPatternLookup: Record<string, string> = {}
const missionDefinitionLookup: Record<string, any[]> = {}

const enablePeriodColumns: Record<number, readonly [number, number]> = {
    1: [25, 26],
    2: [25, 26],
    3: [25, 26],
    4: [27, 28],
    5: [26, 27],
    9: [27, 28],
    10: [25, 26],
}

function indexPatterns(defs: Record<string, any>, category: number) {
    for (const [missionId, rows] of Object.entries(defs)) {
        const row = (rows as any[])[0]
        if (!row || !Array.isArray(row)) continue
        missionDefinitionLookup[`${category}_${missionId}`] = row
        const pattern = String(row[0])
        if (!pattern || pattern === '(None)') continue
        if (!patternIndex[pattern]) patternIndex[pattern] = []
        patternIndex[pattern].push({ missionId: parseInt(missionId), category })
        missionPatternLookup[`${category}_${missionId}`] = pattern
    }
}

indexPatterns(regularDefs as any, 1)
indexPatterns(dailyDefs as any, 2)
indexPatterns(eventDefs as any, 3)
indexPatterns(collectItemDefs as any, 4)
indexPatterns(degreeDefs as any, 5)
indexPatterns(weeklyDefs as any, 10)
indexPatterns(charAwakeDefs as any, 9)

export function getMissionsByPattern(pattern: string): PatternMatch[] {
    return patternIndex[pattern] || []
}

export function getMissionPattern(category: number, missionId: number): string {
    return missionPatternLookup[`${category}_${missionId}`] || ''
}

export function getMissionDefinition(category: number, missionId: number): any[] | undefined {
    return missionDefinitionLookup[`${category}_${missionId}`]
}

function parseMasterJstTime(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    return Date.parse(`${String(value).replace(" ", "T")}+09:00`)
}

export function isMissionEnabledAt(
    category: number,
    missionId: number,
    at: Date,
    eventId?: number
): boolean {
    const definition = getMissionDefinition(category, missionId)
    if (!definition) return false

    if (category === 4 && (eventId === undefined || Number(definition[0]) !== eventId)) {
        return false
    }

    const columns = enablePeriodColumns[category]
    if (!columns) return true

    const start = parseMasterJstTime(definition[columns[0]])
    const end = parseMasterJstTime(definition[columns[1]])
    const now = at.getTime()
    if (start !== undefined && (!Number.isFinite(start) || start > now)) return false
    if (end !== undefined && (!Number.isFinite(end) || now > end)) return false
    return true
}

export function isComputablePattern(pattern: string): boolean {
    if (!pattern) return false
    if (pattern.startsWith('single_battle_play') || pattern.startsWith('single_battle_clear_count')) return true
    if (pattern.startsWith('used_stamina_count') || pattern.includes('stamina_use')) return true
    return pattern.startsWith('rank_ss') || pattern.startsWith('rank_s') || pattern.startsWith('rank_a') || pattern.startsWith('rank_b')
}
