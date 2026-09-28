import { QuestCategory, Reward, RewardType } from "../lib/types"
import {
    getRescueFragmentContent,
    RESCUE_GOLD_FRAGMENT_ITEM_ID,
    RESCUE_PURPLE_FRAGMENT_ITEM_ID,
    RESCUE_SILVER_FRAGMENT_ITEM_ID,
} from "../lib/rescue-fragment-content"

export function getRescueFragmentReward(category: number, questId: number): Reward | null {
    const itemId = getRescueFragmentContent().getItemId(category, questId)
    return itemId === null ? null : { type: RewardType.ITEM, id: itemId, count: 10 } as Reward
}

export {
    RESCUE_GOLD_FRAGMENT_ITEM_ID,
    RESCUE_PURPLE_FRAGMENT_ITEM_ID,
    RESCUE_SILVER_FRAGMENT_ITEM_ID,
}

export function resolveLocalRescueFragmentEligibility(input: {
    readonly allMultiRoomsEligible: boolean
    readonly isRoomHost: boolean
    readonly hostSelfRescueEnabled: boolean
}): boolean {
    return input.allMultiRoomsEligible
        && (!input.isRoomHost || input.hostSelfRescueEnabled)
}

export function settleRescueFragmentReward<TRewardResult>(
    input: {
        readonly eligible: boolean
        readonly questAccomplished: boolean
        readonly questCategory: number
        readonly questId: number
    },
    grant: (rewards: readonly Reward[]) => TRewardResult,
): TRewardResult | null {
    const eligible = input.eligible && input.questAccomplished
    const reward = eligible
        ? getRescueFragmentReward(input.questCategory, input.questId)
        : null
    return reward === null ? null : grant([reward])
}
