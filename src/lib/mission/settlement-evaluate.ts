import {
    getPlayerCategoryMissionsByCategoriesSync,
    getPlayerCategoryMissionsByIdsSync,
    getPlayerCategoryMissionsSync,
} from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import type { Player, PlayerActiveMission } from "../../data/types"
import { MissionEvaluationSession } from "./evaluation-session"
import { getMissionCatalog } from "./mission-catalog"
import { createProductionMissionFactLoaderRegistry } from "./production-fact-loaders"
import type { ProductionMissionFactSeeds } from "./production-fact-loaders"
import { getMissionFactRequirementRegistry } from "./requirements/registry"
import { getComputer } from "./registry"
import { getMissionPattern } from "./patterns"
import { isMissionProgressComplete } from "./stages"
import { getMissionMasterDefinition } from "./master-data"
import type { FactKey } from "./facts/fact-key"
import type { CategoryContext } from "./types"
import type {
    EvaluatedMissionResult,
    MissionEvaluationResult,
    MissionSettlementObserver,
    MissionSettlementPlayerSnapshot,
    PreparedMissionSettlement,
} from "./settlement"

const SESSION_CATEGORIES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

interface MutableEvaluatedMission {
    category: number
    missionId: number
    declaredFactDependencies: readonly FactKey[]
    dbProgress: number
    computedProgress: number
    finalProgress: number
    receivedStages: number[]
}

function isDailyCoreMission(pattern: string): boolean {
    return /^single_battle_play(?:_[23])?$/.test(pattern)
        || /^multi_battle_play(?:_[23])?$/.test(pattern)
        || /^use_dash(?:_[23])?$/.test(pattern)
        || pattern === "daily_quest_stamina_use_2024_02"
}

function applyDailyCompletionProgress(missions: MutableEvaluatedMission[]): void {
    const dailyMissions = missions.filter(mission => mission.category === 2)
    if (dailyMissions.length === 0) return
    const completedCoreCount = dailyMissions.filter(mission => (
        isDailyCoreMission(getMissionPattern(2, mission.missionId))
        && isMissionProgressComplete(2, mission.missionId, mission.finalProgress)
    )).length
    for (const mission of dailyMissions) {
        if (!getMissionPattern(2, mission.missionId).startsWith("daily_quest_all_clear")) continue
        mission.finalProgress = Math.max(mission.dbProgress, completedCoreCount)
    }
}

function snapshotPlayer(player: Player): MissionSettlementPlayerSnapshot {
    const snapshot = Object.fromEntries(Object.entries(player).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
    ]))
    return Object.freeze(snapshot) as MissionSettlementPlayerSnapshot
}

function receivedStageNumbers(stages: Record<string, boolean> | unknown[]): number[] {
    if (Array.isArray(stages)) return []
    return Object.entries(stages)
        .filter(([, received]) => received === true)
        .map(([stage]) => Number(stage))
        .filter(stage => Number.isSafeInteger(stage) && stage > 0)
        .sort((left, right) => left - right)
}

function freezeMission(mission: MutableEvaluatedMission): EvaluatedMissionResult {
    return Object.freeze({
        ...mission,
        receivedStages: Object.freeze([...mission.receivedStages]),
    })
}

function groupPassMissionIds(
    category: number,
    missionIds: readonly number[],
): readonly (readonly number[])[] {
    if (category !== 7 && category !== 8) return [missionIds]
    const groups = new Map<string, number[]>()
    for (const missionId of missionIds) {
        const eventId = getMissionMasterDefinition(category, missionId)?.eventId
        const key = eventId === undefined ? "unknown" : String(eventId)
        const group = groups.get(key) ?? []
        group.push(missionId)
        groups.set(key, group)
    }
    return [...groups.values()]
}

export function evaluateMissionCandidates(
    prepared: PreparedMissionSettlement,
    observer?: MissionSettlementObserver,
    factSeeds: ProductionMissionFactSeeds = {},
): MissionEvaluationResult {
    if (prepared.candidates.length === 0) {
        throw new Error("Mission evaluation requires at least one prepared candidate")
    }
    const catalog = getMissionCatalog()
    const requirementRegistry = getMissionFactRequirementRegistry(catalog)
    const loaderCalls: FactKey[] = []
    const player = getPlayerSync(prepared.playerId)
    if (!player) throw new Error(`Player ${prepared.playerId} not found during mission settlement.`)
    const persistedByCategory = new Map<number, ReturnType<typeof getPlayerCategoryMissionsSync>>()
    const standardCategories = [...new Set(
        prepared.candidates
            .map(candidate => candidate.category)
            .filter(category => category !== 9),
    )]
    if (standardCategories.length > 1) {
        const byCategory = getPlayerCategoryMissionsByCategoriesSync(
            prepared.playerId,
            standardCategories,
        )
        for (const category of standardCategories) {
            persistedByCategory.set(category, byCategory[String(category)] ?? {})
        }
    }
    for (const category of new Set(prepared.candidates.map(candidate => candidate.category))) {
        if (category === 9) {
            const missionIds = new Set<number>()
            const visit = (missionId: number): void => {
                if (missionIds.has(missionId)) return
                missionIds.add(missionId)
                const requirement = requirementRegistry.getRequirement(9, missionId)
                for (const dependency of requirement?.missionDependencies ?? []) {
                    if (dependency.category === 9) visit(dependency.missionId)
                }
            }
            for (const candidate of prepared.candidates) {
                if (candidate.category === 9) visit(candidate.missionId)
            }
            persistedByCategory.set(
                category,
                getPlayerCategoryMissionsByIdsSync(prepared.playerId, category, [...missionIds]),
            )
            continue
        }
        if (standardCategories.length > 1) continue
        persistedByCategory.set(
            category,
            getPlayerCategoryMissionsSync(prepared.playerId, category),
        )
    }
    const session = new MissionEvaluationSession({
        playerId: prepared.playerId,
        evaluationTime: new Date(prepared.evaluationTime),
        catalog,
        requirementRegistry,
        candidates: prepared.candidates,
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(undefined, {
            ...factSeeds,
            player,
            categoryMissions: persistedByCategory,
        }),
        observer: {
            onLoaderCall(key) {
                loaderCalls.push(key)
                observer?.onMissionFactLoaderCall?.(key)
            },
        },
    })
    session.getFact({ kind: "player" })

    const declaredFactsByMission = new Map(session.candidateRequirements.map(candidate => [
        `${candidate.category}:${candidate.missionId}`,
        candidate.requirement.facts,
    ]))
    const evaluatedKeys = new Set<string>()
    const evaluated: MutableEvaluatedMission[] = []
    for (const scope of prepared.scopes) {
        const missionIds = scope.enabledMissionIds.filter(missionId => (
            !evaluatedKeys.has(`${scope.category}:${missionId}`)
        ))
        if (missionIds.length === 0) continue
        const computer = getComputer(scope.category)
        const persisted = persistedByCategory.get(scope.category)
        if (!persisted) {
            throw new Error(`Mission category ${scope.category} was not prefetched`)
        }
        for (const groupedMissionIds of groupPassMissionIds(scope.category, missionIds)) {
            const context = SESSION_CATEGORIES.has(scope.category)
                && computer.buildContextFromSession !== undefined
                ? computer.buildContextFromSession(session, scope.category, groupedMissionIds)
                : computer.buildContext(
                    prepared.playerId,
                    scope.category,
                    new Date(prepared.evaluationTime),
                    groupedMissionIds,
                )
            for (const missionId of groupedMissionIds) {
                const key = `${scope.category}:${missionId}`
                if (evaluatedKeys.has(key)) continue
                evaluatedKeys.add(key)
                const current = persisted[String(missionId)]
                const dbProgress = current?.progress ?? 0
                const computed = computer.compute(missionId, context, dbProgress)
                const computedProgress = Number.isFinite(computed) ? computed : 0
                const declaredFactDependencies = declaredFactsByMission.get(key)
                if (declaredFactDependencies === undefined) {
                    throw new Error(`Mission requirement missing from Session for ${key}`)
                }
                observer?.onMissionComputed?.(scope.category, missionId)
                evaluated.push({
                    category: scope.category,
                    missionId,
                    declaredFactDependencies,
                    dbProgress,
                    computedProgress,
                    finalProgress: Math.max(0, dbProgress, computedProgress),
                    receivedStages: receivedStageNumbers(current?.stages ?? []),
                })
            }
        }
    }
    applyDailyCompletionProgress(evaluated)
    const missions = Object.freeze(evaluated.map(freezeMission))
    return Object.freeze({
        playerId: prepared.playerId,
        evaluationTime: prepared.evaluationTime,
        player: snapshotPlayer(player),
        missions,
        observer: Object.freeze({
            candidateCount: prepared.candidates.length,
            computeCount: missions.length,
            loaderCalls: Object.freeze([...loaderCalls]),
        }),
    })
}
