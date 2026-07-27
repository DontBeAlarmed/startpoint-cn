import { randomInt } from "crypto"
import {
    CommonScoreReward,
    RareScoreReward,
    RareScoreRewardGroup,
    ScoreReward,
    ScoreRewardType,
} from "./types"

export type UnitRandom = () => number

export interface SelectedRareScoreReward {
    readonly groupId: number
    readonly index: number
    readonly reward: RareScoreReward
}

export interface CommonScoreRewardCountSource {
    readonly commonRewardCount?: number
    readonly commonRewardCounts?: readonly [number, number, number, number, number]
}

const RANDOM_SCALE = 0x1_0000_0000

export function cryptoUnitRandom(): number {
    return randomInt(0, RANDOM_SCALE) / RANDOM_SCALE
}

function checkedRoll(random: UnitRandom): number {
    const roll = random()
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
        throw new RangeError("random value must be in [0, 1)")
    }
    return roll
}

function positiveWeight(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${label} must be positive`)
    }
    return value
}

export function getCommonScoreRewardCount(
    source: CommonScoreRewardCountSource,
    clearRank: number | null,
    multiplayerMultiplier = 1,
): number | null {
    let baseCount: number | undefined
    if (source.commonRewardCount !== undefined) {
        baseCount = source.commonRewardCount
    } else if (clearRank !== null && Number.isSafeInteger(clearRank) && clearRank >= 1 && clearRank <= 5) {
        baseCount = source.commonRewardCounts?.[clearRank - 1]
    }
    if (baseCount === undefined) return null
    if (!Number.isSafeInteger(baseCount) || baseCount < 0) {
        throw new RangeError("common score reward count must be a non-negative integer")
    }
    if (!Number.isFinite(multiplayerMultiplier) || multiplayerMultiplier <= 0) {
        throw new RangeError("multiplayer common reward multiplier must be positive")
    }
    return Math.ceil(baseCount * multiplayerMultiplier)
}

export function selectCommonScoreRewards(
    scoreRewards: readonly ScoreReward[],
    count: number,
    random: UnitRandom = cryptoUnitRandom,
): CommonScoreReward[] {
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError("common score reward count must be a non-negative integer")
    }
    const commonRewards = scoreRewards
        .filter((reward): reward is CommonScoreReward => reward.type === ScoreRewardType.ITEM)
        .map((reward, sourceIndex) => ({ reward, sourceIndex }))
        .sort((left, right) => {
            const weightDifference = positiveWeight(
                (right.reward as CommonScoreReward & { field5: number }).field5,
                "common score reward weight",
            ) - positiveWeight(
                (left.reward as CommonScoreReward & { field5: number }).field5,
                "common score reward weight",
            )
            if (weightDifference !== 0) return weightDifference
            return (left.reward.position ?? left.sourceIndex + 1)
                - (right.reward.position ?? right.sourceIndex + 1)
        })
    if (count === 0 || commonRewards.length === 0) return []

    const totalWeight = commonRewards.reduce(
        (sum, entry) => sum + positiveWeight(
            (entry.reward as CommonScoreReward & { field5: number }).field5,
            "common score reward weight",
        ),
        0,
    )
    const selected: CommonScoreReward[] = []
    for (let draw = 0; draw < count; draw += 1) {
        const target = checkedRoll(random) * totalWeight
        let cumulative = 0
        for (const entry of commonRewards) {
            cumulative += (entry.reward as CommonScoreReward & { field5: number }).field5
            if (target < cumulative) {
                selected.push(entry.reward)
                break
            }
        }
    }
    return selected
}

export function selectRareScoreRewards(
    scoreRewards: readonly ScoreReward[],
    getGroup: (groupId: number) => readonly RareScoreReward[] | null,
    random: UnitRandom = cryptoUnitRandom,
): SelectedRareScoreReward[] {
    const pools = scoreRewards
        .filter((reward): reward is RareScoreRewardGroup => reward.type === ScoreRewardType.RARE_POOL)
        .sort((left, right) => right.rarity - left.rarity || left.id - right.id)
    const selected: SelectedRareScoreReward[] = []

    for (const pool of pools) {
        const dropProbability = positiveWeight(pool.rarity, "rare score reward drop probability")
        if (dropProbability > 1) throw new RangeError("rare score reward drop probability must not exceed 1")
        if (checkedRoll(random) >= dropProbability) continue

        const group = getGroup(pool.id)
        if (group === null || group.length === 0) continue
        const ordered = group
            .map((reward, sourceIndex) => ({
                reward,
                index: reward.position ?? sourceIndex + 1,
            }))
            .sort((left, right) => right.reward.rarity - left.reward.rarity || left.index - right.index)
        const target = checkedRoll(random)
        let cumulative = 0
        let chosen: typeof ordered[number] | undefined
        for (const entry of ordered) {
            cumulative += positiveWeight(entry.reward.rarity, "rare score reward probability")
            if (target < cumulative) {
                chosen = entry
                break
            }
        }
        if (chosen === undefined) {
            throw new RangeError(`rare score reward probabilities do not cover roll for group ${pool.id}`)
        }
        selected.push({ groupId: pool.id, index: chosen.index, reward: chosen.reward })
    }
    return selected
}
