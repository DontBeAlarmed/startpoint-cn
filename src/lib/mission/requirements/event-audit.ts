import eventBattleRules from "../../../../assets/mission_event_battle_rules.json"
import eventQuestMap from "../../../../assets/mission_event_quest_map.json"
import { validateEventEntryCatalogRule } from "../event-entry-facts"
import {
    getEventCurrentStateRule,
    isEventCurrentStateMissionId,
} from "../event-current-state-rules"
import type { MissionCatalog, MissionMasterDefinition } from "../mission-catalog"
import { matchesCurrentMissionComputerDefinition } from "./computer-compatibility"

const HISTORICAL_SINGLE_CLEAR_MISSION_IDS = new Set([
    1213, 1214, 1215, 1221, 1222, 1300, 1303, 1304,
])
const EXACT_STATISTICS_MISSION_IDS = new Set([1200, 1208, 1209, 1210, 1211, 1216, 1223])
const EXACT_RESISTANCE_MISSION_IDS = new Set([600001, 900809])
const EXACT_HARD_MULTI_MISSION_IDS = new Set([
    600002, 600003, 900653, 900728, 900793,
    900810, 900811, 900812, 900813, 900814,
])
const EXACT_SINGLE_CLEAR_MISSION_IDS = new Set([
    1213, 1214, 1215, 1221, 1222, 1300, 1303, 1304,
])
const CLEAR_RANGE_KINDS = new Set([5, 6, 7, 16, 17])

type EventQuestMapping = {
    readonly categories?: readonly number[]
    readonly questIds?: readonly number[]
    readonly countMode?: unknown
}

function parsePositiveIntegerList(value: unknown): readonly number[] | null {
    if (typeof value !== "string" || value.trim() === "") return null
    const values = value.split(",").map(entry => Number(entry.trim()))
    return values.length > 0
        && values.every(entry => Number.isSafeInteger(entry) && entry > 0)
        ? values
        : null
}

function hasSingleTarget(catalog: MissionCatalog, missionId: number): boolean {
    const stages = catalog.getRewardStages(3, missionId)
    return stages.length === 1 && stages[0].stage === 1 && stages[0].targetProgress === 1
}

function hasValidQuestMapping(definition: MissionMasterDefinition): boolean {
    const mapping = (eventQuestMap as Readonly<Record<string, EventQuestMapping>>)[definition.pattern]
    return mapping?.countMode === "single"
        && Array.isArray(mapping.categories)
        && mapping.categories.length > 0
        && mapping.categories.every(value => Number.isSafeInteger(value) && value > 0)
        && Array.isArray(mapping.questIds)
        && mapping.questIds.length > 0
        && mapping.questIds.every(value => Number.isSafeInteger(value) && value > 0)
}

function isSafeDefinition(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
    visiting: Set<number>,
): boolean {
    if (!matchesCurrentMissionComputerDefinition(definition)) return false
    const { missionId, row, pattern } = definition
    if (getEventCurrentStateRule(
        definition,
        catalog.getRewardStages(3, missionId),
    )) return true
    if (HISTORICAL_SINGLE_CLEAR_MISSION_IDS.has(missionId)) {
        return hasSingleTarget(catalog, missionId)
    }

    const patternType = Number(row[2])
    if (patternType === 37) {
        const itemId = Number(row[12])
        return Number.isSafeInteger(itemId) && itemId > 0
    }
    if (patternType === 23 && pattern.startsWith("haniwa_carnival_mission_")) {
        return Number.isSafeInteger(Number(row[8])) && Number(row[8]) > 0
            && Number.isSafeInteger(Number(row[10])) && Number(row[10]) > 0
    }
    if (patternType === 14 && pattern.startsWith("challenge_renewal_")) {
        return Number.isSafeInteger(Number(row[8])) && Number(row[8]) > 0
            && (String(row[10] ?? "").trim() === ""
                || parsePositiveIntegerList(row[10]) !== null)
    }
    if (patternType === 15 && (Number(row[7]) === 8 || Number(row[7]) === 17)) {
        return Number.isSafeInteger(Number(row[8])) && Number(row[8]) > 0
            && Number.isSafeInteger(Number(row[10])) && Number(row[10]) > 0
    }
    if (patternType !== 13) return false

    const dependencies = parsePositiveIntegerList(row[17])
    if (!dependencies) return hasValidQuestMapping(definition)
    if (visiting.has(missionId)) return false
    visiting.add(missionId)
    try {
        return dependencies.every(dependencyId => {
            const dependency = catalog.getDefinition(3, dependencyId)
            return dependency !== undefined && isSafeDefinition(dependency, catalog, visiting)
        })
    } finally {
        visiting.delete(missionId)
    }
}

function isGeneratedMultiRule(definition: MissionMasterDefinition): boolean {
    const rule = eventBattleRules.rules.find(entry => entry.missionId === definition.missionId)
    if (!rule) return false
    return Number(definition.row[2]) === rule.patternType
        && definition.row[11] === "(None)"
        && (rule.patternType === 16 && rule.role === "any"
            || rule.patternType === 17 && rule.role === "host"
            || rule.patternType === 18 && rule.role === "guest")
}

function isExactClearRule(definition: MissionMasterDefinition): boolean {
    const row = definition.row
    const battleKind = Number(row[5])
    return Number(row[2]) === 23
        && (battleKind === 1 || battleKind === 3)
        && CLEAR_RANGE_KINDS.has(Number(row[7]))
        && Number.isSafeInteger(Number(row[8]))
        && Number(row[8]) > 0
        && parsePositiveIntegerList(row[10]) !== null
        && row[11] === "(None)"
}

function isExactPhaseRule(definition: MissionMasterDefinition): boolean {
    const row = definition.row
    const patternType = Number(row[2])
    return patternType >= 49 && patternType <= 52
        && Number(row[7]) === 8
        && Number.isSafeInteger(Number(row[8])) && Number(row[8]) > 0
        && Number.isSafeInteger(Number(row[10])) && Number(row[10]) > 0
}

export function isExactEventBattleProducerDefinition(
    definition: MissionMasterDefinition,
): boolean {
    if (!matchesCurrentMissionComputerDefinition(definition)) return false
    return isGeneratedMultiRule(definition)
        || isExactClearRule(definition)
        || isExactPhaseRule(definition)
        || EXACT_STATISTICS_MISSION_IDS.has(definition.missionId)
        || EXACT_RESISTANCE_MISSION_IDS.has(definition.missionId)
        || EXACT_HARD_MULTI_MISSION_IDS.has(definition.missionId)
        || EXACT_SINGLE_CLEAR_MISSION_IDS.has(definition.missionId)
}

export interface EventRequirementView {
    readonly safeMissionIds: ReadonlySet<number>
    readonly producerMissionIds: ReadonlySet<number>
}

export function buildEventRequirementView(catalog: MissionCatalog): EventRequirementView {
    const safeMissionIds = new Set<number>()
    const producerMissionIds = new Set<number>()
    for (const definition of catalog.getDefinitions(3)) {
        if (isSafeDefinition(definition, catalog, new Set())) {
            safeMissionIds.add(definition.missionId)
            continue
        }
        if (isExactEventBattleProducerDefinition(definition)
            || validateEventEntryCatalogRule(
                definition,
                catalog.getRewardStages(3, definition.missionId),
            )) {
            producerMissionIds.add(definition.missionId)
        }
    }
    return Object.freeze({ safeMissionIds, producerMissionIds })
}

export function isEventCurrentStateMission(missionId: number): boolean {
    return isEventCurrentStateMissionId(missionId)
}
