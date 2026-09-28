import { deepFreeze } from "../deep-freeze"
import {
    invalidRuntimeTable,
    requireCanonicalPositiveIntegerKey,
    requireFiniteNumber,
    requireNonNegativeSafeInteger,
    requirePositiveSafeInteger,
    requireRecord,
} from "./runtime-table"

export interface ValidatedPeriodicRewardTables {
    readonly events: Readonly<Record<string, Readonly<{ periodicPointId?: number }>>>
    readonly points: Readonly<Record<string, Readonly<{
        maxPoint: number
        recoveryPoint: number
        recoveryCycle: number
    }>>>
    readonly rewards: Readonly<Record<string, Readonly<Record<string, Readonly<{
        kind: 0
        itemId: number
        count: number
        probability: number
    }>>>>>
    readonly quests?: Readonly<Record<string, Readonly<{
        periodicRewardGroupId?: number
        periodicRewardSlots?: number
    }>>>
}

const FINAL_OPERATION_EVENT_IDS = new Set([1001, 1002, 1003, 1004, 1005, 1006])

export function resolvePeriodicRewardPointId(
    events: ValidatedPeriodicRewardTables["events"],
    eventId: number,
    groupId: number,
): number | null {
    const configured = events[String(eventId)]?.periodicPointId
    if (configured !== undefined) return configured
    return FINAL_OPERATION_EVENT_IDS.has(eventId) ? groupId : null
}

export function validatePeriodicRewardTables(input: {
    readonly events: unknown
    readonly points: unknown
    readonly rewards: unknown
    readonly quests?: unknown
}): ValidatedPeriodicRewardTables {
    const tableName = "periodic reward catalog"
    const events = requireRecord(input.events, tableName, "hard_multi_event")
    const points = requireRecord(input.points, tableName, "periodic_reward_point")
    const rewards = requireRecord(input.rewards, tableName, "periodic_reward")
    if (Object.keys(events).length === 0) invalidRuntimeTable(tableName, "events must not be empty")
    if (Object.keys(points).length === 0) invalidRuntimeTable(tableName, "points must not be empty")
    if (Object.keys(rewards).length === 0) invalidRuntimeTable(tableName, "rewards must not be empty")

    for (const [pointId, rawPoint] of Object.entries(points)) {
        requireCanonicalPositiveIntegerKey(pointId, tableName, "point id")
        const point = requireRecord(rawPoint, tableName, `point ${pointId}`)
        requirePositiveSafeInteger(point.maxPoint, tableName, `point ${pointId}.maxPoint`)
        requireNonNegativeSafeInteger(point.recoveryPoint, tableName, `point ${pointId}.recoveryPoint`)
        requireNonNegativeSafeInteger(point.recoveryCycle, tableName, `point ${pointId}.recoveryCycle`)
    }
    for (const [eventId, rawEvent] of Object.entries(events)) {
        requireCanonicalPositiveIntegerKey(eventId, tableName, "event id")
        const event = requireRecord(rawEvent, tableName, `event ${eventId}`)
        if (event.periodicPointId === undefined) continue
        const pointId = requirePositiveSafeInteger(
            event.periodicPointId,
            tableName,
            `event ${eventId}.periodicPointId`,
        )
        if (points[String(pointId)] === undefined) {
            invalidRuntimeTable(tableName, `event ${eventId} references missing point ${pointId}`)
        }
    }
    for (const [groupId, rawGroup] of Object.entries(rewards)) {
        requireCanonicalPositiveIntegerKey(groupId, tableName, "reward group id")
        const group = requireRecord(rawGroup, tableName, `reward group ${groupId}`)
        if (Object.keys(group).length === 0) {
            invalidRuntimeTable(tableName, `reward group ${groupId} must not be empty`)
        }
        for (const [index, rawReward] of Object.entries(group)) {
            requireCanonicalPositiveIntegerKey(index, tableName, `reward group ${groupId} index`)
            const reward = requireRecord(rawReward, tableName, `reward group ${groupId}[${index}]`)
            if (reward.kind !== 0) {
                invalidRuntimeTable(tableName, `reward group ${groupId}[${index}].kind must be 0`)
            }
            requirePositiveSafeInteger(reward.itemId, tableName, `reward group ${groupId}[${index}].itemId`)
            requirePositiveSafeInteger(reward.count, tableName, `reward group ${groupId}[${index}].count`)
            const probability = requireFiniteNumber(
                reward.probability,
                tableName,
                `reward group ${groupId}[${index}].probability`,
            )
            if (probability < 0 || probability > 1) {
                invalidRuntimeTable(
                    tableName,
                    `reward group ${groupId}[${index}].probability must be between 0 and 1`,
                )
            }
        }
    }

    if (input.quests === undefined) {
        return deepFreeze({ events, points, rewards }) as ValidatedPeriodicRewardTables
    }
    const quests = requireRecord(input.quests, tableName, "hard_multi_event_quest")
    for (const [questId, rawQuest] of Object.entries(quests)) {
        const numericQuestId = requireCanonicalPositiveIntegerKey(questId, tableName, "quest id")
        const quest = requireRecord(rawQuest, tableName, `quest ${questId}`)
        const hasGroup = quest.periodicRewardGroupId !== undefined
        const hasSlots = quest.periodicRewardSlots !== undefined
        if (hasGroup !== hasSlots) {
            invalidRuntimeTable(tableName, `quest ${questId} periodic group/slots must appear together`)
        }
        if (!hasGroup) continue
        const groupId = requirePositiveSafeInteger(
            quest.periodicRewardGroupId,
            tableName,
            `quest ${questId}.periodicRewardGroupId`,
        )
        requirePositiveSafeInteger(
            quest.periodicRewardSlots,
            tableName,
            `quest ${questId}.periodicRewardSlots`,
        )
        if (rewards[String(groupId)] === undefined) {
            invalidRuntimeTable(tableName, `quest ${questId} references missing reward group ${groupId}`)
        }
        const eventId = Math.floor(numericQuestId / 1000)
        if (events[String(eventId)] === undefined) {
            invalidRuntimeTable(tableName, `quest ${questId} references missing event ${eventId}`)
        }
        const pointId = resolvePeriodicRewardPointId(
            events as ValidatedPeriodicRewardTables["events"],
            eventId,
            groupId,
        )
        if (pointId === null || points[String(pointId)] === undefined) {
            invalidRuntimeTable(tableName, `quest ${questId} cannot resolve periodic point`)
        }
    }
    return deepFreeze({ events, points, rewards, quests }) as ValidatedPeriodicRewardTables
}
