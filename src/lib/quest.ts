import { GivePlayerScoreRewardsResult, PlayerRewardResult, Reward, ScoreReward } from "./types";
import {
    selectScoreRewardGrantPlan,
    type ScoreRewardSelectionOptions,
} from "./quest/score-reward-selection"
import {
    recordScoreRewardSettlement,
} from "./quest/score-reward-settlement"
import {
    grantLegacyQuestRewardsWithinTransactionSync,
    grantLegacyQuestScoreRewardsWithinTransactionSync,
} from "./quest/legacy-quest-reward-grant"

/**
 * Grants a player score rewards.
 * 
 * @param playerId The ID of the player.
 * @param groupId The ID of the score reward group.
 * @param scoreRewards The score rewards inside of the group.
 * @returns A result detailing what was added/changed.
 */
export function givePlayerScoreRewardsSync(
    playerId: number,
    groupId?: number,
    scoreRewards?: ScoreReward[],
    boostPointUsed: boolean = false,
    questElement?: number,
    lottery?: ScoreRewardSelectionOptions,
): GivePlayerScoreRewardsResult {
    const selection = selectScoreRewardGrantPlan(
        groupId,
        scoreRewards,
        boostPointUsed,
        questElement,
        lottery,
    )
    const result = grantLegacyQuestScoreRewardsWithinTransactionSync(playerId, selection)
    recordScoreRewardSettlement(playerId, selection, result)
    return result
}

/**
 * Batch gives a specific player data an array of rewards.
 * 
 * @param playerId The ID of the player to reward.
 * @param rewards The array of rewards to give.
 * @returns A PlayerRewardResult.
 */
export function givePlayerRewardsSync(
    playerId: number,
    rewards: Reward[]
): PlayerRewardResult | null {
    return grantLegacyQuestRewardsWithinTransactionSync(playerId, rewards)
}

/**
 * Gives a player a specific reward.
 * 
 * @param playerId The ID of the player.
 * @param reward The reward to give.
 * @returns A PlayerRewardResult.
 */
export function givePlayerRewardSync(
    playerId: number,
    reward: Reward
): PlayerRewardResult | null {
    return givePlayerRewardsSync(playerId, [reward])
}
