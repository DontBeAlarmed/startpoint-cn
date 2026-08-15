import type { MissionEvaluationSession } from "./evaluation-session"
import type { FactKey } from "./facts/fact-key"
import { buildFactLoadPlan } from "./facts/load-plan"
import type { MissionFactLoadPlan } from "./facts/types"

export function buildCategoryFactPlan(
    session: MissionEvaluationSession,
    category: number,
    missionIds: readonly number[],
): MissionFactLoadPlan {
    const requestedIds = new Set(missionIds)
    const foundIds = new Set<number>()
    const facts: FactKey[] = []
    for (const candidate of session.candidateRequirements) {
        if (candidate.category !== category || !requestedIds.has(candidate.missionId)) continue
        foundIds.add(candidate.missionId)
        if (candidate.requirement.mode === "computed") {
            facts.push(...candidate.requirement.facts)
        }
    }
    const missingMissionId = missionIds.find(missionId => !foundIds.has(missionId))
    if (missingMissionId !== undefined) {
        throw new Error(
            `Mission ${category}:${missingMissionId} is outside the evaluation Session candidates`,
        )
    }
    return buildFactLoadPlan(facts)
}

export function getFactLoadPlanKey<Kind extends FactKey["kind"]>(
    plan: MissionFactLoadPlan,
    kind: Kind,
): Extract<FactKey, { kind: Kind }> | undefined {
    return plan.keys.find(key => key.kind === kind) as
        | Extract<FactKey, { kind: Kind }>
        | undefined
}
