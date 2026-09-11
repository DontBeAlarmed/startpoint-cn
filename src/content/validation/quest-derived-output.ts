import { deepFreeze } from "../deep-freeze"
import {
    invalidRuntimeTable,
    requireArray,
    requireBoolean,
    requireCanonicalPositiveIntegerKey,
    requireNonEmptyString,
    requireNonNegativeSafeInteger,
    requirePositiveSafeInteger,
    requireRecord,
} from "./runtime-table"

export interface ValidatedQuestEntryCost {
    readonly itemId: number
    readonly itemCount: number
    readonly stamina: number
}

export interface ValidatedQuestUnlockCost {
    readonly itemIds: readonly number[]
    readonly itemCounts: readonly number[]
}

export function validateQuestEntryCostTable(
    raw: unknown,
): Readonly<Record<string, ValidatedQuestEntryCost>> {
    const tableName = "quest_entry_costs.json"
    const table = requireRecord(raw, tableName)
    if (Object.keys(table).length === 0) invalidRuntimeTable(tableName, "table must not be empty")
    for (const [questKey, value] of Object.entries(table)) {
        const match = /^([1-9]\d*)_([1-9]\d*)$/.exec(questKey)
        if (match === null
            || !Number.isSafeInteger(Number(match[1]))
            || !Number.isSafeInteger(Number(match[2]))) {
            invalidRuntimeTable(tableName, `key must be canonical category_questId: ${questKey}`)
        }
        const row = requireRecord(value, tableName, questKey)
        const itemId = requireNonNegativeSafeInteger(row.itemId, tableName, `${questKey}.itemId`)
        const itemCount = requireNonNegativeSafeInteger(
            row.itemCount,
            tableName,
            `${questKey}.itemCount`,
        )
        requireNonNegativeSafeInteger(row.stamina, tableName, `${questKey}.stamina`)
        if ((itemId === 0) !== (itemCount === 0)) {
            invalidRuntimeTable(tableName, `${questKey} item id and count must both be zero or positive`)
        }
    }
    return deepFreeze(table) as Readonly<Record<string, ValidatedQuestEntryCost>>
}

export function validateQuestUnlockCostTable(
    raw: unknown,
): Readonly<Record<string, ValidatedQuestUnlockCost>> {
    const tableName = "quest_unlock_costs.json"
    const table = requireRecord(raw, tableName)
    if (Object.keys(table).length === 0) invalidRuntimeTable(tableName, "table must not be empty")
    for (const [questId, value] of Object.entries(table)) {
        requireCanonicalPositiveIntegerKey(questId, tableName, "quest id")
        const row = requireRecord(value, tableName, questId)
        const rawIds = requireArray(row.itemIds, tableName, `${questId}.itemIds`)
        const rawCounts = requireArray(row.itemCounts, tableName, `${questId}.itemCounts`)
        if (rawIds.length === 0 || rawIds.length !== rawCounts.length) {
            invalidRuntimeTable(tableName, `${questId} item ids/counts must have equal non-zero length`)
        }
        const itemIds = rawIds.map((itemId, index) => (
            requirePositiveSafeInteger(itemId, tableName, `${questId}.itemIds[${index}]`)
        ))
        rawCounts.forEach((count, index) => {
            requirePositiveSafeInteger(count, tableName, `${questId}.itemCounts[${index}]`)
        })
        if (new Set(itemIds).size !== itemIds.length) {
            invalidRuntimeTable(tableName, `${questId}.itemIds must not contain duplicates`)
        }
    }
    return deepFreeze(table) as Readonly<Record<string, ValidatedQuestUnlockCost>>
}

export interface ValidatedDailyChallengePointDefinition {
    readonly id: number
    readonly maxPoint: number
    readonly isRecovery: boolean
}

export interface ValidatedDailyChallengeContent {
    readonly definitions: readonly ValidatedDailyChallengePointDefinition[]
    readonly eventPointMap: Readonly<Record<string, number>>
}

export function validateDailyChallengeContent(input: {
    readonly lookup: unknown
    readonly eventPointMap: unknown
}): ValidatedDailyChallengeContent {
    const tableName = "daily challenge"
    const lookup = requireRecord(input.lookup, tableName, "daily_challenge_point_lookup")
    if (Object.keys(lookup).length === 0) {
        invalidRuntimeTable(tableName, "daily_challenge_point_lookup must not be empty")
    }
    const definitions: ValidatedDailyChallengePointDefinition[] = []
    const ids = new Set<number>()
    for (const [idText, value] of Object.entries(lookup)) {
        const id = requireCanonicalPositiveIntegerKey(idText, tableName, "point id")
        const row = requireRecord(value, tableName, `point ${id}`)
        definitions.push({
            id,
            maxPoint: requireNonNegativeSafeInteger(
                row.maxPoint,
                tableName,
                `point ${id}.maxPoint`,
            ),
            isRecovery: requireBoolean(
                row.isRecovery,
                tableName,
                `point ${id}.isRecovery`,
            ),
        })
        requireNonEmptyString(row.name, tableName, `point ${id}.name`)
        ids.add(id)
    }
    const eventPointMap = requireRecord(
        input.eventPointMap,
        tableName,
        "event_challenge_point_map",
    )
    for (const [key, value] of Object.entries(eventPointMap)) {
        if (!/^(?:expert|solo|story)_[1-9]\d*$/.test(key)) {
            invalidRuntimeTable(tableName, `event challenge key is invalid: ${key}`)
        }
        const pointId = requirePositiveSafeInteger(
            value,
            tableName,
            `event_challenge_point_map[${key}]`,
        )
        if (!ids.has(pointId)) {
            invalidRuntimeTable(tableName, `${key} references missing point ${pointId}`)
        }
    }
    definitions.sort((left, right) => left.id - right.id)
    return deepFreeze({
        definitions,
        eventPointMap,
    }) as ValidatedDailyChallengeContent
}

export function validateQuestPrerequisiteTable(
    raw: unknown,
): Readonly<Record<string, readonly { readonly category: number, readonly questId: number }[]>> {
    const tableName = "quest_prerequisites.json"
    const table = requireRecord(raw, tableName)
    for (const [questKey, value] of Object.entries(table)) {
        const keyMatch = /^([1-9]\d*)_([1-9]\d*)$/.exec(questKey)
        if (keyMatch === null
            || !Number.isSafeInteger(Number(keyMatch[1]))
            || !Number.isSafeInteger(Number(keyMatch[2]))) {
            invalidRuntimeTable(tableName, `key must be canonical category_questId: ${questKey}`)
        }
        const row = requireArray(value, tableName, questKey)
        if (row.length === 0) invalidRuntimeTable(tableName, `${questKey} prerequisites must not be empty`)
        row.forEach((prerequisite, index) => {
            const entry = requireRecord(prerequisite, tableName, `${questKey}[${index}]`)
            requirePositiveSafeInteger(entry.category, tableName, `${questKey}[${index}].category`)
            requirePositiveSafeInteger(entry.questId, tableName, `${questKey}[${index}].questId`)
        })
        const prerequisiteKeys = row.map(prerequisite => {
            const entry = prerequisite as Record<string, unknown>
            return `${entry.category}_${entry.questId}`
        })
        if (new Set(prerequisiteKeys).size !== prerequisiteKeys.length) {
            invalidRuntimeTable(tableName, `${questKey} prerequisites must be unique`)
        }
        if (prerequisiteKeys.includes(`${keyMatch[1]}_${keyMatch[2]}`)) {
            invalidRuntimeTable(tableName, `${questKey} must not depend on itself`)
        }
    }
    return table as Readonly<Record<string, readonly { readonly category: number, readonly questId: number }[]>>
}
