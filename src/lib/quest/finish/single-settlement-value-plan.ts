import type { Player } from "../../../data/types"
import { getServerTime } from "../../../utils"
import { getRewardCampaignRates } from "../../reward-campaign"
import type { BattleQuest } from "../../types"
import type { ActiveQuest } from "../active-quest-service"
import type { ValidatedSingleFinishBody } from "../single-finish-validation"
import {
    createBattleSettlementValuePlan,
    type BattleSettlementValuePlan,
} from "./battle-settlement-values"

export function createSingleSettlementValuePlan(input: {
    readonly player: Player
    readonly activeQuest: ActiveQuest
    readonly quest: BattleQuest
    readonly body: ValidatedSingleFinishBody
}): { readonly settlementTime: Date; readonly valuePlan: BattleSettlementValuePlan } {
    const settlementTime = new Date(getServerTime() * 1000)
    const rewardCampaignRates = getRewardCampaignRates(
        input.body.category,
        input.body.quest_id,
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
        useBoostPoint: input.activeQuest.useBoostPoint,
        useBossBoostPoint: input.activeQuest.useBossBoostPoint,
        fieldMana: input.body.add_mana,
        maxComboCount: input.body.statistics.max_combo_count ?? 0,
        rewardCampaignRates,
    })
    return Object.freeze({ settlementTime, valuePlan })
}
