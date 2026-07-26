import eventRewards from "../../../assets/mission_event_reward.json"
import { getDb } from "../../data/db"
import {
    completePlayerEventMissionFactSync,
    recordPlayerEventMissionLoginDaySync,
} from "../../data/domains/event_mission_entry_facts"
import { PartyCategory } from "../../data/types"
import {
    getMissionMasterDefinition,
    isMissionDefinitionEnabledAt,
    type MissionMasterDefinition,
} from "./master-data"

export type EventEntryRuleProducer = "login" | "raid-summary" | "raid-set-edit"

export interface EventEntryRuleSpec {
    readonly producer: EventEntryRuleProducer
    readonly missionId: number
    readonly pattern: string
    readonly patternType: number
    readonly targets: readonly number[]
    readonly selectorKind?: number
    readonly eventId?: number
    readonly enableStart: string
    readonly enableEnd: string
    readonly raidSetSlot?: 1 | 2 | 3
}
const EVENT_ENTRY_RULES: readonly EventEntryRuleSpec[] = Object.freeze([
    {
        producer: "login",
        missionId: 1225,
        pattern: "startdash_login",
        patternType: 0,
        targets: Object.freeze([1, 2, 3, 4, 5, 6]),
        enableStart: "2019-11-27 12:00:00",
        enableEnd: "2019-12-16 11:59:59",
    },
    {
        producer: "raid-summary",
        missionId: 400053,
        pattern: "raid_event_04_mission_set_01",
        patternType: 79,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 4,
        enableStart: "2024-05-23 12:00:00",
        enableEnd: "2024-06-06 23:59:59",
    },
    {
        producer: "raid-set-edit",
        missionId: 400054,
        pattern: "raid_event_04_mission_set_02",
        patternType: 80,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 4,
        enableStart: "2024-05-23 12:00:00",
        enableEnd: "2024-06-06 23:59:59",
        raidSetSlot: 1,
    },
    {
        producer: "raid-set-edit",
        missionId: 400055,
        pattern: "raid_event_04_mission_set_03",
        patternType: 81,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 4,
        enableStart: "2024-05-23 12:00:00",
        enableEnd: "2024-06-06 23:59:59",
        raidSetSlot: 2,
    },
    {
        producer: "raid-set-edit",
        missionId: 400056,
        pattern: "raid_event_04_mission_set_04",
        patternType: 82,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 4,
        enableStart: "2024-05-23 12:00:00",
        enableEnd: "2024-06-06 23:59:59",
        raidSetSlot: 3,
    },
    {
        producer: "raid-summary",
        missionId: 400071,
        pattern: "raid_event_05_mission_set_01",
        patternType: 79,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 5,
        enableStart: "2024-12-05 12:00:00",
        enableEnd: "2024-12-19 23:59:59",
    },
    {
        producer: "raid-set-edit",
        missionId: 400072,
        pattern: "raid_event_05_mission_set_02",
        patternType: 80,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 5,
        enableStart: "2024-12-05 12:00:00",
        enableEnd: "2024-12-19 23:59:59",
        raidSetSlot: 1,
    },
    {
        producer: "raid-set-edit",
        missionId: 400073,
        pattern: "raid_event_05_mission_set_03",
        patternType: 81,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 5,
        enableStart: "2024-12-05 12:00:00",
        enableEnd: "2024-12-19 23:59:59",
        raidSetSlot: 2,
    },
    {
        producer: "raid-set-edit",
        missionId: 400074,
        pattern: "raid_event_05_mission_set_04",
        patternType: 82,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 5,
        enableStart: "2024-12-05 12:00:00",
        enableEnd: "2024-12-19 23:59:59",
        raidSetSlot: 3,
    },
    {
        producer: "raid-summary",
        missionId: 400089,
        pattern: "raid_event_06_mission_set_01",
        patternType: 79,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 6,
        enableStart: "2025-05-15 12:00:00",
        enableEnd: "2025-05-29 23:59:59",
    },
    {
        producer: "raid-set-edit",
        missionId: 400090,
        pattern: "raid_event_06_mission_set_02",
        patternType: 80,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 6,
        enableStart: "2025-05-15 12:00:00",
        enableEnd: "2025-05-29 23:59:59",
        raidSetSlot: 1,
    },
    {
        producer: "raid-set-edit",
        missionId: 400091,
        pattern: "raid_event_06_mission_set_03",
        patternType: 81,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 6,
        enableStart: "2025-05-15 12:00:00",
        enableEnd: "2025-05-29 23:59:59",
        raidSetSlot: 2,
    },
    {
        producer: "raid-set-edit",
        missionId: 400092,
        pattern: "raid_event_06_mission_set_04",
        patternType: 82,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 6,
        enableStart: "2025-05-15 12:00:00",
        enableEnd: "2025-05-29 23:59:59",
        raidSetSlot: 3,
    },
    {
        producer: "raid-summary",
        missionId: 400093,
        pattern: "raid_event_07_mission_set_01",
        patternType: 79,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 7,
        enableStart: "2025-06-26 12:00:00",
        enableEnd: "2025-08-14 23:59:59",
    },
    {
        producer: "raid-set-edit",
        missionId: 400094,
        pattern: "raid_event_07_mission_set_02",
        patternType: 80,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 7,
        enableStart: "2025-06-26 12:00:00",
        enableEnd: "2025-08-14 23:59:59",
        raidSetSlot: 1,
    },
    {
        producer: "raid-set-edit",
        missionId: 400095,
        pattern: "raid_event_07_mission_set_03",
        patternType: 81,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 7,
        enableStart: "2025-06-26 12:00:00",
        enableEnd: "2025-08-14 23:59:59",
        raidSetSlot: 2,
    },
    {
        producer: "raid-set-edit",
        missionId: 400096,
        pattern: "raid_event_07_mission_set_04",
        patternType: 82,
        targets: Object.freeze([1]),
        selectorKind: 16,
        eventId: 7,
        enableStart: "2025-06-26 12:00:00",
        enableEnd: "2025-08-14 23:59:59",
        raidSetSlot: 3,
    },
])

const RAID_SET_EVENT_IDS = Object.freeze([4, 5, 6, 7])

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
        || definition.row.slice(3, 7).some(value => value !== "")
        || definition.row[11] !== "(None)"
        || definition.enableStart !== spec.enableStart
        || definition.enableEnd !== spec.enableEnd
        || definition.row[27] !== spec.enableStart
        || definition.row[28] !== spec.enableEnd
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

export interface RaidSetEditPartyFactInput {
    readonly category: PartyCategory
    readonly groupId: number
    readonly slot: number
}

function isValidRaidSetEditPartyFactInput(value: unknown): value is RaidSetEditPartyFactInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const candidate = value as Partial<RaidSetEditPartyFactInput>
    return Number.isSafeInteger(candidate.category)
        && candidate.category! >= PartyCategory.EMPTY
        && candidate.category! <= PartyCategory.RUSH
        && Number.isSafeInteger(candidate.groupId)
        && candidate.groupId! >= 1
        && candidate.groupId! <= 12
        && Number.isSafeInteger(candidate.slot)
        && candidate.slot! >= 1
        && candidate.slot! <= 10
}

function getOpenRaidSetRuleFamily(
    evaluationTime: Date,
): readonly EventEntryRuleSpec[] | undefined {
    const openFamilies = RAID_SET_EVENT_IDS.flatMap(eventId => {
        const specs = EVENT_ENTRY_RULES.filter(spec => (
            spec.producer === "raid-set-edit"
            && spec.eventId === eventId
            && spec.raidSetSlot !== undefined
        ))
        if (specs.length !== 3) return []
        const definitions = specs.map(getValidatedRule)
        if (definitions.some(definition => definition === undefined)
            || !definitions.every(definition => (
                isMissionDefinitionEnabledAt(definition!, evaluationTime)
            ))) return []
        return [specs]
    })
    return openFamilies.length === 1 ? openFamilies[0] : undefined
}

export function recordRaidSetEditMissionFactsSync(
    playerId: number,
    usePartyGroupEdit: boolean,
    parties: readonly RaidSetEditPartyFactInput[],
    evaluationTime: Date,
): boolean {
    if (!Number.isSafeInteger(playerId) || playerId <= 0
        || usePartyGroupEdit !== true
        || !Array.isArray(parties)
        || parties.some(party => !isValidRaidSetEditPartyFactInput(party))
        || !(evaluationTime instanceof Date)
        || !Number.isFinite(evaluationTime.getTime())) return false

    const slots = new Set(parties
        .filter(party => party.category === PartyCategory.RAID
            && party.groupId === 1
            && party.slot >= 1
            && party.slot <= 3)
        .map(party => party.slot))
    if (slots.size === 0) return false

    const family = getOpenRaidSetRuleFamily(evaluationTime)
    if (!family) return false
    const missionIds = [...slots].map(slot => (
        family.find(spec => spec.raidSetSlot === slot)?.missionId
    ))
    if (missionIds.some(missionId => missionId === undefined)) return false

    return getDb().transaction(() => {
        let changed = false
        for (const missionId of missionIds) {
            changed = completePlayerEventMissionFactSync(playerId, missionId!) || changed
        }
        return changed
    })()
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

export function getProducerBackedEventEntryMissionIds(
    producer?: EventEntryRuleProducer,
): readonly number[] {
    return EVENT_ENTRY_RULES
        .filter(spec => producer === undefined || spec.producer === producer)
        .filter(spec => getValidatedRule(spec) !== undefined)
        .map(spec => spec.missionId)
        .sort((left, right) => left - right)
}

function getCnNaturalDay(date: Date): number | undefined {
    const time = date.getTime()
    return Number.isFinite(time) ? Math.floor((time + 8 * 3600_000) / 86400_000) : undefined
}

export function recordEventLoginMissionFactSync(playerId: number, evaluationTime: Date): boolean {
    const spec = EVENT_ENTRY_RULES.find(rule => rule.producer === "login")
    if (!spec) return false
    const definition = getValidatedRule(spec)
    const naturalDay = getCnNaturalDay(evaluationTime)
    if (!definition || naturalDay === undefined
        || !isMissionDefinitionEnabledAt(definition, evaluationTime)) return false
    return recordPlayerEventMissionLoginDaySync(playerId, spec.missionId, naturalDay)
}

function getRaidSummaryRule(eventId: number): EventEntryRuleSpec | undefined {
    return EVENT_ENTRY_RULES.find(rule => (
        rule.producer === "raid-summary"
        && rule.eventId === eventId
        && rule.patternType === 79
        && rule.raidSetSlot === undefined
    ))
}

export function recordRaidSummaryMissionFactSync(
    playerId: number,
    eventId: number,
    evaluationTime: Date,
): boolean {
    if (!Number.isSafeInteger(eventId) || eventId <= 0
        || !Number.isFinite(evaluationTime.getTime())) return false
    const spec = getRaidSummaryRule(eventId)
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
        const missionId = getRaidSummaryRule(eventId)?.missionId
        console.warn(
            `[MISSION] raid summary fact failed player=${playerId} event=${eventId} mission=${missionId ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
    }
}
