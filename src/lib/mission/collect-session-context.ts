import { buildCategoryFactPlan, getFactLoadPlanKey } from "./category-session-plan"
import type { MissionEvaluationSession } from "./evaluation-session"
import type { FactKey } from "./facts/fact-key"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"
import type { CategoryContext } from "./types"

type CollectedItemsFactKey = Extract<FactKey, { kind: "collectedItems" }>

export function buildCollectCategoryContextFromSession(
    session: MissionEvaluationSession,
    missionIds: readonly number[],
): CategoryContext {
    const plan = buildCategoryFactPlan(session, 4, missionIds)
    const requestedIds = new Set(missionIds)
    const collectMissionItemIds = new Map<number, number>()

    for (const candidate of session.candidateRequirements) {
        if (candidate.category !== 4
            || !requestedIds.has(candidate.missionId)
            || candidate.requirement.mode !== "computed") continue
        const itemId = parsePositiveSafeIntegerMasterValue(
            session.catalog.getDefinition(4, candidate.missionId)?.row[14],
        )
        const collectedFacts = candidate.requirement.facts.filter(
            (fact): fact is CollectedItemsFactKey => fact.kind === "collectedItems",
        )
        const selectedItemIds = collectedFacts.length === 1
            ? collectedFacts[0].itemIds
            : undefined
        if (itemId === undefined
            || selectedItemIds === undefined
            || selectedItemIds === "all"
            || selectedItemIds.length !== 1
            || selectedItemIds[0] !== itemId) {
            throw new Error(
                `Collect Session invariant failed for 4:${candidate.missionId}: `
                + "computed requirement selector must match the Catalog item selector",
            )
        }
        collectMissionItemIds.set(candidate.missionId, itemId)
    }
    const collectedItemsKey = getFactLoadPlanKey(plan, "collectedItems")

    return {
        category: 4,
        playerId: session.playerId,
        player: session.getFact({ kind: "player" }),
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
        collectedItemTotals: collectedItemsKey
            ? session.getFactFromPlan(collectedItemsKey, plan)
            : {},
        collectMissionItemIds,
    }
}
