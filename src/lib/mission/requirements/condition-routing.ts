import type { FactKey } from "../facts/fact-key"
import type { DegreeContextFactFamily } from "../degree-context-requirements"

/**
 * Single-channel condition routing tables: (category, condition number) →
 * counting capability, in the same form as the daily and collect chains'
 * condition-number constants.
 *
 * Routing discriminators are row data only (range kind, statistics code,
 * selector/item columns) — never pattern names. The retired pattern-name
 * lists (Regular fact patterns, Degree family prefixes, the Event haniwa and
 * challenge-renewal prefixes) live on as startup cross-checks in
 * routing-validation.ts: they still pin the audited data they were built
 * from, so content that re-shapes a known pattern fails startup loudly
 * instead of silently re-routing.
 *
 * Evidence anchors: every table below was derived row-by-row from the
 * bundled CN 1.8.1 content snapshot (5986 rows) and locked by
 * tools/mission_coverage_audit.test.cjs plus the per-chain routing suites;
 * the range-kind → quest-section mappings follow the client-verified kind
 * table of the shared quest-range translator.
 */

const PLAYER_FACTS: readonly FactKey[] = Object.freeze([{ kind: "player" }])
const CHARACTER_FACTS: readonly FactKey[] = Object.freeze([{ kind: "characters" }])
const BATTLE_COUNTER_FACTS: readonly FactKey[] = Object.freeze([{ kind: "missionBattleCounters" }])
const DEGREE_BATTLE_STATS_FACTS: readonly FactKey[] = Object.freeze([{ kind: "degreeBattleStats" }])
const MANA_NODE_FACTS: readonly FactKey[] = Object.freeze([{ kind: "characterManaNodes" }])
const EQUIPMENT_FACTS: readonly FactKey[] = Object.freeze([{ kind: "equipment" }])

// ---------------------------------------------------------------------------
// Regular (category 1), condition column row[2]
// ---------------------------------------------------------------------------

/** Conditions whose counting capability is fully determined by the condition number. */
export const REGULAR_COMPUTED_FACTS_BY_CONDITION: Readonly<Record<number, readonly FactKey[]>> = Object.freeze({
    0: PLAYER_FACTS, // total login days family
    1: PLAYER_FACTS, // player rank
    2: PLAYER_FACTS, // total mana obtained
    4: CHARACTER_FACTS, // characters owned
    5: CHARACTER_FACTS, // max character level
    6: CHARACTER_FACTS, // level-80 characters
    7: MANA_NODE_FACTS, // released mana nodes
    8: CHARACTER_FACTS, // bond tokens obtained
    9: CHARACTER_FACTS, // over-limit characters
    11: EQUIPMENT_FACTS, // equipment kinds collected
    16: BATTLE_COUNTER_FACTS, // multi clears
    17: BATTLE_COUNTER_FACTS, // multi host clears
    18: BATTLE_COUNTER_FACTS, // multi guest clears
    21: Object.freeze<readonly FactKey[]>([{ kind: "questProgress", sections: [3] }]), // episodes read
    25: BATTLE_COUNTER_FACTS, // max single score
    27: DEGREE_BATTLE_STATS_FACTS, // max party power
    30: PLAYER_FACTS, // max combo
    31: DEGREE_BATTLE_STATS_FACTS, // max skill chain
    34: EQUIPMENT_FACTS, // equipment awakenings
    36: EQUIPMENT_FACTS, // max-level equipment
    47: CHARACTER_FACTS, // second mana board opened
    48: Object.freeze<readonly FactKey[]>([CHARACTER_FACTS[0], MANA_NODE_FACTS[0]]),
})

/** Atomic-producer conditions (mana/MVP/ability-soul/social writes). */
export const REGULAR_PERSISTED_CONDITIONS: ReadonlySet<number> = new Set([3, 19, 23, 32, 35, 67])

/**
 * Quest-range conditions: range kind row[7] selects the quest fact section
 * through the quest-rule resolver (which validates the selector columns);
 * a missing range kind keeps the battle-counter capability for 14/26.
 */
export const REGULAR_QUEST_RANGE_CONDITIONS: ReadonlySet<number> = new Set([14, 22, 26])
export const REGULAR_QUEST_SECTION_BY_RANGE_KIND: Readonly<Record<number, number>> = Object.freeze({
    0: 1, // main story chapter quests
    1: 4, // ex quests
    11: 15, // practice quests
})

/** Condition 26 with an EX range counts SS ranks in the EX section directly. */
export const REGULAR_EX_RANK_SS_SECTION = 4

/**
 * Condition 28 splits by zone-statistics code row[3]: dash/power-flip are
 * player lifetime counters, skill use is a battle counter, the rest are
 * degree battle statistics. Codes agree with the collect/daily producer map.
 */
export const REGULAR_TYPE_28_FACTS_BY_STATISTICS_CODE: Readonly<Record<number, readonly FactKey[]>> = Object.freeze({
    0: DEGREE_BATTLE_STATS_FACTS,
    1: PLAYER_FACTS,
    2: PLAYER_FACTS,
    4: BATTLE_COUNTER_FACTS,
    5: DEGREE_BATTLE_STATS_FACTS,
    7: DEGREE_BATTLE_STATS_FACTS,
})

/** Craft-point accumulation; the item id comes from the catalog config. */
export const REGULAR_CRAFT_POINT_CONDITION = 37

// ---------------------------------------------------------------------------
// Degree (category 5), condition column row[3]
// ---------------------------------------------------------------------------

/** Conditions whose fact family is fully determined by the condition number. */
export const DEGREE_FACT_FAMILIES_BY_CONDITION: Readonly<Record<number, readonly DegreeContextFactFamily[]>> = Object.freeze({
    0: ["player"], // login count
    1: ["player"], // player rank growth
    4: ["characters"], // companions
    5: ["characters"], // character level
    8: ["characters"], // proof of bond
    9: ["characters"], // over-limit
    7: ["manaNodes"], // mana board growth
    15: ["missionBattleCounters"], // single time-clear
    16: ["missionBattleCounters"], // multi clears
    17: ["missionBattleCounters"], // multi host clears
    21: ["episodeClearCount"], // character episodes read
    22: ["episodeChapters"], // all-episode chapter clear
    25: ["missionBattleCounters"], // single score
    27: ["degreeBattleStats"], // max party power
    29: ["degreeBattleStats"], // onetime damage / revival coffins
    30: ["player"], // onetime combo
    31: ["degreeBattleStats"], // skill chain
    36: ["equipment"], // max-level equipment
    39: ["player"], // stamina use
    45: ["treasureShop"], // treasure shop purchases
    20: ["missionBattleCounters"], // rescue battle clears (bell-join semantics)
    92: ["missionBattleCounters"], // newbie multi battle clears
    44: ["characters"], // specific-character bond (row[15] selector)
    48: ["characters", "manaNodes"], // second mana board per-character or aggregate
})

/** Atomic-producer conditions: operations (mana, MVP, awakening, souls) and client-reported selectors. */
export const DEGREE_PERSISTED_CONDITIONS: ReadonlySet<number> = new Set([3, 19, 34, 35])
export const DEGREE_CLIENT_PROGRESS_CONDITIONS: ReadonlySet<number> = new Set([40, 41, 42, 43])

/** Condition 14 challenge clears: range kind row[8] selects the capability. */
export interface DegreeChallengeRule {
    readonly kind: "battleCounters" | "finishedQuest"
    readonly section?: number
    readonly bossBattleSuperQuest?: boolean
}

export const DEGREE_CHALLENGE_RULES_BY_RANGE_KIND: Readonly<Record<number, DegreeChallengeRule>> = Object.freeze({
    2: { kind: "finishedQuest", section: 2, bossBattleSuperQuest: true }, // boss battle EX super
    5: { kind: "finishedQuest", section: 7 }, // boss epuration event
    9: { kind: "finishedQuest", section: 18 }, // event challenge quests
    12: { kind: "battleCounters" }, // challenge dungeon clears
    14: { kind: "finishedQuest", section: 21 }, // challenge single battles
})

/** Condition 23 battle clears: range kinds 15/19 are finished-quest sections; the selector shapes stay persisted. */
export const DEGREE_TYPE_23_SECTION_BY_RANGE_KIND: Readonly<Record<number, number>> = Object.freeze({
    15: 22, // haniwa carnival quests
    19: 26, // steam robot challenges
})

/** Condition 26: range kind 11 is the practice SS family; rangeless rows are battle counters. */
export const DEGREE_PRACTICE_RANGE_KIND = 11

/** Condition 28 splits by zone-statistics code row[4] (same code space as Regular). */
export const DEGREE_TYPE_28_FAMILY_BY_STATISTICS_CODE: Readonly<Record<number, DegreeContextFactFamily[]>> = Object.freeze({
    0: ["degreeBattleStats"],
    2: ["player"], // dash
    4: ["missionBattleCounters"], // skill
    5: ["degreeBattleStats"],
    7: ["degreeBattleStats"],
    8: ["degreeBattleStats"],
    9: ["degreeBattleStats"],
    10: ["degreeBattleStats"],
    11: ["degreeBattleStats"],
    12: ["degreeBattleStats"],
    13: ["degreeBattleStats"],
    14: ["degreeBattleStats"],
    15: ["degreeBattleStats"],
    16: ["degreeBattleStats"],
})

/**
 * Condition 37 collected items: the item column (row[13]) holds either the
 * master craft currency id — whose fact follows the catalog config, not the
 * row — or an event collect item whose fact is the row value itself.
 */
export const DEGREE_COLLECT_ITEM_CONDITION = 37
export const DEGREE_COLLECT_ITEM_COLUMN = 13

// ---------------------------------------------------------------------------
// Event (category 3), condition column row[2], range kind row[7]
// ---------------------------------------------------------------------------

/**
 * Quest-section fallbacks for computed Event selectors whose quest mapping
 * table carries no categories: condition + range kind → sections. The
 * quest-mapping table itself (mission_event_quest_map.json) stays the first
 * authority when it provides categories.
 */
export const EVENT_QUEST_SECTIONS_BY_CONDITION_AND_RANGE: Readonly<Record<number, Readonly<Record<number, readonly number[]>>>> = Object.freeze({
    14: Object.freeze({
        1: Object.freeze([4]),
        12: Object.freeze([6, 13, 14, 20]),
        13: Object.freeze([13]),
    }),
    15: Object.freeze({
        8: Object.freeze([11]), // time attack
        17: Object.freeze([24]), // combat diver
    }),
    23: Object.freeze({
        15: Object.freeze([22]), // haniwa carnival quests
    }),
})

// ---------------------------------------------------------------------------
// Pass (categories 6/7/8), condition = patternType
// ---------------------------------------------------------------------------

const DAILY_SNAPSHOT_FACT: FactKey = Object.freeze({ kind: "periodicSnapshot", snapshotKind: "daily" })

export const PASS_DAILY_COMPUTED_CONDITIONS: Readonly<Record<number, readonly FactKey[]>> = Object.freeze({
    14: Object.freeze<readonly FactKey[]>([BATTLE_COUNTER_FACTS[0], DAILY_SNAPSHOT_FACT]),
    16: Object.freeze<readonly FactKey[]>([BATTLE_COUNTER_FACTS[0], DAILY_SNAPSHOT_FACT]),
    28: Object.freeze<readonly FactKey[]>([PLAYER_FACTS[0], DAILY_SNAPSHOT_FACT]),
    39: Object.freeze<readonly FactKey[]>([PLAYER_FACTS[0], DAILY_SNAPSHOT_FACT]),
})

export const PASS_WEEK_CONDITIONS: ReadonlySet<number> = new Set([16, 39])
export const PASS_WEEK_EMOTION_CONDITION = 85

export const PASS_EVENT_COMPUTED_LOGIN_CONDITION = 0
export const PASS_EVENT_PERSISTED_CONDITIONS: ReadonlySet<number> = new Set([16, 23])
