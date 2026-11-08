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
    readonly bellResponded: boolean
}): boolean {
    if (!input.allMultiRoomsEligible) {
        // 官服严格模式(Battle_Boss L57「响应救援请求者」):仅响应救援铃铛
        // 而参战的客机可获得——房主是救援发起方,不适用;响应以 quest/start
        // 携带的 attention_key 判定(resolveBellRecruitmentForStart)。
        return input.bellResponded && !input.isRoomHost
    }
    // 特化模式(单人部署放宽——官服取物路径在单人部署不可创建,开关设计
    // 背景):所有客机均可获得;房主自救由 hostSelfRescueEnabled 单独控制。
    return !input.isRoomHost || input.hostSelfRescueEnabled
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
