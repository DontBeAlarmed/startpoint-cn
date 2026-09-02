import { formatQuestScoreRewardsSummary } from "../hot-path-log-formatters"
import type { RewardGrantExecutionResult } from "../reward-grant"
import { sampledLog } from "../sampled-log"
import type { GivePlayerScoreRewardsResult, PlayerRewardResult } from "../types"
import { projectScoreRewardDropIds } from "./score-reward-projection"
import {
    type ScoreRewardSelection,
} from "./score-reward-selection"

export function projectScoreRewardSettlementResult(
    selection: ScoreRewardSelection,
    aggregate: PlayerRewardResult,
): GivePlayerScoreRewardsResult {
    return {
        ...projectScoreRewardDropIds(selection),
        ...aggregate,
    }
}

export function projectGrantedScoreRewardSettlementResult(
    selection: ScoreRewardSelection,
    grant: RewardGrantExecutionResult,
): GivePlayerScoreRewardsResult {
    return projectScoreRewardSettlementResult(
        selection,
        aggregateScoreRewardEntries(grant.entries),
    )
}

function aggregateScoreRewardEntries(
    entries: RewardGrantExecutionResult["entries"],
): PlayerRewardResult {
    const aggregate: PlayerRewardResult = {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
    for (const entry of entries) {
        const outcome = entry.outcome
        if (outcome.kind === "currency") {
            const field = outcome.currency === "freeMana"
                ? "free_mana"
                : outcome.currency === "freeVmoney" ? "free_vmoney" : "exp_pool"
            aggregate.user_info[field] += outcome.requestedAmount
        } else if (outcome.kind === "item") {
            aggregate.items[outcome.item.itemId] = outcome.item.afterAmount
        } else if (outcome.kind === "character") {
            aggregate.character_list.push(outcome.after)
            if (outcome.compensationItem !== null) {
                aggregate.items[outcome.compensationItem.itemId]
                    = outcome.compensationItem.acceptedAmount
            }
        } else {
            aggregate.equipment_list.push(outcome.after)
        }
    }
    return aggregate
}

export function recordScoreRewardSettlement(
    playerId: number,
    selection: ScoreRewardSelection,
    result: GivePlayerScoreRewardsResult,
): void {
    const groupId = selection.groupId
    if (groupId === undefined) return
    sampledLog("quest-score-rewards", () => formatQuestScoreRewardsSummary({
        playerId,
        groupId,
        commonDrops: result.drop_score_reward_ids,
        rareDrops: result.drop_rare_reward_ids,
        inventoryTotals: result.items,
    }))
}
