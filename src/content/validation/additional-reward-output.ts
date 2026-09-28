import { deepFreeze } from "../deep-freeze"
import { hasValidQuestRangeShape } from "../quest-range-shape"
import {
    invalidRuntimeTable,
    requireArray,
    requireCanonicalPositiveIntegerKey,
    requireFiniteNumber,
    requireNonNegativeSafeInteger,
    requirePositiveSafeInteger,
    requireRecord,
} from "./runtime-table"

function validateQuestRange(
    row: Readonly<Record<string, unknown>>,
    tableName: string,
    subject: string,
): void {
    const categories = requireArray(row.categories, tableName, `${subject}.categories`)
    if (categories.length === 0) invalidRuntimeTable(tableName, `${subject}.categories is empty`)
    categories.forEach((category, index) => {
        requirePositiveSafeInteger(category, tableName, `${subject}.categories[${index}]`)
    })
    const queries = requireArray(row.keyQueries, tableName, `${subject}.keyQueries`)
    if (!hasValidQuestRangeShape(categories as readonly number[], queries.length)) {
        invalidRuntimeTable(tableName, `${subject} quest range shape is invalid`)
    }
    queries.forEach((query, queryIndex) => {
        if (query === null) return
        const values = requireArray(query, tableName, `${subject}.keyQueries[${queryIndex}]`)
        values.forEach((value, valueIndex) => {
            requirePositiveSafeInteger(
                value,
                tableName,
                `${subject}.keyQueries[${queryIndex}][${valueIndex}]`,
            )
        })
        if (new Set(values).size !== values.length) {
            invalidRuntimeTable(tableName, `${subject}.keyQueries[${queryIndex}] has duplicates`)
        }
    })
}

function assertDeterministicItemGroup(
    groups: Readonly<Record<string, unknown>>,
    groupId: number,
    tableName: string,
    subject: string,
): void {
    const candidates = requireArray(groups[String(groupId)], tableName, `${subject} group`)
    if (candidates.length !== 1) {
        invalidRuntimeTable(tableName, `${subject} must reference one deterministic candidate`)
    }
    const candidate = requireRecord(candidates[0], tableName, `${subject} candidate`)
    if (candidate.type !== 0) {
        invalidRuntimeTable(tableName, `${subject} candidate must be an Item reward`)
    }
    requirePositiveSafeInteger(candidate.id, tableName, `${subject} candidate id`)
}

export function validateAdditionalRewardTable(raw: unknown): Readonly<Record<string, unknown>> {
    const tableName = "additional_reward_rules.json"
    const table = requireRecord(raw, tableName)
    const groups = requireRecord(table.groups, tableName, "groups")
    const collectRules = requireArray(table.collectItemRules, tableName, "collectItemRules")
    const bossRules = requireArray(table.bossPickupRules, tableName, "bossPickupRules")
    if (Object.keys(groups).length === 0) invalidRuntimeTable(tableName, "groups must not be empty")
    if (collectRules.length === 0 && bossRules.length === 0) {
        invalidRuntimeTable(tableName, "at least one reward rule is required")
    }

    for (const [groupId, rawCandidates] of Object.entries(groups)) {
        requireCanonicalPositiveIntegerKey(groupId, tableName, "group id")
        const candidates = requireArray(rawCandidates, tableName, `groups[${groupId}]`)
        const indices = new Set<number>()
        candidates.forEach((rawCandidate, offset) => {
            const candidate = requireRecord(
                rawCandidate,
                tableName,
                `groups[${groupId}][${offset}]`,
            )
            const index = requirePositiveSafeInteger(
                candidate.index,
                tableName,
                `groups[${groupId}][${offset}].index`,
            )
            if (indices.has(index)) invalidRuntimeTable(tableName, `group ${groupId} has duplicate index ${index}`)
            indices.add(index)
            if (typeof candidate.groupStringId !== "string") {
                invalidRuntimeTable(tableName, `group ${groupId} candidate groupStringId is invalid`)
            }
            if (!Number.isSafeInteger(candidate.type)
                || (candidate.type as number) < 0
                || (candidate.type as number) > 7) {
                invalidRuntimeTable(tableName, `group ${groupId} candidate type is invalid`)
            }
            if (candidate.id !== undefined) {
                requirePositiveSafeInteger(
                    candidate.id,
                    tableName,
                    `groups[${groupId}][${offset}].id`,
                )
            }
            requirePositiveSafeInteger(
                candidate.number,
                tableName,
                `groups[${groupId}][${offset}].number`,
            )
            requirePositiveSafeInteger(
                candidate.weight,
                tableName,
                `groups[${groupId}][${offset}].weight`,
            )
        })
    }

    collectRules.forEach((rawRule, index) => {
        const subject = `collectItemRules[${index}]`
        const rule = requireRecord(rawRule, tableName, subject)
        validateQuestRange(rule, tableName, subject)
        requirePositiveSafeInteger(rule.eventId, tableName, `${subject}.eventId`)
        const startAtMs = requireFiniteNumber(rule.startAtMs, tableName, `${subject}.startAtMs`)
        const endAtMs = requireFiniteNumber(rule.endAtMs, tableName, `${subject}.endAtMs`)
        if (endAtMs < startAtMs) invalidRuntimeTable(tableName, `${subject} period is inverted`)
        if (rule.prerequisite !== null) {
            const prerequisite = requireRecord(rule.prerequisite, tableName, `${subject}.prerequisite`)
            requirePositiveSafeInteger(
                prerequisite.category,
                tableName,
                `${subject}.prerequisite.category`,
            )
            requirePositiveSafeInteger(
                prerequisite.questId,
                tableName,
                `${subject}.prerequisite.questId`,
            )
        }
        const thresholds = requireArray(rule.thresholds, tableName, `${subject}.thresholds`)
        if (thresholds.length === 0) invalidRuntimeTable(tableName, `${subject}.thresholds is empty`)
        let previousLevel = -1
        thresholds.forEach((rawThreshold, thresholdIndex) => {
            const threshold = requireRecord(
                rawThreshold,
                tableName,
                `${subject}.thresholds[${thresholdIndex}]`,
            )
            const enemyLevelMin = requireNonNegativeSafeInteger(
                threshold.enemyLevelMin,
                tableName,
                `${subject}.thresholds[${thresholdIndex}].enemyLevelMin`,
            )
            if (enemyLevelMin <= previousLevel) {
                invalidRuntimeTable(tableName, `${subject}.thresholds must be strictly increasing`)
            }
            previousLevel = enemyLevelMin
            const groupId = requirePositiveSafeInteger(
                threshold.groupId,
                tableName,
                `${subject}.thresholds[${thresholdIndex}].groupId`,
            )
            assertDeterministicItemGroup(groups, groupId, tableName, subject)
        })
    })

    bossRules.forEach((rawRule, index) => {
        const subject = `bossPickupRules[${index}]`
        const rule = requireRecord(rawRule, tableName, subject)
        validateQuestRange(rule, tableName, subject)
        requirePositiveSafeInteger(rule.eventId, tableName, `${subject}.eventId`)
        const startAtMs = requireFiniteNumber(rule.startAtMs, tableName, `${subject}.startAtMs`)
        const endAtMs = requireFiniteNumber(rule.endAtMs, tableName, `${subject}.endAtMs`)
        if (endAtMs < startAtMs) invalidRuntimeTable(tableName, `${subject} period is inverted`)
        requireNonNegativeSafeInteger(rule.availableRank, tableName, `${subject}.availableRank`)
        const groupId = requirePositiveSafeInteger(rule.groupId, tableName, `${subject}.groupId`)
        assertDeterministicItemGroup(groups, groupId, tableName, subject)
    })

    return deepFreeze(table)
}
