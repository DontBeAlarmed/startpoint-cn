import { getDegreeComputedMissionIds } from "./computer-degree"
import { getRegularComputedMissionIds } from "./computer-regular"
import { getEventSafeMissionIds } from "./computer-event-safe"
import { getExactEventBattleMissionIds } from "./event-battle-facts"
import { getProducerBackedEventEntryMissionIds } from "./event-entry-facts"
import { getAwakeMissionRuleFamilies } from "./awake-rule-catalog"
import type { AwakeMissionRuleFamilyName } from "./awake-rule-catalog"
import { MissionMasterDefinition, getMissionCatalog } from "./mission-catalog"
import { getMissionRequirementDraft } from "./requirements/providers"

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
    readonly schemaVersion: 2
    readonly regular: MissionCoveragePartition
    readonly daily: MissionCoveragePartition
    readonly event: MissionCoveragePartition
    readonly collect: MissionCoveragePartition
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
    readonly weekly: MissionCoveragePartition
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

function degreeFallbackReason(missionId: number): string {
    return "authoritative-degree-fact-unavailable"
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
])

function dailyFallbackReason(definition: MissionMasterDefinition): string {
    const patternType = Number(definition.row[2])
    if (patternType === 20) return "rescue-source-unavailable"
    return `authoritative-daily-fact-unavailable:type-${Number.isSafeInteger(patternType) ? patternType : "unknown"}`
}

function collectFallbackReason(definition: MissionMasterDefinition): string {
    const draft = getMissionRequirementDraft(definition, getMissionCatalog())
    if (draft.mode === "unsupported" && draft.reason !== undefined
        && draft.reason !== "Collect mission shape has no authoritative fact source.") {
        return draft.reason
    }
    const patternType = Number(definition.row[4])
    return `authoritative-collect-fact-unavailable:type-${Number.isSafeInteger(patternType) ? patternType : "unknown"}`
}

/**
 * Daily, collect, and weekly partitions are derived from the requirement
 * provider itself: a mission is automated when the provider routes it to a
 * computed mapping or an atomic producer, and fallback otherwise. The
 * provider is the single authority for these categories' wiring, so the
 * partition can never drift from the actual settlement routing.
 */
function requirementBackedPartition(
    category: number,
    reason: (definition: MissionMasterDefinition) => string,
): MissionCoveragePartition {
    const catalog = getMissionCatalog()
    const definitions = catalog.getDefinitions(category)
    const automated = new Set<string>()
    for (const definition of definitions) {
        if (getMissionRequirementDraft(definition, catalog).mode !== "unsupported") {
            automated.add(`${category}:${definition.missionId}`)
        }
    }
    return createPartition([{ category, definitions }], automated, (_category, definition) => (
        reason(definition)
    ))
}

function regularPartition(): MissionCoveragePartition {
    // 62/63/64/87/88/89（patternType 20 救援通关）由多人 finish 的救援计数
    // 生产者直接递增（见 rescue-battle-counters），属生产者支持而非 regular
    // computer 的 computed 集。
    const producerBacked = missionKeys(1, [62, 63, 64, 87, 88, 89, 100])
    const automated = missionKeys(1, getRegularComputedMissionIds())
    for (const key of producerBacked) automated.add(key)
    return createPartition(
        [{ category: 1, definitions: getMissionCatalog().getDefinitions(1) }],
        automated,
        (_category, definition) => REGULAR_FALLBACK_REASON_BY_MISSION_ID.get(definition.missionId)
            ?? "authoritative-regular-fact-unavailable",
    )
}

function createPartition(
    categoryDefinitions: readonly { readonly category: number; readonly definitions: readonly MissionMasterDefinition[] }[],
    automatedKeys: ReadonlySet<string>,
    reason: (category: number, definition: MissionMasterDefinition) => string,
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
        [{ category: 3, definitions: getMissionCatalog().getDefinitions(3) }],
        missionKeys(3, [...ids]),
        (_category, definition) => eventFallbackReason(definition.row),
    )
}

function degreePartition(): MissionCoveragePartition {
    return createPartition(
        [{ category: 5, definitions: getMissionCatalog().getDefinitions(5) }],
        missionKeys(5, getDegreeComputedMissionIds()),
        (_category, definition) => degreeFallbackReason(definition.missionId),
    )
}

function passPartition(): MissionCoveragePartition {
    // Provider-backed, same as the daily/collect/weekly partitions: the
    // requirement provider is the single routing authority for the pass
    // categories, so the partition cannot drift from settlement routing.
    const catalog = getMissionCatalog()
    const definitions = [6, 7, 8].map(category => ({
        category,
        definitions: catalog.getDefinitions(category),
    }))
    const automated = new Set<string>()
    for (const { category, definitions: entries } of definitions) {
        for (const definition of entries) {
            if (getMissionRequirementDraft(definition, catalog).mode !== "unsupported") {
                automated.add(`${category}:${definition.missionId}`)
            }
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
    const definitions = getMissionCatalog().getDefinitions(9)
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
        schemaVersion: 2,
        regular: regularPartition(),
        daily: requirementBackedPartition(2, dailyFallbackReason),
        event: eventPartition(),
        collect: requirementBackedPartition(4, collectFallbackReason),
        degree: degreePartition(),
        awake: awakeCoverage(),
        pass: passPartition(),
        weekly: requirementBackedPartition(
            10,
            () => "authoritative-weekly-fact-unavailable",
        ),
    })
}
