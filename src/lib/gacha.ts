/**
 * Handles gacha summoning.
 */

import { randomInt } from "crypto";
import seedValidator from "./seed-validator";
import { MOVIE_CONFIGS } from "./gacha-physics";
import { PlayerBoxGachaDrawnReward } from "../data/types";
import { givePlayerCharacterSync } from "./character";
import { givePlayerEquipmentSync } from "./equipment";
import { givePlayerRewardsSync } from "./quest";
import { getCharacterDataSync } from "./assets";
import { BoxGachaBox, BoxGachaDrawResult, BoxGachaIdReward, BoxGachaRewardTier, BoxGachaRewardType, CharacterGacha, CharacterReward, CurrencyReward, EquipmentItemReward, Gacha, GachaCharacterDraw, GachaDrawResult, GachaDraws, GachaMovieSeeds, GachaMovieType, GachaType, PlayerRewardResult, Reward, RewardPlayerGachaDrawResult, RewardType } from "./types";
import { computeEquipmentGachaMovieEffectsForGacha, EquipmentMovieDrawInput } from "./gacha-equipment-movie";

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ASSETS_DIR = join(__dirname, "..", "..", "assets");

/** Load movie-specific seed pool, fall back to default pool. */
function loadMovieSeeds(movieId: string): any {
    const specific = join(ASSETS_DIR, `gacha_movie_seeds_${movieId}.json`);
    if (existsSync(specific)) return JSON.parse(readFileSync(specific, "utf-8"));
    const fallback = join(ASSETS_DIR, "gacha_movie_seeds.json");
    if (existsSync(fallback)) return JSON.parse(readFileSync(fallback, "utf-8"));
    return {};
}

const characterGachaRankRates = {
    normal: [
        50, // 5*
        250, // 4*
        700 // 3*
    ],
    multiGuarantee: [
        50, // 5*
        950 // 4*
    ]
}

const equipmentGachaRankRates = {
    normal: [
        50,  // 5*
        250, // 4*
        700  // 3*
    ],
    multiGuarantee: [
        50, // 5*
        950 // 4*
    ]
}

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

function positiveWeight(weight: number): number {
    return Number.isFinite(weight) && weight > 0 ? weight : 0
}

function totalPositiveWeight(pool: number[]): number {
    return pool.reduce((sum, weight) => sum + positiveWeight(weight), 0)
}

export function selectWeightedIndexByRoll(
    pool: number[],
    roll: number
): number | null {
    const total = totalPositiveWeight(pool)
    if (total <= 0 || roll < 1 || roll > total) return null

    let offset = 0
    for (let index = 0; index < pool.length; index += 1) {
        offset += positiveWeight(pool[index])
        if (roll <= offset) return index
    }
    return null
}

function randomWeightedIndex(pool: number[]): number | null {
    const total = totalPositiveWeight(pool)
    if (total <= 0) return null
    return selectWeightedIndexByRoll(pool, randomInt(1, Math.floor(total) + 1))
}

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

export interface GachaDrawMetadata {
    id: number,
    rank: number,
    isGuarantee: boolean
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

export function drawGachaWithMetadataSync(
    gacha: Gacha,
    drawAmount: number
): GachaDrawMetadata[] {
    const isCharacterGacha = gacha.type === GachaType.CHARACTER
    const fallbackRankRates = isCharacterGacha ? characterGachaRankRates : equipmentGachaRankRates
    const rankRates = gacha.rankRates ?? fallbackRankRates

    const pulls: GachaDrawMetadata[] = []

    for (let drawNumber = 0; drawNumber < drawAmount; drawNumber++) {
        const isGuarantee = ((drawNumber + 1) % 10) === 0
        const drawRankRates = isGuarantee ? rankRates.multiGuarantee : rankRates.normal
        const rankIndex = randomWeightedIndex(drawRankRates) ?? 0
        const ratePool = gacha.pool[String(rankIndex + 1)]
        if (!ratePool || ratePool.length === 0) {
            throw new Error(`gacha pool is empty for rank key ${rankIndex + 1}`)
        }

        // pick item from pool
        const selectedItem = ratePool[randomWeightedIndex(ratePool.map(item => item.odds)) ?? 0]
        pulls.push({
            id: selectedItem.id,
            rank: selectedItem.rank,
            isGuarantee,
        })
    }

    return pulls
}

export function drawGachaSync(
    gacha: Gacha,
    drawAmount: number
): number[] {
    return drawGachaWithMetadataSync(gacha, drawAmount).map((draw) => draw.id)
}

export function rewardPlayerGachaDrawResultSync(
    playerId: number,
    gacha: Gacha,
    gachaDrawResult: number[],
    gachaDrawMetadata?: GachaDrawMetadata[]
): RewardPlayerGachaDrawResult {

    seedValidator.flushAll();  // Clean up stale sentSeeds from previous draws

    const draws: GachaDraws = []
    const characters: Map<number, Object> = new Map()
    const equipment: Map<number, Object> = new Map()
    const items: Map<number, number> = new Map()

    if (gacha.type == GachaType.CHARACTER) {
        const characterGacha = gacha as CharacterGacha
        var drawIndex = 0
        // reward characters (flat array, no grouping)
        for (const characterId of gachaDrawResult) {
            const giveResult = givePlayerCharacterSync(playerId, characterId)
            
            if (giveResult !== null) {
                // Build draw with CN-validated seeds from pre-computed pool
                // Generated by gacha-physics.ts: MersenneTwister + FixedFallingField simulation
                const rarity = getCharacterDataSync(characterId)?.rarity || 3

                // rarityIndex for rankMovieRates: 0=★5, 1=★4, 2=★3
                const rarityIndex = 5 - rarity

                // Select movie type: NORMAL (80%) or GUARANTEE (20%) for ★4/★5, NORMAL only for ★3
                const movieType = randomPoolItem(1, 101, rankMovieRates[rarityIndex])
                    ?? GachaMovieType.NORMAL

                // movieName determines which physics config the CLIENT uses
                const movieId = movieType === GachaMovieType.GUARANTEE
                    ? (characterGacha.guaranteeMovieName || characterGacha.movieName || "normal")
                    : (characterGacha.movieName || "normal")

                // rarity_5_guarantee: isRarity5=true → ball.rarity forced to 2, moviePlayable=false
                // Client skips ALL physics. Seed is irrelevant — use characterId*1000.
                const movieConfig = MOVIE_CONFIGS[movieId];
                if (movieConfig?.threshold?.isRarity5) {
                    const draw: GachaCharacterDraw = {
                        "character_id": characterId,
                        "movie_id": movieId,
                        "seed": characterId * 1000,
                        "entry_count": 1
                    }
                    draws.push(draw)
                    characters.set(characterId, giveResult.character)
                    console.log(`[GACHA] rarity=${rarity}★ seed=${characterId * 1000} movie=${movieId} charId=${characterId} [SKIP]`)
                    continue
                }

                // Load movie-specific seed pool (e.g., gacha_movie_seeds_fes.json)
                // seed pool key: "1"=★5, "2"=★4, "3"=★3
                const seedKey = String(6 - rarity)
                const movieSeeds = loadMovieSeeds(movieId)
                const seedPool: number[] = (movieSeeds as any)[seedKey]?.[String(movieType)] || []
                const fallbackPool: number[] = (movieSeeds as any)[seedKey]?.["0"] || []
                const basePool = seedPool.length > 0 ? seedPool : fallbackPool
                // Inject cross-pool purified seeds (SIM may classify seed in wrong pool)
                    const playSeeds = seedValidator.getPlayForRarity(movieId, rarity)
                    const pool = Array.from(new Set([...playSeeds, ...basePool]))
                // Use seed validator with pool mode support
                const seed = pool.length > 0
                    ? seedValidator.getSeed(movieId, rarity, pool, characterId, drawIndex)
                    : characterId * 1000

                drawIndex += 1

                // Mark seed as TESTING (pending verification)
                seedValidator.markSent(movieId, seed, rarity)

                console.log(`[GACHA] rarity=${rarity}★ seed=${seed} movie=${movieId} charId=${characterId}`)

                const draw: GachaCharacterDraw = {
                    "character_id": characterId,
                    "movie_id": movieId,
                    "seed": seed,
                    "entry_count": 1
                }
                    
                    // set values in items map, characters map, and draws array.
                    const giveItem = giveResult.item
                    if (giveItem !== undefined) {
                        draw['ex_boost_item'] = giveItem // add ex_boost_item to draw
                        items.set(giveItem.id, (items.get(giveItem.id) ?? 0) + giveItem.count)
                    }

                    const existingCharacter = characters.get(characterId)
                    if (existingCharacter) {
                        characters.set(characterId, {...existingCharacter, ...giveResult.character})
                    } else {    
                        characters.set(characterId, giveResult.character)
                    }
                    draws.push(draw)
            }
        }
    } else {
        const equipmentMovieInputs: EquipmentMovieDrawInput[] = gachaDrawResult.map((equipmentId, index) => {
            const metadata = gachaDrawMetadata?.[index]
            return {
                id: equipmentId,
                rank: metadata?.rank ?? 0,
                isGuarantee: metadata?.isGuarantee ?? false,
            }
        })
        const equipmentMovieEffects = computeEquipmentGachaMovieEffectsForGacha(gacha, equipmentMovieInputs)

        for (let index = 0; index < gachaDrawResult.length; index += 1) {
            const equipmentId = gachaDrawResult[index]
            const giveResult = givePlayerEquipmentSync(playerId, equipmentId, 1);

            equipment.set(equipmentId, giveResult)
            draws.push({
                "equipment_id": equipmentId,
                "treasure_up_type": equipmentMovieEffects.draws[index]?.treasureUpType ?? 0
            })
        }

        return {
            draw: draws,
            characters: [],
            equipment: Array.from(equipment.values()),
            items: Object.fromEntries(items),
            isErupt: equipmentMovieEffects.isErupt,
        }
    }
    
    const returnCharacters: Object[] = [];
    for (const value of characters.values()) {
        returnCharacters.push(value)
    }

    const returnEquipment: Object[] = []
    for (const value of equipment.values()) {
        returnEquipment.push(value)
    }
    
    const returnItems: Record<number, number> = {}
    for (const [itemId, amount] of items) {
        returnItems[itemId] = amount
    }

    return {
        draw: draws,
        characters: returnCharacters,
        equipment: returnEquipment,
        items: returnItems
    }
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
