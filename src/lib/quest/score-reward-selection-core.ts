import {
    createRewardGrantExecutionPlan,
    rewardGrantFingerprint,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
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

export interface ScoreRewardDropMetadata {
    readonly entryIndex: number
    readonly kind: ScoreRewardSourceKind
    readonly groupId: number
    readonly dropIndex: number
    readonly number: number
    readonly rewardFingerprint: string
}

export interface ScoreRewardSelection {
    readonly groupId?: number
    readonly plan: RewardGrantExecutionPlan
    readonly dropMetadata: readonly ScoreRewardDropMetadata[]
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

function normalizeCommonReward(
    reward: CommonScoreReward,
    amount: number,
    input: ScoreRewardSelectionCoreInput,
    dependencies: ScoreRewardSelectionCoreDependencies,
): RewardGrantCommand {
    switch (reward.reward_type) {
        case RewardType.ITEM:
            return {
                type: reward.reward_type,
                id: dependencies.resolveEventCurrencyId(
                    (reward as ItemScoreReward).id,
                    input.rewardDate,
                ),
                count: amount,
            }
        case RewardType.MANA:
        case RewardType.EXP:
            return { type: reward.reward_type, count: amount }
        case RewardType.ELEMENT:
        case RewardType.AETHER:
            return {
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
    const entries: RewardGrantCommand[] = []
    const dropMetadata: ScoreRewardDropMetadata[] = []
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
        const command = normalizeCommonReward(reward, amount, input, dependencies)
        dropMetadata.push(Object.freeze({
            entryIndex: entries.length,
            kind: "score_common",
            groupId: input.groupId,
            dropIndex: reward.position ?? input.scoreRewards.indexOf(reward) + 1,
            number: amount,
            rewardFingerprint: rewardGrantFingerprint(command),
        }))
        entries.push(command)
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
        const command = normalizeRareReward(
            reward,
            amount,
            {
                questElement: input.questElement,
                rewardDate: input.rewardDate,
                resolveContextualItemId: dependencies.resolveContextualItemId,
                resolveEventCurrencyId: dependencies.resolveEventCurrencyId,
            },
        )
        dropMetadata.push(Object.freeze({
            entryIndex: entries.length,
            kind: "score_rare",
            groupId: selected.groupId,
            dropIndex: selected.index,
            number: amount,
            rewardFingerprint: rewardGrantFingerprint(command),
        }))
        entries.push(command)
    }

    return {
        groupId: input.groupId,
        plan: createRewardGrantExecutionPlan(entries),
        dropMetadata: Object.freeze(dropMetadata),
    }
}
