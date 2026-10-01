import { ensurePlayerCategoryMissionProgressSync, incrementPlayerCategoryMissionSync } from "../../data/domains/mission"
import type { FinishContext } from "../quest/finish/types"
import { getMissionCatalog, isMissionMasterDefinitionEnabledAt } from "./mission-catalog"
import { getMissionRequirementDraft } from "./requirements/providers"
import { matchesBattleCountCondition } from "./battle-count-condition"
import { COLLECT_MISSION_RANGE_LAYOUT } from "./quest-range-translator"
import { matchesZoneStatisticsCountCondition } from "./battle-count-condition"

const COLLECT_BATTLE_CONDITION_TYPES: ReadonlySet<number> = new Set([14, 16, 17, 18, 23, 26])
const COLLECT_MANA_CONDITION_TYPE = 46
const COLLECT_ZONE_STATISTICS_CONDITION_TYPE = 28
const COLLECT_SKILL_CHAIN_CONDITION_TYPE = 31

/**
 * Zone-statistics codes for condition 28, cross-verified against both the
 * daily (selector column 3) and collect (selector column 5) tables: every
 * row's code maps to exactly one text family with zero conflicts, and the
 * two tables agree on the overlapping codes 2 (dash) and 4 (skill).
 */
const ZONE_STATISTICS_FIELDS: Readonly<Record<number, string>> = Object.freeze({
    0: "weak_point_attack_count",
    1: "use_power_flip_count",
    2: "use_dash_count",
    4: "use_skill_count",
    5: "fever_count",
    7: "enemy_kill_count",
})

export function sumCollectZoneStatistic(
    context: { statistics?: { zones?: readonly unknown[] } },
    selectorColumnValue: unknown,
): number | null {
    const field = ZONE_STATISTICS_FIELDS[Number(selectorColumnValue)]
    if (field === undefined) return null
    return sumZoneStatistic(context.statistics?.zones, field)
}

function sumZoneStatistic(
    zones: readonly unknown[] | undefined,
    field: string,
): number | null {
    if (!Array.isArray(zones)) return null
    let total = 0
    for (const entry of zones) {
        if (entry === null || typeof entry !== "object") return null
        const value = (entry as Record<string, unknown>)[field]
        if (value === undefined) continue
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null
        total += value
        if (!Number.isSafeInteger(total)) return null
    }
    return total
}

function openPersistedCollectMissions(
    catalog: ReturnType<typeof getMissionCatalog>,
    predicate: (definition: import("./mission-catalog").MissionMasterDefinition) => boolean,
    evaluationTime: Date,
) {
    const matched: import("./mission-catalog").MissionMasterDefinition[] = []
    for (const definition of catalog.getDefinitions(4)) {
        if (!predicate(definition)) continue
        if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime, definition.eventId)) continue
        matched.push(definition)
    }
    return matched
}

/**
 * Collect-event battle facts: routed by condition number through the shared
 * matcher with the collect column layout. Event scope is enforced by the
 * catalog's requiresEventScope check against the mission's own event id, and
 * the range containment already pins the event's quests.
 */
export function recordCollectMissionBattleFacts(
    context: FinishContext,
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []

    const catalog = getMissionCatalog()
    const matchedMissionIds: number[] = []
    for (const definition of catalog.getDefinitions(4)) {
        const conditionType = Number(definition.row[4])
        if (!COLLECT_BATTLE_CONDITION_TYPES.has(conditionType)) continue
        if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime, definition.eventId)) continue
        if (!matchesBattleCountCondition(definition.row, conditionType, context, COLLECT_MISSION_RANGE_LAYOUT)) continue

        incrementPlayerCategoryMissionSync(context.playerId, 4, definition.missionId, 1)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}

/**
 * Mana spent inside a collect event: the ledger increments carry their own
 * time gate (the mission must be inside its enable window), so they must be
 * called from the same transaction as the mana deduction.
 */
export function recordCollectMissionManaSpend(
    playerId: number,
    amount: number,
    evaluationTime: Date,
): number[] {
    if (!Number.isSafeInteger(amount) || amount <= 0) return []

    const catalog = getMissionCatalog()
    const matchedMissionIds: number[] = []
    for (const definition of catalog.getDefinitions(4)) {
        if (Number(definition.row[4]) !== COLLECT_MANA_CONDITION_TYPE) continue
        if (getMissionRequirementDraft(definition, catalog).mode !== "persisted") continue
        if (!isMissionMasterDefinitionEnabledAt(definition, evaluationTime, definition.eventId)) continue

        incrementPlayerCategoryMissionSync(playerId, 4, definition.missionId, amount)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}

/**
 * Condition 28 rows: per-battle sum of the selected zone statistic. The
 * statistics code rides the collect selector column (5); any invalid zone
 * value rejects the whole battle (fail closed).
 */
export function recordCollectMissionZoneStatisticsFacts(
    context: Parameters<typeof recordCollectMissionBattleFacts>[0],
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []
    const catalog = getMissionCatalog()
    const missions = openPersistedCollectMissions(
        catalog,
        definition => Number(definition.row[4]) === COLLECT_ZONE_STATISTICS_CONDITION_TYPE,
        evaluationTime,
    )
    if (missions.length === 0) return []

    const matchedMissionIds: number[] = []
    for (const definition of missions) {
        if (!matchesZoneStatisticsCountCondition(
            definition.row,
            context,
            COLLECT_MISSION_RANGE_LAYOUT,
        )) continue
        const field = ZONE_STATISTICS_FIELDS[Number(definition.row[5])]
        const amount = field === undefined
            ? null
            : sumZoneStatistic(context.statistics?.zones, field)
        if (field === undefined || amount === null || amount <= 0) continue
        incrementPlayerCategoryMissionSync(context.playerId, 4, definition.missionId, amount)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}

/**
 * Condition 31 rows: highest skill chain achieved in a cleared battle; the
 * ledger keeps the running maximum via the MAX-merge writer.
 */
export function recordCollectMissionSkillChainFacts(
    context: Parameters<typeof recordCollectMissionBattleFacts>[0],
    evaluationTime: Date,
): number[] {
    if (!context.questAccomplished) return []
    const chain = context.statistics?.max_skill_chain_count
    if (typeof chain !== "number" || !Number.isSafeInteger(chain) || chain <= 0) return []
    const catalog = getMissionCatalog()
    const matchedMissionIds: number[] = []
    for (const definition of openPersistedCollectMissions(
        catalog,
        definition => Number(definition.row[4]) === COLLECT_SKILL_CHAIN_CONDITION_TYPE,
        evaluationTime,
    )) {
        ensurePlayerCategoryMissionProgressSync(context.playerId, 4, definition.missionId, chain)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}

/**
 * Condition 39 rows: stamina committed by a cleared battle entry. Runs in
 * the entry-resource commit transaction with its own window gate.
 */
export function recordCollectMissionStaminaSpend(
    playerId: number,
    amount: number,
    evaluationTime: Date,
): number[] {
    if (!Number.isSafeInteger(amount) || amount <= 0) return []
    const catalog = getMissionCatalog()
    const matchedMissionIds: number[] = []
    for (const definition of openPersistedCollectMissions(
        catalog,
        definition => Number(definition.row[4]) === 39,
        evaluationTime,
    )) {
        incrementPlayerCategoryMissionSync(playerId, 4, definition.missionId, amount)
        matchedMissionIds.push(definition.missionId)
    }
    return matchedMissionIds
}
