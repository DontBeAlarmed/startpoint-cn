import { randomInt } from "crypto"
import type { GachaDrawMetadata } from "../gacha-draw"
import type { GachaBanner } from "./model"

type Roll = (maximumInclusive: number) => number

function defaultRoll(maximumInclusive: number): number {
    return randomInt(1, maximumInclusive + 1)
}

export function selectCumulativeIndex(
    cumulativeWeights: readonly number[],
    roll: number,
): number | null {
    if (!Number.isSafeInteger(roll) || roll <= 0) return null
    let lower = 0
    let upper = cumulativeWeights.length - 1
    while (lower <= upper) {
        const middle = lower + Math.floor((upper - lower) / 2)
        if (roll <= cumulativeWeights[middle]) upper = middle - 1
        else lower = middle + 1
    }
    return lower < cumulativeWeights.length ? lower : null
}

function cumulative(weights: readonly number[]): number[] {
    let total = 0
    return weights.map(weight => {
        total += weight
        return total
    })
}

export function drawGachaBannerWithMetadata(
    banner: GachaBanner,
    drawAmount: number,
    roll: Roll = defaultRoll,
): GachaDrawMetadata[] {
    if (!Number.isSafeInteger(drawAmount) || drawAmount <= 0) {
        throw new TypeError("Gacha draw amount must be a positive safe integer.")
    }
    const draws: GachaDrawMetadata[] = []
    for (let drawNumber = 0; drawNumber < drawAmount; drawNumber += 1) {
        const isGuarantee = (drawNumber + 1) % 10 === 0
        const rankRates = isGuarantee
            ? banner.definition.rankRates.multiGuarantee
            : banner.definition.rankRates.normal
        const rankCumulative = cumulative(rankRates)
        const rankTotal = rankCumulative.at(-1) ?? 0
        const rankIndex = selectCumulativeIndex(rankCumulative, roll(rankTotal))
        if (rankIndex === null) throw new TypeError("Gacha rank rates are empty.")
        const pool = banner.poolsByRank[String(rankIndex + 1)]
        if (pool === undefined) throw new TypeError("Gacha rank pool is missing.")
        const itemIndex = selectCumulativeIndex(pool.cumulativeWeights, roll(pool.totalWeight))
        if (itemIndex === null) throw new TypeError(`Gacha pool ${pool.oddsId} is empty.`)
        const item = pool.items[itemIndex]
        draws.push({ id: item.id, rank: item.rank, isGuarantee })
    }
    return draws
}
