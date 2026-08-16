import { buildCategoryFactPlan, getFactLoadPlanKey } from "./category-session-plan"
import type { Player, PlayerCharacter, PlayerEquipment, PlayerQuestProgress } from "../../data/types"
import {
    buildDegreeRuleCatalog,
    type DegreeRule,
} from "./degree-rule-catalog"
import { deriveDegreeStats, type DegreeLoadedFacts } from "./degree-state-derivation"
import { cloneAndFreeze } from "./degree-immutable"
import type { MissionEvaluationSession } from "./evaluation-session"
import { getFactKeyId } from "./facts/fact-key"
import type { MissionFactRequirement } from "./requirements/types"
import type { CategoryContext } from "./types"

function projectPlayer(player: Player): Player {
    return {
        id: player.id,
        rankPoint: player.rankPoint,
        totalStaminaUsed: player.totalStaminaUsed,
        totalDashes: player.totalDashes,
        maxComboAchieved: player.maxComboAchieved,
        totalLoginDays: player.totalLoginDays,
    } as Player
}

function projectCharacters(characters: Record<string, PlayerCharacter>): NonNullable<DegreeLoadedFacts["characters"]> {
    return Object.fromEntries(Object.entries(characters).map(([characterId, character]) => [
        characterId,
        {
            overLimitStep: character.overLimitStep,
            exp: character.exp,
            bondTokenList: character.bondTokenList.map(token => ({
                manaBoardIndex: token.manaBoardIndex,
                status: token.status,
            })),
        },
    ]))
}

function projectQuestProgress(progress: Record<string, PlayerQuestProgress[]>): NonNullable<DegreeLoadedFacts["questProgress"]> {
    return Object.fromEntries(Object.entries(progress).map(([section, quests]) => [
        section,
        quests.map(quest => ({
            questId: quest.questId,
            finished: quest.finished,
            clearRank: quest.clearRank,
        })),
    ]))
}

function projectEquipment(equipment: Record<string, PlayerEquipment>): NonNullable<DegreeLoadedFacts["equipment"]> {
    return Object.fromEntries(Object.entries(equipment).map(([equipmentId, item]) => [
        equipmentId,
        { level: item.level },
    ]))
}

function ruleMode(rule: DegreeRule): MissionFactRequirement["mode"] {
    return rule.kind === "persisted" || rule.kind === "unsupported"
        ? rule.kind
        : "computed"
}

function factIds(requirement: MissionFactRequirement | DegreeRule): readonly string[] {
    return requirement.facts.map(getFactKeyId).sort()
}

function assertRuleRequirementInvariant(
    missionId: number,
    rule: DegreeRule | undefined,
    requirement: MissionFactRequirement,
): asserts rule is DegreeRule {
    const prefix = `Degree Session invariant failed for 5:${missionId}: `
    if (!rule) throw new Error(`${prefix}Catalog rule is missing`)
    if (ruleMode(rule) !== requirement.mode) {
        throw new Error(`${prefix}requirement mode must match the Catalog rule`)
    }
    const expected = factIds(rule)
    const actual = factIds(requirement)
    if (expected.length !== actual.length
        || expected.some((id, index) => id !== actual[index])) {
        throw new Error(`${prefix}${requirement.mode} requirement facts/selector must match the Catalog rule`)
    }
}

export function buildDegreeCategoryContextFromSession(
    session: MissionEvaluationSession,
    category: number,
    missionIds: readonly number[],
): CategoryContext {
    if (category !== 5) throw new Error("Degree Session context only supports category 5")
    const requestedIds = new Set(missionIds)
    const catalog = buildDegreeRuleCatalog(session.catalog, missionIds)
    const candidateById = new Map(session.candidateRequirements
        .filter(candidate => candidate.category === 5 && requestedIds.has(candidate.missionId))
        .map(candidate => [candidate.missionId, candidate]))

    for (const missionId of new Set(missionIds)) {
        const candidate = candidateById.get(missionId)
        if (!candidate) {
            throw new Error(`Mission 5:${missionId} is outside the evaluation Session candidates`)
        }
        assertRuleRequirementInvariant(
            missionId,
            catalog.rules.get(missionId),
            candidate.requirement,
        )
    }

    const plan = buildCategoryFactPlan(session, 5, missionIds)
    const charactersKey = getFactLoadPlanKey(plan, "characters")
    const manaNodesKey = getFactLoadPlanKey(plan, "characterManaNodes")
    const battleKey = getFactLoadPlanKey(plan, "missionBattleCounters")
    const degreeBattleKey = getFactLoadPlanKey(plan, "degreeBattleStats")
    const questKey = getFactLoadPlanKey(plan, "questProgress")
    const shopKey = getFactLoadPlanKey(plan, "shopPurchases")
    const collectedKey = getFactLoadPlanKey(plan, "collectedItems")
    const equipmentKey = getFactLoadPlanKey(plan, "equipment")
    const facts = cloneAndFreeze<DegreeLoadedFacts>({
        ...(charactersKey ? {
            characters: projectCharacters(session.getFactFromPlan(charactersKey, plan)),
        } : {}),
        ...(manaNodesKey ? { characterManaNodes: session.getFactFromPlan(manaNodesKey, plan) } : {}),
        ...(battleKey ? { missionBattleCounters: session.getFactFromPlan(battleKey, plan) } : {}),
        ...(degreeBattleKey ? { degreeBattleStats: session.getFactFromPlan(degreeBattleKey, plan) } : {}),
        ...(questKey ? {
            questProgress: projectQuestProgress(session.getFactFromPlan(questKey, plan)),
        } : {}),
        ...(shopKey ? { shopPurchases: session.getFactFromPlan(shopKey, plan) } : {}),
        ...(collectedKey ? { collectedItems: session.getFactFromPlan(collectedKey, plan) } : {}),
        ...(equipmentKey ? {
            equipment: projectEquipment(session.getFactFromPlan(equipmentKey, plan)),
        } : {}),
    })
    const player = cloneAndFreeze(projectPlayer(session.getFact({ kind: "player" })))
    const degreeStats = deriveDegreeStats(facts, catalog.rules, catalog.tables)

    return Object.freeze({
        category: 5,
        playerId: session.playerId,
        player,
        questProgress: Object.freeze({}),
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: Object.freeze({}),
        ...(battleKey ? { battleCounters: facts.missionBattleCounters } : {}),
        degreeRules: catalog.rules,
        degreeStats,
    })
}
