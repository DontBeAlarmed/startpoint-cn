import { deepFreeze } from "../deep-freeze"
import type { OrderedMapTextRow } from "../sync/ordered-map"
import type { GameCalendarPolicy } from "../../time/game-calendar"
import {
    resolveContentConverterContext,
    type ContentConverterContext,
} from "./context"
import { parseCsvLine } from "./csv"

/**
 * Activity event families for the admin clairvoyance activity timeline.
 *
 * Column layouts come from the operations-schedule cleaning review
 * (tools/operations_schedule/activity.py ACTIVITY_SPECS, cross-validated
 * against 318 CN notices): name = CN display name, start = schedule start,
 * activeEnd = playable window end, closeEnd = banner/exchange cutoff.
 * `label` is the primary CN alias and `aliases` feed the admin search index.
 */
export interface EventFamilySpec {
    readonly logicalPath: string
    readonly nameColumn: number
    readonly startColumn: number
    readonly activeEndColumn: number
    readonly closeEndColumn: number
    readonly bannerColumn: number
    readonly columnCount: number
    readonly label: string
}

export const EVENT_FAMILY_TABLES = Object.freeze({
    advent_event: {
        logicalPath: "master/quest/event/advent_event.orderedmap",
        nameColumn: 2,
        startColumn: 24,
        activeEndColumn: 25,
        closeEndColumn: 26,
        bannerColumn: 4,
        columnCount: 27,
        label: "降临讨伐",
    },
    carnival_event: {
        logicalPath: "master/quest/event/carnival_event.orderedmap",
        nameColumn: 1,
        startColumn: 20,
        activeEndColumn: 21,
        closeEndColumn: 22,
        bannerColumn: 3,
        columnCount: 23,
        label: "土俑嘉年华",
    },
    challenge_dungeon_event: {
        logicalPath: "master/quest/event/challenge_dungeon_event.orderedmap",
        nameColumn: 1,
        startColumn: 13,
        activeEndColumn: 14,
        closeEndColumn: 15,
        bannerColumn: 3,
        columnCount: 16,
        label: "崩坏域",
    },
    expert_single_event: {
        logicalPath: "master/quest/event/expert_single_event.orderedmap",
        nameColumn: 1,
        startColumn: 13,
        activeEndColumn: 14,
        closeEndColumn: 15,
        bannerColumn: 3,
        columnCount: 16,
        label: "追忆试炼",
    },
    hard_multi_event: {
        logicalPath: "master/quest/event/hard_multi_event.orderedmap",
        nameColumn: 2,
        startColumn: 23,
        activeEndColumn: 24,
        closeEndColumn: 25,
        bannerColumn: 4,
        columnCount: 26,
        label: "共同决战",
    },
    raid_event: {
        logicalPath: "master/quest/event/raid_event.orderedmap",
        nameColumn: 1,
        startColumn: 22,
        activeEndColumn: 23,
        closeEndColumn: 24,
        bannerColumn: 3,
        columnCount: 25,
        label: "战阵之宴",
    },
    ranking_event: {
        logicalPath: "master/quest/event/ranking_event.orderedmap",
        nameColumn: 2,
        startColumn: 18,
        activeEndColumn: 19,
        closeEndColumn: 20,
        bannerColumn: 4,
        columnCount: 21,
        label: "试炼",
    },
    rush_event: {
        logicalPath: "master/quest/event/rush_event.orderedmap",
        nameColumn: 1,
        startColumn: 15,
        activeEndColumn: 16,
        closeEndColumn: 17,
        bannerColumn: 3,
        columnCount: 18,
        label: "狂热激战",
    },
    score_attack_event: {
        logicalPath: "master/quest/event/score_attack_event.orderedmap",
        nameColumn: 1,
        startColumn: 17,
        activeEndColumn: 18,
        closeEndColumn: 19,
        bannerColumn: 3,
        columnCount: 20,
        label: "无限演武",
    },
    solo_time_attack_event: {
        logicalPath: "master/quest/event/solo_time_attack_event.orderedmap",
        nameColumn: 1,
        startColumn: 12,
        activeEndColumn: 13,
        closeEndColumn: 14,
        bannerColumn: 3,
        columnCount: 15,
        label: "极时试炼",
    },
    story_event: {
        logicalPath: "master/quest/event/story_event.orderedmap",
        nameColumn: 2,
        startColumn: 16,
        activeEndColumn: 17,
        closeEndColumn: 18,
        bannerColumn: 3,
        columnCount: 19,
        label: "故事活动",
    },
    tower_dungeon_event: {
        logicalPath: "master/quest/event/tower_dungeon_event.orderedmap",
        nameColumn: 1,
        startColumn: 11,
        activeEndColumn: 12,
        closeEndColumn: 13,
        bannerColumn: 3,
        columnCount: 14,
        label: "幽玄域",
    },
    world_story_event: {
        logicalPath: "master/quest/event/world_story_event.orderedmap",
        nameColumn: 2,
        startColumn: 22,
        activeEndColumn: 23,
        closeEndColumn: 24,
        bannerColumn: 4,
        columnCount: 25,
        label: "大型故事活动",
    },
} satisfies Record<string, EventFamilySpec>)

export type EventFamilyName = keyof typeof EVENT_FAMILY_TABLES

export const EVENT_FAMILY_SOURCE_PATHS: readonly string[] = Object.values(
    EVENT_FAMILY_TABLES,
).map(spec => spec.logicalPath)

export interface EventFamilySourceReader {
    read(logicalPath: string): Promise<readonly OrderedMapTextRow[]>
}

export interface ActivityEventRow {
    readonly eventId: number
    readonly family: string
    readonly familyLabel: string
    readonly stringId: string
    readonly name: string
    readonly startTime: string
    readonly activeEndTime?: string
    readonly closeEndTime?: string
    readonly bannerPath?: string
}

export interface EventFamilyConversionOutput {
    readonly "event_activity.json": readonly ActivityEventRow[]
}

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/
const ABSENT_FIELD = new Set(["", "(None)"])

function invalidEventFamily(reason: string): never {
    throw new Error(`invalid event family content: ${reason}`)
}

function parseMasterWallTime(
    value: string,
    subject: string,
    calendar: GameCalendarPolicy,
    invalid: (reason: string) => never,
): string {
    try {
        calendar.parseMasterTimestamp(value)
    } catch {
        invalid(`${subject} must be a valid master timestamp`)
    }
    return value
}

function requireField(value: string, subject: string): string {
    if (ABSENT_FIELD.has(value)) invalidEventFamily(`${subject} must be present`)
    return value
}

function optionalField(value: string): string | undefined {
    return ABSENT_FIELD.has(value) ? undefined : value
}

function convertFamily(
    family: EventFamilyName,
    rows: readonly OrderedMapTextRow[],
    calendar: GameCalendarPolicy,
): ActivityEventRow[] {
    const spec = EVENT_FAMILY_TABLES[family]
    const converted: ActivityEventRow[] = []
    const seen = new Set<string>()
    for (const row of rows) {
        if (!POSITIVE_INTEGER_PATTERN.test(row.key)) {
            invalidEventFamily(`${family} key must be a canonical positive integer: ${row.key}`)
        }
        if (seen.has(row.key)) invalidEventFamily(`${family} has duplicate key: ${row.key}`)
        seen.add(row.key)
        const fields = parseCsvLine(row.text, `${family}[${row.key}]`, invalidEventFamily)
        if (fields.length !== spec.columnCount) {
            invalidEventFamily(
                `${family}[${row.key}] must have ${spec.columnCount} columns, got ${fields.length}`,
            )
        }
        const subject = `${family}[${row.key}]`
        const startTime = parseMasterWallTime(
            requireField(fields[spec.startColumn], `${subject}.startTime`),
            `${subject}.startTime`,
            calendar,
            invalidEventFamily,
        )
        const activeEndRaw = fields[spec.activeEndColumn]
        const activeEndTime = activeEndRaw === undefined || ABSENT_FIELD.has(activeEndRaw)
            ? undefined
            : parseMasterWallTime(
                activeEndRaw,
                `${subject}.activeEndTime`,
                calendar,
                invalidEventFamily,
            )
        const closeEndRaw = fields[spec.closeEndColumn]
        const closeEndTime = closeEndRaw === undefined || ABSENT_FIELD.has(closeEndRaw)
            ? undefined
            : parseMasterWallTime(
                closeEndRaw,
                `${subject}.closeEndTime`,
                calendar,
                invalidEventFamily,
            )
        if (activeEndTime !== undefined && activeEndTime < startTime) {
            invalidEventFamily(`${subject}.activeEndTime precedes startTime`)
        }
        if (activeEndTime !== undefined && closeEndTime !== undefined && closeEndTime < activeEndTime) {
            invalidEventFamily(`${subject}.closeEndTime precedes activeEndTime`)
        }
        const bannerPath = optionalField(fields[spec.bannerColumn])
        converted.push({
            eventId: Number(row.key),
            family,
            familyLabel: spec.label,
            stringId: requireField(fields[0], `${subject}.stringId`),
            name: requireField(fields[spec.nameColumn], `${subject}.name`),
            startTime,
            ...(activeEndTime === undefined ? {} : { activeEndTime }),
            ...(closeEndTime === undefined ? {} : { closeEndTime }),
            ...(bannerPath === undefined ? {} : { bannerPath }),
        })
    }
    return converted
}

export async function convertEventFamilies(
    reader: EventFamilySourceReader,
    context?: ContentConverterContext,
): Promise<EventFamilyConversionOutput> {
    const { gameCalendar } = resolveContentConverterContext(context)
    const families = Object.keys(EVENT_FAMILY_TABLES) as EventFamilyName[]
    const rowsPerFamily = await Promise.all(
        families.map(family => reader.read(EVENT_FAMILY_TABLES[family].logicalPath)),
    )
    const rows = families.flatMap((family, index) => convertFamily(family, rowsPerFamily[index], gameCalendar))
    rows.sort((left, right) => (
        left.startTime.localeCompare(right.startTime)
        || left.family.localeCompare(right.family)
        || left.eventId - right.eventId
    ))
    return deepFreeze({
        "event_activity.json": rows,
    })
}
