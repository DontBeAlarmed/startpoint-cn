import {
    createRewardGrantPlan,
    type RewardGrantPlan,
    type RewardGrantReward,
} from "../reward-grant"
import {
    calculateScoreRewardAmount,
    type RewardCampaignRates,
} from "../reward-campaign"
import {
    selectCommonScoreRewards,
    selectRareScoreRewards,
    type UnitRandom,
} from "../score-reward-lottery"
import {
    type CommonScoreReward,
    type ItemScoreReward,
    type ScoreReward,
    ScoreRewardType,
    RewardType,
} from "../types"
import {
    normalizeRareReward,
    normalizeRareScoreRewardGroup,
    type ScoreRewardContextualItemResolver,
} from "./score-reward-normalization"

export { projectScoreRewardDropIds } from "./score-reward-projection"
export type { ScoreRewardDropIds } from "./score-reward-projection"
export {
    ScoreRewardNormalizationError,
} from "./score-reward-normalization"
export type {
    ScoreRewardNormalizationField,
} from "./score-reward-normalization"

export type ScoreRewardSourceKind = "score_common" | "score_rare"

export interface ScoreRewardSource {
    readonly kind: ScoreRewardSourceKind
    readonly groupId: number
    readonly index: number
    readonly number: number
}

export interface ScoreRewardSelection {
    readonly groupId?: number
    readonly plan: RewardGrantPlan<ScoreRewardSource>
}

export interface ScoreRewardSelectionCoreInput {
    readonly groupId: number
    readonly scoreRewards: readonly ScoreReward[]
    readonly boostPointUsed: boolean
    readonly questElement?: number
    readonly commonRewardCount?: number
    readonly random?: UnitRandom
    readonly rewardCampaignRates: RewardCampaignRates
    readonly rewardDate: Date
    readonly dropMultiplier: number
}

export interface ScoreRewardSelectionCoreDependencies {
    readonly getRareScoreRewardGroup: (groupId: number) => readonly unknown[] | null
    readonly resolveEventCurrencyId: (itemId: number, rewardDate: Date) => number
    readonly resolveContextualItemId: ScoreRewardContextualItemResolver
}

function rewardName(reward: { readonly name?: string }): { readonly name?: string } {
    return reward.name === undefined ? {} : { name: reward.name }
}

function normalizeCommonReward(
    reward: CommonScoreReward,
    amount: number,
    input: ScoreRewardSelectionCoreInput,
    dependencies: ScoreRewardSelectionCoreDependencies,
): RewardGrantReward {
    switch (reward.reward_type) {
        case RewardType.ITEM:
            return {
                ...rewardName(reward),
                type: reward.reward_type,
                id: dependencies.resolveEventCurrencyId(
                    (reward as ItemScoreReward).id,
                    input.rewardDate,
                ),
                count: amount,
            }
        case RewardType.MANA:
        case RewardType.EXP:
            return { ...rewardName(reward), type: reward.reward_type, count: amount }
        case RewardType.ELEMENT:
        case RewardType.AETHER:
            return {
                ...rewardName(reward),
                type: reward.reward_type,
                id: dependencies.resolveContextualItemId(
                    reward.reward_type === RewardType.ELEMENT ? "element" : "aether",
                    (reward as ItemScoreReward).id,
                    input.questElement,
                ),
                count: amount,
            }
        default:
            throw new RangeError(`unsupported common score reward type ${reward.reward_type}`)
    }
}

export function selectScoreRewardGrantPlanCore(
    input: ScoreRewardSelectionCoreInput,
    dependencies: ScoreRewardSelectionCoreDependencies,
): ScoreRewardSelection {
    const entries: Array<{
        source: ScoreRewardSource
        reward: RewardGrantReward
    }> = []
    const commonRewards = input.commonRewardCount === undefined
        ? input.scoreRewards.filter((reward): reward is CommonScoreReward => (
            reward.type === ScoreRewardType.ITEM
        ))
        : selectCommonScoreRewards(input.scoreRewards, input.commonRewardCount, input.random)

    for (const reward of commonRewards) {
        const amount = calculateScoreRewardAmount(
            (reward as CommonScoreReward & { readonly count: number }).count,
            reward.reward_type,
            input.rewardCampaignRates,
            input.boostPointUsed,
            input.dropMultiplier,
        )
        entries.push({
            source: Object.freeze({
                kind: "score_common",
                groupId: input.groupId,
                index: reward.position ?? input.scoreRewards.indexOf(reward) + 1,
                number: amount,
            }),
            reward: normalizeCommonReward(reward, amount, input, dependencies),
        })
    }

    const rareRewards = selectRareScoreRewards(
        input.scoreRewards,
        groupId => normalizeRareScoreRewardGroup(
            groupId,
            dependencies.getRareScoreRewardGroup(groupId),
        ),
        input.random,
    )
    for (const selected of rareRewards) {
        const reward = selected.reward
        const amount = reward.type === RewardType.CHARACTER
            ? 1
            : calculateScoreRewardAmount(
                reward.count,
                reward.type,
                input.rewardCampaignRates,
                input.boostPointUsed,
                input.dropMultiplier,
            )
        entries.push({
            source: Object.freeze({
                kind: "score_rare",
                groupId: selected.groupId,
                index: selected.index,
                number: amount,
            }),
            reward: normalizeRareReward(
                reward,
                amount,
                input.questElement,
                dependencies.resolveContextualItemId,
            ),
        })
    }

    return { groupId: input.groupId, plan: createRewardGrantPlan(entries) }
}
