export interface BattleStatisticsSummary {
    dashCount: number
    powerFlipCount: number
    skillCount: number
    maxComboCount: number
    clearPhase?: number
}

export interface BattleFinishMissionEvent {
    type: "battle_finish"
    playerId: number
    questCategory: number
    questId: number
    accomplished: boolean
    mode: "single" | "multi"
    role?: "host" | "guest"
    clearRank?: number | null
    clearTimeMs: number
    partyCharacterIds: number[]
    leaderCharacterId?: number
    unisonCharacterIds: number[]
    statistics: BattleStatisticsSummary
}

export type MissionProgressEvent = BattleFinishMissionEvent

function parseNonNegativeStat(value: any): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function parseOptionalNonNegativeStat(value: any): number | undefined {
    if (value === undefined || value === null) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function parsePositiveId(value: any): number | undefined {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function summarizeBattleStatistics(raw: any): BattleStatisticsSummary {
    const zones = Array.isArray(raw?.zones) ? raw.zones : []
    let dashCount = 0
    let powerFlipCount = 0
    let zoneSkillCount = 0
    let hasZoneSkillCount = false
    for (const zone of zones) {
        dashCount += parseNonNegativeStat(zone?.use_dash_count)
        powerFlipCount += parseNonNegativeStat(zone?.use_power_flip_count)
        if (zone?.use_skill_count !== undefined && zone?.use_skill_count !== null) {
            zoneSkillCount += parseNonNegativeStat(zone.use_skill_count)
            hasZoneSkillCount = true
        }
    }
    return {
        dashCount,
        powerFlipCount,
        skillCount: hasZoneSkillCount ? zoneSkillCount : parseNonNegativeStat(raw?.use_skill_count ?? raw?.skill_count),
        maxComboCount: parseNonNegativeStat(raw?.max_combo_count),
        clearPhase: parseOptionalNonNegativeStat(raw?.clear_phase),
    }
}

export function collectPartyCharacterIds(party: any): { partyCharacterIds: number[]; leaderCharacterId?: number; unisonCharacterIds: number[] } {
    const characters = Array.isArray(party?.characters) ? party.characters : []
    const unisons = Array.isArray(party?.unison_characters) ? party.unison_characters : []
    const partyCharacterIds = characters.map((c: any) => parsePositiveId(c?.id)).filter((id: number | undefined): id is number => id !== undefined)
    const unisonCharacterIds = unisons.map((c: any) => parsePositiveId(c?.id)).filter((id: number | undefined): id is number => id !== undefined)
    const leaderCharacterId = parsePositiveId(characters[0]?.id)
    return { partyCharacterIds, leaderCharacterId, unisonCharacterIds }
}
