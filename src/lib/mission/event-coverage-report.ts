import eventQuestMap from "../../../assets/mission_event_quest_map.json"
import { getExactEventBattleRuleCoverage } from "./event-battle-facts"
import {
    getMissionCatalog,
    isMissionMasterDefinitionEnabledAt,
} from "./mission-catalog"

type EventCountMode = "single" | "multi" | "finish"

interface EventQuestMapping {
    readonly questIds: readonly number[]
    readonly categories: readonly number[]
    readonly countMode: EventCountMode
}

export interface EventMissionCoverageReport {
    readonly total: number
    readonly mapped: number
    readonly exactMultiRules: number
    readonly exactMultiRulesByRole: Readonly<Record<"any" | "host" | "guest", number>>
    readonly unsupported: number
    readonly activeUnsupported: number
    readonly countModes: Readonly<Record<EventCountMode, number>>
    readonly unsupportedPatterns: readonly string[]
}

/** Offline coverage report; runtime settlement does not consume the legacy quest map. */
export function getEventMissionCoverageReport(at: Date): EventMissionCoverageReport {
    const definitions = getMissionCatalog().getDefinitions(3)
    const mappings = eventQuestMap as Readonly<Record<string, EventQuestMapping>>
    const exactCoverage = getExactEventBattleRuleCoverage()
    const unsupportedDefinitions = definitions.filter(definition => mappings[definition.pattern] === undefined)
    const countModes: Record<EventCountMode, number> = { single: 0, multi: 0, finish: 0 }
    for (const definition of definitions) {
        const mapping = mappings[definition.pattern]
        if (mapping) countModes[mapping.countMode]++
    }
    return Object.freeze({
        total: definitions.length,
        mapped: definitions.length - unsupportedDefinitions.length,
        exactMultiRules: exactCoverage.exactMultiRules,
        exactMultiRulesByRole: Object.freeze({ ...exactCoverage.roles }),
        unsupported: unsupportedDefinitions.length,
        activeUnsupported: unsupportedDefinitions.filter(definition =>
            isMissionMasterDefinitionEnabledAt(definition, at)
        ).length,
        countModes: Object.freeze(countModes),
        unsupportedPatterns: Object.freeze(unsupportedDefinitions.map(definition => definition.pattern)),
    })
}
