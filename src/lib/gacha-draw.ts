import { randomInt } from "crypto";
import { Gacha, GachaType } from "./types";

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

export interface GachaDrawMetadata {
    id: number,
    rank: number,
    isGuarantee: boolean
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
