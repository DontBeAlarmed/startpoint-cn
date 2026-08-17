import { formatQuestScoreRewardsSummary } from "../hot-path-log-formatters"
import type {
    RewardGrantEntry,
} from "../reward-grant"
import type { InternalRewardGrantEntryResult, InternalRewardGrantResult } from "../reward-grant/entry-result"
import { sampledLog } from "../sampled-log"
import { RewardType, type GivePlayerScoreRewardsResult, type PlayerRewardResult } from "../types"
import { projectScoreRewardDropIds } from "./score-reward-projection"
import {
    type ScoreRewardSelection,
    type ScoreRewardSource,
} from "./score-reward-selection"

export function projectScoreRewardSettlementResult(
    selection: ScoreRewardSelection,
    aggregate: PlayerRewardResult,
    entries?: readonly RewardGrantEntry<ScoreRewardSource>[],
): GivePlayerScoreRewardsResult {
    return {
        ...projectScoreRewardDropIds(selection, entries),
        ...aggregate,
    }
}

export function projectGrantedScoreRewardSettlementResult(
    selection: ScoreRewardSelection,
    grant: InternalRewardGrantResult<ScoreRewardSource>,
): GivePlayerScoreRewardsResult {
    return projectScoreRewardSettlementResult(
        selection,
        aggregateScoreRewardEntries(grant.entries),
        grant.entries,
    )
}

function aggregateScoreRewardEntries(
    entries: readonly InternalRewardGrantEntryResult<ScoreRewardSource>[],
): PlayerRewardResult {
    const aggregate: PlayerRewardResult = {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
    for (const entry of entries) {
        const result = entry.result
        aggregate.user_info.free_mana += result.user_info.free_mana
        aggregate.user_info.free_vmoney += result.user_info.free_vmoney
        aggregate.user_info.exp_pool += result.user_info.exp_pool
        aggregate.character_list.push(...result.character_list)
        aggregate.equipment_list.push(...result.equipment_list)
        Object.assign(
            aggregate.items,
            entry.reward.type === RewardType.CHARACTER
                ? entry.itemDeltas ?? {}
                : result.items,
        )
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
