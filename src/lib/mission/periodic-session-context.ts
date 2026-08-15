import { getFactKeyId, type PeriodicSnapshotKind } from "./facts/fact-key"
import type { MissionEvaluationSession } from "./evaluation-session"
import type { CategoryContext } from "./types"

function getCategoryFactIds(
    session: MissionEvaluationSession,
    category: number,
    missionIds: readonly number[],
): ReadonlySet<string> {
    const requestedIds = new Set(missionIds)
    const foundIds = new Set<number>()
    const factIds = new Set<string>()

    for (const candidate of session.candidateRequirements) {
        if (candidate.category !== category || !requestedIds.has(candidate.missionId)) continue
        foundIds.add(candidate.missionId)
        for (const fact of candidate.requirement.facts) factIds.add(getFactKeyId(fact))
    }

    const missingMissionId = missionIds.find(missionId => !foundIds.has(missionId))
    if (missingMissionId !== undefined) {
        throw new Error(
            `Mission ${category}:${missingMissionId} is outside the evaluation Session candidates`,
        )
    }
    return factIds
}

export function buildPeriodicCategoryContextFromSession(
    session: MissionEvaluationSession,
    category: number,
    missionIds: readonly number[],
    snapshotKind: Extract<PeriodicSnapshotKind, "daily" | "weekly">,
): CategoryContext {
    const factIds = getCategoryFactIds(session, category, missionIds)
    const battleKey = { kind: "missionBattleCounters" } as const
    const snapshotKey = { kind: "periodicSnapshot", snapshotKind } as const

    return {
        category,
        playerId: session.playerId,
        player: session.getFact({ kind: "player" }),
        questProgress: {},
        totalQuestClears: 0,
        totalStories: 0,
        rankCounts: { rank_ss: 0, rank_s: 0, rank_a: 0, rank_b: 0 },
        ...(factIds.has(getFactKeyId(battleKey))
            ? { battleCounters: session.getFact(battleKey) }
            : {}),
        ...(factIds.has(getFactKeyId(snapshotKey))
            ? { snapshot: session.getFact(snapshotKey) }
            : {}),
    }
}
