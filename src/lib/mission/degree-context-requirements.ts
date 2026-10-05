import { getDegreeClientProgressPattern } from "./client-progress"
import {
    DEFAULT_CRAFT_POINT_ITEM_ID,
    MissionCatalog,
    MissionMasterDefinition,
    getMissionCatalog,
} from "./mission-catalog"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"
import { getCategoryMissionRewardStageDefinition } from "./rewards"
import {
    DEGREE_CHALLENGE_RULES_BY_RANGE_KIND,
    DEGREE_CLIENT_PROGRESS_CONDITIONS,
    DEGREE_COLLECT_ITEM_COLUMN,
    DEGREE_COLLECT_ITEM_CONDITION,
    DEGREE_FACT_FAMILIES_BY_CONDITION,
    DEGREE_PERSISTED_CONDITIONS,
    DEGREE_PRACTICE_RANGE_KIND,
    DEGREE_TYPE_23_SECTION_BY_RANGE_KIND,
    DEGREE_TYPE_28_FAMILY_BY_STATISTICS_CODE,
} from "./requirements/condition-routing"

export const DEGREE_SUPPORTED_FAMILIES = {
    playerRank: "degree_player_rank_growth_", companionCount: "degree_companion_add_",
    overLimitCount: "degree_overlimit_growth_", manaBoardCount: "degree_manaboard_growth_",
    bondTokenCount: "degree_proof_of_bond_get_", singleSsCount: "degree_rank_ss_clear_single_",
    multiClearCount: "degree_multi_battle_clear_", multiHostClearCount: "degree_multi_battle_by_host_clear_",
    episodeClearCount: "degree_character_episode_read_", staminaUseCount: "degree_stamina_use_",
    loginCount: "degree_login_count_", challengeDungeonClear: "degree_challenge_dungeon_clear_",
    scoreClearSingle: "degree_score_clear_single_", timeClearSingle: "degree_time_clear_single_",
    bossBattleClear: "degree_boss_battle_clear_", dashUse: "degree_dash_use_",
    comboOneTime: "degree_combo_onetime_", craftPointGet: "degree_craft_point_get_",
    skillUse: "degree_skill_use_", feverCount: "degree_fever_condition_single_",
    feverTime: "degree_time_fever_elapse_single_", debuffEnemy: "degree_weak_enemy_use_single_",
    clearEnemyBuff: "degree_debuff_enemy_use_single_", clearSelfDebuff: "degree_deweak_myself_use_single_",
    buffParty: "degree_buff_companion_use_", healParty: "degree_recovery_hp_companion_",
    emotionUse: "degree_emotion_multi_battle_use_", enemyKill: "degree_kill_enemy_",
    weakPointAttack: "degree_destruction_weak_point_", powerFlipLv3: "degree_power_flip_lv3_use_",
    coffinReduced: "degree_coffin_count_sub_", damageMax: "degree_damage_onetime_",
    revivalCoffinMax: "degree_return_coffin_count_30over_", partyPowerMax: "degree_condition_party_force_",
    skillChainMax: "degree_skill_chain_condition_",
    attentionBattleClear: "degree_attention_battle_clear_",
    multiBattleNewbie: "degree_multi_battle_newbie_",
} as const

export type DegreeContextFactFamily =
    | "player" | "characters" | "manaNodes" | "missionBattleCounters"
    | "episodeClearCount" | "episodeChapters" | "practiceRanks" | "treasureShop"
    | "craftPoint" | "collectedItems" | "equipment" | "degreeBattleStats"

export interface DegreeMissionFactRequirements {
    readonly factFamilies: readonly DegreeContextFactFamily[]
    readonly finishedQuestSection?: number
    readonly bossBattleSuperQuest?: boolean
    readonly collectedItemId?: number
}

export interface DegreeContextRequirements {
    readonly factFamilies: ReadonlySet<DegreeContextFactFamily>
    readonly finishedQuestSections: ReadonlySet<number>
    readonly bossBattleSuperMissionIds: ReadonlySet<number>
    readonly collectedItemIds: ReadonlySet<number>
}

const AUTHORITATIVE_CHARACTER_LEVEL_MISSIONS: ReadonlyMap<number, {
    readonly pattern: string
    readonly target: number
}> = new Map([
    [3000, { pattern: "degree_character_lv_growth_1", target: 60 }],
    [3010, { pattern: "degree_character_lv_growth_2", target: 80 }],
    [3020, { pattern: "degree_character_lv_growth_3", target: 100 }],
] as const)

export function isAuthoritativeCharacterLevelMission(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionCatalog().getDefinition(5, missionId),
    catalog?: MissionCatalog,
): boolean {
    const expected = AUTHORITATIVE_CHARACTER_LEVEL_MISSIONS.get(missionId)
    if (!expected) return false
    const targetProgress = catalog
        ? catalog.getRewardStage(5, missionId, 1)?.targetProgress
        : getCategoryMissionRewardStageDefinition(5, missionId, 1)?.targetProgress
    return Boolean(
        definition
        && parsePositiveSafeIntegerMasterValue(definition.row[3]) === 5
        && definition.pattern === expected.pattern
        && targetProgress === expected.target
    )
}

export function getSpecificCharacterBondId(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionCatalog().getDefinition(5, missionId),
): number | undefined {
    if (!definition || parsePositiveSafeIntegerMasterValue(definition.row[3]) !== 44) return undefined
    return parsePositiveSafeIntegerMasterValue(definition.row[15])
}

export function getSecondManaBoardCharacterId(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionCatalog().getDefinition(5, missionId),
): number | undefined {
    if (!definition || parsePositiveSafeIntegerMasterValue(definition.row[3]) !== 48) return undefined
    return parsePositiveSafeIntegerMasterValue(definition.row[15])
}

export function isSecondManaBoardAggregateMission(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionCatalog().getDefinition(5, missionId),
): boolean {
    return Boolean(
        definition
        && parsePositiveSafeIntegerMasterValue(definition.row[3]) === 48
        && definition.pattern.startsWith("degree_manaboard_all_growth_"),
    )
}

export function getEpisodeChapter(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionCatalog().getDefinition(5, missionId),
): number | undefined {
    if (!definition
        || parsePositiveSafeIntegerMasterValue(definition.row[3]) !== 22
        || !definition.pattern.startsWith("degree_all_episode_quest_clear_")) return undefined
    return parsePositiveSafeIntegerMasterValue(definition.row[9])
}

const AGGREGATE_BOSS_BATTLE_CLEAR_PATTERNS: ReadonlyMap<number, string> = new Map([
    [30000, "degree_boss_battle_clear_1"],
    [30010, "degree_boss_battle_clear_2"],
    [30020, "degree_boss_battle_clear_3"],
])

function parseNonnegativeCondition(value: unknown): number | undefined {
    const parsed = parsePositiveSafeIntegerMasterValue(value)
    if (parsed !== undefined) return parsed
    return value === "0" || value === 0 ? 0 : undefined
}

function isAggregateBossBattleClearDefinition(definition: MissionMasterDefinition): boolean {
    const expectedPattern = AGGREGATE_BOSS_BATTLE_CLEAR_PATTERNS.get(definition.missionId)
    return expectedPattern !== undefined
        && definition.pattern === expectedPattern
        && definition.row[1] === expectedPattern
        && definition.row[3] === "23"
        && definition.row[6] === "3"
        && definition.row[8] === "2"
        && definition.row[9] === ""
        && definition.row[10] === ""
        && definition.row[11] === ""
        && definition.row[12] === "(None)"
}

/**
 * Condition-number routing for Degree missions. Pinned audited contracts —
 * the three aggregate boss counters and the client-reported selectors —
 * stay first and fail closed on field drift; everything else routes by
 * condition number with the range kind, statistics code, and selector
 * columns as discriminators. The retired DEGREE_SUPPORTED_FAMILIES prefix
 * routing survives as a startup cross-check in
 * requirements/routing-validation.ts.
 */
export function getDegreeMissionFactRequirements(
    definition: MissionMasterDefinition,
    catalog?: MissionCatalog,
): DegreeMissionFactRequirements | undefined {
    if (definition.category !== 5) return undefined
    const { missionId } = definition
    if (AGGREGATE_BOSS_BATTLE_CLEAR_PATTERNS.has(missionId)) {
        return isAggregateBossBattleClearDefinition(definition)
            ? { factFamilies: ["missionBattleCounters"] }
            : undefined
    }
    // Condition 0 (login days) is a legal master value; parse non-negative.
    const conditionType = parseNonnegativeCondition(definition.row[3])
    if (conditionType === undefined) return undefined

    // Client-reported progress selectors and operation-backed shapes.
    if (DEGREE_CLIENT_PROGRESS_CONDITIONS.has(conditionType)) return { factFamilies: [] }
    if (DEGREE_PERSISTED_CONDITIONS.has(conditionType)) return { factFamilies: [] }

    const rangeKind = parsePositiveSafeIntegerMasterValue(definition.row[8])
    if (conditionType === 23) {
        // Selector-shaped battle clears keep their atomic producer; the
        // haniwa (15) and steam-robot (19) range kinds are finished quests.
        if (definition.row[11] === "" && definition.row[12] === "(None)"
            && (rangeKind === 2 || (rangeKind === 5 && definition.row[10] === ""))) {
            return { factFamilies: [] }
        }
        const section = rangeKind === undefined
            ? undefined
            : DEGREE_TYPE_23_SECTION_BY_RANGE_KIND[rangeKind]
        return section === undefined
            ? undefined
            : { factFamilies: [], finishedQuestSection: section }
    }
    if (conditionType === 14) {
        const rule = rangeKind === undefined
            ? undefined
            : DEGREE_CHALLENGE_RULES_BY_RANGE_KIND[rangeKind]
        if (rule === undefined) return undefined
        return rule.kind === "battleCounters"
            ? { factFamilies: ["missionBattleCounters"] }
            : {
                factFamilies: [],
                finishedQuestSection: rule.section,
                ...(rule.bossBattleSuperQuest ? { bossBattleSuperQuest: true } : {}),
            }
    }
    if (conditionType === 26) {
        if (rangeKind === DEGREE_PRACTICE_RANGE_KIND) return { factFamilies: ["practiceRanks"] }
        if (rangeKind === undefined) return { factFamilies: ["missionBattleCounters"] }
        return undefined
    }
    if (conditionType === 28) {
        const families = DEGREE_TYPE_28_FAMILY_BY_STATISTICS_CODE[Number(definition.row[4])]
        return families === undefined ? undefined : { factFamilies: families }
    }
    if (conditionType === DEGREE_COLLECT_ITEM_CONDITION) {
        const itemId = parsePositiveSafeIntegerMasterValue(
            definition.row[DEGREE_COLLECT_ITEM_COLUMN],
        )
        if (itemId === undefined) return undefined
        return itemId === DEFAULT_CRAFT_POINT_ITEM_ID
            ? { factFamilies: ["craftPoint"] }
            : { factFamilies: ["collectedItems"], collectedItemId: itemId }
    }
    if (conditionType === 44) {
        return getSpecificCharacterBondId(missionId, definition) !== undefined
            ? { factFamilies: ["characters"] }
            : undefined
    }
    if (conditionType === 22) {
        const chapter = parsePositiveSafeIntegerMasterValue(definition.row[9])
        return chapter === undefined
            ? undefined
            : { factFamilies: ["episodeChapters"] }
    }
    const families = DEGREE_FACT_FAMILIES_BY_CONDITION[conditionType]
    return families === undefined ? undefined : { factFamilies: families }
}

export function getDegreeContextRequirements(
    missionIds: readonly number[],
): DegreeContextRequirements {
    const factFamilies = new Set<DegreeContextFactFamily>()
    const finishedQuestSections = new Set<number>()
    const bossBattleSuperMissionIds = new Set<number>()
    const collectedItemIds = new Set<number>()

    for (const missionId of new Set(missionIds)) {
        const definition = getMissionCatalog().getDefinition(5, missionId)
        if (!definition) continue
        const requirements = getDegreeMissionFactRequirements(definition)
        if (!requirements) continue
        for (const family of requirements.factFamilies) factFamilies.add(family)
        if (requirements.finishedQuestSection !== undefined) {
            finishedQuestSections.add(requirements.finishedQuestSection)
        }
        if (requirements.bossBattleSuperQuest) bossBattleSuperMissionIds.add(missionId)
        if (requirements.collectedItemId !== undefined) {
            collectedItemIds.add(requirements.collectedItemId)
        }
    }
    return {
        factFamilies,
        finishedQuestSections,
        bossBattleSuperMissionIds,
        collectedItemIds,
    }
}
