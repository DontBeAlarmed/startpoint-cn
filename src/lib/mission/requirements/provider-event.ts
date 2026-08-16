import eventQuestMap from "../../../../assets/mission_event_quest_map.json"
import type { MissionCatalog, MissionMasterDefinition } from "../mission-catalog"
import type { FactKey } from "../facts/fact-key"
import type { MissionFactRequirementDraft, MissionRef } from "./types"
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

function currentStateFacts(missionId: number): readonly FactKey[] {
    if ([1201, 1202, 1203].includes(missionId)) {
        return [{ kind: "questProgress", sections: [1] }]
    }
    if (missionId === 1204) {
        return [{ kind: "characters" }, { kind: "questProgress", sections: [3] }]
    }
    if ([1205, 1206, 1207, 1217, 1218, 1219].includes(missionId)) {
        return [{ kind: "characters" }, { kind: "characterManaNodes" }]
    }
    if (missionId === 1212 || missionId === 1307) return [{ kind: "equipment" }]
    if (missionId === 1220) {
        return [
            { kind: "items" },
            { kind: "partyGroups", category: 1 },
        ]
    }
    return [{ kind: "characters" }]
}

function questFacts(definition: MissionMasterDefinition): readonly FactKey[] {
    const mapping = (eventQuestMap as Readonly<Record<string, QuestMapEntry>>)[definition.pattern]
    const sections = mapping?.categories?.filter(category => (
        Number.isSafeInteger(category) && category > 0
    ))
    if (sections && sections.length > 0) return [{ kind: "questProgress", sections }]

    const patternType = Number(definition.row[2])
    const rangeKind = Number(definition.row[7])
    if (patternType === 14 && rangeKind === 1) {
        return [{ kind: "questProgress", sections: [4] }]
    }
    if (patternType === 14 && rangeKind === 12) {
        return [{ kind: "questProgress", sections: [6, 13, 14, 20] }]
    }
    if (patternType === 14 && rangeKind === 13) {
        return [{ kind: "questProgress", sections: [13] }]
    }
    if (patternType === 15 && (rangeKind === 8 || rangeKind === 17)) {
        return [{ kind: "questProgress", sections: [rangeKind === 8 ? 11 : 24] }]
    }
    if (patternType === 23 && definition.pattern.startsWith("haniwa_carnival_mission_")) {
        return [{ kind: "questProgress", sections: [22] }]
    }
    return [{ kind: "questProgress", sections: "all" }]
}

interface EventDependencyFacts {
    readonly facts: readonly FactKey[]
    readonly missionIds: readonly number[]
}

function directComputedFacts(definition: MissionMasterDefinition): readonly FactKey[] {
    const { missionId } = definition
    if (isEventCurrentStateMission(missionId)) return currentStateFacts(missionId)
    if (Number(definition.row[2]) === 37) {
        const itemId = Number(definition.row[12])
        return Number.isSafeInteger(itemId) && itemId > 0
            ? [{ kind: "collectedItems", itemIds: [itemId] }]
            : []
    }
    return questFacts(definition)
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
            facts.push(...directComputedFacts(child))
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
            const facts = directComputedFacts(definition)
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
