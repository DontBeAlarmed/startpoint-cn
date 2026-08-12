import { getDegreeComputedMissionIds } from "./computer-degree"
import { getRegularComputedMissionIds } from "./computer-regular"
import { getEventSafeMissionIds } from "./computer-event-safe"
import { getExactEventBattleMissionIds } from "./event-battle-facts"
import { getProducerBackedEventEntryMissionIds } from "./event-entry-facts"
import { getMissionMasterDefinitions } from "./master-data"
import { getAwakeMissionRuleFamilies } from "./awake-rule-catalog"
import type { AwakeMissionRuleFamilyName } from "./awake-rule-catalog"

export interface MissionCoverageEntry {
    readonly category: number
    readonly missionId: number
}

export interface MissionFallbackEntry extends MissionCoverageEntry {
    readonly patternType: number | null
    readonly pattern: string
    readonly reason: string
}

export interface MissionCoveragePartition {
    readonly total: number
    readonly automated: number
    readonly fallback: number
    readonly automatedMissions: readonly MissionCoverageEntry[]
    readonly fallbackMissions: readonly MissionFallbackEntry[]
}

export interface MissionCoverageAudit {
    readonly schemaVersion: 1
    readonly regular: MissionCoveragePartition
    readonly event: MissionCoveragePartition
    readonly degree: MissionCoveragePartition
    readonly awake: {
        readonly total: number
        readonly routed: number
        readonly resolved: number
        readonly failClosed: number
        readonly families: readonly {
            readonly family: AwakeMissionRuleFamilyName
            readonly status: "resolved" | "fail-closed"
            readonly missionIds: readonly number[]
            readonly reason: string
        }[]
        readonly unresolvedMissionIds: readonly number[]
    }
    readonly pass: MissionCoveragePartition
}

function eventFallbackReason(row: readonly unknown[]): string {
    const patternType = Number(row[2])
    if (patternType === 20) return "rescue-source-unavailable"
    if (patternType === 16 && [row[8], row[9], row[10]].includes("")) {
        return "empty-quest-selector"
    }
    if (row[11] !== undefined && row[11] !== "" && row[11] !== "(None)") {
        return "client-check-unverified"
    }
    return `authoritative-event-fact-unavailable:type-${Number.isSafeInteger(patternType) ? patternType : "unknown"}`
}

const DEFERRED_DEGREE_REASON_BY_MISSION_ID: ReadonlyMap<number, string> = new Map([
    [3000, "character-level-curve-incomplete"],
    [25000, "attention-source-unavailable"],
    [25010, "attention-source-unavailable"],
    [25020, "attention-source-unavailable"],
    [70004, "newbie-classification-unavailable"],
    [70005, "newbie-classification-unavailable"],
    [70006, "newbie-classification-unavailable"],
])

function degreeFallbackReason(missionId: number): string {
    return DEFERRED_DEGREE_REASON_BY_MISSION_ID.get(missionId)
        ?? "authoritative-degree-fact-unavailable"
}

const REGULAR_FALLBACK_REASON_BY_MISSION_ID: ReadonlyMap<number, string> = new Map([
    [62, "rescue-source-unavailable"],
    [63, "rescue-source-unavailable"],
    [64, "rescue-source-unavailable"],
    [87, "rescue-source-unavailable"],
    [88, "rescue-source-unavailable"],
    [89, "rescue-source-unavailable"],
    [100, "rescue-source-unavailable"],
    [107, "external-social-check-not-supported"],
    [108, "anniversary-window-semantics-unverified"],
])

function regularPartition(): MissionCoveragePartition {
    return createPartition(
        [{ category: 1, definitions: getMissionMasterDefinitions(1) }],
        missionKeys(1, getRegularComputedMissionIds()),
        (_category, definition) => REGULAR_FALLBACK_REASON_BY_MISSION_ID.get(definition.missionId)
            ?? "authoritative-regular-fact-unavailable",
    )
}

function createPartition(
    categoryDefinitions: readonly { readonly category: number; readonly definitions: ReturnType<typeof getMissionMasterDefinitions> }[],
    automatedKeys: ReadonlySet<string>,
    reason: (category: number, definition: ReturnType<typeof getMissionMasterDefinitions>[number]) => string,
): MissionCoveragePartition {
    const automatedMissions: MissionCoverageEntry[] = []
    const fallbackMissions: MissionFallbackEntry[] = []
    for (const { category, definitions } of categoryDefinitions) {
        for (const definition of definitions) {
            const entry = { category, missionId: definition.missionId }
            if (automatedKeys.has(`${category}:${definition.missionId}`)) {
                automatedMissions.push(entry)
            } else {
                const rawPatternType = definition.patternType
                    ?? Number(definition.row[category === 5 ? 3 : 2])
                fallbackMissions.push({
                    ...entry,
                    patternType: Number.isSafeInteger(rawPatternType)
                        ? rawPatternType
                        : null,
                    pattern: definition.pattern,
                    reason: reason(category, definition),
                })
            }
        }
    }
    const byKey = (left: MissionCoverageEntry, right: MissionCoverageEntry) => (
        left.category - right.category || left.missionId - right.missionId
    )
    automatedMissions.sort(byKey)
    fallbackMissions.sort(byKey)
    return Object.freeze({
        total: automatedMissions.length + fallbackMissions.length,
        automated: automatedMissions.length,
        fallback: fallbackMissions.length,
        automatedMissions: Object.freeze(automatedMissions),
        fallbackMissions: Object.freeze(fallbackMissions),
    })
}

function missionKeys(category: number, missionIds: readonly number[]): Set<string> {
    return new Set(missionIds.map(missionId => `${category}:${missionId}`))
}

function eventPartition(): MissionCoveragePartition {
    const ids = new Set([
        ...getEventSafeMissionIds(),
        ...getExactEventBattleMissionIds(),
        ...getProducerBackedEventEntryMissionIds(),
    ])
    return createPartition(
        [{ category: 3, definitions: getMissionMasterDefinitions(3) }],
        missionKeys(3, [...ids]),
        (_category, definition) => eventFallbackReason(definition.row),
    )
}

function degreePartition(): MissionCoveragePartition {
    return createPartition(
        [{ category: 5, definitions: getMissionMasterDefinitions(5) }],
        missionKeys(5, getDegreeComputedMissionIds()),
        (_category, definition) => degreeFallbackReason(definition.missionId),
    )
}

function passPartition(): MissionCoveragePartition {
    const definitions = [6, 7, 8].map(category => ({
        category,
        definitions: getMissionMasterDefinitions(category),
    }))
    const automated = new Set<string>()
    for (const { category, definitions: entries } of definitions) {
        for (const definition of entries) {
            const type = definition.patternType
            const supported = category === 6 && [14, 16, 28, 39].includes(type ?? -1)
                || category === 7 && [16, 39, 85].includes(type ?? -1)
                || category === 8 && [0, 16, 23].includes(type ?? -1)
            if (supported) automated.add(`${category}:${definition.missionId}`)
        }
    }
    return createPartition(definitions, automated, (_category, definition) => (
        definition.patternType === 20
            ? "rescue-source-unavailable"
            : definition.patternType === 85
                ? "battle-emotion-source-unavailable"
                : "authoritative-pass-fact-unavailable"
    ))
}

function awakeCoverage(): MissionCoverageAudit["awake"] {
    const definitions = getMissionMasterDefinitions(9)
    const families = getAwakeMissionRuleFamilies().map(family => Object.freeze({
        family: family.family,
        status: family.status,
        missionIds: Object.freeze([...family.missionIds]),
        reason: family.reason ?? "",
    }))
    const unresolvedMissionIds = families
        .filter(family => family.status === "fail-closed")
        .flatMap(family => family.missionIds)
        .sort((left, right) => left - right)
    const resolved = families
        .filter(family => family.status === "resolved")
        .reduce((total, family) => total + family.missionIds.length, 0)
    return Object.freeze({
        total: definitions.length,
        routed: families.reduce((total, family) => total + family.missionIds.length, 0),
        resolved,
        failClosed: unresolvedMissionIds.length,
        families: Object.freeze(families),
        unresolvedMissionIds: Object.freeze(unresolvedMissionIds),
    })
}

export function getMissionCoverageAudit(): MissionCoverageAudit {
    return Object.freeze({
        schemaVersion: 1,
        regular: regularPartition(),
        event: eventPartition(),
        degree: degreePartition(),
        awake: awakeCoverage(),
        pass: passPartition(),
    })
}
