import type { FactKey } from "../facts/fact-key"
import {
    type MissionCatalog,
    type MissionMasterDefinition,
} from "../mission-catalog"
import { DEGREE_SUPPORTED_FAMILIES as FAMILY } from "../degree-context-requirements"
import { getMissionRequirementDraft } from "./providers"
import type { MissionFactRequirementDraft } from "./types"

/**
 * Startup cross-checks for the condition-number routing tables.
 *
 * The pattern-name lists below are the retired routing authorities
 * (requirements/providers.ts REGULAR_FACTS / REGULAR_PERSISTED_PATTERNS,
 * the Degree family prefixes, the Event haniwa and challenge-renewal
 * prefixes). They are kept verbatim as data-validity oracles: content that
 * moves a known pattern onto a different condition — or reshapes a pinned
 * audited mission — fails startup loudly instead of silently re-routing.
 * They must stay complete; deleting entries turns real drift into noise.
 */

export interface MissionRoutingProblem {
    readonly table: string
    readonly id: string
    readonly reason: string
}

export class MissionRoutingValidationError extends Error {
    readonly problems: readonly MissionRoutingProblem[]

    constructor(problems: readonly MissionRoutingProblem[]) {
        const listed = problems
            .slice(0, 20)
            .map(problem => `${problem.table}[${problem.id}]: ${problem.reason}`)
            .join("; ")
        const suffix = problems.length > 20
            ? ` (+${problems.length - 20} more, see .problems)`
            : ""
        super(`Mission condition routing has ${problems.length} invalid row(s): ${listed}${suffix}`)
        this.name = "MissionRoutingValidationError"
        this.problems = Object.freeze([...problems])
    }
}

function factSignature(fact: FactKey): string {
    switch (fact.kind) {
        case "questProgress":
            return `questProgress[${fact.sections === "all" ? "all" : fact.sections.join(",")}]`
        case "collectedItems":
            return `collectedItems(${fact.itemIds === "all" ? "all" : `n=${fact.itemIds.length}`})`
        case "shopPurchases":
            return `shopPurchases#${fact.shopType}`
        case "partyGroups":
            return `partyGroups#${fact.category}`
        case "periodicSnapshot":
            return `periodicSnapshot@${fact.snapshotKind}`
        case "passState":
            return `passState#${fact.eventId}`
        default:
            return fact.kind
    }
}

function draftSignature(draft: MissionFactRequirementDraft): string {
    if (draft.mode === "persisted") return "persisted"
    if (draft.mode === "unsupported") return "unsupported"
    const parts = (draft.facts ?? []).map(factSignature)
    if (draft.missionDependencies && draft.missionDependencies.length > 0) {
        parts.push(`deps(${draft.missionDependencies.length})`)
    }
    return `computed:${parts.join("+")}`
}

// ---------------------------------------------------------------------------
// Regular (category 1) — the retired REGULAR_FACTS / persisted pattern lists
// ---------------------------------------------------------------------------

const REGULAR_LEGACY_PERSISTED_PATTERNS: ReadonlySet<string> = new Set([
    "total_attained_drop_mana_count",
    "get_mvp",
    "treasure_shop_used_mana_count",
    "challenge_single_battle_play",
    "total_ability_soul_use_count",
    "twitter_check_mission_001",
])

const REGULAR_LEGACY_PATTERN_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
    max_combo: "computed:player",
    rank_ss: "computed:missionBattleCounters",
    use_dash: "computed:player",
    single_battle_play: "computed:missionBattleCounters",
    use_power_flip: "computed:player",
    use_skill: "computed:missionBattleCounters",
    character_level: "computed:characters",
    user_rank: "computed:player",
    clear_episode: "computed:questProgress[3]",
    total_login: "computed:player",
    special_total_login_2anv: "computed:player",
    multi_battle_play: "computed:missionBattleCounters",
    multi_play_host: "computed:missionBattleCounters",
    multi_play_guest: "computed:missionBattleCounters",
    max_skill_chain: "computed:degreeBattleStats",
    max_power_achievement: "computed:degreeBattleStats",
    fever: "computed:degreeBattleStats",
    characters_count: "computed:characters",
    got_equip_kind_count: "computed:equipment",
    max_score: "computed:missionBattleCounters",
    enemy_kill: "computed:degreeBattleStats",
    weak_point_attack: "computed:degreeBattleStats",
    character_80_level: "computed:characters",
    total_released_mana_node_count: "computed:characterManaNodes",
    over_limit_total_count: "computed:characters",
    total_obtained_bond_token_count: "computed:characters",
    total_mana_addition_count: "computed:player",
    ex_rank_ss: "computed:questProgress[4]",
    total_equipment_awaking_count: "computed:equipment",
    total_equipment_5_level_count: "computed:equipment",
    manaboard_2nd_open_count: "computed:characters",
    manaboard_2nd_complete_count: "computed:characters+characterManaNodes",
    // Craft points follow the catalog-configured item id, so the oracle
    // pins the family and arity rather than the id itself.
    total_craft_point_addition_count: "computed:collectedItems(n=1)",
})

// ---------------------------------------------------------------------------
// Degree (category 5) — the retired family prefixes, verbatim from the
// pre-single-channel routing, each pinned to the capability it produced
// ---------------------------------------------------------------------------

const DEGREE_LEGACY_PREFIX_CAPABILITIES: readonly {
    readonly prefix: string
    readonly capability: string
}[] = Object.freeze([
    { prefix: FAMILY.playerRank, capability: "computed:player" },
    { prefix: FAMILY.staminaUseCount, capability: "computed:player" },
    { prefix: FAMILY.loginCount, capability: "computed:player" },
    { prefix: FAMILY.dashUse, capability: "computed:player" },
    { prefix: FAMILY.comboOneTime, capability: "computed:player" },
    { prefix: FAMILY.companionCount, capability: "computed:characters" },
    { prefix: FAMILY.overLimitCount, capability: "computed:characters" },
    { prefix: FAMILY.bondTokenCount, capability: "computed:characters" },
    { prefix: FAMILY.manaBoardCount, capability: "computed:characterManaNodes" },
    { prefix: FAMILY.singleSsCount, capability: "computed:missionBattleCounters" },
    { prefix: FAMILY.multiClearCount, capability: "computed:missionBattleCounters" },
    { prefix: FAMILY.multiHostClearCount, capability: "computed:missionBattleCounters" },
    { prefix: FAMILY.challengeDungeonClear, capability: "computed:missionBattleCounters" },
    { prefix: FAMILY.scoreClearSingle, capability: "computed:missionBattleCounters" },
    { prefix: FAMILY.timeClearSingle, capability: "computed:missionBattleCounters" },
    { prefix: FAMILY.skillUse, capability: "computed:missionBattleCounters" },
    { prefix: FAMILY.feverCount, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.feverTime, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.debuffEnemy, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.clearEnemyBuff, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.clearSelfDebuff, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.buffParty, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.healParty, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.emotionUse, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.enemyKill, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.weakPointAttack, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.powerFlipLv3, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.coffinReduced, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.damageMax, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.revivalCoffinMax, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.partyPowerMax, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.skillChainMax, capability: "computed:degreeBattleStats" },
    { prefix: FAMILY.episodeClearCount, capability: "computed:questProgress[3]" },
    { prefix: "degree_all_episode_quest_clear_", capability: "computed:questProgress[1]+questProgress[4]" },
    { prefix: "degree_practice_rank_ss_clear_", capability: "computed:questProgress[15]" },
    { prefix: "degree_treasure_shop_buy_count_", capability: "computed:shopPurchases#2" },
    { prefix: "degree_boss_battle_ex_clear_single_", capability: "computed:questProgress[2]" },
    { prefix: FAMILY.craftPointGet, capability: "computed:collectedItems(n=1)" },
    { prefix: "degree_collect_item_event_", capability: "computed:collectedItems(n=1)" },
    { prefix: "degree_equipment_lv5_get_", capability: "computed:equipment" },
    { prefix: "degree_treasure_shop_mana_use_", capability: "persisted" },
    { prefix: "degree_mvp_get_", capability: "persisted" },
    { prefix: "degree_equipment_awake_", capability: "persisted" },
    { prefix: "degree_abilitiesoul_use_", capability: "persisted" },
    { prefix: "degree_manaboard_all_growth_", capability: "computed:characters+characterManaNodes" },
    { prefix: "degree_character_lv_growth_", capability: "computed:characters" },
])

// Pinned audited mission contracts that the condition routing keeps as
// fail-closed exceptions; drift on these rows must never silently re-route.
const DEGREE_AGGREGATE_BOSS_CLEAR_MISSIONS: ReadonlyMap<number, string> = new Map([
    [30000, "degree_boss_battle_clear_1"],
    [30010, "degree_boss_battle_clear_2"],
    [30020, "degree_boss_battle_clear_3"],
])

const REGULAR_TABLE_BY_CATEGORY: Readonly<Record<number, string>> = Object.freeze({
    1: "mission_regular.json",
    3: "mission_event.json",
    5: "mission_degree.json",
    6: "mission_pass_daily.json",
    7: "mission_pass_week.json",
    8: "mission_pass_event.json",
})

function tableName(category: number): string {
    return REGULAR_TABLE_BY_CATEGORY[category] ?? `mission-category-${category}`
}

function problem(
    definition: MissionMasterDefinition,
    reason: string,
): MissionRoutingProblem {
    return {
        table: tableName(definition.category),
        id: String(definition.missionId),
        reason,
    }
}

function checkRegular(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
    problems: MissionRoutingProblem[],
): void {
    const expected = REGULAR_LEGACY_PERSISTED_PATTERNS.has(definition.pattern)
        ? "persisted"
        : REGULAR_LEGACY_PATTERN_CAPABILITIES[definition.pattern]
    if (expected === undefined) return
    const actual = draftSignature(getMissionRequirementDraft(definition, catalog))
    if (actual !== expected) {
        problems.push(problem(
            definition,
            `pattern ${definition.pattern} no longer routes to its audited capability`
                + ` (condition ${Number(definition.row[2])}): expected ${expected}, got ${actual}`,
        ))
    }
}

function checkDegree(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
    problems: MissionRoutingProblem[],
): void {
    const aggregatePattern = DEGREE_AGGREGATE_BOSS_CLEAR_MISSIONS.get(definition.missionId)
    if (aggregatePattern !== undefined) {
        if (definition.pattern !== aggregatePattern
            || draftSignature(getMissionRequirementDraft(definition, catalog)) !== "computed:missionBattleCounters") {
            problems.push(problem(
                definition,
                `aggregate boss clear mission no longer matches its pinned audited shape`,
            ))
        }
        return
    }
    for (const { prefix, capability } of DEGREE_LEGACY_PREFIX_CAPABILITIES) {
        if (!definition.pattern.startsWith(prefix)) continue
        const actual = draftSignature(getMissionRequirementDraft(definition, catalog))
        if (actual !== capability) {
            problems.push(problem(
                definition,
                `degree pattern ${definition.pattern} no longer routes to its family capability`
                    + ` (condition ${Number(definition.row[3])}): expected ${capability}, got ${actual}`,
            ))
        }
        return
    }
    // Selector-shaped rows the condition routing accepts unconditionally:
    // bond (44) and second mana board (48) rows must carry their audited
    // selectors or the aggregate prefix.
    const conditionType = Number(definition.row[3])
    if (conditionType === 44 || conditionType === 48) {
        const hasCharacterSelector = Number.isSafeInteger(Number(definition.row[15]))
            && Number(definition.row[15]) > 0
        const isAggregate = conditionType === 48
            && definition.pattern.startsWith("degree_manaboard_all_growth_")
        if (!hasCharacterSelector && !isAggregate) {
            problems.push(problem(
                definition,
                `degree condition ${conditionType} row carries neither the character selector`
                    + ` nor the aggregate prefix the audited family requires`,
            ))
        }
    }
}

// Event: the haniwa family is routed by condition 23 + range kind 15, and
// the renewal family by condition 14 + the challenge range; the retired
// prefixes stay pinned to exactly those shapes.
const EVENT_HANIWA_PREFIX = "haniwa_carnival_mission_"
const EVENT_RENEWAL_PREFIX = "challenge_renewal_"

function checkEvent(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
    problems: MissionRoutingProblem[],
): void {
    const conditionType = Number(definition.row[2])
    const rangeKind = Number(definition.row[7])
    // Audited families: leaves on their condition+range shape, plus the
    // condition-13 dependency aggregates that complete through their leaves.
    const isHaniwaLeaf = conditionType === 23 && rangeKind === 15
    const isDependencyAggregate = conditionType === 13
    if (definition.pattern.startsWith(EVENT_HANIWA_PREFIX)) {
        if (!isHaniwaLeaf && !isDependencyAggregate) {
            problems.push(problem(
                definition,
                `haniwa-prefixed row no longer sits on condition 23 range 15 (leaf)`
                    + ` or a condition 13 dependency aggregate`,
            ))
        }
    } else if (isHaniwaLeaf) {
        problems.push(problem(
            definition,
            `condition-23 range-15 row no longer carries the audited haniwa prefix`,
        ))
    }
    if (definition.pattern.startsWith(EVENT_RENEWAL_PREFIX)
        && !(conditionType === 14 && rangeKind === 7)
        && !isDependencyAggregate) {
        problems.push(problem(
            definition,
            `challenge-renewal row no longer sits on condition 14 range 7 (leaf)`
                + ` or a condition 13 dependency aggregate`,
        ))
    }
    if (isHaniwaLeaf
        && draftSignature(getMissionRequirementDraft(definition, catalog)) !== "computed:questProgress[22]") {
        problems.push(problem(
            definition,
            `condition-23 range-15 row no longer routes to the haniwa quest section`,
        ))
    }
}

/**
 * Cross-checks the condition-number routing of every catalog row against the
 * retired pattern-name lists. Unknown patterns pass through the condition
 * channel by design; only audited patterns and pinned missions can fail.
 */
export function getMissionRoutingValidationProblems(
    catalog: MissionCatalog,
): readonly MissionRoutingProblem[] {
    const problems: MissionRoutingProblem[] = []
    for (const definition of catalog.getDefinitions(1)) {
        checkRegular(definition, catalog, problems)
    }
    for (const definition of catalog.getDefinitions(3)) {
        checkEvent(definition, catalog, problems)
    }
    for (const definition of catalog.getDefinitions(5)) {
        checkDegree(definition, catalog, problems)
    }
    return Object.freeze(problems)
}

export function assertMissionConditionRouting(catalog: MissionCatalog): void {
    const problems = getMissionRoutingValidationProblems(catalog)
    if (problems.length > 0) throw new MissionRoutingValidationError(problems)
}
