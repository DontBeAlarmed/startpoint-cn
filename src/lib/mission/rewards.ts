// Mission reward parsers — from CDN reward tables

import activeRewards from "../../../assets/mission_active_reward.json"
import regularRewards from "../../../assets/mission_regular_reward.json"
import dailyRewards from "../../../assets/mission_daily_reward.json"
import eventRewards from "../../../assets/mission_event_reward.json"
import degreeRewards from "../../../assets/mission_degree_reward.json"
import collectRewards from "../../../assets/mission_collect_item_reward.json"
import weeklyRewards from "../../../assets/mission_weekly_reward.json"
import charAwakeRewards from "../../../assets/mission_char_awake_reward.json"

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

export function getActiveMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    const row = getRewardRow(activeRewards as Record<string, Record<string, any[]>>, missionId, stage)
    return row ? parseMissionRewardSlots(row, 7) : []
}

export function getMissionRewardStageDefinition(missionId: number, stage: number): MissionRewardStageDefinition | null {
    const row = getRewardRow(activeRewards as Record<string, Record<string, any[]>>, missionId, stage)
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

export const getRegularMissionRewards = (missionId: number, stage: number) =>
    getCategoryRewards(regularRewards as Record<string, Record<string, any[]>>, missionId, stage, 5)

export const getDailyMissionRewards = (missionId: number, stage: number) =>
    getCategoryRewards(dailyRewards as Record<string, Record<string, any[]>>, missionId, stage, 5)

export function getAwakeMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    return getCategoryRewards(charAwakeRewards as Record<string, Record<string, any[]>>, missionId, stage, 9)
}

export function getEventMissionRewards(missionId: number, stage: number): ActiveMissionReward[] {
    return getCategoryRewards(eventRewards as Record<string, Record<string, any[]>>, missionId, stage, 5)
}

export const getCollectMissionRewards = (missionId: number, stage: number) =>
    getCategoryRewards(collectRewards as Record<string, Record<string, any[]>>, missionId, stage, 6)

export const getDegreeMissionRewards = (missionId: number, stage: number) =>
    getCategoryRewards(degreeRewards as Record<string, Record<string, any[]>>, missionId, stage, 5)

export const getWeeklyMissionRewards = (missionId: number, stage: number) =>
    getCategoryRewards(weeklyRewards as Record<string, Record<string, any[]>>, missionId, stage, 5)
