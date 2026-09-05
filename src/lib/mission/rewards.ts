import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import type { ActiveMissionReward } from "./active-plan"
import {
    getMissionCatalog,
    type MissionCatalogReward,
    type MissionCatalogStage,
} from "./mission-catalog"

export type { ActiveMissionReward } from "./active-plan"

export interface MissionRewardStageDefinition {
    targetProgress: number
    targetClearSeconds?: number
    rewards: ActiveMissionReward[]
}

export interface CategoryMissionRewardStageDefinition extends MissionRewardStageDefinition {
    missionRewardId: number
}

export interface AwakeMissionSpecialReward {
    characterId: number
    boardIndex: number
    awakeLevel: number
}

export interface AwakeMissionRewardStageDefinition extends MissionRewardStageDefinition {
    missionRewardId: number
    specialReward?: AwakeMissionSpecialReward
}

function cloneReward(reward: MissionCatalogReward): ActiveMissionReward {
    return {
        kind: reward.kind,
        amount: reward.amount,
        ...(reward.itemId === undefined ? {} : { itemId: reward.itemId }),
        ...(reward.characterId === undefined ? {} : { characterId: reward.characterId }),
        ...(reward.equipmentId === undefined ? {} : { equipmentId: reward.equipmentId }),
        ...(reward.degreeId === undefined ? {} : { degreeId: reward.degreeId }),
    }
}

function cloneRewards(stage: MissionCatalogStage | undefined): ActiveMissionReward[] {
    return stage?.rewards.map(cloneReward) ?? []
}

export function getAwakeMissionRewardStageDefinition(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): AwakeMissionRewardStageDefinition | null {
    const definition = getMissionCatalog(repository).getRewardStage(9, missionId, stage)
    if (!definition) return null
    return {
        missionRewardId: definition.missionRewardId,
        targetProgress: definition.targetProgress,
        ...(definition.targetClearSeconds === undefined
            ? {}
            : { targetClearSeconds: definition.targetClearSeconds }),
        ...(definition.specialReward === undefined ? {} : {
            specialReward: { ...definition.specialReward },
        }),
        rewards: cloneRewards(definition),
    }
}

const CATEGORY_REWARD_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10])

export function getCategoryMissionRewardStageDefinition(
    category: number,
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): CategoryMissionRewardStageDefinition | null {
    if (!CATEGORY_REWARD_IDS.has(category)) return null
    const definition = getMissionCatalog(repository).getRewardStage(category, missionId, stage)
    if (!definition) return null
    return {
        missionRewardId: definition.missionRewardId,
        targetProgress: definition.targetProgress,
        rewards: cloneRewards(definition),
    }
}
