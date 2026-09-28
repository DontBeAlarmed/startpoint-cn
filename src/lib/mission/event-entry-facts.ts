import { getDb } from "../../data/db"
import {
    completePlayerEventMissionFactSync,
    recordPlayerEventMissionLoginDaySync,
} from "../../data/domains/event_mission_entry_facts"
import { PartyCategory } from "../../data/types"
import { GameCalendarError, type GameCalendarPolicy } from "../../time/game-calendar"
import { getGameCalendar } from "../../time/game-calendar-provider"
import { MissionCatalogStage, MissionMasterDefinition, getMissionCatalog, isMissionMasterDefinitionEnabledAt } from "./mission-catalog"

export type EventEntryRuleProducer =
    | "login"
    | "raid-summary"
    | "raid-set-edit"
    | "character-election-vote"

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
        producer: "character-election-vote",
        missionId: 2389,
        pattern: "chara_election_01",
        patternType: 68,
        targets: Object.freeze([1]),
        enableStart: "2022-05-02 12:00:00",
        enableEnd: "2022-05-13 23:59:59",
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

function parseCnMasterTime(
    value: string | undefined,
    calendar: GameCalendarPolicy = getGameCalendar(),
): number | undefined {
    if (value === undefined) return undefined
    try {
        return calendar.parseMasterTimestamp(value)
    } catch (error) {
        if (error instanceof GameCalendarError) return undefined
        throw error
    }
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

function hasExactCatalogTargets(
    stages: readonly MissionCatalogStage[],
    targets: readonly number[],
): boolean {
    return stages.length === targets.length
        && stages.every((stage, index) => (
            stage.stage === index + 1 && stage.targetProgress === targets[index]
        ))
}

export function validateEventEntryCatalogRule(
    definition: MissionMasterDefinition,
    stages: readonly MissionCatalogStage[],
): boolean {
    const spec = EVENT_ENTRY_RULES.find(rule => rule.missionId === definition.missionId)
    if (!spec || !hasExactCatalogTargets(stages, spec.targets)) return false
    const start = parseCnMasterTime(definition.enableStart)
    const end = parseCnMasterTime(definition.enableEnd)
    if (definition.category !== 3
        || definition.pattern !== spec.pattern
        || parseIntegerToken(definition.row[2]) !== spec.patternType
        || definition.row.slice(3, 7).some(value => value !== "")
        || definition.row[11] !== "(None)"
        || definition.enableStart !== spec.enableStart
        || definition.enableEnd !== spec.enableEnd
        || definition.row[27] !== spec.enableStart
        || definition.row[28] !== spec.enableEnd
        || start === undefined || end === undefined || start > end) return false
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
                isMissionMasterDefinitionEnabledAt(definition!, evaluationTime)
            ))) return []
        return [specs]
    })
    return openFamilies.length === 1 ? openFamilies[0] : undefined
}

export function getRaidSetEditMissionIds(
    usePartyGroupEdit: boolean,
    parties: readonly RaidSetEditPartyFactInput[],
    evaluationTime: Date,
): readonly number[] {
    if (usePartyGroupEdit !== true
        || !Array.isArray(parties)
        || parties.some(party => !isValidRaidSetEditPartyFactInput(party))
        || !(evaluationTime instanceof Date)
        || !Number.isFinite(evaluationTime.getTime())) return []

    const slots = new Set(parties
        .filter(party => party.category === PartyCategory.RAID
            && party.groupId === 1
            && party.slot >= 1
            && party.slot <= 3)
        .map(party => party.slot))
    if (slots.size === 0) return []

    const family = getOpenRaidSetRuleFamily(evaluationTime)
    if (!family) return []
    const missionIds = [...slots].map(slot => (
        family.find(spec => spec.raidSetSlot === slot)?.missionId
    ))
    if (missionIds.some(missionId => missionId === undefined)) return []
    return missionIds as number[]
}

export function recordRaidSetEditMissionFactsSync(
    playerId: number,
    usePartyGroupEdit: boolean,
    parties: readonly RaidSetEditPartyFactInput[],
    evaluationTime: Date,
): boolean {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) return false
    const missionIds = getRaidSetEditMissionIds(usePartyGroupEdit, parties, evaluationTime)
    if (missionIds.length === 0) return false

    return getDb().transaction(() => {
        let changed = false
        for (const missionId of missionIds) {
            changed = completePlayerEventMissionFactSync(playerId, missionId!) || changed
        }
        return changed
    })()
}

function getValidatedRule(spec: EventEntryRuleSpec): MissionMasterDefinition | undefined {
    const catalog = getMissionCatalog()
    const definition = catalog.getDefinition(3, spec.missionId)
    if (!definition) return undefined
    const stages = catalog.getRewardStages(3, spec.missionId)
    return validateEventEntryCatalogRule(definition, stages) ? definition : undefined
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

export function getEventLoginNaturalDay(
    date: Date,
    calendar: GameCalendarPolicy = getGameCalendar(),
): number | undefined {
    const time = date.getTime()
    if (!Number.isFinite(time)) return undefined
    const bucket = calendar.getDayBucket(time)
    return Date.UTC(bucket.y, bucket.m, bucket.d) / 86_400_000
}

export function getEventLoginMissionId(evaluationTime: Date): number | null {
    const spec = EVENT_ENTRY_RULES.find(rule => rule.producer === "login")
    if (!spec) return null
    const definition = getValidatedRule(spec)
    return definition && isMissionMasterDefinitionEnabledAt(definition, evaluationTime)
        ? spec.missionId
        : null
}

export function recordEventLoginMissionFactSync(playerId: number, evaluationTime: Date): boolean {
    const missionId = getEventLoginMissionId(evaluationTime)
    const naturalDay = getEventLoginNaturalDay(evaluationTime)
    return missionId === null || naturalDay === undefined
        ? false
        : recordPlayerEventMissionLoginDaySync(playerId, missionId, naturalDay)
}

export function getOpenCharacterElectionVoteMissionId(
    stringId: string,
    enableStart: string,
    enableEnd: string,
    evaluationTime: Date,
): number | null {
    if (!(evaluationTime instanceof Date) || !Number.isFinite(evaluationTime.getTime())) return null
    const specs = EVENT_ENTRY_RULES.filter(rule => (
        rule.producer === "character-election-vote"
        && rule.pattern === stringId
        && rule.enableStart === enableStart
        && rule.enableEnd === enableEnd
    ))
    if (specs.length !== 1) return null
    const definition = getValidatedRule(specs[0])
    return definition && isMissionMasterDefinitionEnabledAt(definition, evaluationTime)
        ? definition.missionId
        : null
}

function getRaidSummaryRule(eventId: number): EventEntryRuleSpec | undefined {
    return EVENT_ENTRY_RULES.find(rule => (
        rule.producer === "raid-summary"
        && rule.eventId === eventId
        && rule.patternType === 79
        && rule.raidSetSlot === undefined
    ))
}

export function getRaidSummaryMissionId(
    eventId: number,
    evaluationTime: Date,
): number | null {
    if (!Number.isSafeInteger(eventId) || eventId <= 0
        || !(evaluationTime instanceof Date)
        || !Number.isFinite(evaluationTime.getTime())) return null
    const spec = getRaidSummaryRule(eventId)
    if (!spec) return null
    const definition = getValidatedRule(spec)
    return definition && isMissionMasterDefinitionEnabledAt(definition, evaluationTime)
        ? spec.missionId
        : null
}

export function recordRaidSummaryMissionFactSync(
    playerId: number,
    eventId: number,
    evaluationTime: Date,
): boolean {
    const missionId = getRaidSummaryMissionId(eventId, evaluationTime)
    return missionId === null
        ? false
        : completePlayerEventMissionFactSync(playerId, missionId)
}
