// Mission reward parsers — from CDN reward tables

import bundledActiveRewards from "../../../assets/mission_active_reward.json"
import bundledRegularRewards from "../../../assets/mission_regular_reward.json"
import bundledDailyRewards from "../../../assets/mission_daily_reward.json"
import bundledEventRewards from "../../../assets/mission_event_reward.json"
import bundledDegreeRewards from "../../../assets/mission_degree_reward.json"
import bundledCollectRewards from "../../../assets/mission_collect_item_reward.json"
import bundledWeeklyRewards from "../../../assets/mission_weekly_reward.json"
import bundledCharAwakeRewards from "../../../assets/mission_char_awake_reward.json"
import bundledPassDailyRewards from "../../../assets/mission_pass_daily_reward.json"
import bundledPassWeekRewards from "../../../assets/mission_pass_week_reward.json"
import bundledPassEventRewards from "../../../assets/mission_pass_event_reward.json"
import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"

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

function getRewardRow(
    table: Record<string, Record<string, any[]>>,
    missionId: number,
    stage: number
): any[] | undefined {
    return table[String(missionId)]?.[String(stage)]?.[0]
}

function parseOptionalInteger(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    const parsed = Number.parseInt(String(value))
    return Number.isNaN(parsed) ? undefined : parsed
}

function parseMissionRewardSlots(row: any[], firstKindIndex: number, slotCount = 4): ActiveMissionReward[] {
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

type RewardTable = Record<string, Record<string, any[]>>

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

function getCategoryRewards(
    table: Record<string, Record<string, any[]>>,
    missionId: number,
    stage: number,
    firstKindIndex: number
): ActiveMissionReward[] {
    const row = getRewardRow(table, missionId, stage)
    return row ? parseMissionRewardSlots(row, firstKindIndex) : []
}

const REGULAR_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_regular_reward.json",
    bundledBeforeInitialization: bundledRegularRewards as RewardTable,
}
const DAILY_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_daily_reward.json",
    bundledBeforeInitialization: bundledDailyRewards as RewardTable,
}
const EVENT_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_event_reward.json",
    bundledBeforeInitialization: bundledEventRewards as RewardTable,
}
const COLLECT_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_collect_item_reward.json",
    bundledBeforeInitialization: bundledCollectRewards as RewardTable,
}
const DEGREE_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_degree_reward.json",
    bundledBeforeInitialization: bundledDegreeRewards as RewardTable,
}
const WEEKLY_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_weekly_reward.json",
    bundledBeforeInitialization: bundledWeeklyRewards as RewardTable,
}
const AWAKE_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_char_awake_reward.json",
    bundledBeforeInitialization: bundledCharAwakeRewards as RewardTable,
}
const PASS_DAILY_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_pass_daily_reward.json",
    bundledBeforeInitialization: bundledPassDailyRewards as RewardTable,
}
const PASS_WEEK_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_pass_week_reward.json",
    bundledBeforeInitialization: bundledPassWeekRewards as RewardTable,
}
const PASS_EVENT_REWARD_SOURCE: RewardTableSource = {
    tableName: "mission_pass_event_reward.json",
    bundledBeforeInitialization: bundledPassEventRewards as RewardTable,
}

export const getRegularMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
) => getCategoryRewards(getRewardTable(REGULAR_REWARD_SOURCE, repository), missionId, stage, 5)

export const getDailyMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
) => getCategoryRewards(getRewardTable(DAILY_REWARD_SOURCE, repository), missionId, stage, 5)

export function getAwakeMissionRewardStageDefinition(
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): AwakeMissionRewardStageDefinition | null {
    const row = getRewardRow(
        getRewardTable(AWAKE_REWARD_SOURCE, repository),
        missionId,
        stage
    )
    if (!row) return null

    const missionRewardId = parseOptionalInteger(row[0])
    const targetProgress = Number.parseFloat(String(row[5]))
    if (missionRewardId === undefined || !Number.isFinite(targetProgress)) return null

    const specialKind = parseOptionalInteger(row[1])
    let specialReward: AwakeMissionSpecialReward | undefined
    if (specialKind === 0) {
        const characterId = parseOptionalInteger(row[2])
        const boardIndex = parseOptionalInteger(row[3])
        const awakeLevel = parseOptionalInteger(row[4])
        if (characterId === undefined || boardIndex === undefined || awakeLevel === undefined) return null
        specialReward = { characterId, boardIndex, awakeLevel }
    }

    const targetClearSeconds = parseOptionalInteger(row[6])
    return {
        missionRewardId,
        targetProgress,
        ...(targetClearSeconds !== undefined ? { targetClearSeconds } : {}),
        ...(specialReward ? { specialReward } : {}),
        rewards: parseMissionRewardSlots(row, 9),
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
    return getCategoryRewards(getRewardTable(EVENT_REWARD_SOURCE, repository), missionId, stage, 5)
}

export const getCollectMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
) => getCategoryRewards(getRewardTable(COLLECT_REWARD_SOURCE, repository), missionId, stage, 6)

export const getDegreeMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
) => getCategoryRewards(getRewardTable(DEGREE_REWARD_SOURCE, repository), missionId, stage, 5)

export const getWeeklyMissionRewards = (
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
) => getCategoryRewards(getRewardTable(WEEKLY_REWARD_SOURCE, repository), missionId, stage, 5)

const categoryRewardTables: Readonly<Record<number, {
    source: RewardTableSource
    targetProgressIndex: number
    firstKindIndex: number
}>> = {
    1: { source: REGULAR_REWARD_SOURCE, targetProgressIndex: 1, firstKindIndex: 5 },
    2: { source: DAILY_REWARD_SOURCE, targetProgressIndex: 1, firstKindIndex: 5 },
    3: { source: EVENT_REWARD_SOURCE, targetProgressIndex: 1, firstKindIndex: 5 },
    4: { source: COLLECT_REWARD_SOURCE, targetProgressIndex: 2, firstKindIndex: 6 },
    5: { source: DEGREE_REWARD_SOURCE, targetProgressIndex: 1, firstKindIndex: 5 },
    6: { source: PASS_DAILY_REWARD_SOURCE, targetProgressIndex: 1, firstKindIndex: 5 },
    7: { source: PASS_WEEK_REWARD_SOURCE, targetProgressIndex: 1, firstKindIndex: 5 },
    8: { source: PASS_EVENT_REWARD_SOURCE, targetProgressIndex: 1, firstKindIndex: 5 },
    10: { source: WEEKLY_REWARD_SOURCE, targetProgressIndex: 1, firstKindIndex: 5 },
}

export function getCategoryMissionRewardStageDefinition(
    category: number,
    missionId: number,
    stage: number,
    repository?: ReadonlyContentRepository,
): CategoryMissionRewardStageDefinition | null {
    const layout = categoryRewardTables[category]
    if (!layout) return null
    const row = getRewardRow(getRewardTable(layout.source, repository), missionId, stage)
    if (!row) return null

    const missionRewardId = parseOptionalInteger(row[0])
    const targetProgress = Number.parseFloat(String(row[layout.targetProgressIndex]))
    if (missionRewardId === undefined || !Number.isFinite(targetProgress)) return null
    return {
        missionRewardId,
        targetProgress,
        rewards: parseMissionRewardSlots(row, layout.firstKindIndex),
    }
}
