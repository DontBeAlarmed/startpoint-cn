import { isDeepStrictEqual } from "node:util"
import { ContentAssetAuditError } from "./types"

type JsonRecord = Record<string, unknown>

const MISSION_REWARD_PAIRS = [
    ["mission_regular.json", "mission_regular_reward.json"],
    ["mission_daily.json", "mission_daily_reward.json"],
    ["mission_weekly_def.json", "mission_weekly_reward.json"],
    ["mission_degree.json", "mission_degree_reward.json"],
    ["mission_event.json", "mission_event_reward.json"],
    ["mission_char_awake.json", "mission_char_awake_reward.json"],
    ["mission_collect_item.json", "mission_collect_item_reward.json"],
    ["mission_active.json", "mission_active_reward.json"],
    ["mission_pass_daily.json", "mission_pass_daily_reward.json"],
    ["mission_pass_week.json", "mission_pass_week_reward.json"],
    ["mission_pass_event.json", "mission_pass_event_reward.json"],
] as const

export interface MissionContractAuditResult {
    readonly missionRewardPairCount: number
    readonly awakeCharacterCount: number
    readonly passCardEventCount: number
    readonly passCardRewardCount: number
}

function contractError(tableName: string, message: string): never {
    throw new ContentAssetAuditError(
        "CONTENT_ASSET_AUDIT_MISSION_CONTRACT",
        `${message}: ${tableName}`,
        tableName,
    )
}

function isPlainRecord(value: unknown): value is JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function requireTable(tables: Readonly<Record<string, unknown>>, tableName: string): JsonRecord {
    const value = tables[tableName]
    if (!isPlainRecord(value)) contractError(tableName, "table must be a JSON object")
    return value
}

function validateDefinitionTable(table: JsonRecord, tableName: string): void {
    for (const [missionId, rows] of Object.entries(table)) {
        if (!/^[1-9]\d*$/.test(missionId)
            || !Array.isArray(rows)
            || !Array.isArray(rows[0])) {
            contractError(tableName, `invalid mission definition ${missionId}`)
        }
    }
}

function validateRewardTable(table: JsonRecord, tableName: string): void {
    for (const [missionId, stages] of Object.entries(table)) {
        if (!isPlainRecord(stages) || Object.keys(stages).length === 0) {
            contractError(tableName, `mission ${missionId} has no reward stage`)
        }
        for (const [stageId, rows] of Object.entries(stages)) {
            if (!/^[1-9]\d*$/.test(stageId)
                || !Array.isArray(rows)
                || rows.length === 0
                || !Array.isArray(rows[0])) {
                contractError(tableName, `mission ${missionId} has invalid reward stage ${stageId}`)
            }
        }
    }
}

function validateMissionRewardPair(
    tables: Readonly<Record<string, unknown>>,
    missionTableName: string,
    rewardTableName: string,
): void {
    const missions = requireTable(tables, missionTableName)
    const rewards = requireTable(tables, rewardTableName)
    validateDefinitionTable(missions, missionTableName)
    validateRewardTable(rewards, rewardTableName)
    const missionIds = Object.keys(missions).sort((left, right) => Number(left) - Number(right))
    const rewardIds = Object.keys(rewards).sort((left, right) => Number(left) - Number(right))
    if (!isDeepStrictEqual(missionIds, rewardIds)) {
        contractError(rewardTableName, "mission and reward ID sets differ")
    }
}

function validateAwakeGroups(awakeTable: JsonRecord): number {
    const missionIds = Object.keys(awakeTable).map(Number)
    if (missionIds.length !== 144
        || missionIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
        contractError("mission_char_awake.json", "official CN awake table must contain 144 missions")
    }
    const groups = new Map<number, number[]>()
    for (const missionId of missionIds) {
        const groupId = Math.floor(missionId / 10)
        const group = groups.get(groupId) ?? []
        group.push(missionId)
        groups.set(groupId, group)
    }
    for (const group of groups.values()) {
        group.sort((left, right) => left - right)
        if (group.length !== 4 || group.some((missionId, index) => missionId % 10 !== index + 1)) {
            contractError("mission_char_awake.json", "awake character group must contain suffixes 1 through 4")
        }
        const finalMissionId = group[3]
        const finalRows = awakeTable[String(finalMissionId)]
        const finalRow = Array.isArray(finalRows) && Array.isArray(finalRows[0]) ? finalRows[0] : null
        const references = String(finalRow?.[19] ?? "").split(",").map(Number)
        if (!isDeepStrictEqual(references, group.slice(0, 3))) {
            contractError("mission_char_awake.json", `awake final mission ${finalMissionId} has invalid children`)
        }
    }
    return groups.size
}

function validatePassCardRewards(tables: Readonly<Record<string, unknown>>): {
    eventCount: number
    rewardCount: number
} {
    const events = requireTable(tables, "pass_card_event.json")
    const rewards = requireTable(tables, "pass_card_reward.json")
    validateDefinitionTable(events, "pass_card_event.json")
    validateDefinitionTable(rewards, "pass_card_reward.json")
    const eventIds = new Set(Object.keys(events).map(Number))
    for (const [rewardId, rows] of Object.entries(rewards)) {
        const row = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : null
        const eventId = Number(row?.[0])
        if (!Number.isSafeInteger(eventId) || !eventIds.has(eventId)) {
            contractError("pass_card_reward.json", `reward ${rewardId} references unknown event`)
        }
    }
    return { eventCount: eventIds.size, rewardCount: Object.keys(rewards).length }
}

export function auditMissionTableContracts(
    tables: Readonly<Record<string, unknown>>,
): MissionContractAuditResult {
    for (const [missionTable, rewardTable] of MISSION_REWARD_PAIRS) {
        validateMissionRewardPair(tables, missionTable, rewardTable)
    }
    const awakeCharacterCount = validateAwakeGroups(requireTable(tables, "mission_char_awake.json"))
    const passCard = validatePassCardRewards(tables)
    return {
        missionRewardPairCount: MISSION_REWARD_PAIRS.length,
        awakeCharacterCount,
        passCardEventCount: passCard.eventCount,
        passCardRewardCount: passCard.rewardCount,
    }
}
