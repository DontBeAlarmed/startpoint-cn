import { PlayerRewardResult, RewardType } from "../types/rewards"

export type RewardGrantReward = Readonly<
    | {
        name?: string
        type: RewardType.ITEM | RewardType.EQUIPMENT | RewardType.ELEMENT | RewardType.AETHER
        id: number
        count: number
    }
    | {
        name?: string
        type: RewardType.CHARACTER
        id: number
    }
    | {
        name?: string
        type: RewardType.BEADS | RewardType.MANA | RewardType.EXP
        count: number
    }
>

export interface RewardGrantEntry<TSource> {
    readonly source: TSource
    readonly reward: RewardGrantReward
}

export interface RewardGrantPlan<TSource> {
    readonly entries: readonly Readonly<RewardGrantEntry<TSource>>[]
}

export interface RewardGrantEntryResult<TSource> extends RewardGrantEntry<TSource> {
    readonly result: PlayerRewardResult
}

export interface RewardGrantPlayerAfter {
    readonly freeMana: number
    readonly freeVmoney: number
    readonly expPool: number
}

export interface RewardGrantResult<TSource> {
    readonly aggregate: PlayerRewardResult
    readonly entries: readonly RewardGrantEntryResult<TSource>[]
    readonly playerAfter: RewardGrantPlayerAfter
}
