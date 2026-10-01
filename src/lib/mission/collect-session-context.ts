import { buildCategoryFactPlan, getFactLoadPlanKey } from "./category-session-plan"
import type { MissionEvaluationSession } from "./evaluation-session"
import type { FactKey } from "./facts/fact-key"
import { parsePositiveSafeIntegerMasterValue } from "./master-value"
import { getCollectCurrentStateShape } from "./collect-current-state"
import { deriveEventCurrentState } from "./event-static-state"
import {
    buildEventSafeQuestProgress,
    getEventCurrentStateStaticIndex,
} from "./computer-event-safe"
import type { CategoryContext } from "./types"

type CollectedItemsFactKey = Extract<FactKey, { kind: "collectedItems" }>

function currentStateShapeFor(
    session: MissionEvaluationSession,
    missionId: number,
): ReturnType<typeof getCollectCurrentStateShape> {
    const definition = session.catalog.getDefinition(4, missionId)
    if (definition === undefined) return undefined
    return getCollectCurrentStateShape(Number(definition.row[4]))
}

export function buildCollectCategoryContextFromSession(
    session: MissionEvaluationSession,
    missionIds: readonly number[],
): CategoryContext {
    const plan = buildCategoryFactPlan(session, 4, missionIds)
    const requestedIds = new Set(missionIds)
    const collectMissionItemIds = new Map<number, number>()

    const charactersKey = getFactLoadPlanKey(plan, "characters")
    const manaNodesKey = getFactLoadPlanKey(plan, "characterManaNodes")
    const questKey = getFactLoadPlanKey(plan, "questProgress")
    const equipmentKey = getFactLoadPlanKey(plan, "equipment")
    const itemsKey = getFactLoadPlanKey(plan, "items")
    const partyGroupsKey = getFactLoadPlanKey(plan, "partyGroups")

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
        // Dependency-shaped computed missions (complete-all, condition 13)
        // legitimately carry no collected-item facts; their progress derives
        // from their dependency list in the post-evaluate completion pass.
        if (collectedFacts.length === 0
            && (candidate.requirement.missionDependencies?.length ?? 0) > 0) {
            continue
        }
        // Current-state shapes carry state facts instead; validated against
        // the shape map so a drift between provider and rows fails closed.
        if (collectedFacts.length === 0
            && currentStateShapeFor(session, candidate.missionId) !== undefined) {
            continue
        }
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

    const currentStateMissionIds = missionIds.filter(missionId => (
        currentStateShapeFor(session, missionId) !== undefined
    ))
    const questProgress = questKey
        ? buildEventSafeQuestProgress(session.getFactFromPlan(questKey, plan))
        : {}

    return {
        category: 4,
        playerId: session.playerId,
        player: session.getFact({ kind: "player" }),
        questProgress,
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: {},
        collectedItemTotals: collectedItemsKey
            ? session.getFactFromPlan(collectedItemsKey, plan)
            : {},
        collectMissionItemIds,
        ...(currentStateMissionIds.length === 0 ? {} : {
            eventCurrentState: deriveEventCurrentState(
                {
                    characters: charactersKey
                        ? session.getFactFromPlan(charactersKey, plan)
                        : undefined,
                    characterManaNodes: manaNodesKey
                        ? session.getFactFromPlan(manaNodesKey, plan)
                        : undefined,
                    questProgress,
                    equipment: equipmentKey
                        ? session.getFactFromPlan(equipmentKey, plan)
                        : undefined,
                    items: itemsKey
                        ? session.getFactFromPlan(itemsKey, plan)
                        : undefined,
                    partyGroups: partyGroupsKey
                        ? session.getFactFromPlan(partyGroupsKey, plan)
                        : undefined,
                },
                getEventCurrentStateStaticIndex(session.catalog),
                currentStateMissionIds,
                missionId => {
                    const shape = currentStateShapeFor(session, missionId)
                    return shape === undefined ? undefined : {
                        patternType: Number(
                            session.catalog.getDefinition(4, missionId)?.row[4],
                        ),
                        targets: session.catalog
                            .getRewardStages(4, missionId)
                            .map(stage => stage.targetProgress),
                        fact: shape.fact,
                    }
                },
            ),
        }),
    }
}
