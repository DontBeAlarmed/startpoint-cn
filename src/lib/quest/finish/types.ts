// Finish context — pass-through data shared by all finish trackers

import type { Player } from "../../../data/types"
import type { QuestRewardEligibility } from "../first-clear-reward"
import type { BattleQuest } from "../../types"
import type { ScoreAttackBorderTier } from "./score-attack-handler"
import type { ValidatedSingleFinishBody } from "../single-finish-validation"

export interface PartyCharacter {
    id?: number | null
    [key: string]: unknown
}

export interface QuestStatistics {
    clear_phase: number
    party: {
        unison_characters: (PartyCharacter | null)[]
        characters: (PartyCharacter | null)[]
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
            [key: string]: unknown
        } | null)[]
    }[]
    client_checks?: string[]
    max_combo_count?: number
    is_mvp?: boolean | null
    [key: string]: unknown
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

export interface SingleSettlementWritesInput {
    body: ValidatedSingleFinishBody
    questData: BattleQuest & { rankPointReward: number }
    rewardEligibility: QuestRewardEligibility
    finishCtx: FinishContext
    rushEventFolderMaxRound?: number
    scoreAttackBorderTiers: ScoreAttackBorderTier[]
    dailyResetHour?: number
}
