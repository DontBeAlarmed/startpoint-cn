import { deepFreeze } from "../deep-freeze"
import type { NestedOrderedMapTextRows, OrderedMapTextRow } from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

export const ADDITIONAL_REWARD_PATHS = Object.freeze({
    groups: "master/reward/event/additional_reward.orderedmap",
    collectItemEvents: "master/reward/event/collect_item_event.orderedmap",
    collectItemQuestRelations:
        "master/reward/event/collect_item_event_quest_relation.orderedmap",
    collectItemRewardRelations:
        "master/reward/event/collect_item_event_reward_relation.orderedmap",
    bossPickupEvents:
        "master/quest/boss_battle/boss_battle_multi_pickup_event.orderedmap",
    bossPickupSchedules:
        "master/quest/boss_battle/boss_battle_multi_pickup_event_schedule.orderedmap",
})

const CATEGORY_BY_RANGE_KIND: readonly (readonly number[])[] = [
    [1], [4], [2], [6], [14], [7], [10], [13], [11], [18], [19], [15],
    [6, 14, 13, 20], [20], [21], [22], [23], [24], [25], [26], [27],
]

const CATEGORY_BY_REFERENCE_KIND: readonly number[] = [
    1, 4, 2, 6, 11, 10, 7, 13, 14, 18, 19, 20, 21, 22, 3, 23, 24, 25, 26, 27,
]

export interface AdditionalRewardSourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
    readNested(logicalPath: string): Promise<readonly NestedOrderedMapTextRows[]>
}
export interface AdditionalRewardConversionOutput {
    readonly "additional_reward_rules.json": Readonly<Record<string, unknown>>
}

function invalidAdditionalReward(reason: string): never {
    throw new Error(`invalid additional reward content: ${reason}`)
}

function parseInteger(value: string, subject: string): number {
    if (!/^(?:0|-?[1-9]\d*)$/.test(value)) {
        invalidAdditionalReward(`${subject} must be an integer`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) invalidAdditionalReward(`${subject} must be a safe integer`)
    return parsed
}

function parsePositiveInteger(value: string, subject: string): number {
    const parsed = parseInteger(value, subject)
    if (parsed <= 0) invalidAdditionalReward(`${subject} must be positive`)
    return parsed
}

function parseNonNegativeInteger(value: string, subject: string): number {
    const parsed = parseInteger(value, subject)
    if (parsed < 0) invalidAdditionalReward(`${subject} must not be negative`)
    return parsed
}

function parseTimestamp(value: string, subject: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (match === null) invalidAdditionalReward(`${subject} must be a CN date-time`)
    const parts = match.slice(1).map(Number)
    const [year, month, day, hour, minute, second] = parts
    const utc = new Date(0)
    utc.setUTCFullYear(year, month - 1, day)
    utc.setUTCHours(hour, minute, second, 0)
    const normalized = [
        utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(),
        utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(),
    ]
    if (parts.some((part, index) => part !== normalized[index])) {
        invalidAdditionalReward(`${subject} is not a real date-time`)
    }
    return utc.getTime() - 8 * 60 * 60 * 1000
}

function parseFields(row: OrderedMapTextRow, subject: string, count: number): readonly string[] {
    const fields = parseCsvLine(row.text, subject, invalidAdditionalReward)
    if (fields.length !== count) invalidAdditionalReward(`${subject} must have ${count} columns`)
    return fields
}

function parseOptionalList(value: string, subject: string): readonly number[] | null {
    if (value === "(None)") return null
    if (value === "") return []
    const values = value.split(",").map((part, index) => (
        parsePositiveInteger(part, `${subject}[${index}]`)
    ))
    if (new Set(values).size !== values.length) {
        invalidAdditionalReward(`${subject} contains duplicate values`)
    }
    return values
}

function parseOptionalId(value: string, subject: string): readonly number[] | null {
    return value === "(None)" ? null : [parsePositiveInteger(value, subject)]
}

function parseQuestRange(fields: readonly string[], subject: string): {
    readonly categories: readonly number[]
    readonly keyQueries: readonly (readonly number[] | null)[]
} {
    const kind = parseInteger(fields[1], `${subject}.kind`)
    const categories = CATEGORY_BY_RANGE_KIND[kind]
    if (categories === undefined) invalidAdditionalReward(`${subject}.kind is unsupported: ${kind}`)
    if (kind <= 2) {
        return {
            categories,
            keyQueries: [2, 3, 4].map(column => (
                parseOptionalList(fields[column], `${subject}.query[${column - 2}]`)
            )),
        }
    }
    if (kind === 11) {
        return { categories, keyQueries: [parseOptionalList(fields[4], `${subject}.questIds`)] }
    }
    if (kind === 12) return { categories, keyQueries: [] }
    return {
        categories,
        keyQueries: [
            parseOptionalId(fields[2], `${subject}.eventId`),
            parseOptionalList(fields[4], `${subject}.questIds`),
        ],
    }
}

function parsePrerequisite(fields: readonly string[], subject: string): {
    readonly category: number
    readonly questId: number
} | null {
    if (fields[23] === "(None)") return null
    const kind = parseInteger(fields[23], `${subject}.prerequisite.kind`)
    const category = CATEGORY_BY_REFERENCE_KIND[kind]
    if (category === undefined) {
        invalidAdditionalReward(`${subject}.prerequisite.kind is unsupported: ${kind}`)
    }
    const first = parsePositiveInteger(fields[24], `${subject}.prerequisite.first`)
    const third = parsePositiveInteger(fields[26], `${subject}.prerequisite.third`)
    if (kind <= 2) {
        const second = parsePositiveInteger(fields[25], `${subject}.prerequisite.second`)
        return { category, questId: first * 1_000_000 + second * 1_000 + third }
    }
    if (kind === 14) return { category, questId: third }
    return { category, questId: first * 1_000 + third }
}

function nestedByKey(
    rows: readonly NestedOrderedMapTextRows[],
    subject: string,
): ReadonlyMap<string, readonly OrderedMapTextRow[]> {
    const output = new Map<string, readonly OrderedMapTextRow[]>()
    for (const row of rows) {
        if (output.has(row.key)) invalidAdditionalReward(`${subject} has duplicate key ${row.key}`)
        output.set(row.key, row.rows)
    }
    return output
}

export async function convertAdditionalRewards(
    reader: AdditionalRewardSourceReader,
): Promise<AdditionalRewardConversionOutput> {
    const [
        groupRows,
        collectEventRows,
        collectQuestRows,
        collectRewardRows,
        bossEventRows,
        bossScheduleRows,
    ] = await Promise.all([
        reader.readNested(ADDITIONAL_REWARD_PATHS.groups),
        reader.read(ADDITIONAL_REWARD_PATHS.collectItemEvents),
        reader.readNested(ADDITIONAL_REWARD_PATHS.collectItemQuestRelations),
        reader.readNested(ADDITIONAL_REWARD_PATHS.collectItemRewardRelations),
        reader.read(ADDITIONAL_REWARD_PATHS.bossPickupEvents),
        reader.readNested(ADDITIONAL_REWARD_PATHS.bossPickupSchedules),
    ])

    const groups: Record<string, unknown[]> = {}
    for (const group of groupRows) {
        const groupId = parsePositiveInteger(group.key, `additional_reward group ${group.key}`)
        const candidates: unknown[] = []
        for (const row of group.rows) {
            const index = parsePositiveInteger(row.key, `additional_reward[${groupId}].index`)
            const fields = parseFields(row, `additional_reward[${groupId}][${index}]`, 5)
            const type = parseInteger(fields[1], `additional_reward[${groupId}][${index}].type`)
            if (type < 0 || type > 7) {
                invalidAdditionalReward(`additional_reward[${groupId}][${index}].type is unsupported`)
            }
            const id = fields[2] === "" ? undefined : parsePositiveInteger(
                fields[2], `additional_reward[${groupId}][${index}].id`,
            )
            const candidate: Record<string, unknown> = {
                index,
                groupStringId: fields[0],
                type,
                number: parsePositiveInteger(
                    fields[3], `additional_reward[${groupId}][${index}].number`,
                ),
                weight: parsePositiveInteger(
                    fields[4], `additional_reward[${groupId}][${index}].weight`,
                ),
            }
            if (id !== undefined) candidate.id = id
            candidates.push(candidate)
        }
        groups[String(groupId)] = candidates
    }

    const rewardRelations = nestedByKey(collectRewardRows, "collect item reward relations")
    const questRelations = nestedByKey(collectQuestRows, "collect item quest relations")
    const collectItemRules: unknown[] = []
    for (const eventRow of collectEventRows) {
        const eventId = parsePositiveInteger(eventRow.key, `collect_item_event key ${eventRow.key}`)
        const fields = parseFields(eventRow, `collect_item_event[${eventId}]`, 28)
        const startAtMs = parseTimestamp(fields[20], `collect_item_event[${eventId}].startAt`)
        const endAtMs = parseTimestamp(fields[21], `collect_item_event[${eventId}].endAt`)
        if (endAtMs < startAtMs) invalidAdditionalReward(`collect_item_event[${eventId}] period is inverted`)
        for (const relationRow of questRelations.get(String(eventId)) ?? []) {
            const sequence = parsePositiveInteger(
                relationRow.key, `collect_item_event_quest_relation[${eventId}].sequence`,
            )
            const relation = parseFields(
                relationRow,
                `collect_item_event_quest_relation[${eventId}][${sequence}]`,
                6,
            )
            const rewardId = parsePositiveInteger(
                relation[5], `collect_item_event_quest_relation[${eventId}][${sequence}].rewardId`,
            )
            const thresholdRows = rewardRelations.get(String(rewardId))
            if (thresholdRows === undefined) {
                invalidAdditionalReward(`collect item reward relation ${rewardId} is missing`)
            }
            const thresholds = thresholdRows.map(thresholdRow => {
                const enemyLevelMin = parseNonNegativeInteger(
                    thresholdRow.key, `collect_item_event_reward_relation[${rewardId}].enemyLevelMin`,
                )
                const thresholdFields = parseFields(
                    thresholdRow,
                    `collect_item_event_reward_relation[${rewardId}][${enemyLevelMin}]`,
                    3,
                )
                const groupId = parsePositiveInteger(
                    thresholdFields[2],
                    `collect_item_event_reward_relation[${rewardId}][${enemyLevelMin}].groupId`,
                )
                if (groups[String(groupId)] === undefined) {
                    invalidAdditionalReward(`additional reward group ${groupId} is missing`)
                }
                return { enemyLevelMin, groupId }
            }).sort((left, right) => left.enemyLevelMin - right.enemyLevelMin)
            collectItemRules.push({
                eventId,
                startAtMs,
                endAtMs,
                prerequisite: parsePrerequisite(fields, `collect_item_event[${eventId}]`),
                ...parseQuestRange(
                    relation,
                    `collect_item_event_quest_relation[${eventId}][${sequence}]`,
                ),
                thresholds,
            })
        }
    }

    const bossPeriods = new Map<number, { startAtMs: number; endAtMs: number }>()
    for (const eventRow of bossEventRows) {
        const eventId = parsePositiveInteger(eventRow.key, `boss pickup event ${eventRow.key}`)
        const fields = parseFields(eventRow, `boss_battle_multi_pickup_event[${eventId}]`, 8)
        const startAtMs = parseTimestamp(fields[6], `boss pickup event ${eventId}.startAt`)
        const endAtMs = parseTimestamp(fields[7], `boss pickup event ${eventId}.endAt`)
        if (endAtMs < startAtMs) invalidAdditionalReward(`boss pickup event ${eventId} period is inverted`)
        bossPeriods.set(eventId, { startAtMs, endAtMs })
    }

    const bossPickupRules: unknown[] = []
    for (const scheduleGroup of bossScheduleRows) {
        const eventId = parsePositiveInteger(
            scheduleGroup.key, `boss pickup schedule event ${scheduleGroup.key}`,
        )
        const eventPeriod = bossPeriods.get(eventId)
        if (eventPeriod === undefined) invalidAdditionalReward(`boss pickup event ${eventId} is missing`)
        for (const scheduleRow of scheduleGroup.rows) {
            const scheduleId = parsePositiveInteger(
                scheduleRow.key, `boss pickup schedule ${eventId}.id`,
            )
            const fields = parseFields(
                scheduleRow, `boss pickup schedule ${eventId}.${scheduleId}`, 8,
            )
            if (fields[3] === "(None)") continue
            const groupId = parsePositiveInteger(
                fields[3], `boss pickup schedule ${eventId}.${scheduleId}.groupId`,
            )
            if (groups[String(groupId)] === undefined) {
                invalidAdditionalReward(`additional reward group ${groupId} is missing`)
            }
            const startAtMs = Math.max(
                eventPeriod.startAtMs,
                parseTimestamp(fields[6], `boss pickup schedule ${eventId}.${scheduleId}.startAt`),
            )
            const endAtMs = Math.min(
                eventPeriod.endAtMs,
                parseTimestamp(fields[7], `boss pickup schedule ${eventId}.${scheduleId}.endAt`),
            )
            if (endAtMs < startAtMs) {
                invalidAdditionalReward(`boss pickup schedule ${eventId}.${scheduleId} is outside its event`)
            }
            bossPickupRules.push({
                eventId,
                startAtMs,
                endAtMs,
                categories: [2],
                keyQueries: [
                    [parsePositiveInteger(fields[0], `boss pickup schedule ${eventId}.${scheduleId}.chapterId`)],
                    [parsePositiveInteger(fields[1], `boss pickup schedule ${eventId}.${scheduleId}.stageNodeId`)],
                    null,
                ],
                groupId,
                availableRank: parseNonNegativeInteger(
                    fields[4], `boss pickup schedule ${eventId}.${scheduleId}.availableRank`,
                ),
            })
        }
    }

    return deepFreeze({
        "additional_reward_rules.json": { groups, collectItemRules, bossPickupRules },
    })
}
