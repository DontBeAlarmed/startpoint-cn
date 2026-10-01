/**
 * Shared quest-range translator for mission master rows.
 *
 * Semantics are taken from the CN 1.8.1 client
 * (QuestRangeReferenceIdKind.as / QuestRangeReferenceIdKindTools.as):
 * a range kind maps to quest categories, and the three selector columns
 * become per-kind key queries matched against the quest id's segments.
 * Selector "(None)" is the client's unconstrained value; the empty string
 * is Some([]) client-side (matches nothing) but the completion preflight
 * ruled both read as "unconstrained within the kind" so historically
 * shipped empty-selector rows stay achievable (档 C).
 *
 * Only kinds verified against the client enum are routed; unknown kinds or
 * a truly blank kind column return null and callers fail closed.
 */

export interface MissionQuestRangeLayout {
    readonly kindCol: number
    readonly selectorCols: readonly [number, number, number]
    /**
     * Column holding the battle_kind parameter (1 single / 2 multi / 3 any).
     * Differs per table family: standard tables parse it at column 5
     * (DailyMissionValues parseAt5), collect tables at column 7
     * (CollectItemEventMissionValues parseAt7), pass tables at column 6
     * (PassCardEventMissionValues parseAt6) — all client-verified.
     */
    readonly battleKindCol: number
}

/** regular / daily / event tables: kind at 7, selectors at 8..10. */
export const STANDARD_MISSION_RANGE_LAYOUT: MissionQuestRangeLayout = Object.freeze({
    kindCol: 7,
    selectorCols: Object.freeze([8, 9, 10] as const),
    battleKindCol: 5,
})

/** collect tables: kind at 9, selectors at 10..12. */
export const COLLECT_MISSION_RANGE_LAYOUT: MissionQuestRangeLayout = Object.freeze({
    kindCol: 9,
    selectorCols: Object.freeze([10, 11, 12] as const),
    battleKindCol: 7,
})

/** pass tables: kind at 8, selectors at 9..11. */
export const PASS_MISSION_RANGE_LAYOUT: MissionQuestRangeLayout = Object.freeze({
    kindCol: 8,
    selectorCols: Object.freeze([9, 10, 11] as const),
    battleKindCol: 6,
})

type SegmentStructure = "triple" | "eventId" | "practice" | "none"

interface RangeKindRule {
    /** Client toQuestCategories, 1-based quest category ids. */
    readonly sections: readonly number[]
    readonly structure: SegmentStructure
}

const RANGE_KIND_RULES: Readonly<Record<number, RangeKindRule>> = Object.freeze({
    0: { sections: Object.freeze([1]), structure: "triple" },        // Main
    1: { sections: Object.freeze([4]), structure: "triple" },        // Ex
    2: { sections: Object.freeze([2]), structure: "triple" },        // BossBattle
    3: { sections: Object.freeze([6]), structure: "eventId" },       // DailyWeekEvent
    4: { sections: Object.freeze([14]), structure: "eventId" },      // DailyExpManaEvent
    5: { sections: Object.freeze([7]), structure: "eventId" },       // AdventEvent
    6: { sections: Object.freeze([10]), structure: "eventId" },      // StoryEventSingle
    7: { sections: Object.freeze([13]), structure: "eventId" },      // ChallengeDungeonEvent
    8: { sections: Object.freeze([11]), structure: "eventId" },      // RankingEventSingle
    9: { sections: Object.freeze([18]), structure: "eventId" },      // WorldStoryEvent
    10: { sections: Object.freeze([19]), structure: "eventId" },     // WorldStoryEventBossBattle
    11: { sections: Object.freeze([15]), structure: "practice" },    // Practice
    12: { sections: Object.freeze([6, 14, 13, 20]), structure: "none" }, // DailyWeek+ExpMana+Challenge+Tower
    13: { sections: Object.freeze([20]), structure: "eventId" },     // TowerDungeonEvent
    14: { sections: Object.freeze([21]), structure: "eventId" },     // ExpertSingleEvent
    15: { sections: Object.freeze([22]), structure: "eventId" },     // CarnivalEvent
    16: { sections: Object.freeze([23]), structure: "eventId" },     // RaidEvent
    17: { sections: Object.freeze([24]), structure: "eventId" },     // RushEvent
    18: { sections: Object.freeze([25]), structure: "eventId" },     // SoloTimeAttackEvent
    19: { sections: Object.freeze([26]), structure: "eventId" },     // HardMultiEvent
    20: { sections: Object.freeze([27]), structure: "eventId" },     // ScoreAttackEvent
})

type RangeSegment = { readonly all: true } | { readonly all: false; readonly ids: readonly number[] }

function parseSegment(value: unknown): RangeSegment | undefined {
    if (value === undefined || value === null || value === "(None)" || value === "") return { all: true }
    if (typeof value !== "string") return undefined
    const ids: number[] = []
    for (const part of value.split(",")) {
        const parsed = Number(part)
        if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined
        ids.push(parsed)
    }
    return { all: false, ids }
}

export interface TranslatedMissionQuestRange {
    /** Quest categories the kind maps to; empty when the row has no range. */
    readonly sections: readonly number[]
    /** True when the kind column is "(None)": the row constrains nothing. */
    readonly unconstrained: boolean
    matches(questCategory: number, questId: number): boolean
}

function segmentMatches(segment: RangeSegment, value: number): boolean {
    return segment.all || segment.ids.includes(value)
}

function tripleQuestSegments(questId: number): readonly [number, number, number] {
    return [
        Math.trunc(questId / 1_000_000),
        Math.trunc(questId / 1_000) % 1_000,
        questId % 1_000,
    ]
}

function eventQuestSegments(questId: number): readonly [number, number] {
    return [Math.trunc(questId / 1_000), questId % 1_000]
}

/**
 * Translate a mission row's range columns. Returns null when the kind column
 * is present but unknown, or a selector is malformed — callers fail closed.
 */
export function translateMissionQuestRange(
    row: readonly unknown[],
    layout: MissionQuestRangeLayout = STANDARD_MISSION_RANGE_LAYOUT,
): TranslatedMissionQuestRange | null {
    const rawKind = row[layout.kindCol]
    if (rawKind === undefined || rawKind === null || rawKind === "(None)") {
        return {
            sections: Object.freeze([]),
            unconstrained: true,
            matches: () => true,
        }
    }
    // A truly blank kind string is a client parse crash per the preflight;
    // treat it as unusable data rather than a wildcard.
    if (rawKind === "") return null
    const kind = Number(rawKind)
    if (!Number.isSafeInteger(kind)) return null
    const rule = RANGE_KIND_RULES[kind]
    if (rule === undefined) return null

    const [first, middle, last] = layout.selectorCols.map(col => parseSegment(row[col]))
    if (first === undefined || middle === undefined || last === undefined) return null
    const segments: readonly RangeSegment[] = (() => {
        switch (rule.structure) {
            case "triple": return [first, middle, last]
            case "eventId": return [first, last]
            case "practice": return [last]
            case "none": return []
        }
    })()

    return {
        sections: rule.sections,
        unconstrained: false,
        matches(questCategory: number, questId: number): boolean {
            if (!rule.sections.includes(questCategory)) return false
            if (segments.length === 0) return true
            const questKeys = rule.structure === "triple"
                ? tripleQuestSegments(questId)
                : rule.structure === "eventId"
                    ? eventQuestSegments(questId)
                    : [questId]
            for (let index = 0; index < segments.length; index++) {
                if (!segmentMatches(segments[index], questKeys[index])) return false
            }
            return true
        },
    }
}
