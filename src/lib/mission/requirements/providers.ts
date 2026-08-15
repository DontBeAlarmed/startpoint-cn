import type { FactKey } from "../facts/fact-key"
import {
    getMissionCatalogCraftPointItemId,
    type MissionCatalog,
    type MissionMasterDefinition,
} from "../mission-catalog"
import { getRegularQuestFactSection } from "../regular-quest-facts"
import { getAwakeRequirement } from "./provider-awake"
import { getDegreeRequirement } from "./provider-degree"
import { getEventRequirement } from "./provider-event"
import { matchesCurrentMissionComputerDefinition } from "./computer-compatibility"
import type { MissionFactRequirementDraft, MissionRef } from "./types"

const REGULAR_PERSISTED_PATTERNS = new Set([
    "total_attained_drop_mana_count",
    "get_mvp",
    "treasure_shop_used_mana_count",
    "challenge_single_battle_play",
    "total_ability_soul_use_count",
    "twitter_check_mission_001",
])

const DAILY_BATTLE_PRODUCER_IDS = new Set([
    10075, 800115, 800116, 800117, 800124, 800125, 800126, 800392,
])

const REGULAR_FACTS: Readonly<Record<string, readonly FactKey[]>> = Object.freeze({
    max_combo: [{ kind: "player" }],
    rank_ss: [{ kind: "missionBattleCounters" }],
    use_dash: [{ kind: "player" }],
    single_battle_play: [{ kind: "missionBattleCounters" }],
    use_power_flip: [{ kind: "player" }],
    use_skill: [{ kind: "missionBattleCounters" }],
    character_level: [{ kind: "player" }],
    user_rank: [{ kind: "player" }],
    clear_episode: [{ kind: "questProgress", sections: [3] }],
    total_login: [{ kind: "player" }],
    multi_battle_play: [{ kind: "missionBattleCounters" }],
    multi_play_host: [{ kind: "missionBattleCounters" }],
    multi_play_guest: [{ kind: "missionBattleCounters" }],
    max_skill_chain: [{ kind: "degreeBattleStats" }],
    max_power_achievement: [{ kind: "degreeBattleStats" }],
    fever: [{ kind: "degreeBattleStats" }],
    characters_count: [{ kind: "characters" }],
    got_equip_kind_count: [{ kind: "equipment" }],
    max_score: [{ kind: "missionBattleCounters" }],
    enemy_kill: [{ kind: "degreeBattleStats" }],
    weak_point_attack: [{ kind: "degreeBattleStats" }],
    character_80_level: [{ kind: "characters" }],
    total_released_mana_node_count: [{ kind: "characterManaNodes" }],
    over_limit_total_count: [{ kind: "characters" }],
    total_obtained_bond_token_count: [{ kind: "characters" }],
    total_mana_addition_count: [{ kind: "player" }],
    ex_rank_ss: [{ kind: "questProgress", sections: [4] }],
    total_equipment_awaking_count: [{ kind: "equipment" }],
    total_equipment_5_level_count: [{ kind: "equipment" }],
    manaboard_2nd_open_count: [{ kind: "characters" }],
    manaboard_2nd_complete_count: [
        { kind: "characters" },
        { kind: "characterManaNodes" },
    ],
})

function parsePositiveIntegerList(value: unknown): readonly number[] | null {
    if (typeof value !== "string" || value === "" || value === "(None)") return null
    const values = value.split(",").map(Number)
    return values.length > 0 && values.every(value => Number.isSafeInteger(value) && value > 0)
        ? values
        : null
}

function getRegularRequirement(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): MissionFactRequirementDraft {
    if (definition.pattern === "total_craft_point_addition_count") {
        return {
            mode: "computed",
            facts: [{
                kind: "collectedItems",
                itemIds: [getMissionCatalogCraftPointItemId(catalog)],
            }],
        }
    }
    const facts = REGULAR_FACTS[definition.pattern]
    if (facts) return { mode: "computed", facts }
    if (REGULAR_PERSISTED_PATTERNS.has(definition.pattern)) return { mode: "persisted" }

    if (matchesCurrentMissionComputerDefinition(definition)) {
        const questSection = getRegularQuestFactSection(definition)
        if (questSection !== undefined) {
            return {
                mode: "computed",
                facts: [{ kind: "questProgress", sections: [questSection] }],
            }
        }
    }
    return {
        mode: "unsupported",
        reason: "Regular mission has no authoritative computed mapping or atomic producer.",
    }
}

function dailyDependencies(definition: MissionMasterDefinition): readonly MissionRef[] {
    if (Number(definition.row[2]) !== 13) return []
    return (parsePositiveIntegerList(definition.row[17]) ?? [])
        .map(missionId => ({ category: 2, missionId }))
}

function getDailyRequirement(definition: MissionMasterDefinition): MissionFactRequirementDraft {
    const dependencies = dailyDependencies(definition)
    if (dependencies.length > 0) {
        return { mode: "computed", missionDependencies: dependencies }
    }
    const snapshot: FactKey = { kind: "periodicSnapshot", snapshotKind: "daily" }
    if (/^single_battle_play(?:_[23])?$/.test(definition.pattern)
        || /^multi_battle_play(?:_[23])?$/.test(definition.pattern)) {
        return { mode: "computed", facts: [{ kind: "missionBattleCounters" }, snapshot] }
    }
    if (/^use_dash(?:_[23])?$/.test(definition.pattern)
        || definition.pattern === "daily_quest_stamina_use_2024_02") {
        return { mode: "computed", facts: [{ kind: "player" }, snapshot] }
    }
    if (DAILY_BATTLE_PRODUCER_IDS.has(definition.missionId)) return { mode: "persisted" }
    return {
        mode: "unsupported",
        reason: "Daily mission has no authoritative computed mapping or atomic producer.",
    }
}

function getWeeklyRequirement(definition: MissionMasterDefinition): MissionFactRequirementDraft {
    const snapshot: FactKey = { kind: "periodicSnapshot", snapshotKind: "weekly" }
    if (definition.pattern === "weekly_mission_1") {
        return { mode: "computed", facts: [{ kind: "player" }, snapshot] }
    }
    if (definition.pattern === "weekly_mission_2") {
        return { mode: "computed", facts: [{ kind: "missionBattleCounters" }, snapshot] }
    }
    return { mode: "unsupported", reason: "Weekly mission pattern is not authoritative." }
}

function getCollectRequirement(definition: MissionMasterDefinition): MissionFactRequirementDraft {
    if (!matchesCurrentMissionComputerDefinition(definition)) {
        return {
            mode: "unsupported",
            reason: "Collect mission definition is incompatible with the current Computer Catalog.",
        }
    }
    const itemId = Number(definition.row[14])
    return Number.isSafeInteger(itemId) && itemId > 0
        ? { mode: "computed", facts: [{ kind: "collectedItems", itemIds: [itemId] }] }
        : { mode: "unsupported", reason: "Collect mission item selector is invalid." }
}

function getPassRequirement(definition: MissionMasterDefinition): MissionFactRequirementDraft {
    const eventId = definition.eventId
    if (!Number.isSafeInteger(eventId) || eventId! <= 0) {
        return { mode: "unsupported", reason: "Pass mission event scope is invalid." }
    }
    const patternType = definition.patternType
    if (definition.category === 6) {
        const snapshot: FactKey = { kind: "periodicSnapshot", snapshotKind: "daily" }
        if (patternType === 14 || patternType === 16) {
            return { mode: "computed", facts: [{ kind: "missionBattleCounters" }, snapshot] }
        }
        if (patternType === 28 || patternType === 39) {
            return { mode: "computed", facts: [{ kind: "player" }, snapshot] }
        }
    }
    if (definition.category === 7) {
        const snapshot: FactKey = {
            kind: "periodicSnapshot",
            snapshotKind: "passWeek",
            eventId: eventId!,
        }
        if (patternType === 16) {
            return { mode: "computed", facts: [{ kind: "missionBattleCounters" }, snapshot] }
        }
        if (patternType === 39) return { mode: "computed", facts: [{ kind: "player" }, snapshot] }
        if (patternType === 85) return { mode: "persisted" }
    }
    if (definition.category === 8) {
        if (patternType === 0) {
            return {
                mode: "computed",
                facts: [{ kind: "player" }, { kind: "passState", eventId: eventId! }],
            }
        }
        if (patternType === 16 || patternType === 23) return { mode: "persisted" }
    }
    return {
        mode: "unsupported",
        reason: "Pass mission has no authoritative computed mapping or atomic producer.",
    }
}

export function getMissionRequirementDraft(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): MissionFactRequirementDraft {
    switch (definition.category) {
        case 1:
            return getRegularRequirement(definition, catalog)
        case 2:
            return getDailyRequirement(definition)
        case 3:
            return getEventRequirement(definition, catalog)
        case 4:
            return getCollectRequirement(definition)
        case 5:
            return getDegreeRequirement(definition, catalog)
        case 6:
        case 7:
        case 8:
            return getPassRequirement(definition)
        case 9:
            return getAwakeRequirement(definition, catalog)
        case 10:
            return getWeeklyRequirement(definition)
        default:
            return { mode: "unsupported", reason: "Mission category is outside the Catalog." }
    }
}
