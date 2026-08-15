import { getDegreeClientProgressPattern } from "./client-progress"
import {
    getMissionMasterDefinition,
    type MissionMasterDefinition,
} from "./master-data"
import type { MissionCatalog } from "./mission-catalog"
import { getCategoryMissionRewardStageDefinition } from "./rewards"

export const DEGREE_SUPPORTED_FAMILIES = {
    playerRank: "degree_player_rank_growth_",
    companionCount: "degree_companion_add_",
    overLimitCount: "degree_overlimit_growth_",
    manaBoardCount: "degree_manaboard_growth_",
    bondTokenCount: "degree_proof_of_bond_get_",
    singleSsCount: "degree_rank_ss_clear_single_",
    multiClearCount: "degree_multi_battle_clear_",
    multiHostClearCount: "degree_multi_battle_by_host_clear_",
    episodeClearCount: "degree_character_episode_read_",
    staminaUseCount: "degree_stamina_use_",
    loginCount: "degree_login_count_",
    challengeDungeonClear: "degree_challenge_dungeon_clear_",
    scoreClearSingle: "degree_score_clear_single_",
    timeClearSingle: "degree_time_clear_single_",
    bossBattleClear: "degree_boss_battle_clear_",
    dashUse: "degree_dash_use_",
    comboOneTime: "degree_combo_onetime_",
    craftPointGet: "degree_craft_point_get_",
    skillUse: "degree_skill_use_",
    feverCount: "degree_fever_condition_single_",
    feverTime: "degree_time_fever_elapse_single_",
    debuffEnemy: "degree_weak_enemy_use_single_",
    clearEnemyBuff: "degree_debuff_enemy_use_single_",
    clearSelfDebuff: "degree_deweak_myself_use_single_",
    buffParty: "degree_buff_companion_use_",
    healParty: "degree_recovery_hp_companion_",
    emotionUse: "degree_emotion_multi_battle_use_",
    enemyKill: "degree_kill_enemy_",
    weakPointAttack: "degree_destruction_weak_point_",
    powerFlipLv3: "degree_power_flip_lv3_use_",
    coffinReduced: "degree_coffin_count_sub_",
    damageMax: "degree_damage_onetime_",
    revivalCoffinMax: "degree_return_coffin_count_30over_",
    partyPowerMax: "degree_condition_party_force_",
    skillChainMax: "degree_skill_chain_condition_",
} as const

export type DegreeContextFactFamily =
    | "player"
    | "characters"
    | "manaNodes"
    | "missionBattleCounters"
    | "episodeClearCount"
    | "episodeChapters"
    | "practiceRanks"
    | "treasureShop"
    | "craftPoint"
    | "collectedItems"
    | "equipment"
    | "degreeBattleStats"

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
    [3010, { pattern: "degree_character_lv_growth_2", target: 80 }],
    [3020, { pattern: "degree_character_lv_growth_3", target: 100 }],
] as const)

export function isAuthoritativeCharacterLevelMission(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionMasterDefinition(5, missionId),
    catalog?: MissionCatalog,
): boolean {
    const expected = AUTHORITATIVE_CHARACTER_LEVEL_MISSIONS.get(missionId)
    if (!expected) return false
    const targetProgress = catalog
        ? catalog.getRewardStage(5, missionId, 1)?.targetProgress
        : getCategoryMissionRewardStageDefinition(5, missionId, 1)?.targetProgress
    return Boolean(
        definition
        && Number(definition.row[3]) === 5
        && definition.pattern === expected.pattern
        && targetProgress === expected.target
    )
}

export function getSpecificCharacterBondId(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionMasterDefinition(5, missionId),
): number | undefined {
    if (!definition || Number(definition.row[3]) !== 44) return undefined
    const characterId = Number(definition.row[15])
    return Number.isSafeInteger(characterId) && characterId > 0 ? characterId : undefined
}

export function getSecondManaBoardCharacterId(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionMasterDefinition(5, missionId),
): number | undefined {
    if (!definition || Number(definition.row[3]) !== 48) return undefined
    const characterId = Number(definition.row[15])
    return Number.isSafeInteger(characterId) && characterId > 0 ? characterId : undefined
}

export function isSecondManaBoardAggregateMission(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionMasterDefinition(5, missionId),
): boolean {
    return Boolean(
        definition
        && Number(definition.row[3]) === 48
        && definition.pattern.startsWith("degree_manaboard_all_growth_"),
    )
}

export function getEpisodeChapter(
    missionId: number,
    definition: MissionMasterDefinition | undefined = getMissionMasterDefinition(5, missionId),
): number | undefined {
    if (!definition
        || Number(definition.row[3]) !== 22
        || !definition.pattern.startsWith("degree_all_episode_quest_clear_")) return undefined
    const chapter = Number(definition.row[9])
    return Number.isSafeInteger(chapter) && chapter > 0 ? chapter : undefined
}

const PLAYER_PREFIXES = [
    DEGREE_SUPPORTED_FAMILIES.playerRank,
    DEGREE_SUPPORTED_FAMILIES.staminaUseCount,
    DEGREE_SUPPORTED_FAMILIES.loginCount,
    DEGREE_SUPPORTED_FAMILIES.dashUse,
    DEGREE_SUPPORTED_FAMILIES.comboOneTime,
] as const

const CHARACTER_PREFIXES = [
    DEGREE_SUPPORTED_FAMILIES.companionCount,
    DEGREE_SUPPORTED_FAMILIES.overLimitCount,
    DEGREE_SUPPORTED_FAMILIES.bondTokenCount,
] as const

const BATTLE_COUNTER_PREFIXES = [
    DEGREE_SUPPORTED_FAMILIES.singleSsCount,
    DEGREE_SUPPORTED_FAMILIES.multiClearCount,
    DEGREE_SUPPORTED_FAMILIES.multiHostClearCount,
    DEGREE_SUPPORTED_FAMILIES.challengeDungeonClear,
    DEGREE_SUPPORTED_FAMILIES.scoreClearSingle,
    DEGREE_SUPPORTED_FAMILIES.timeClearSingle,
    DEGREE_SUPPORTED_FAMILIES.bossBattleClear,
    DEGREE_SUPPORTED_FAMILIES.skillUse,
] as const

const DEGREE_BATTLE_STAT_PREFIXES = [
    DEGREE_SUPPORTED_FAMILIES.feverCount,
    DEGREE_SUPPORTED_FAMILIES.feverTime,
    DEGREE_SUPPORTED_FAMILIES.debuffEnemy,
    DEGREE_SUPPORTED_FAMILIES.clearEnemyBuff,
    DEGREE_SUPPORTED_FAMILIES.clearSelfDebuff,
    DEGREE_SUPPORTED_FAMILIES.buffParty,
    DEGREE_SUPPORTED_FAMILIES.healParty,
    DEGREE_SUPPORTED_FAMILIES.emotionUse,
    DEGREE_SUPPORTED_FAMILIES.enemyKill,
    DEGREE_SUPPORTED_FAMILIES.weakPointAttack,
    DEGREE_SUPPORTED_FAMILIES.powerFlipLv3,
    DEGREE_SUPPORTED_FAMILIES.coffinReduced,
    DEGREE_SUPPORTED_FAMILIES.damageMax,
    DEGREE_SUPPORTED_FAMILIES.revivalCoffinMax,
    DEGREE_SUPPORTED_FAMILIES.partyPowerMax,
    DEGREE_SUPPORTED_FAMILIES.skillChainMax,
] as const

function startsWithAny(pattern: string, prefixes: readonly string[]): boolean {
    return prefixes.some(prefix => pattern.startsWith(prefix))
}

function isPersistedProgressDefinition(definition: MissionMasterDefinition): boolean {
    const conditionType = Number(definition.row[3])
    if (getDegreeClientProgressPattern(definition) !== undefined) return true
    if (conditionType === 3 && definition.pattern.startsWith("degree_treasure_shop_mana_use_")) return true
    if (conditionType === 19 && definition.pattern.startsWith("degree_mvp_get_")) return true
    if (conditionType === 34 && definition.pattern.startsWith("degree_equipment_awake_")) return true
    if (conditionType === 35 && definition.pattern.startsWith("degree_abilitiesoul_use_")) return true
    if (conditionType !== 23 || definition.row[11] !== "" || definition.row[12] !== "(None)") {
        return false
    }
    const rangeKind = Number(definition.row[8])
    return rangeKind === 2 || (rangeKind === 5 && definition.row[10] === "")
}

export function getDegreeMissionFactRequirements(
    definition: MissionMasterDefinition,
    catalog?: MissionCatalog,
): DegreeMissionFactRequirements | undefined {
    if (definition.category !== 5) return undefined
    if (isPersistedProgressDefinition(definition)) return { factFamilies: [] }

    const { missionId, pattern } = definition
    const conditionType = Number(definition.row[3])
    if (startsWithAny(pattern, PLAYER_PREFIXES)) return { factFamilies: ["player"] }
    if (startsWithAny(pattern, CHARACTER_PREFIXES)) return { factFamilies: ["characters"] }
    if (pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.manaBoardCount)) {
        return { factFamilies: ["manaNodes"] }
    }
    if (startsWithAny(pattern, BATTLE_COUNTER_PREFIXES)) {
        return { factFamilies: ["missionBattleCounters"] }
    }
    if (startsWithAny(pattern, DEGREE_BATTLE_STAT_PREFIXES)) {
        return { factFamilies: ["degreeBattleStats"] }
    }
    if (isAuthoritativeCharacterLevelMission(missionId, definition, catalog)) {
        return { factFamilies: ["characters"] }
    }
    if (getSpecificCharacterBondId(missionId, definition) !== undefined) {
        return { factFamilies: ["characters"] }
    }
    if (isSecondManaBoardAggregateMission(missionId, definition)
        || getSecondManaBoardCharacterId(missionId, definition) !== undefined) {
        return { factFamilies: ["characters", "manaNodes"] }
    }
    if (getEpisodeChapter(missionId, definition) !== undefined) {
        return { factFamilies: ["episodeChapters"] }
    }
    if (conditionType === 21 && pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.episodeClearCount)) {
        return { factFamilies: ["episodeClearCount"] }
    }
    if (conditionType === 26 && pattern.startsWith("degree_practice_rank_ss_clear_")) {
        return { factFamilies: ["practiceRanks"] }
    }
    if (conditionType === 45 && pattern.startsWith("degree_treasure_shop_buy_count_")) {
        return { factFamilies: ["treasureShop"] }
    }
    if (conditionType === 14 && pattern.startsWith("degree_boss_battle_ex_clear_single_")) {
        return { factFamilies: [], finishedQuestSection: 2, bossBattleSuperQuest: true }
    }
    if (conditionType === 14) {
        const sectionByRangeKind: Readonly<Record<number, number>> = { 5: 7, 9: 18, 14: 21 }
        const section = sectionByRangeKind[Number(definition.row[8])]
        if (section !== undefined) return { factFamilies: [], finishedQuestSection: section }
    }
    if (conditionType === 23) {
        const sectionByRangeKind: Readonly<Record<number, number>> = { 15: 22, 19: 26 }
        const section = sectionByRangeKind[Number(definition.row[8])]
        if (section !== undefined) return { factFamilies: [], finishedQuestSection: section }
    }
    if (conditionType === 37 && pattern.startsWith(DEGREE_SUPPORTED_FAMILIES.craftPointGet)) {
        return { factFamilies: ["craftPoint"] }
    }
    if (conditionType === 37 && pattern.startsWith("degree_collect_item_event_")) {
        const itemId = Number(definition.row[13])
        return Number.isSafeInteger(itemId) && itemId > 0
            ? { factFamilies: ["collectedItems"], collectedItemId: itemId }
            : undefined
    }
    if (conditionType === 36 && pattern.startsWith("degree_equipment_lv5_get_")) {
        return { factFamilies: ["equipment"] }
    }
    return undefined
}

export function getDegreeContextRequirements(
    missionIds: readonly number[],
): DegreeContextRequirements {
    const factFamilies = new Set<DegreeContextFactFamily>()
    const finishedQuestSections = new Set<number>()
    const bossBattleSuperMissionIds = new Set<number>()
    const collectedItemIds = new Set<number>()

    for (const missionId of new Set(missionIds)) {
        const definition = getMissionMasterDefinition(5, missionId)
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
