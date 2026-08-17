import type { PlayerRewardResult } from "../types/rewards"
import type {
    RewardGrantEntry,
    RewardGrantPlayerAfter,
    RewardGrantResult,
} from "./types"

export interface RewardGrantEntryExecution {
    readonly result: PlayerRewardResult
    readonly itemDeltas?: Readonly<Record<string, number>>
}

export interface InternalRewardGrantEntryResult<TSource> extends RewardGrantEntry<TSource> {
    readonly result: PlayerRewardResult
    readonly itemDeltas?: Readonly<Record<string, number>>
}

export interface InternalRewardGrantResult<TSource> {
    readonly aggregate: PlayerRewardResult
    readonly entries: readonly InternalRewardGrantEntryResult<TSource>[]
    readonly playerAfter: RewardGrantPlayerAfter
}

export function createRewardGrantEntryResult<TSource>(
    entry: RewardGrantEntry<TSource>,
    execution: RewardGrantEntryExecution,
): InternalRewardGrantEntryResult<TSource> {
    return {
        source: entry.source,
        reward: entry.reward,
        result: execution.result,
        ...(execution.itemDeltas === undefined
            ? {}
            : { itemDeltas: Object.freeze({ ...execution.itemDeltas }) }),
    }
}

export function projectPublicRewardGrantResult<TSource>(
    result: InternalRewardGrantResult<TSource>,
): RewardGrantResult<TSource> {
    return {
        aggregate: result.aggregate,
        entries: result.entries.map(entry => ({
            source: entry.source,
            reward: entry.reward,
            result: entry.result,
        })),
        playerAfter: result.playerAfter,
    }
}
