import { mergePartyCoClearRows } from "./awake-battle-rules"
import type { AwakeContext } from "./computer-awake"
import type { MissionEvaluationSession } from "./evaluation-session"
import { getFactKeyId, type FactKey } from "./facts/fact-key"
import { buildFactLoadPlan } from "./facts/load-plan"
import { getAwakeRequirement } from "./requirements/provider-awake"
import type { MissionFactRequirement } from "./requirements/types"
import type { CategoryContext } from "./types"

function requirementSignature(requirement: MissionFactRequirement): string {
    return JSON.stringify({
        mode: requirement.mode,
        facts: requirement.facts.map(getFactKeyId),
        missionDependencies: requirement.missionDependencies.map(dependency => (
            `${dependency.category}:${dependency.missionId}`
        )),
    })
}

function expectedRequirementSignature(
    session: MissionEvaluationSession,
    missionId: number,
): string {
    const definition = session.catalog.getDefinition(9, missionId)
    if (!definition) throw new Error(`Awake mission ${missionId} is missing from the Session Catalog`)
    const draft = getAwakeRequirement(definition, session.catalog)
    return JSON.stringify({
        mode: draft.mode,
        facts: buildFactLoadPlan(draft.facts ?? []).keyIds,
        missionDependencies: [...(draft.missionDependencies ?? [])]
            .map(dependency => `${dependency.category}:${dependency.missionId}`)
            .sort(),
    })
}

function buildAwakeFactPlan(
    session: MissionEvaluationSession,
    category: number,
    missionIds: readonly number[],
) {
    if (category !== 9) throw new Error("Awake Session context requires category 9")
    const candidateMissionIds = new Set(session.candidateRequirements
        .filter(candidate => candidate.category === 9)
        .map(candidate => candidate.missionId))
    const facts: FactKey[] = [{ kind: "player" }]
    const visited = new Set<number>()
    const collect = (missionId: number): void => {
        if (!Number.isSafeInteger(missionId) || missionId <= 0) {
            throw new TypeError("Awake Session missionIds must be positive safe integers")
        }
        if (visited.has(missionId)) return
        visited.add(missionId)
        const requirement = session.requirementRegistry.getRequirement(9, missionId)
        if (!requirement) throw new Error(`Awake requirement missing for 9:${missionId}`)
        if (requirementSignature(requirement) !== expectedRequirementSignature(session, missionId)) {
            throw new Error(`Awake requirement mismatch for 9:${missionId}`)
        }
        facts.push(...requirement.facts)
        for (const dependency of requirement.missionDependencies) {
            if (dependency.category !== 9) {
                throw new Error(`Awake requirement dependency must use category 9 for 9:${missionId}`)
            }
            collect(dependency.missionId)
        }
    }
    for (const missionId of missionIds) {
        if (!candidateMissionIds.has(missionId)) {
            throw new Error(
                `Awake mission ${missionId} is outside the current Session candidate batch`,
            )
        }
        collect(missionId)
    }
    return buildFactLoadPlan(facts)
}

export function buildAwakeContextFromSession(
    session: MissionEvaluationSession,
    category: number,
    missionIds: readonly number[],
): AwakeContext {
    const awakePlan = buildAwakeFactPlan(session, category, missionIds)
    const planned = <Kind extends FactKey["kind"]>(kind: Kind) => (
        awakePlan.keys.find(key => key.kind === kind) as Extract<
            FactKey,
            { kind: Kind }
        > | undefined
    )
    const questKey = planned("questProgress")
    const characterKey = planned("characters")
    const clearKey = planned("characterClearCounters")
    const coClearKey = planned("partyCoClearCounters")
    const missionProgressKey = awakePlan.keys.find((key): key is Extract<FactKey, {
        kind: "categoryMissionProgress"
    }> => key.kind === "categoryMissionProgress" && key.category === 9)
    const playerKey = planned("player")!
    const player = session.getFactFromPlan(playerKey, awakePlan)
    const questProgressRaw = questKey ? session.getFactFromPlan(questKey, awakePlan) : {}
    const allChars = characterKey ? session.getFactFromPlan(characterKey, awakePlan) : {}
    const characterClears = clearKey
        ? session.getFactFromPlan(clearKey, awakePlan)
        : {}
    const coClearRows = coClearKey ? session.getFactFromPlan(coClearKey, awakePlan) : []
    const categoryMissionProgress = missionProgressKey
        ? new Map(session.getFactFromPlan(missionProgressKey, awakePlan))
        : new Map<number, number>()
    let totalQuestClears = 0
    let totalStories = 0
    const rankCounts = { rank_ss: 0, rank_s: 0, rank_a: 0, rank_b: 0 }
    const questProgress: CategoryContext["questProgress"] = {}
    for (const [section, quests] of Object.entries(questProgressRaw)) {
        questProgress[section] = quests.map(quest => ({
            questId: quest.questId,
            finished: quest.finished,
            clearRank: quest.clearRank,
            bestElapsedTimeMs: quest.bestElapsedTimeMs,
            leaderCharacterId: quest.leaderCharacterId,
            multiClearCount: quest.multiClearCount,
        }))
        for (const quest of quests) {
            if (!quest.finished) continue
            totalQuestClears++
            if (section === "3") totalStories++
            if (quest.clearRank === 5) rankCounts.rank_ss++
            else if (quest.clearRank === 4) rankCounts.rank_s++
            else if (quest.clearRank === 3) rankCounts.rank_a++
            else if (quest.clearRank === 2) rankCounts.rank_b++
        }
    }
    const charClears = new Map<string, number>()
    const leaderClears = new Map<string, number>()
    const multiClears = new Map<string, number>()
    const leaderMultiClears = new Map<string, number>()
    for (const [characterId, counters] of Object.entries(characterClears)) {
        charClears.set(characterId, counters.clear_count)
        leaderClears.set(characterId, counters.leader_clear_count)
        multiClears.set(characterId, counters.multi_count)
        leaderMultiClears.set(characterId, counters.leader_multi_count)
    }
    return {
        category: 9,
        playerId: session.playerId,
        player,
        questProgress,
        totalQuestClears,
        totalStories,
        rankCounts,
        charClears,
        leaderClears,
        multiClears,
        leaderMultiClears,
        coClears: mergePartyCoClearRows(coClearRows),
        charData: new Map(Object.entries(allChars)),
        categoryMissionProgress,
    }
}
