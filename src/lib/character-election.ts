import type {
    ReadonlyCharacterElectionRule,
    ReadonlyCharacterElectionTable,
} from "../content/converters/character-election"
import { deepFreeze } from "../content/deep-freeze"
import { getContentSnapshot, type ReadonlyContentRepository } from "../content/runtime/content-snapshot"
import { GameCalendarError, type GameCalendarPolicy } from "../time/game-calendar"
import { getGameCalendar } from "../time/game-calendar-provider"

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

function parseMasterTime(value: unknown, calendar: GameCalendarPolicy): number | null {
    if (typeof value !== "string") return null
    // Content validation keeps its historical supported master-year window;
    // field validity and the fixed-offset conversion go through the policy.
    const year = Number(value.slice(0, 4))
    if (!Number.isSafeInteger(year) || year < 1970 || year > 2200) return null
    try {
        return calendar.parseMasterTimestamp(value)
    } catch (error) {
        if (error instanceof GameCalendarError) return null
        throw error
    }
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

interface ValidatedCharacterElectionRule extends ReadonlyCharacterElectionRule {
    readonly electionId: number
    readonly startAt: number
    readonly endAt: number
    readonly keywordIdSet: ReadonlySet<number>
}

export interface CharacterElectionDescriptor extends ReadonlyCharacterElectionRule {
    readonly electionId: number
    readonly startAt: number
    readonly endAt: number
}

export interface CharacterElectionCatalog {
    readonly resolve: (electionId: number) => CharacterElectionDescriptor | null
    readonly acceptsKeyword: (electionId: number, keywordId: number) => boolean
}

function validateCharacterElectionRule(
    table: ReadonlyCharacterElectionTable,
    electionId: number,
    calendar: GameCalendarPolicy,
): ValidatedCharacterElectionRule | null {
    if (!isPositiveSafeInteger(electionId)
        || !table || typeof table !== "object" || Array.isArray(table)) return null
    const rule = table[String(electionId)]
    if (!rule || typeof rule !== "object" || Array.isArray(rule)
        || typeof rule.stringId !== "string"
        || !/^[A-Za-z0-9_]+$/.test(rule.stringId)
        || !Array.isArray(rule.keywordIds)
        || rule.keywordIds.length === 0
        || rule.keywordIds.some(keywordId => !isPositiveSafeInteger(keywordId))) return null
    const startAt = parseMasterTime(rule.startTime, calendar)
    const endAt = parseMasterTime(rule.endTime, calendar)
    if (startAt === null || endAt === null || startAt > endAt) return null
    const keywordIdSet = new Set(rule.keywordIds)
    if (keywordIdSet.size !== rule.keywordIds.length) return null
    return {
        ...rule,
        electionId,
        startAt,
        endAt,
        keywordIdSet,
    }
}

export function isCharacterElectionOpenAt(
    rule: Pick<CharacterElectionDescriptor, "startAt" | "endAt">,
    evaluationTime: Date,
): boolean {
    const time = evaluationTime.getTime()
    return Number.isFinite(time) && time >= rule.startAt && time <= rule.endAt
}

export function buildCharacterElectionCatalog(
    repository: ReadonlyContentRepository,
    calendar: GameCalendarPolicy = getGameCalendar(),
): CharacterElectionCatalog {
    const table = repository.table<ReadonlyCharacterElectionTable>("character_election.json")
    if (!table || typeof table !== "object" || Array.isArray(table)) {
        throw new TypeError("Invalid Character Election table.")
    }
    const descriptors = new Map<number, CharacterElectionDescriptor>()
    const keywordSets = new Map<number, ReadonlySet<number>>()
    for (const electionIdText of Object.keys(table)) {
        if (!POSITIVE_INTEGER_PATTERN.test(electionIdText)) {
            throw new TypeError(`Invalid Character Election id: ${electionIdText}`)
        }
        const electionId = Number(electionIdText)
        const validated = validateCharacterElectionRule(table, electionId, calendar)
        if (validated === null || String(electionId) !== electionIdText) {
            throw new TypeError(`Invalid Character Election ${electionIdText}.`)
        }
        const descriptor = deepFreeze({
            electionId,
            stringId: validated.stringId,
            startTime: validated.startTime,
            endTime: validated.endTime,
            startAt: validated.startAt,
            endAt: validated.endAt,
            keywordIds: [...validated.keywordIds],
        })
        descriptors.set(electionId, descriptor)
        keywordSets.set(electionId, new Set(validated.keywordIds))
    }
    return Object.freeze({
        resolve: (electionId: number) => descriptors.get(electionId) ?? null,
        acceptsKeyword: (electionId: number, keywordId: number) => (
            keywordSets.get(electionId)?.has(keywordId) ?? false
        ),
    })
}

// Cached catalogs are keyed by repository identity and by the calendar offset
// they were parsed under, so a catalog parsed under one offset can never be
// served for another.
const catalogs = new WeakMap<ReadonlyContentRepository, Map<number, CharacterElectionCatalog>>()

export function getCharacterElectionCatalog(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
    calendar: GameCalendarPolicy = getGameCalendar(),
): CharacterElectionCatalog {
    let byOffset = catalogs.get(repository)
    if (byOffset === undefined) {
        byOffset = new Map<number, CharacterElectionCatalog>()
        catalogs.set(repository, byOffset)
    }
    const cached = byOffset.get(calendar.utcOffsetMinutes)
    if (cached !== undefined) return cached
    const catalog = buildCharacterElectionCatalog(repository, calendar)
    byOffset.set(calendar.utcOffsetMinutes, catalog)
    return catalog
}
