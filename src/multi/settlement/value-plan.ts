import type { Player } from "../../data/types"
import type { ActiveQuest } from "../../lib/quest/active-quest-service"
import {
    createBattleSettlementValuePlan,
    type BattleSettlementValuePlan,
} from "../../lib/quest/finish/battle-settlement-values"
import { getRewardCampaignRates } from "../../lib/reward-campaign"
import type { BattleQuest } from "../../lib/types"
import { getServerTime } from "../../utils"

export function createMultiSettlementValuePlan(input: {
    readonly player: Player
    readonly activeQuest: ActiveQuest
    readonly quest: BattleQuest
    readonly questCategory: number
    readonly questId: number
    readonly questAccomplished: boolean
    readonly fieldMana: number
    readonly maxComboCount: number
}): { readonly settlementTime: Date; readonly valuePlan: BattleSettlementValuePlan } {
    const settlementTime = new Date(getServerTime() * 1000)
    const rewardCampaignRates = getRewardCampaignRates(
        input.questCategory,
        input.questId,
        settlementTime,
    )
    const valuePlan = createBattleSettlementValuePlan({
        player: {
            freeMana: input.player.freeMana,
            expPool: input.player.expPool,
            rankPoint: input.player.rankPoint,
            boostPoint: input.player.boostPoint,
            bossBoostPoint: input.player.bossBoostPoint,
            totalManaObtained: input.player.totalManaObtained ?? 0,
            maxComboAchieved: input.player.maxComboAchieved ?? 0,
        },
        quest: input.quest,
        questAccomplished: input.questAccomplished,
        useBoostPoint: input.activeQuest.useBoostPoint,
        useBossBoostPoint: input.activeQuest.useBossBoostPoint,
        fieldMana: input.fieldMana,
        maxComboCount: input.maxComboCount,
        rewardCampaignRates,
    })
    return Object.freeze({ settlementTime, valuePlan })
}
