import {
    calculateCharacterBattleExp,
    calculateFixedQuestMana,
    calculateFixedQuestPoolExp,
    type RewardCampaignRates,
} from "../../reward-campaign"
import { getRankDegree } from "../../stamina"

export interface BattleSettlementValuePlayer {
    readonly freeMana: number
    readonly expPool: number
    readonly rankPoint: number
    readonly boostPoint: number
    readonly bossBoostPoint: number
    readonly totalManaObtained: number
    readonly maxComboAchieved: number
}

export interface BattleSettlementValueQuest {
    readonly rankPointReward: number
    readonly characterExpReward: number
    readonly manaReward: number
    readonly poolExpReward: number
}

export interface BattleSettlementValuePlanInput {
    readonly player: BattleSettlementValuePlayer
    readonly quest: BattleSettlementValueQuest
    readonly questAccomplished: boolean
    readonly useBoostPoint: boolean
    readonly useBossBoostPoint: boolean
    readonly fieldMana: number
    readonly maxComboCount: number
    readonly rewardCampaignRates: RewardCampaignRates
}

export interface BattleSettlementPlayerValues {
    readonly freeMana: number
    readonly expPool: number
    readonly rankPoint: number
    readonly boostPoint: number
    readonly bossBoostPoint: number
    readonly totalManaObtained: number
    readonly maxComboAchieved: number
}

export interface BattleSettlementValuePlan {
    readonly useBoostPoint: boolean
    readonly rewardCampaignRates: RewardCampaignRates
    readonly fixedManaReward: number
    readonly fixedPoolExpReward: number
    readonly characterBattleExp: number
    readonly fieldMana: number
    readonly manaObtained: number
    readonly beforeRankPoint: number
    readonly newRankPoint: number
    readonly oldDegreeId: number
    readonly newDegreeId: number
    readonly didLevelUp: boolean
    readonly playerValues: BattleSettlementPlayerValues
}

/**
 * Computes the values shared by Single and Multi finish adapters.
 * The caller remains the lifecycle/transaction owner and supplies validated facts.
 *
 * A failed settlement keeps every success-only contribution at zero: fixed and
 * field Mana, the fixed EXP pool, character battle EXP and rank points are not
 * published, and the boost points are not consumed. Entry resources are handled
 * by the caller's release path, not by this plan.
 */
export function createBattleSettlementValuePlan(
    input: BattleSettlementValuePlanInput,
): BattleSettlementValuePlan {
    const useBoostPoint = input.useBoostPoint || input.useBossBoostPoint
    const rates = Object.freeze({ ...input.rewardCampaignRates })
    const fixedManaReward = input.questAccomplished
        ? calculateFixedQuestMana(
            input.quest.manaReward,
            rates,
            useBoostPoint,
        )
        : 0
    const fixedPoolExpReward = input.questAccomplished
        ? calculateFixedQuestPoolExp(
            input.quest.poolExpReward,
            rates,
            useBoostPoint,
        )
        : 0
    const characterBattleExp = input.questAccomplished
        ? calculateCharacterBattleExp(
            input.quest.characterExpReward,
            rates,
        )
        : 0
    const fieldMana = input.questAccomplished ? input.fieldMana : 0
    const manaObtained = fixedManaReward + fieldMana
    const beforeRankPoint = input.player.rankPoint
    const newRankPoint = beforeRankPoint
        + (input.questAccomplished ? input.quest.rankPointReward : 0)
    const oldDegreeId = getRankDegree(beforeRankPoint)
    const newDegreeId = getRankDegree(newRankPoint)

    return Object.freeze({
        useBoostPoint,
        rewardCampaignRates: rates,
        fixedManaReward,
        fixedPoolExpReward,
        characterBattleExp,
        fieldMana,
        manaObtained,
        beforeRankPoint,
        newRankPoint,
        oldDegreeId,
        newDegreeId,
        didLevelUp: newDegreeId > oldDegreeId,
        playerValues: Object.freeze({
            freeMana: input.player.freeMana + manaObtained,
            expPool: input.player.expPool + fixedPoolExpReward,
            rankPoint: newRankPoint,
            boostPoint: input.player.boostPoint
                - (input.questAccomplished && input.useBoostPoint ? 1 : 0),
            bossBoostPoint: input.player.bossBoostPoint
                - (input.questAccomplished && input.useBossBoostPoint ? 1 : 0),
            totalManaObtained: input.player.totalManaObtained + manaObtained,
            maxComboAchieved: Math.max(input.player.maxComboAchieved, input.maxComboCount),
        }),
    })
}
