// Active Mission rewards keep their independent table path; standard rewards use MissionCatalog.

import bundledActiveRewards from "../../../assets/mission_active_reward.json"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import {
    getMissionCatalog,
    type MissionCatalogReward,
    type MissionCatalogStage,
} from "./mission-catalog"

export interface ActiveMissionReward {
    kind: number
    amount: number
    itemId?: number
    characterId?: number
    equipmentId?: number
    degreeId?: number
}

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

type RewardTable = Record<string, Record<string, any[]>>

function getRewardRow(
    table: RewardTable,
    missionId: number,
    stage: number,
): any[] | undefined {
    return table[String(missionId)]?.[String(stage)]?.[0]
}

function parseOptionalInteger(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    const parsed = Number.parseInt(String(value))
    return Number.isNaN(parsed) ? undefined : parsed
}

function parseMissionRewardSlots(
    row: any[],
    firstKindIndex: number,
    slotCount = 4,
): ActiveMissionReward[] {
    const result: ActiveMissionReward[] = []
    for (let slot = 0; slot < slotCount; slot++) {
        const base = firstKindIndex + slot * 6
        const kind = parseOptionalInteger(row[base])
        if (kind === undefined) continue

        const amount = parseOptionalInteger(row[base + 1]) ?? 0
        const itemId = parseOptionalInteger(row[base + 2])
        const characterId = parseOptionalInteger(row[base + 3])
        const equipmentId = parseOptionalInteger(row[base + 4])
        const degreeId = parseOptionalInteger(row[base + 5])

        if (amount === 0 && kind !== 6) continue
        if (kind === 1 && itemId === undefined) continue
        if (kind === 2 && equipmentId === undefined) continue
        if (kind === 4 && characterId === undefined) continue
        if (kind === 6 && degreeId === undefined) continue

        result.push({
            kind,
            amount,
            ...(itemId !== undefined ? { itemId } : {}),
            ...(characterId !== undefined ? { characterId } : {}),
            ...(equipmentId !== undefined ? { equipmentId } : {}),
            ...(degreeId !== undefined ? { degreeId } : {}),
        })
    }
    return result
}

interface RewardTableSource {
    readonly tableName: string
    readonly bundledBeforeInitialization: RewardTable
}

function getRewardTable(
    source: RewardTableSource,
    repository?: ReadonlyContentRepository,
): RewardTable {
    return repository
        ? repository.table<RewardTable>(source.tableName)
        : getRuntimeContentTableSync(source.tableName, source.bundledBeforeInitialization)
}

const ACTIVE_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_active_reward.json",
    bundledBeforeInitialization: bundledActiveRewards as RewardTable,
}

export function getActiveMissionRewards(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): ActiveMissionReward[] {
    const row = getRewardRow(getRewardTable(ACTIVE_REWARD_SOURCE, repository), missionId, stage)
    return row ? parseMissionRewardSlots(row, 7) : []
}

export function getMissionRewardStageDefinition(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): MissionRewardStageDefinition | null {
    const row = getRewardRow(getRewardTable(ACTIVE_REWARD_SOURCE, repository), missionId, stage)
    if (!row) return null
    const targetProgress = Number.parseFloat(String(row[3]))
    if (!Number.isFinite(targetProgress)) return null
    return {
        targetProgress,
        targetClearSeconds: parseOptionalInteger(row[4]),
        rewards: parseMissionRewardSlots(row, 7),
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
