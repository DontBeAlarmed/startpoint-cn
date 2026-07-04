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
    eventId?: number
}

export type MissionProgressEvent = BattleFinishMissionEvent

export function summarizeBattleStatistics(raw: any): BattleStatisticsSummary {
    const zones = Array.isArray(raw?.zones) ? raw.zones : []
    let dashCount = 0
    let powerFlipCount = 0
    for (const zone of zones) {
        dashCount += Number(zone?.use_dash_count ?? 0)
        powerFlipCount += Number(zone?.use_power_flip_count ?? 0)
    }
    return {
        dashCount,
        powerFlipCount,
        skillCount: Number(raw?.use_skill_count ?? raw?.skill_count ?? 0),
        maxComboCount: Number(raw?.max_combo_count ?? 0),
        clearPhase: raw?.clear_phase === undefined ? undefined : Number(raw.clear_phase),
    }
}

export function collectPartyCharacterIds(party: any): { partyCharacterIds: number[]; leaderCharacterId?: number; unisonCharacterIds: number[] } {
    const characters = Array.isArray(party?.characters) ? party.characters : []
    const unisons = Array.isArray(party?.unison_characters) ? party.unison_characters : []
    const partyCharacterIds = characters.map((c: any) => Number(c?.id ?? 0)).filter((id: number) => id > 0)
    const unisonCharacterIds = unisons.map((c: any) => Number(c?.id ?? 0)).filter((id: number) => id > 0)
    const leaderCharacterId = partyCharacterIds[0]
    return { partyCharacterIds, leaderCharacterId, unisonCharacterIds }
}
