import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import {
    getActiveMissionPlan,
    getActiveMissionPlanRewardStages,
    type ActiveMissionReward,
    type PlannedActiveMissionRewardStage,
} from "./active-plan"
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

function getActiveRewardStage(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): PlannedActiveMissionRewardStage | undefined {
    return getActiveMissionPlanRewardStages(getActiveMissionPlan(repository), missionId)
        .find(definition => definition.stage === stage)
}

function cloneActiveReward(reward: ActiveMissionReward): ActiveMissionReward {
    return { ...reward }
}

export function getActiveMissionRewards(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] {
    return getActiveRewardStage(missionId, stage, repository)?.rewards.map(cloneActiveReward) ?? []
}

export function getMissionRewardStageDefinition(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): MissionRewardStageDefinition | null {
    const definition = getActiveRewardStage(missionId, stage, repository)
    if (!definition) return null
    return {
        targetProgress: definition.targetProgress,
        targetClearSeconds: definition.targetClearSeconds,
        rewards: definition.rewards.map(cloneActiveReward),
    }
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

function getStandardMissionRewards(
    category: number,
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] {
    return cloneRewards(getMissionCatalog(repository).getRewardStage(category, missionId, stage))
}

export const getRegularMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] => getStandardMissionRewards(1, missionId, stage, repository)

export const getDailyMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] => getStandardMissionRewards(2, missionId, stage, repository)

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
        rewards: definition.rewards.map(cloneReward),
    }
}

export function getAwakeMissionRewards(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] {
    return getAwakeMissionRewardStageDefinition(missionId, stage, repository)?.rewards ?? []
}

export function getEventMissionRewards(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] {
    return getStandardMissionRewards(3, missionId, stage, repository)
}

export const getCollectMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] => getStandardMissionRewards(4, missionId, stage, repository)

export const getDegreeMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] => getStandardMissionRewards(5, missionId, stage, repository)

export const getWeeklyMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] => getStandardMissionRewards(10, missionId, stage, repository)

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
        rewards: definition.rewards.map(cloneReward),
    }
}
