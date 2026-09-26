import type { FactKey } from "./facts/fact-key"
import type { MissionCatalogStage, MissionMasterDefinition } from "./mission-catalog"

export type EventCurrentStateFact =
    | "maxCharacterLevel"
    | "manaBoardNodeCount"
    | "overLimitCount"
    | "characterEpisodeClearCount"
    | "mainChapterClear"
    | "equipmentAwakeningCount"
    | "hasEquippedAbilitySoul"

export interface EventCurrentStateRule {
    readonly patternType: number
    readonly targets: readonly number[]
    readonly fact: EventCurrentStateFact
    readonly mainChapter?: number
}

const EVENT_CURRENT_STATE_RULES: Readonly<Record<number, EventCurrentStateRule>> = Object.freeze({
    1201: { patternType: 22, targets: [1], fact: "mainChapterClear", mainChapter: 1 },
    1202: { patternType: 22, targets: [1], fact: "mainChapterClear", mainChapter: 2 },
    1203: { patternType: 22, targets: [1], fact: "mainChapterClear", mainChapter: 3 },
    1204: { patternType: 21, targets: [1], fact: "characterEpisodeClearCount" },
    1205: { patternType: 7, targets: [3], fact: "manaBoardNodeCount" },
    1206: { patternType: 7, targets: [3], fact: "manaBoardNodeCount" },
    1207: { patternType: 7, targets: [3], fact: "manaBoardNodeCount" },
    1212: { patternType: 34, targets: [1], fact: "equipmentAwakeningCount" },
    1217: { patternType: 7, targets: [15], fact: "manaBoardNodeCount" },
    1218: { patternType: 7, targets: [15], fact: "manaBoardNodeCount" },
    1219: { patternType: 7, targets: [15], fact: "manaBoardNodeCount" },
    1220: { patternType: 35, targets: [1], fact: "hasEquippedAbilitySoul" },
    1305: { patternType: 5, targets: [50, 60, 70], fact: "maxCharacterLevel" },
    1306: { patternType: 9, targets: [1], fact: "overLimitCount" },
    1307: { patternType: 34, targets: [1, 2, 3, 4], fact: "equipmentAwakeningCount" },
})

function hasExpectedTargets(
    stages: readonly MissionCatalogStage[],
    expected: readonly number[],
): boolean {
    return stages.length === expected.length
        && stages.every((stage, index) => (
            stage.stage === index + 1 && stage.targetProgress === expected[index]
        ))
}

export function getEventCurrentStateRule(
    definition: MissionMasterDefinition,
    stages: readonly MissionCatalogStage[],
): EventCurrentStateRule | undefined {
    const rule = EVENT_CURRENT_STATE_RULES[definition.missionId]
    if (!rule
        || Number(definition.row[2]) !== rule.patternType
        || !hasExpectedTargets(stages, rule.targets)
        || definition.row[11] !== "(None)") return undefined
    if (rule.fact !== "mainChapterClear") {
        return definition.row[7] === "(None)" ? rule : undefined
    }
    return Number(definition.row[7]) === 0
        && Number(definition.row[8]) === rule.mainChapter
        && definition.row[9] === "(None)"
        && definition.row[10] === "(None)"
        ? rule
        : undefined
}

/** Fact domains each current-state fact counts from, single-sourced with the rules. */
const CURRENT_STATE_FACT_KEYS: Readonly<Record<EventCurrentStateFact, readonly FactKey[]>> = Object.freeze({
    maxCharacterLevel: Object.freeze<readonly FactKey[]>([{ kind: "characters" }]),
    overLimitCount: Object.freeze<readonly FactKey[]>([{ kind: "characters" }]),
    mainChapterClear: Object.freeze<readonly FactKey[]>([{ kind: "questProgress", sections: [1] }]),
    characterEpisodeClearCount: Object.freeze<readonly FactKey[]>([
        { kind: "characters" },
        { kind: "questProgress", sections: [3] },
    ]),
    manaBoardNodeCount: Object.freeze<readonly FactKey[]>([
        { kind: "characters" },
        { kind: "characterManaNodes" },
    ]),
    equipmentAwakeningCount: Object.freeze<readonly FactKey[]>([{ kind: "equipment" }]),
    hasEquippedAbilitySoul: Object.freeze<readonly FactKey[]>([
        { kind: "items" },
        { kind: "partyGroups", category: 1 },
    ]),
})

/**
 * Requirement facts for a current-state mission, derived from its rule's
 * fact field. This replaces the missionId-keyed switch provider-event.ts
 * used to carry: the rule table is the single authority.
 */
export function getEventCurrentStateFactKeys(missionId: number): readonly FactKey[] | undefined {
    const rule = EVENT_CURRENT_STATE_RULES[missionId]
    return rule === undefined ? undefined : CURRENT_STATE_FACT_KEYS[rule.fact]
}

export function getEventCurrentStateRuleMissionIds(): readonly number[] {
    return Object.freeze(Object.keys(EVENT_CURRENT_STATE_RULES).map(Number).sort((a, b) => a - b))
}

export function isEventCurrentStateMissionId(missionId: number): boolean {
    return EVENT_CURRENT_STATE_RULES[missionId] !== undefined
}
