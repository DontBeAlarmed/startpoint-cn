import { PlayerRewardResult, RewardType } from "../types/rewards"
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

export function emptyPlayerRewardResult(): PlayerRewardResult {
    return {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
}

export function aggregateRewardGrantEntryResults<TSource>(
    entries: readonly InternalRewardGrantEntryResult<TSource>[],
): PlayerRewardResult {
    const aggregate = emptyPlayerRewardResult()
    const characters = new Map<number, Object>()
    const equipment = new Map<number, Object>()
    const joinedCharacterIds = new Set<number>()

    for (const entry of entries) {
        const result = entry.result
        aggregate.user_info.free_mana += result.user_info.free_mana
        aggregate.user_info.free_vmoney += result.user_info.free_vmoney
        aggregate.user_info.exp_pool += result.user_info.exp_pool
        Object.assign(aggregate.items, result.items)

        if (entry.reward.type === RewardType.CHARACTER) {
            for (const character of result.character_list) {
                characters.set(entry.reward.id, character)
            }
        }
        if (entry.reward.type === RewardType.EQUIPMENT) {
            for (const item of result.equipment_list) {
                equipment.set(entry.reward.id, item)
            }
        }
        for (const characterId of result.joined_character_id_list) {
            joinedCharacterIds.add(characterId)
        }
    }

    aggregate.character_list = [...characters.values()]
    aggregate.equipment_list = [...equipment.values()]
    aggregate.joined_character_id_list = [...joinedCharacterIds]
    return aggregate
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
