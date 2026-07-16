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

function indexPatterns(defs: Record<string, any>, category: number) {
    for (const [missionId, rows] of Object.entries(defs)) {
        const row = (rows as any[])[0]
        if (!row || !Array.isArray(row)) continue
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

export function isComputablePattern(pattern: string): boolean {
    if (!pattern) return false
    if (pattern.startsWith('single_battle_play') || pattern.startsWith('single_battle_clear_count')) return true
    if (pattern.startsWith('used_stamina_count') || pattern.includes('stamina_use')) return true
    return pattern.startsWith('rank_ss') || pattern.startsWith('rank_s') || pattern.startsWith('rank_a') || pattern.startsWith('rank_b')
}
