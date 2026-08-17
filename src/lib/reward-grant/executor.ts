import { getDb } from "../../data/db"
import { getPlayerCharacterSync } from "../../data/domains/character"
import { getPlayerItemSync, givePlayerItemSync } from "../../data/domains/item"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { givePlayerCharacterSync } from "../character"
import { givePlayerEquipmentSync } from "../equipment"
import { PlayerRewardResult, RewardType } from "../types/rewards"
import { createRewardGrantPlan } from "./plan"
import {
    RewardGrantEntry,
    RewardGrantEntryResult,
    RewardGrantPlan,
    RewardGrantResult,
    RewardGrantReward,
} from "./types"

export class RewardGrantTransactionRequiredError extends Error {
    constructor() {
        super("Reward grant execution requires an active transaction")
        this.name = "RewardGrantTransactionRequiredError"
    }
}

export class RewardGrantPlayerNotFoundError extends Error {
    readonly playerId: number

    constructor(playerId: number) {
        super(`Reward grant player not found: ${playerId}`)
        this.name = "RewardGrantPlayerNotFoundError"
        this.playerId = playerId
    }
}

export class RewardGrantExecutionError extends Error {
    readonly entryIndex: number
    readonly rewardType: RewardType

    constructor(entryIndex: number, rewardType: RewardType, message: string) {
        super(`Reward grant entry ${entryIndex} failed: ${message}`)
        this.name = "RewardGrantExecutionError"
        this.entryIndex = entryIndex
        this.rewardType = rewardType
    }
}

function normalizeRewardGrantPlan<TSource>(
    plan: RewardGrantPlan<TSource>,
): RewardGrantPlan<TSource> {
    const entries = typeof plan === "object" && plan !== null
        ? (plan as unknown as Record<string, unknown>).entries
        : undefined
    return createRewardGrantPlan(
        entries as readonly RewardGrantEntry<TSource>[],
    )
}

function emptyPlayerRewardResult(): PlayerRewardResult {
    return {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
}

function getExistingPlayer(playerId: number) {
    const player = getPlayerSync(playerId)
    if (player === null) throw new RewardGrantPlayerNotFoundError(playerId)
    return player
}

function grantCurrencySync(
    playerId: number,
    reward: Extract<RewardGrantReward, { type: RewardType.BEADS | RewardType.MANA | RewardType.EXP }>,
): PlayerRewardResult {
    const player = getExistingPlayer(playerId)
    const result = emptyPlayerRewardResult()
    switch (reward.type) {
        case RewardType.BEADS:
            result.user_info.free_vmoney = reward.count
            updatePlayerSync({ id: playerId, freeVmoney: player.freeVmoney + reward.count })
            break
        case RewardType.MANA:
            result.user_info.free_mana = reward.count
            updatePlayerSync({
                id: playerId,
                freeMana: player.freeMana + reward.count,
                totalManaObtained: player.totalManaObtained + reward.count,
            })
            break
        case RewardType.EXP:
            result.user_info.exp_pool = reward.count
            updatePlayerSync({ id: playerId, expPool: player.expPool + reward.count })
            break
    }
    return result
}

function grantEntrySync(
    playerId: number,
    reward: RewardGrantReward,
    entryIndex: number,
): PlayerRewardResult {
    const result = emptyPlayerRewardResult()
    switch (reward.type) {
        case RewardType.ITEM:
        case RewardType.ELEMENT:
        case RewardType.AETHER:
            result.items[reward.id] = givePlayerItemSync(playerId, reward.id, reward.count)
            return result
        case RewardType.EQUIPMENT:
            result.equipment_list.push(
                givePlayerEquipmentSync(playerId, reward.id, reward.count),
            )
            return result
        case RewardType.CHARACTER: {
            const alreadyOwned = getPlayerCharacterSync(playerId, reward.id) !== null
            const granted = givePlayerCharacterSync(playerId, reward.id)
            if (granted === null) {
                throw new RewardGrantExecutionError(
                    entryIndex,
                    reward.type,
                    `unknown character ${reward.id}`,
                )
            }
            result.character_list.push(granted.character)
            if (!alreadyOwned) result.joined_character_id_list.push(reward.id)
            if (granted.item !== undefined) {
                const finalCount = getPlayerItemSync(playerId, granted.item.id)
                if (finalCount === null) {
                    throw new RewardGrantExecutionError(
                        entryIndex,
                        reward.type,
                        `missing compensation item ${granted.item.id}`,
                    )
                }
                result.items[granted.item.id] = finalCount
            }
            return result
        }
        case RewardType.BEADS:
        case RewardType.MANA:
        case RewardType.EXP:
            return grantCurrencySync(playerId, reward)
    }
}

function aggregateEntryResults<TSource>(
    entries: readonly RewardGrantEntryResult<TSource>[],
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

function executeNormalizedRewardGrantPlanSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
): RewardGrantResult<TSource> {
    if (getPlayerSync(playerId) === null) throw new RewardGrantPlayerNotFoundError(playerId)

    const entries = plan.entries.map((entry, entryIndex): RewardGrantEntryResult<TSource> => ({
        source: entry.source,
        reward: entry.reward,
        result: grantEntrySync(playerId, entry.reward, entryIndex),
    }))
    const playerAfter = getExistingPlayer(playerId)
    return {
        aggregate: aggregateEntryResults(entries),
        entries,
        playerAfter: {
            freeMana: playerAfter.freeMana,
            freeVmoney: playerAfter.freeVmoney,
            expPool: playerAfter.expPool,
        },
    }
}

export function executeRewardGrantPlanWithinTransactionSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
): RewardGrantResult<TSource> {
    const db = getDb()
    if (!db.inTransaction) throw new RewardGrantTransactionRequiredError()
    const normalizedPlan = normalizeRewardGrantPlan(plan)
    return db.transaction(() =>
        executeNormalizedRewardGrantPlanSync(playerId, normalizedPlan))()
}

export function executeRewardGrantPlanSync<TSource>(
    playerId: number,
    plan: RewardGrantPlan<TSource>,
): RewardGrantResult<TSource> {
    const normalizedPlan = normalizeRewardGrantPlan(plan)
    return getDb().transaction(() =>
        executeNormalizedRewardGrantPlanSync(playerId, normalizedPlan))()
}
