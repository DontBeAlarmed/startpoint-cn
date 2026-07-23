// Finish context — pass-through data shared by all finish trackers

import type { Player } from "../../../data/types"

export interface PartyCharacter {
    id?: number | null
}

export interface QuestStatistics {
    clear_phase: number
    party: {
        unison_characters: (PartyCharacter | null)[]
        characters: PartyCharacter[]
    }
    zones?: { use_power_flip_count?: number; use_dash_count?: number }[]
    max_combo_count?: number
    [key: string]: any
}

export interface FinishContext {
    playerId: number
    questCategory: number
    questId: number
    questAccomplished: boolean
    clearTime: number
    clearRank: number | null
    party: QuestStatistics['party']
    statistics: QuestStatistics
    player: Player
    questPreviouslyCompleted: boolean
    questProgress: { bestElapsedTimeMs?: number | null; highScore?: number; clearRank?: number } | null
    isMulti?: boolean
    isMultiHost?: boolean
}
