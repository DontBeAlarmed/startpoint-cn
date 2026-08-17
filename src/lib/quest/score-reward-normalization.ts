import type { RewardGrantReward } from "../reward-grant"
import {
    RewardType,
} from "../types"

export type ScoreRewardContextualItemResolver = (
    kind: "element" | "aether",
    rarity: number,
    questElement?: number,
) => number

export type ScoreRewardNormalizationField =
    | "reward"
    | "type"
    | "name"
    | "id"
    | "count"
    | "rarity"
    | "position"

export class ScoreRewardNormalizationError extends Error {
    constructor(
        public readonly groupId: number,
        public readonly index: number,
        public readonly field: ScoreRewardNormalizationField,
    ) {
        super(`Invalid Rare Score reward group=${groupId} index=${index}: ${field}`)
        this.name = "ScoreRewardNormalizationError"
    }
}

export interface NormalizedRareScoreRewardBase {
    readonly name?: string
    readonly rarity: number
    readonly position?: number
}

export type NormalizedRareScoreReward = NormalizedRareScoreRewardBase & (
    | {
        readonly type: RewardType.CHARACTER
        readonly id: number
    }
    | {
        readonly type: RewardType.ITEM
            | RewardType.EQUIPMENT
            | RewardType.ELEMENT
            | RewardType.AETHER
        readonly id: number
        readonly count: number
    }
    | {
        readonly type: RewardType.BEADS | RewardType.MANA | RewardType.EXP
        readonly count: number
    }
)

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function normalizeRareScoreReward(
    groupId: number,
    value: unknown,
    sourceIndex: number,
): NormalizedRareScoreReward {
    const fallbackIndex = sourceIndex + 1
    if (!isRecord(value)) {
        throw new ScoreRewardNormalizationError(groupId, fallbackIndex, "reward")
    }
    const position = value.position
    if (position !== undefined && !isPositiveSafeInteger(position)) {
        throw new ScoreRewardNormalizationError(groupId, fallbackIndex, "position")
    }
    const index = position ?? fallbackIndex
    const name = value.name
    if (name !== undefined && typeof name !== "string") {
        throw new ScoreRewardNormalizationError(groupId, index, "name")
    }
    const rarity = value.rarity
    if (typeof rarity !== "number" || !Number.isFinite(rarity) || rarity <= 0) {
        throw new ScoreRewardNormalizationError(groupId, index, "rarity")
    }
    const type = value.type
    if (type === RewardType.CHARACTER) {
        if (!isPositiveSafeInteger(value.id)) {
            throw new ScoreRewardNormalizationError(groupId, index, "id")
        }
        return {
            type,
            id: value.id,
            rarity,
            ...(name === undefined ? {} : { name }),
            ...(position === undefined ? {} : { position }),
        }
    }
    if (type === RewardType.ITEM
        || type === RewardType.EQUIPMENT
        || type === RewardType.ELEMENT
        || type === RewardType.AETHER) {
        if (!isPositiveSafeInteger(value.id)) {
            throw new ScoreRewardNormalizationError(groupId, index, "id")
        }
        if (!isPositiveSafeInteger(value.count)) {
            throw new ScoreRewardNormalizationError(groupId, index, "count")
        }
        return {
            type,
            id: value.id,
            count: value.count,
            rarity,
            ...(name === undefined ? {} : { name }),
            ...(position === undefined ? {} : { position }),
        }
    }
    if (type === RewardType.BEADS || type === RewardType.MANA || type === RewardType.EXP) {
        if (!isPositiveSafeInteger(value.count)) {
            throw new ScoreRewardNormalizationError(groupId, index, "count")
        }
        return {
            type,
            count: value.count,
            rarity,
            ...(name === undefined ? {} : { name }),
            ...(position === undefined ? {} : { position }),
        }
    }
    throw new ScoreRewardNormalizationError(groupId, index, "type")
}

export function normalizeRareScoreRewardGroup(
    groupId: number,
    group: readonly unknown[] | null,
): readonly NormalizedRareScoreReward[] | null {
    if (group === null) return null
    const normalized = group.map((reward, index) => (
        normalizeRareScoreReward(groupId, reward, index)
    ))
    let totalProbability = 0
    for (const [sourceIndex, reward] of normalized.entries()) {
        if (reward.rarity > 1) {
            throw new ScoreRewardNormalizationError(
                groupId,
                reward.position ?? sourceIndex + 1,
                "rarity",
            )
        }
        totalProbability += reward.rarity
    }
    if (totalProbability > 1) {
        throw new ScoreRewardNormalizationError(
            groupId,
            normalized[0]?.position ?? 1,
            "rarity",
        )
    }
    return normalized
}

function rewardName(reward: { readonly name?: string }): { readonly name?: string } {
    return reward.name === undefined ? {} : { name: reward.name }
}

export function normalizeRareReward(
    reward: NormalizedRareScoreReward,
    amount: number,
    questElement: number | undefined,
    resolveContextualItemId: ScoreRewardContextualItemResolver,
): RewardGrantReward {
    const name = rewardName(reward)
    switch (reward.type) {
        case RewardType.CHARACTER:
            return { ...name, type: reward.type, id: reward.id }
        case RewardType.BEADS:
        case RewardType.MANA:
        case RewardType.EXP:
            return { ...name, type: reward.type, count: amount }
        case RewardType.ITEM:
        case RewardType.EQUIPMENT:
            return { ...name, type: reward.type, id: reward.id, count: amount }
        case RewardType.ELEMENT:
        case RewardType.AETHER:
            return {
                ...name,
                type: reward.type,
                id: resolveContextualItemId(
                    reward.type === RewardType.ELEMENT ? "element" : "aether",
                    reward.id,
                    questElement,
                ),
                count: amount,
            }
    }
}
