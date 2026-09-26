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
import {
    PASS_DAILY_COMPUTED_CONDITIONS,
    PASS_EVENT_COMPUTED_LOGIN_CONDITION,
    PASS_EVENT_PERSISTED_CONDITIONS,
    PASS_WEEK_CONDITIONS,
    PASS_WEEK_EMOTION_CONDITION,
    REGULAR_COMPUTED_FACTS_BY_CONDITION,
    REGULAR_CRAFT_POINT_CONDITION,
    REGULAR_EX_RANK_SS_SECTION,
    REGULAR_PERSISTED_CONDITIONS,
    REGULAR_QUEST_RANGE_CONDITIONS,
    REGULAR_QUEST_SECTION_BY_RANGE_KIND,
    REGULAR_TYPE_28_FACTS_BY_STATISTICS_CODE,
} from "./condition-routing"
import type { MissionFactRequirementDraft, MissionRef } from "./types"

const DAILY_BATTLE_PRODUCER_TYPES: ReadonlySet<number> = new Set([
    14, 16, 17, 18, 23, 26, 49, 50, 51, 52,
])

const DAILY_PERIODIC_COMPUTED_TYPES: ReadonlySet<number> = new Set([0, 28, 39])
const DAILY_GACHA_DRAW_CONDITION_TYPE = 78

function isMasterRangeKind(value: unknown): boolean {
    return typeof value === "string" && /^\d+$/.test(value)
}

/**
 * Condition-number routing for Regular missions. The retired pattern-name
 * tables (REGULAR_FACTS / REGULAR_PERSISTED_PATTERNS) survive as startup
 * cross-checks in routing-validation.ts; routing itself reads only the
 * condition number, the range kind, and the zone-statistics code.
 */
function getRegularRequirement(
    definition: MissionMasterDefinition,
    catalog: MissionCatalog,
): MissionFactRequirementDraft {
    const conditionType = Number(definition.row[2])
    if (conditionType === REGULAR_CRAFT_POINT_CONDITION) {
        return {
            mode: "computed",
            facts: [{
                kind: "collectedItems",
                itemIds: [getMissionCatalogCraftPointItemId(catalog)],
            }],
        }
    }
    const directFacts = REGULAR_COMPUTED_FACTS_BY_CONDITION[conditionType]
    if (directFacts) return { mode: "computed", facts: directFacts }
    if (REGULAR_PERSISTED_CONDITIONS.has(conditionType)) return { mode: "persisted" }

    if (REGULAR_QUEST_RANGE_CONDITIONS.has(conditionType)) {
        // Quest-range shapes: a range kind hands the row to the quest-rule
        // resolver (sections by range kind, selectors validated there);
        // rangeless battle-count shapes keep the battle-counter capability.
        if (isMasterRangeKind(definition.row[7])) {
            if (conditionType === 26) {
                // EX SS ranks (range kind 1) count inside the EX section
                // directly; any other pinned range fails closed.
                if (Number(definition.row[7]) !== 1) {
                    return {
                        mode: "unsupported",
                        reason: "Regular mission has no authoritative computed mapping or atomic producer.",
                    }
                }
                return {
                    mode: "computed",
                    facts: [{
                        kind: "questProgress",
                        sections: [REGULAR_EX_RANK_SS_SECTION],
                    }],
                }
            }
            const questSection = getRegularQuestFactSection(definition, catalog)
            if (questSection !== undefined
                && questSection === REGULAR_QUEST_SECTION_BY_RANGE_KIND[Number(definition.row[7])]) {
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
        if (conditionType === 14 || conditionType === 26) {
            return { mode: "computed", facts: [{ kind: "missionBattleCounters" }] }
        }
    }

    if (conditionType === 28) {
        const facts = REGULAR_TYPE_28_FACTS_BY_STATISTICS_CODE[Number(definition.row[3])]
        if (facts) return { mode: "computed", facts }
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
const COLLECT_EVENT_LOGIN_CONDITION_TYPE = 0
const COLLECT_PROFILE_VIEW_CONDITION_TYPE = 88

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
    // hook; window login (0) and profile view (88) by the collect entry
    // facts. All carry their own enable-window gates.
    const conditionType = Number(definition.row[4])
    if (COLLECT_BATTLE_PRODUCER_TYPES.has(conditionType)
        || conditionType === COLLECT_MANA_CONDITION_TYPE
        || conditionType === 28 || conditionType === 31 || conditionType === 39
        || conditionType === COLLECT_EVENT_LOGIN_CONDITION_TYPE
        || conditionType === COLLECT_PROFILE_VIEW_CONDITION_TYPE) {
        return { mode: "persisted" }
    }
    const currentState = getCollectCurrentStateShape(conditionType)
    if (currentState !== undefined) {
        return { mode: "computed", facts: currentState.facts }
    }
    return { mode: "unsupported", reason: "Collect mission shape has no authoritative fact source." }
}

/**
 * Condition-number routing for Pass missions: the daily snapshot family
 * (category 6), the pass-week snapshot family with its emotion producer
 * (category 7), and the event-login plus persisted battle producers
 * (category 8).
 */
function getPassRequirement(definition: MissionMasterDefinition): MissionFactRequirementDraft {
    const eventId = definition.eventId
    if (!Number.isSafeInteger(eventId) || eventId! <= 0) {
        return { mode: "unsupported", reason: "Pass mission event scope is invalid." }
    }
    const patternType = definition.patternType
    if (definition.category === 6) {
        const facts = patternType === undefined
            ? undefined
            : PASS_DAILY_COMPUTED_CONDITIONS[patternType]
        if (facts) return { mode: "computed", facts }
    }
    if (definition.category === 7) {
        if (patternType === PASS_WEEK_EMOTION_CONDITION) return { mode: "persisted" }
        if (patternType !== undefined && PASS_WEEK_CONDITIONS.has(patternType)) {
            const snapshot: FactKey = {
                kind: "periodicSnapshot",
                snapshotKind: "passWeek",
                eventId: eventId!,
            }
            return {
                mode: "computed",
                facts: [
                    patternType === 16 ? { kind: "missionBattleCounters" } : { kind: "player" },
                    snapshot,
                ],
            }
        }
    }
    if (definition.category === 8) {
        if (patternType === PASS_EVENT_COMPUTED_LOGIN_CONDITION) {
            return {
                mode: "computed",
                facts: [{ kind: "player" }, { kind: "passState", eventId: eventId! }],
            }
        }
        if (patternType !== undefined && PASS_EVENT_PERSISTED_CONDITIONS.has(patternType)) {
            return { mode: "persisted" }
        }
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
