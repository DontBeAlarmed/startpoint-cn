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
    zones?: {
        use_power_flip_count?: number
        use_dash_count?: number
        use_skill_count?: number
        send_emotion_count?: number
        encoffinment_count?: number
        skill_point_over_on_start?: number
        damage_deal_total?: number
        members?: ({
            debuff_r?: number
            origin_damage?: number
            conditions?: ({
                max_acc_good?: number
                max_acc_bad?: number
            } | null)[]
            [key: string]: any
        } | null)[]
    }[]
    client_checks?: string[]
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
    score?: number
    manaObtained?: number
    party: QuestStatistics['party']
    statistics: QuestStatistics
    equipmentElements?: readonly number[]
    player: Player
    questPreviouslyCompleted: boolean
    questProgress: { bestElapsedTimeMs?: number | null; highScore?: number; clearRank?: number } | null
    isMulti?: boolean
    isMultiHost?: boolean
}
