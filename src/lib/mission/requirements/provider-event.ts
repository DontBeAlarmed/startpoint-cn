import type { MissionCatalog, MissionMasterDefinition } from "../mission-catalog"
import { getEventQuestMapping } from "../event-content"
import { getEventCurrentStateFactKeys } from "../event-current-state-rules"
import type { FactKey } from "../facts/fact-key"
import type { MissionFactRequirementDraft, MissionRef } from "./types"
import { EVENT_QUEST_SECTIONS_BY_CONDITION_AND_RANGE } from "./condition-routing"
import {
    buildEventRequirementView,
    isEventCurrentStateMission,
    type EventRequirementView,
} from "./event-audit"

type QuestMapEntry = {
    readonly categories?: readonly number[]
}

const viewByCatalog = new WeakMap<MissionCatalog, EventRequirementView>()

function getView(catalog: MissionCatalog): EventRequirementView {
    const cached = viewByCatalog.get(catalog)
    if (cached) return cached
    const view = buildEventRequirementView(catalog)
    viewByCatalog.set(catalog, view)
    return view
}

function parseMissionDependencies(definition: MissionMasterDefinition): readonly MissionRef[] {
    if (Number(definition.row[2]) !== 13 || typeof definition.row[17] !== "string") return []
    const values = definition.row[17].split(",").map(Number)
    return values.length > 0 && values.every(value => Number.isSafeInteger(value) && value > 0)
        ? values.map(missionId => ({ category: 3, missionId }))
        : []
}

function questFacts(catalog: MissionCatalog, definition: MissionMasterDefinition): readonly FactKey[] {
    const mapping = getEventQuestMapping(catalog, definition.pattern) as QuestMapEntry | undefined
    const sections = mapping?.categories?.filter(category => (
        Number.isSafeInteger(category) && category > 0
    ))
    if (sections && sections.length > 0) return [{ kind: "questProgress", sections }]

    // Condition + range-kind fallback sections (single-channel table); the
    // haniwa family is range kind 15 of condition 23, not a pattern prefix.
    const patternType = Number(definition.row[2])
    const rangeKind = Number(definition.row[7])
    const tableSections = EVENT_QUEST_SECTIONS_BY_CONDITION_AND_RANGE[patternType]
    const fallback = tableSections === undefined ? undefined : tableSections[rangeKind]
    if (fallback !== undefined) {
        return [{ kind: "questProgress", sections: [...fallback] }]
    }
    return [{ kind: "questProgress", sections: "all" }]
}

interface EventDependencyFacts {
    readonly facts: readonly FactKey[]
    readonly missionIds: readonly number[]
}

function directComputedFacts(catalog: MissionCatalog, definition: MissionMasterDefinition): readonly FactKey[] {
    const { missionId } = definition
    if (isEventCurrentStateMission(missionId)) {
        // Facts derive from the rule table's fact field; the characters
        // fallback keeps the historical default for any rule without a
        // fact-key mapping (none in the current table).
        return getEventCurrentStateFactKeys(missionId) ?? [{ kind: "characters" }]
    }
    if (Number(definition.row[2]) === 37) {
        const itemId = Number(definition.row[12])
        return Number.isSafeInteger(itemId) && itemId > 0
            ? [{ kind: "collectedItems", itemIds: [itemId] }]
            : []
    }
    return questFacts(catalog, definition)
}

function collectDependencyFacts(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
    view: EventRequirementView,
    visiting: Set<number>,
): EventDependencyFacts | undefined {
    const dependencies = parseMissionDependencies(definition)
    const facts: FactKey[] = []
    const missionIds = new Set<number>()
    for (const dependency of dependencies) {
        if (visiting.has(dependency.missionId)
            || !view.safeMissionIds.has(dependency.missionId)) return undefined
        const child = catalog.getDefinition(dependency.category, dependency.missionId)
        if (!child) return undefined
        missionIds.add(dependency.missionId)
        const childDependencies = parseMissionDependencies(child)
        if (childDependencies.length === 0) {
        facts.push(...directComputedFacts(catalog, child))
            continue
        }
        visiting.add(dependency.missionId)
        const nested = collectDependencyFacts(child, catalog, view, visiting)
        visiting.delete(dependency.missionId)
        if (!nested) return undefined
        facts.push(...nested.facts)
        for (const missionId of nested.missionIds) missionIds.add(missionId)
    }
    return { facts, missionIds: [...missionIds] }
}

export function getEventRequirement(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): MissionFactRequirementDraft {
    const view = getView(catalog)
    const { missionId } = definition
    if (view.safeMissionIds.has(missionId)) {
        const missionDependencies = parseMissionDependencies(definition)
        if (missionDependencies.length === 0) {
            const facts = directComputedFacts(catalog, definition)
            return facts.length > 0
                ? { mode: "computed", facts }
                : {
                    mode: "unsupported",
                    reason: "Event computed selector produced no authoritative facts.",
                }
        }
        const dependencyFacts = collectDependencyFacts(
            definition,
            catalog,
            view,
            new Set([missionId]),
        )
        if (!dependencyFacts || dependencyFacts.missionIds.length === 0) {
            return {
                mode: "unsupported",
                reason: "Event aggregate dependency graph is malformed.",
            }
        }
        return {
            mode: "computed",
            missionDependencies,
            facts: [
                ...dependencyFacts.facts,
                {
                    kind: "categoryMissionProgress",
                    category: 3,
                    missionIds: dependencyFacts.missionIds,
                },
            ],
        }
    }
    if (view.producerMissionIds.has(missionId)) return { mode: "persisted" }
    return {
        mode: "unsupported",
        reason: "Event selector has no authoritative computed mapping or atomic producer.",
    }
}
