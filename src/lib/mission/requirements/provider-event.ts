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

export function getEventRequirement(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): MissionFactRequirementDraft {
    const view = getView(catalog)
    const { missionId } = definition
    if (view.safeMissionIds.has(missionId)) {
        if (isEventCurrentStateMission(missionId)) {
            return { mode: "computed", facts: currentStateFacts(missionId) }
        }
        if (Number(definition.row[2]) === 37) {
            const itemId = Number(definition.row[12])
            return Number.isSafeInteger(itemId) && itemId > 0
                ? { mode: "computed", facts: [{ kind: "collectedItems", itemIds: [itemId] }] }
                : {
                    mode: "unsupported",
                    reason: "Event item selector is not authoritative.",
                }
        }
        const missionDependencies = parseMissionDependencies(definition)
        return missionDependencies.length > 0
            ? { mode: "computed", missionDependencies }
            : { mode: "computed", facts: questFacts(definition) }
    }
    if (view.producerMissionIds.has(missionId)) return { mode: "persisted" }
    return {
        mode: "unsupported",
        reason: "Event selector has no authoritative computed mapping or atomic producer.",
    }
}
