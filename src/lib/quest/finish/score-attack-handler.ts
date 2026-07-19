import type { PlayerQuestProgress } from "../../../data/types"
import type { PlayerRewardResult, Reward } from "../../types"
import { RewardType } from "../../types"

export interface ScoreAttackRewardSlot {
    kind: number
    id?: number
    amount: number
}

export interface ScoreAttackBorderTier {
    id: number
    eventId: number
    questId: number
    score: number
    reasonId: number
    rewards: ScoreAttackRewardSlot[]
}

export interface ScoreAttackRankThresholds {
    bRankScore: number
    aRankScore: number
    sRankScore: number
    ssRankScore: number
}

interface ScoreAttackParty {
    characters: ({ id: number | null } | null)[]
}

interface ScoreAttackFinishInput {
    playerId: number
    questId: number
    category: number
    score: number
    elapsedTimeMs: number
    isAccomplished: boolean
    quest: ScoreAttackRankThresholds
    tiers: ScoreAttackBorderTier[]
    party: ScoreAttackParty
}

interface ScoreAttackFinishDependencies {
    transaction: <T>(operation: () => T) => T
    getProgress: (playerId: number, category: number, questId: number) => PlayerQuestProgress | null
    grantRewards: (playerId: number, rewards: Reward[]) => PlayerRewardResult | null
    giveDegree: (playerId: number, degreeId: number) => boolean
    updateProgress: (
        playerId: number,
        category: number,
        progress: Partial<PlayerQuestProgress> & Pick<PlayerQuestProgress, "questId">,
    ) => void
    insertProgress: (playerId: number, category: number, progress: PlayerQuestProgress) => void
    deleteActiveQuest: (playerId: number) => void
}

export interface ScoreAttackFinishResult {
    clearRank: number
    oldHighScore: number
    rewardResult: PlayerRewardResult
    newDegreeIds: number[]
    scoreAttackEvent: {
        main_character_ids: Record<number, number>
        reward_ids: number[]
    }
}

function emptyRewardResult(): PlayerRewardResult {
    return {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
}

export function calculateScoreAttackClearRank(
    score: number,
    thresholds: ScoreAttackRankThresholds,
): number {
    if (score >= thresholds.ssRankScore) return 5
    if (score >= thresholds.sRankScore) return 4
    if (score >= thresholds.aRankScore) return 3
    if (score >= thresholds.bRankScore) return 2
    return 1
}

export function selectScoreAttackRewardTiers(
    tiers: ScoreAttackBorderTier[],
    oldHighScore: number,
    newScore: number,
): ScoreAttackBorderTier[] {
    if (newScore <= oldHighScore) return []
    return tiers
        .filter(tier => tier.score > oldHighScore && tier.score <= newScore)
        .sort((left, right) => left.score - right.score || left.id - right.id)
}

export function buildScoreAttackMainCharacterIds(
    party: ScoreAttackParty,
): Record<number, number> {
    const result: Record<number, number> = {}
    party.characters.forEach((character, index) => {
        if (character?.id !== null && character?.id !== undefined) result[index] = character.id
    })
    return result
}

function buildGeneralRewards(tiers: ScoreAttackBorderTier[]): {
    rewards: Reward[]
    degreeIds: number[]
} {
    const rewards = new Map<string, Reward & { count?: number }>()
    const characters: Reward[] = []
    const degreeIds = new Set<number>()

    const addCountedReward = (type: RewardType, amount: number, id?: number) => {
        const key = `${type}_${id ?? "currency"}`
        const existing = rewards.get(key)
        if (existing) {
            existing.count = (existing.count ?? 0) + amount
            return
        }
        rewards.set(key, {
            type,
            ...(id !== undefined ? { id } : {}),
            count: amount,
        })
    }

    for (const tier of tiers) {
        for (const slot of tier.rewards) {
            if (!Number.isInteger(slot.amount) || slot.amount <= 0) {
                throw new Error(`Score attack reward ${tier.id} has invalid amount ${slot.amount}`)
            }
            switch (slot.kind) {
                case 0:
                    if (slot.id === undefined) throw new Error(`Score attack reward ${tier.id} item has no id`)
                    addCountedReward(RewardType.ITEM, slot.amount, slot.id)
                    break
                case 1:
                    if (slot.id === undefined) throw new Error(`Score attack reward ${tier.id} equipment has no id`)
                    addCountedReward(RewardType.EQUIPMENT, slot.amount, slot.id)
                    break
                case 2:
                    addCountedReward(RewardType.BEADS, slot.amount)
                    break
                case 3:
                    addCountedReward(RewardType.MANA, slot.amount)
                    break
                case 4:
                    addCountedReward(RewardType.EXP, slot.amount)
                    break
                case 5:
                    throw new Error(`Score attack reward ${tier.id} uses unsupported pass card points`)
                case 6:
                    if (slot.id === undefined) throw new Error(`Score attack reward ${tier.id} character has no id`)
                    for (let count = 0; count < slot.amount; count++) {
                        characters.push({ type: RewardType.CHARACTER, id: slot.id })
                    }
                    break
                case 7:
                    if (slot.id === undefined) throw new Error(`Score attack reward ${tier.id} degree has no id`)
                    degreeIds.add(slot.id)
                    break
                default:
                    throw new Error(`Score attack reward ${tier.id} has unknown kind ${slot.kind}`)
            }
        }
    }

    return { rewards: [...rewards.values(), ...characters], degreeIds: [...degreeIds] }
}

export function handleScoreAttackEventFinish(
    input: ScoreAttackFinishInput,
    dependencies: ScoreAttackFinishDependencies,
): ScoreAttackFinishResult {
    return dependencies.transaction(() => {
        const previousProgress = dependencies.getProgress(input.playerId, input.category, input.questId)
        const oldHighScore = previousProgress?.highScore ?? 0
        const clearRank = calculateScoreAttackClearRank(input.score, input.quest)
        const eligibleTiers = input.isAccomplished
            ? selectScoreAttackRewardTiers(input.tiers, oldHighScore, input.score)
            : []
        const { rewards, degreeIds } = buildGeneralRewards(eligibleTiers)
        const rewardResult = rewards.length > 0
            ? dependencies.grantRewards(input.playerId, rewards)
            : emptyRewardResult()
        if (rewardResult === null) throw new Error(`Player ${input.playerId} does not exist`)

        const newDegreeIds = degreeIds.filter(degreeId => dependencies.giveDegree(input.playerId, degreeId))
        const leaderCharacterId = input.party.characters[0]?.id ?? undefined

        if (input.isAccomplished) {
            const progress: PlayerQuestProgress = {
                questId: input.questId,
                finished: true,
                highScore: Math.max(oldHighScore, input.score),
                clearRank: Math.max(previousProgress?.clearRank ?? 1, clearRank),
                bestElapsedTimeMs: previousProgress?.bestElapsedTimeMs === undefined
                    || previousProgress.bestElapsedTimeMs === null
                    ? input.elapsedTimeMs
                    : Math.min(previousProgress.bestElapsedTimeMs, input.elapsedTimeMs),
                leaderCharacterId,
            }
            if (previousProgress === null) {
                dependencies.insertProgress(input.playerId, input.category, progress)
            } else {
                dependencies.updateProgress(input.playerId, input.category, progress)
            }
        }

        dependencies.deleteActiveQuest(input.playerId)

        return {
            clearRank,
            oldHighScore,
            rewardResult,
            newDegreeIds,
            scoreAttackEvent: {
                main_character_ids: buildScoreAttackMainCharacterIds(input.party),
                reward_ids: eligibleTiers.map(tier => tier.id),
            },
        }
    })
}
