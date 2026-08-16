import { buildCategoryFactPlan, getFactLoadPlanKey } from "./category-session-plan"
import {
    buildEventSafeQuestProgress,
    getEventCurrentStateStaticIndex,
} from "./computer-event-safe"
import { selectEventRules } from "./event-rule-catalog"
import { deriveEventCurrentState } from "./event-static-state"
import type { MissionEvaluationSession } from "./evaluation-session"
import { getFactKeyId } from "./facts/fact-key"
import { buildFactLoadPlan } from "./facts/load-plan"
import { getEventRequirement } from "./requirements/provider-event"
import type { MissionFactRequirement, MissionRef } from "./requirements/types"
import type { CategoryContext } from "./types"

function dependencyIds(requirement: Pick<MissionFactRequirement, "missionDependencies">): readonly string[] {
    return requirement.missionDependencies
        .map(dependency => `${dependency.category}:${dependency.missionId}`)
        .sort()
}

function factIds(requirement: Pick<MissionFactRequirement, "facts">): readonly string[] {
    return requirement.facts.map(getFactKeyId).sort()
}

function expectedRequirement(
    session: MissionEvaluationSession,
    missionId: number,
): MissionFactRequirement {
    const definition = session.catalog.getDefinition(3, missionId)
    if (!definition) throw new Error(`Event Session Catalog rule is missing for 3:${missionId}`)
    const draft = getEventRequirement(definition, session.catalog)
    const dependencies = (draft.missionDependencies ?? [])
        .filter(dependency => session.catalog.getDefinition(
            dependency.category,
            dependency.missionId,
        ) !== undefined)
        .map((dependency): MissionRef => Object.freeze({ ...dependency }))
        .sort((left, right) => left.category - right.category || left.missionId - right.missionId)
    return {
        mode: draft.mode,
        facts: buildFactLoadPlan(draft.facts ?? []).keys,
        missionDependencies: dependencies,
        ...(draft.reason === undefined ? {} : { reason: draft.reason }),
    }
}

function assertRequirementInvariant(
    session: MissionEvaluationSession,
    missionId: number,
    requirement: MissionFactRequirement,
): void {
    const expected = expectedRequirement(session, missionId)
    const prefix = `Event Session invariant failed for 3:${missionId}: `
    if (expected.mode !== requirement.mode) {
        throw new Error(`${prefix}requirement mode must match the Catalog rule`)
    }
    if (factIds(expected).join("|") !== factIds(requirement).join("|")) {
        throw new Error(`${prefix}${requirement.mode} requirement facts/selector must match the Catalog rule`)
    }
    if (dependencyIds(expected).join("|") !== dependencyIds(requirement).join("|")) {
        throw new Error(`${prefix}mission dependencies must match the Catalog rule`)
    }
}

export function buildEventCategoryContextFromSession(
    session: MissionEvaluationSession,
    category: number,
    missionIds: readonly number[],
): CategoryContext {
    if (category !== 3) throw new Error("Event Session context only supports category 3")
    const requestedIds = new Set(missionIds)
    const candidateById = new Map(session.candidateRequirements
        .filter(candidate => candidate.category === 3 && requestedIds.has(candidate.missionId))
        .map(candidate => [candidate.missionId, candidate]))
    for (const missionId of requestedIds) {
        const candidate = candidateById.get(missionId)
        if (!candidate) {
            throw new Error(`Mission 3:${missionId} is outside the evaluation Session candidates`)
        }
        assertRequirementInvariant(session, missionId, candidate.requirement)
    }

    const computedMissionIds = missionIds.filter(missionId => (
        candidateById.get(missionId)?.requirement.mode === "computed"
    ))
    const eventRules = selectEventRules(session.catalog, computedMissionIds)
    const plan = buildCategoryFactPlan(session, 3, missionIds)
    const questKey = getFactLoadPlanKey(plan, "questProgress")
    const collectedKey = getFactLoadPlanKey(plan, "collectedItems")
    const charactersKey = getFactLoadPlanKey(plan, "characters")
    const manaNodesKey = getFactLoadPlanKey(plan, "characterManaNodes")
    const equipmentKey = getFactLoadPlanKey(plan, "equipment")
    const itemsKey = getFactLoadPlanKey(plan, "items")
    const partyGroupsKey = getFactLoadPlanKey(plan, "partyGroups")
    const missionProgressKey = getFactLoadPlanKey(plan, "categoryMissionProgress")
    const questProgress = questKey
        ? buildEventSafeQuestProgress(session.getFactFromPlan(questKey, plan))
        : {}
    const collectedItemTotals = collectedKey
        ? session.getFactFromPlan(collectedKey, plan)
        : undefined
    const currentStateMissionIds = missionIds.filter(missionId => {
        const candidate = candidateById.get(missionId)
        if (candidate?.requirement.mode !== "computed") return false
        return eventRules.get(missionId)?.kind === "currentState"
    })
    const characters = charactersKey
        ? session.getFactFromPlan(charactersKey, plan)
        : undefined
    const characterManaNodes = manaNodesKey
        ? session.getFactFromPlan(manaNodesKey, plan)
        : undefined
    const equipment = equipmentKey
        ? session.getFactFromPlan(equipmentKey, plan)
        : undefined
    const items = itemsKey
        ? session.getFactFromPlan(itemsKey, plan)
        : undefined
    const partyGroups = partyGroupsKey
        ? session.getFactFromPlan(partyGroupsKey, plan)
        : undefined
    const eventMissionProgress = missionProgressKey
        ? session.getFactFromPlan(missionProgressKey, plan)
        : new Map<number, number>()

    return {
        category: 3,
        playerId: session.playerId,
        player: session.getFact({ kind: "player" }),
        questProgress,
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
        eventRules,
        ...(collectedItemTotals === undefined ? {} : { collectedItemTotals }),
        eventMissionProgress,
        ...(currentStateMissionIds.length === 0 ? {} : {
            eventCurrentState: deriveEventCurrentState(
                {
                    characters,
                    characterManaNodes,
                    questProgress,
                    equipment,
                    items,
                    partyGroups,
                },
                getEventCurrentStateStaticIndex(session.catalog),
                currentStateMissionIds,
                missionId => {
                    const rule = eventRules.get(missionId)
                    return rule?.kind === "currentState" ? rule.rule : undefined
                },
            ),
        }),
    }
}
