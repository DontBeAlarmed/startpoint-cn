/**
 * Handles gacha summoning.
 */

import { randomInt } from "crypto";
import { getDefaultGachaSeedCatalog, reserveUniquePlaceholderSeed } from "./gacha-seed-catalog";
import { PlayerBoxGachaDrawnReward } from "../data/types";
import { givePlayerRewardsSync } from "./quest";
import { getCharacterDataSync } from "./assets";
import { BoxGachaBox, BoxGachaDrawResult, BoxGachaIdReward, BoxGachaRewardTier, BoxGachaRewardType, CharacterGacha, CharacterReward, CurrencyReward, EquipmentItemReward, Gacha, GachaDrawResult, GachaMovieType, GachaType, PlayerRewardResult, Reward, RewardPlayerGachaDrawResult, RewardType } from "./types";
import { drawGachaWithMetadataSync } from "./gacha-draw";
import type { GachaDrawMetadata } from "./gacha-draw";
import {
    rewardGachaDrawResultThroughGrantOwnerSync,
    type GachaRewardGrantOptions,
    type PlannedCharacterGachaMovie,
} from "./gacha-reward-grant";
import { rewardPlayerGachaDrawResultLegacySync } from "./gacha-reward-legacy";

export { drawGachaSync, drawGachaWithMetadataSync, selectWeightedIndexByRoll } from "./gacha-draw";
export type { GachaDrawMetadata } from "./gacha-draw";

const gachaSeedCatalog = getDefaultGachaSeedCatalog();

const rankMovieRates = [
    [ // 5*
        80,
        20
    ],
    [ // 4*
        80,
        20
    ],
    [
        100
    ]
]

export interface GachaResult {
    characterId: number,
    movieId: string,
    seed: number,
    entryCount: number
}

export interface SummonResult {
    freeVmoney: number,
    vmoney: number,
    pulls: GachaResult[],
}

export type { PlannedCharacterGachaMovie } from "./gacha-reward-grant"

export function planCharacterGachaMovies(
    gacha: CharacterGacha,
    characterIds: number[],
): PlannedCharacterGachaMovie[] {
    const usedSeeds = new Set<number>()
    return characterIds.map(characterId => {
        const rarity = getCharacterDataSync(characterId)?.rarity || 3
        const rarityIndex = 5 - rarity
        const movieType = randomPoolItem(1, 101, rankMovieRates[rarityIndex])
            ?? GachaMovieType.NORMAL
        const movieId = movieType === GachaMovieType.GUARANTEE
            ? (gacha.guaranteeMovieName || gacha.movieName || "normal")
            : (gacha.movieName || "normal")
        const requiresVerification = movieId !== "rarity_5_guarantee"
        const seed = requiresVerification
            ? gachaSeedCatalog.select(movieId, rarity, usedSeeds)
            : reserveUniquePlaceholderSeed(characterId * 1000, usedSeeds)
        return { characterId, rarity, movieId, seed, requiresVerification }
    })
}

/**
 * Selects a random index from a weighted pool.
 * 
 * @param min The minimum random value to pick.
 * @param max The maximum random value to pick.
 * @param pool The pool to select the random index from.
 * @returns The index that was selected. null if nothing was selected.
 */
export function randomPoolItem(
    min: number,
    max: number,
    pool: number[]
): number | null {
    let roll = randomInt(min, max)

    let offset = 0;
    let index = 0
    for (const rate of pool) {
        if ((rate + offset) >= roll) return index;
        offset += rate;
        index += 1;
    }
    return null;
}

export function rewardPlayerGachaDrawResultSync(
    playerId: number,
    gacha: Gacha,
    gachaDrawResult: number[],
    gachaDrawMetadata?: GachaDrawMetadata[],
    plannedCharacterMovies?: PlannedCharacterGachaMovie[],
    options: GachaRewardGrantOptions = {},
): RewardPlayerGachaDrawResult {
    const characterMoviePlan = gacha.type === GachaType.CHARACTER
        ? plannedCharacterMovies
            ?? planCharacterGachaMovies(gacha as CharacterGacha, gachaDrawResult)
        : undefined
    if (options.ownerGrant !== undefined) {
        return rewardGachaDrawResultThroughGrantOwnerSync(
            playerId,
            gacha,
            gachaDrawResult,
            gachaDrawMetadata,
            characterMoviePlan,
            { ...options, ownerGrant: options.ownerGrant },
        )
    }
    return rewardPlayerGachaDrawResultLegacySync(
        playerId,
        gacha,
        gachaDrawResult,
        gachaDrawMetadata,
        characterMoviePlan,
    )
}

/**
 * Performs box gacha draws.
 * 
 * @param rewards A record, where the key is the reward id and the value is a BoxGachaReward
 * @param drawnRewards The current draws the player has made on the box gacha.
 * @param drawAmount The number of draws to perform.
 */
export function drawBoxGachaSync(
    rewards: BoxGachaBox,
    drawnRewards: PlayerBoxGachaDrawnReward[],
    drawAmount: number, // the number of times to draw
    stopOnFeaturedReward: boolean = false
): BoxGachaDrawResult {
    // build drawn reward map
    const drawnRewardsMap = new Map(drawnRewards.map(reward => [reward.id, reward.number]))

    const rewardsPool: string[] = []
    for (const [rewardId, reward] of Object.entries(rewards)) {
        for (let i = 0; i < (reward.available - (drawnRewardsMap.get(Number(rewardId)) ?? 0)); i++) {
            rewardsPool.push(rewardId)
        }
    }

    let drawnMana = 0
    let drawnExp = 0
    const drawnCharacters: Map<number, number> = new Map()
    const drawnEquipment: Map<number, number> = new Map()
    const drawnItems: Map<number, number> = new Map()
    const sessionDrawnRewards: Map<string, number> = new Map()

    let totalDraws = 0

    for (let n = 0; n < drawAmount && rewardsPool.length > 0; n++) {
        const rollIndex = randomInt(rewardsPool.length)
        const rewardId = rewardsPool[rollIndex]
        const reward = rewards[rewardId]

        switch (reward.type) {
            case BoxGachaRewardType.ITEM: {
                const itemId = (reward as BoxGachaIdReward).id
                drawnItems.set(itemId, (drawnItems.get(itemId) ?? 0) + reward.count)
                break;
            }
            case BoxGachaRewardType.EQUIPMENT: {
                const equipmentId = (reward as BoxGachaIdReward).id
                drawnEquipment.set(equipmentId, (drawnEquipment.get(equipmentId) ?? 0) + reward.count)
                break;
            }
            case BoxGachaRewardType.MANA: {
                drawnMana += reward.count
                break;
            }
            case BoxGachaRewardType.EXP: {
                drawnExp += reward.count
                break;
            }
            case BoxGachaRewardType.CHARACTER: {
                const characterId = (reward as BoxGachaIdReward).id
                drawnCharacters.set(characterId, (drawnCharacters.get(characterId) ?? 0) + reward.count)
                break;
            }
        }
        
        sessionDrawnRewards.set(rewardId, (sessionDrawnRewards.get(rewardId) ?? 0) + 1)
        rewardsPool.splice(rollIndex, 1)
        totalDraws += 1

        // break if the reward was featured & stop of featured is enabled
        if (reward.tier == BoxGachaRewardTier.FEATURED && stopOnFeaturedReward) break;
    }

    // return the draw result
    const returnSessionDrawnRewards: PlayerBoxGachaDrawnReward[] = []

    sessionDrawnRewards.forEach((value, rewardId) => {
        returnSessionDrawnRewards.push({
            id: Number(rewardId),
            number: value
        })
    })

    return {
        mana: drawnMana,
        exp: drawnExp,
        characters: drawnCharacters,
        equipment: drawnEquipment,
        items: drawnItems,
        rewards: returnSessionDrawnRewards
    }
}

/**
 * Rewards a player with the results of a box gacha draw.
 * 
 * @param playerId The ID of the player.
 * @param drawResult The box gacha draw result.
 * @returns A PlayerRewardResult.
 */
export function rewardPlayerBoxGachaResultSync(
    playerId: number,
    drawResult: BoxGachaDrawResult
): PlayerRewardResult | null {
    const rewards: Reward[] = []

    // convert draw results into rewards

    // items
    for (const [itemId, number] of drawResult.items) {
        rewards.push({
            name: '',
            type: RewardType.ITEM,
            id: itemId,
            count: number
        } as EquipmentItemReward)
    }

    // equipment
    for (const [equipmentId, number] of drawResult.equipment) {
        rewards.push({
            name: '',
            type: RewardType.EQUIPMENT,
            id: equipmentId,
            count: number
        } as EquipmentItemReward)
    }

    // characters
    for (const [characterId, number] of drawResult.characters) {
        for (let i = 0; i < number; i++) {
            rewards.push({
                name: '',
                type: RewardType.CHARACTER,
                id: characterId,
            } as CharacterReward)
        }
    }

    // mana & exp
    rewards.push({
        name: '',
        type: RewardType.EXP,
        count: drawResult.exp,
    } as CurrencyReward)
    rewards.push({
        name: '',
        type: RewardType.MANA,
        count: drawResult.mana,
    } as CurrencyReward)

    return givePlayerRewardsSync(playerId, rewards)
}
