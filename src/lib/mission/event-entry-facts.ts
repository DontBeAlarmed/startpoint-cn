import eventRewards from "../../../assets/mission_event_reward.json"
import {
    completePlayerEventMissionFactSync,
    recordPlayerEventMissionLoginDaySync,
} from "../../data/domains/event_mission_entry_facts"
import {
    getMissionMasterDefinition,
    isMissionDefinitionEnabledAt,
    type MissionMasterDefinition,
} from "./master-data"

export interface EventEntryRuleSpec {
    readonly missionId: number
    readonly pattern: string
    readonly patternType: number
    readonly targets: readonly number[]
    readonly selectorKind?: number
    readonly eventId?: number
}
const EVENT_ENTRY_RULES: readonly EventEntryRuleSpec[] = Object.freeze([
    {
        missionId: 1225,
        pattern: "startdash_login",
        patternType: 0,
        targets: Object.freeze([1, 2, 3, 4, 5, 6]),
    },
    {
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 4,
    },
    {
        missionId: 400071,
        pattern: "raid_event_05_mission_set_01",
        patternType: 79,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 5,
    },
    {
        missionId: 400089,
        pattern: "raid_event_06_mission_set_01",
        patternType: 79,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 6,
    },
    {
        missionId: 400093,
        pattern: "raid_event_07_mission_set_01",
        patternType: 79,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 7,
    },
])

function parseIntegerToken(value: unknown): number | undefined {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
    if (month === 2) return isLeapYear(year) ? 29 : 28
    return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function parseCnMasterTime(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    if (!match) return undefined
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
    if (year < 1 || month < 1 || month > 12
        || day < 1 || day > daysInMonth(year, month)
        || hour < 0 || hour > 23
        || minute < 0 || minute > 59
        || second < 0 || second > 59) return undefined
    return Date.UTC(year, month - 1, day, hour - 8, minute, second)
}

function hasExactTargets(rewards: unknown, targets: readonly number[]): boolean {
    if (!rewards || typeof rewards !== "object" || Array.isArray(rewards)) return false
    const stages = rewards as Record<string, unknown>
    const stageIds = Object.keys(stages).map(Number).sort((left, right) => left - right)
    if (stageIds.length !== targets.length
        || stageIds.some((stageId, index) => stageId !== index + 1)) return false
    return stageIds.every((stageId, index) => {
        const rows = stages[String(stageId)]
        return Array.isArray(rows)
            && rows.length === 1
            && Array.isArray(rows[0])
            && parseIntegerToken(rows[0][1]) === targets[index]
    })
}

export function validateEventEntryRule(
    definition: MissionMasterDefinition | undefined,
    rewards: unknown,
    spec: EventEntryRuleSpec,
): boolean {
    if (!definition
        || definition.category !== 3
        || definition.missionId !== spec.missionId
        || definition.pattern !== spec.pattern
        || parseIntegerToken(definition.row[2]) !== spec.patternType
        || definition.row[11] !== "(None)"
        || !hasExactTargets(rewards, spec.targets)) return false

    const start = parseCnMasterTime(definition.enableStart)
    const end = parseCnMasterTime(definition.enableEnd)
    if (start === undefined || end === undefined
        || !Number.isFinite(start) || !Number.isFinite(end) || start > end) return false

    if (spec.selectorKind === undefined) {
        return definition.row[7] === "(None)"
            && definition.row[8] === ""
            && definition.row[9] === ""
            && definition.row[10] === ""
    }
    return parseIntegerToken(definition.row[7]) === spec.selectorKind
        && parseIntegerToken(definition.row[8]) === spec.eventId
        && definition.row[9] === ""
        && definition.row[10] === "(None)"
}

function getValidatedRule(spec: EventEntryRuleSpec): MissionMasterDefinition | undefined {
    const definition = getMissionMasterDefinition(3, spec.missionId)
    const rewards = (eventRewards as Record<string, unknown>)[String(spec.missionId)]
    return validateEventEntryRule(definition, rewards, spec) ? definition : undefined
}

export function getAuthoritativeEventEntryMissionIds(): readonly number[] {
    return EVENT_ENTRY_RULES
        .filter(spec => getValidatedRule(spec) !== undefined)
        .map(spec => spec.missionId)
        .sort((left, right) => left - right)
}

function getCnNaturalDay(date: Date): number | undefined {
    const time = date.getTime()
    return Number.isFinite(time) ? Math.floor((time + 8 * 3600_000) / 86400_000) : undefined
}

export function recordEventLoginMissionFactSync(playerId: number, evaluationTime: Date): boolean {
    const spec = EVENT_ENTRY_RULES[0]
    const definition = getValidatedRule(spec)
    const naturalDay = getCnNaturalDay(evaluationTime)
    if (!definition || naturalDay === undefined
        || !isMissionDefinitionEnabledAt(definition, evaluationTime)) return false
    return recordPlayerEventMissionLoginDaySync(playerId, spec.missionId, naturalDay)
}

export function recordRaidSummaryMissionFactSync(
    playerId: number,
    eventId: number,
    evaluationTime: Date,
): boolean {
    if (!Number.isSafeInteger(eventId) || eventId <= 0
        || !Number.isFinite(evaluationTime.getTime())) return false
    const spec = EVENT_ENTRY_RULES.find(rule => rule.eventId === eventId)
    if (!spec) return false
    const definition = getValidatedRule(spec)
    if (!definition || !isMissionDefinitionEnabledAt(definition, evaluationTime)) return false
    return completePlayerEventMissionFactSync(playerId, spec.missionId)
}

export function recordRaidSummaryMissionFactFailSoftSync(
    playerId: number,
    eventId: number,
    evaluationTime: Date,
): boolean {
    try {
        return recordRaidSummaryMissionFactSync(playerId, eventId, evaluationTime)
    } catch (error) {
        const missionId = EVENT_ENTRY_RULES.find(rule => rule.eventId === eventId)?.missionId
        console.warn(
            `[MISSION] raid summary fact failed player=${playerId} event=${eventId} mission=${missionId ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
    }
}
