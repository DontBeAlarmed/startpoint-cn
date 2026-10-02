import { deepFreeze } from "../content/deep-freeze"
import { OffsetKeyedStaticTimelineCache } from "./timeline-cache"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"
import { getVirtualNow } from "../runtime/time/game-time"
import type { GameCalendarPolicy } from "../time/game-calendar"
import { getGameCalendar } from "../time/game-calendar-provider"
import type { ActivityEventRow } from "../content/converters/event-family"

// Search-only CN aliases from the operations-schedule review
// (tools/operations_schedule/activity.py). familyLabel is baked into content;
// the extra folk aliases here only widen the admin search haystack.
const FAMILY_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
    advent_event: Object.freeze(["降临讨伐"]),
    carnival_event: Object.freeze(["土俑嘉年华", "竞分"]),
    challenge_dungeon_event: Object.freeze(["崩坏域", "宝物域"]),
    expert_single_event: Object.freeze(["追忆试炼", "单人挑战"]),
    hard_multi_event: Object.freeze(["共同决战"]),
    raid_event: Object.freeze(["战阵之宴", "团本"]),
    ranking_event: Object.freeze(["试炼", "竞速"]),
    rush_event: Object.freeze(["狂热激战"]),
    score_attack_event: Object.freeze(["无限演武"]),
    solo_time_attack_event: Object.freeze(["极时试炼"]),
    story_event: Object.freeze(["故事活动"]),
    tower_dungeon_event: Object.freeze(["幽玄域"]),
    world_story_event: Object.freeze(["大型故事活动"]),
})

// Notice-title aliases from the schedule review: CN announcements used
// different names than the master-table rows for these reruns.
const EXPLICIT_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "雷废龙讨伐复刻": Object.freeze(["黑雷的荒龙"]),
    "水废龙讨伐复刻": Object.freeze(["水蚀的荒龙"]),
    "灼炎的荒龙讨伐复刻": Object.freeze(["灼炎的荒龙"]),
    "光废龙讨伐复刻": Object.freeze(["光芒的荒龙"]),
    "阻止暴走的罗梅罗~另一个SAGA的传奇": Object.freeze(["阻止狂暴的罗梅罗"]),
    "凶暗的荒龙讨伐": Object.freeze(["凶暗的荒龙"]),
    "始龙之眼讨伐": Object.freeze(["始龙之眼"]),
})

export interface AdminActivityEvent {
    eventId: number
    family: string
    familyLabel: string
    stringId: string
    name: string
    startTime: string
    activeEndTime: string | null
    closeEndTime: string | null
}

export interface AdminActivitySearchRow {
    eventId: number
    family: string
    familyLabel: string
    stringId: string
    name: string
    aliases: readonly string[]
}

export interface AdminActivityTimeline {
    scope: "event-quest"
    currentTime: string
    timeline: AdminActivityEvent[]
    searchIndex: AdminActivitySearchRow[]
}

interface StaticActivityTimeline {
    readonly timeline: AdminActivityEvent[]
    readonly searchIndex: AdminActivitySearchRow[]
}

function toIso(masterWallTime: string, calendar: GameCalendarPolicy): string {
    return new Date(calendar.parseMasterTimestamp(masterWallTime)).toISOString()
}

const staticTimelineCache = new OffsetKeyedStaticTimelineCache<StaticActivityTimeline>(buildStaticTimeline)

function toActivityEvent(row: ActivityEventRow, calendar: GameCalendarPolicy): AdminActivityEvent {
    return {
        eventId: row.eventId,
        family: row.family,
        familyLabel: row.familyLabel,
        stringId: row.stringId,
        name: row.name,
        startTime: toIso(row.startTime, calendar),
        activeEndTime: row.activeEndTime === undefined ? null : toIso(row.activeEndTime, calendar),
        closeEndTime: row.closeEndTime === undefined ? null : toIso(row.closeEndTime, calendar),
    }
}

function aliasesFor(row: ActivityEventRow): readonly string[] {
    const familyAliases = FAMILY_SEARCH_ALIASES[row.family] ?? [row.familyLabel]
    const nameAliases = EXPLICIT_NAME_ALIASES[row.name] ?? []
    return [...new Set([...familyAliases, ...nameAliases])]
}

function sortEpoch(value: string | null): number {
    return value === null ? Number.POSITIVE_INFINITY : Date.parse(value)
}

function buildStaticTimeline(
    repository: ReadonlyContentRepository,
    calendar: GameCalendarPolicy,
): StaticActivityTimeline {
    const rows = repository.table<readonly ActivityEventRow[]>("event_activity.json")
    const timeline = rows
        .map(row => toActivityEvent(row, calendar))
        .sort((left, right) => (
            sortEpoch(left.activeEndTime) - sortEpoch(right.activeEndTime)
            || Date.parse(left.startTime) - Date.parse(right.startTime)
            || left.family.localeCompare(right.family)
            || left.eventId - right.eventId
        ))
    const searchIndex = rows
        .map(row => ({
            eventId: row.eventId,
            family: row.family,
            familyLabel: row.familyLabel,
            stringId: row.stringId,
            name: row.name,
            aliases: aliasesFor(row),
        }))
        .sort((left, right) => (
            left.family.localeCompare(right.family) || left.eventId - right.eventId
        ))
    return deepFreeze({ timeline, searchIndex })
}

export function buildAdminActivityTimeline(
    now: Date = getVirtualNow(),
    calendar: GameCalendarPolicy = getGameCalendar(),
): AdminActivityTimeline {
    const repository = getContentSnapshot().repository
    const staticTimeline = staticTimelineCache.get(repository, calendar)
    return {
        scope: "event-quest",
        currentTime: now.toISOString(),
        timeline: staticTimeline.timeline,
        searchIndex: staticTimeline.searchIndex,
    }
}
