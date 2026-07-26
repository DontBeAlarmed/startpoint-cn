export interface FirstClearQuestProgress {
    finished?: boolean | null
    clearRank?: number | null
}

export interface QuestRewardEligibility {
    firstClear: boolean
    sPlus: boolean
}

/** 首通和 S+ 奖励只由本次结算事实与历史进度决定。 */
export function resolveQuestRewardEligibility(params: {
    questAccomplished: boolean
    clearRank: number | null | undefined
    questProgress: FirstClearQuestProgress | null
}): QuestRewardEligibility {
    return {
        firstClear: params.questAccomplished === true && params.questProgress?.finished !== true,
        sPlus: params.questAccomplished === true
            && params.clearRank === 5
            && params.questProgress?.clearRank !== 5,
    }
}
