import type { FactKey } from "../facts/fact-key"
import {
    getDailyCompletionDependencies,
    getCollectCompletionDependencies,
} from "../daily-completion"
import {
    getMissionCatalogCraftPointItemId,
    type MissionCatalog,
    type MissionMasterDefinition,
} from "../mission-catalog"
import { getRegularQuestFactSection } from "../regular-quest-facts"
import { getCollectCurrentStateShape } from "../collect-current-state"
import { parsePositiveSafeIntegerMasterValue } from "../master-value"
import { getAwakeRequirement } from "./provider-awake"
import { getDegreeRequirement } from "./provider-degree"
import { getEventRequirement } from "./provider-event"
import type { MissionFactRequirementDraft, MissionRef } from "./types"

const REGULAR_PERSISTED_PATTERNS = new Set([
    "total_attained_drop_mana_count",
    "get_mvp",
    "treasure_shop_used_mana_count",
    "challenge_single_battle_play",
    "total_ability_soul_use_count",
    "twitter_check_mission_001",
])

const DAILY_BATTLE_PRODUCER_TYPES: ReadonlySet<number> = new Set([
    14, 16, 17, 18, 23, 26, 49, 50, 51, 52,
])

const DAILY_PERIODIC_COMPUTED_TYPES: ReadonlySet<number> = new Set([0, 28, 39])
const DAILY_GACHA_DRAW_CONDITION_TYPE = 78

const REGULAR_FACTS: Readonly<Record<string, readonly FactKey[]>> = Object.freeze({
    max_combo: [{ kind: "player" }],
    rank_ss: [{ kind: "missionBattleCounters" }],
    use_dash: [{ kind: "player" }],
    single_battle_play: [{ kind: "missionBattleCounters" }],
    use_power_flip: [{ kind: "player" }],
    use_skill: [{ kind: "missionBattleCounters" }],
    character_level: [{ kind: "characters" }],
    user_rank: [{ kind: "player" }],
    clear_episode: [{ kind: "questProgress", sections: [3] }],
    total_login: [{ kind: "player" }],
    special_total_login_2anv: [{ kind: "player" }],
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

    const questSection = getRegularQuestFactSection(definition, catalog)
    if (questSection !== undefined) {
        return {
            mode: "computed",
            facts: [{ kind: "questProgress", sections: [questSection] }],
        }
    }
    return {
        mode: "unsupported",
        reason: "Regular mission has no authoritative computed mapping or atomic producer.",
    }
}

function dailyDependencies(definition: MissionMasterDefinition): readonly MissionRef[] {
    return getDailyCompletionDependencies(definition)
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
    // Condition-number routing (data-driven): battle shapes are served by
    // the per-battle producer through the shared quest-range translator;
    // login, dash, and stamina shapes compute from periodic player facts.
    const conditionType = Number(definition.row[2])
    if (DAILY_BATTLE_PRODUCER_TYPES.has(conditionType)
        || conditionType === DAILY_GACHA_DRAW_CONDITION_TYPE) {
        return { mode: "persisted" }
    }
    if (DAILY_PERIODIC_COMPUTED_TYPES.has(conditionType)) {
        // Dash rows keep the periodic computed path (statistics code 2);
        // other zone-statistics codes go through the per-battle producer.
        if (conditionType === 28 && Number(definition.row[3]) !== 2) {
            return { mode: "persisted" }
        }
        return { mode: "computed", facts: [{ kind: "player" }, snapshot] }
    }
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

const COLLECT_BATTLE_PRODUCER_TYPES: ReadonlySet<number> = new Set([14, 16, 17, 18, 23, 26])
const COLLECT_MANA_CONDITION_TYPE = 46

function getCollectRequirement(definition: MissionMasterDefinition): MissionFactRequirementDraft {
    const itemId = parsePositiveSafeIntegerMasterValue(definition.row[14])
    if (itemId !== undefined) {
        return { mode: "computed", facts: [{ kind: "collectedItems", itemIds: [itemId] }] }
    }
    const dependencies = getCollectCompletionDependencies(definition)
        .map(missionId => ({ category: 4, missionId }))
    if (dependencies.length > 0) {
        return { mode: "computed", missionDependencies: dependencies }
    }
    // Condition-number routing: battle shapes are served by the per-battle
    // producer through the collect range layout; mana spend by the spend-time
    // hook. Both carry their own enable-window gates.
    const conditionType = Number(definition.row[4])
    if (COLLECT_BATTLE_PRODUCER_TYPES.has(conditionType)
        || conditionType === COLLECT_MANA_CONDITION_TYPE
        || conditionType === 28 || conditionType === 31 || conditionType === 39) {
        return { mode: "persisted" }
    }
    const currentState = getCollectCurrentStateShape(conditionType)
    if (currentState !== undefined) {
        return { mode: "computed", facts: currentState.facts }
    }
    if (conditionType === 0) {
        return { mode: "unsupported", reason: "collect-event-window-login-fact-unavailable" }
    }
    if (conditionType === 88) {
        return { mode: "unsupported", reason: "player-history-view-fact-unavailable" }
    }
    return { mode: "unsupported", reason: "Collect mission shape has no authoritative fact source." }
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
