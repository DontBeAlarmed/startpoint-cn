import passCardEvents from "../../assets/pass_card_event.json"
import passCardRewards from "../../assets/pass_card_reward.json"
import type { ActiveMissionReward } from "./mission/rewards"

export interface PassCardEventDefinition {
    eventId: number
    thresholdPoint: number
    levelThreshold: number
    startTime: number
    endTime: number
    forceTime: number
}

export interface PassCardRewardDefinition {
    rewardId: number
    eventId: number
    level: number
    reward1: ActiveMissionReward
    reward2: ActiveMissionReward
}

function firstRow(value: unknown): readonly unknown[] | undefined {
    return Array.isArray(value) && Array.isArray(value[0]) ? value[0] : undefined
}

function integer(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
}

function cnTimestamp(value: unknown): number | undefined {
    if (typeof value !== "string" || value === "") return undefined
    const parsed = Date.parse(`${value.replace(" ", "T")}+08:00`)
    return Number.isFinite(parsed) ? parsed : undefined
}

function parseReward(row: readonly unknown[], kindIndex: number): ActiveMissionReward | undefined {
    const kind = integer(row[kindIndex])
    if (kind === undefined) return undefined
    const amount = integer(row[kindIndex + 1]) ?? (kind === 6 ? 0 : undefined)
    if (amount === undefined) return undefined
    const itemId = integer(row[kindIndex + 2])
    const characterId = integer(row[kindIndex + 3])
    const equipmentId = integer(row[kindIndex + 4])
    const degreeId = integer(row[kindIndex + 5])
    if (kind === 1 && itemId === undefined) return undefined
    if (kind === 2 && equipmentId === undefined) return undefined
    if (kind === 4 && characterId === undefined) return undefined
    if (kind === 6 && degreeId === undefined) return undefined
    return {
        kind,
        amount,
        ...(itemId !== undefined ? { itemId } : {}),
        ...(characterId !== undefined ? { characterId } : {}),
        ...(equipmentId !== undefined ? { equipmentId } : {}),
        ...(degreeId !== undefined ? { degreeId } : {}),
    }
}

export function getPassCardEventDefinition(eventId: number): PassCardEventDefinition | undefined {
    const row = firstRow((passCardEvents as Record<string, unknown>)[String(eventId)])
    const thresholdPoint = row ? integer(row[4]) : undefined
    const levelThreshold = row ? integer(row[5]) : undefined
    const startTime = row ? cnTimestamp(row[8]) : undefined
    const endTime = row ? cnTimestamp(row[9]) : undefined
    const forceTime = row ? cnTimestamp(row[10]) : undefined
    if (thresholdPoint === undefined
        || levelThreshold === undefined || levelThreshold <= 0
        || startTime === undefined || endTime === undefined || forceTime === undefined) return undefined
    return { eventId, thresholdPoint, levelThreshold, startTime, endTime, forceTime }
}

export function isPassCardEventActiveAt(event: PassCardEventDefinition, at: Date): boolean {
    const time = at.getTime()
    return Number.isFinite(time) && event.startTime <= time && time <= event.endTime
}

export function getPassCardRewardDefinition(rewardId: number): PassCardRewardDefinition | undefined {
    const row = firstRow((passCardRewards as Record<string, unknown>)[String(rewardId)])
    if (!row) return undefined
    const eventId = integer(row[0])
    const level = integer(row[1])
    const reward1 = parseReward(row, 2)
    const reward2 = parseReward(row, 8)
    if (eventId === undefined || level === undefined || !reward1 || !reward2) return undefined
    return { rewardId, eventId, level, reward1, reward2 }
}
