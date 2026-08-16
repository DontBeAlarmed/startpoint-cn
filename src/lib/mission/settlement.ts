import { getPlayerCategoryMissionsSync, updatePlayerCategoryMissionStageSync, updatePlayerCategoryMissionSync } from "../../data/domains/mission"
import { getDb } from "../../data/db"
import type { FactKey } from "./facts/fact-key"
import { MissionEvaluationSession } from "./evaluation-session"
import { getMissionCatalog } from "./mission-catalog"
import { createProductionMissionFactLoaderRegistry } from "./production-fact-loaders"
import { getMissionFactRequirementRegistry } from "./requirements/registry"
import { getComputer } from "./registry"
import { getCategoryMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers, getMissionIdsByCategory, isMissionProgressComplete } from "./stages"
import { getMissionPattern, isMissionEnabledAt } from "./patterns"
import { MissionRewardGranter } from "./grants"
import { getMissionMasterDefinition } from "./master-data"

export interface MissionSettlementInfo {
    mission_category_id: number
    mission_id: number
    mission_reward_id: number
}

export interface MissionSettlementResult {
    missionInfo: MissionSettlementInfo[]
    itemList: Record<string, number>
    characterList: Object[]
    equipmentList: Object[]
    degreeIds: number[]
    passCardPoints: Record<string, number>
    userInfo?: Record<string, number>
}

export interface MissionSettlementScope {
    category: number
    eventId?: number
    /**
     * Restrict evaluation to these missions. Invalid or out-of-category IDs are
     * ignored (fail closed); undefined keeps the existing full-category behavior.
     */
    missionIds?: readonly number[]
}

export interface MissionSettlementObserver {
    onCategoryCandidates?(category: number, count: number): void
    onMissionComputed?(category: number, missionId: number): void
    onMissionProgressChanged?(category: number, missionId: number): void
    onMissionFactLoaderCall?(key: FactKey): void
}

interface EvaluatedMission {
    category: number
    missionId: number
    progress: number
    receivedStages: Record<string, boolean> | unknown[]
    dbProgress: number
}

function isSafeMissionId(missionId: number): boolean {
    return Number.isSafeInteger(missionId) && missionId > 0
}

function mergeSettlementScopes(
    categories: readonly (number | MissionSettlementScope)[],
): MissionSettlementScope[] {
    const scopes = new Map<string, MissionSettlementScope>()
    for (const entry of categories) {
        const scope = typeof entry === "number" ? { category: entry } : entry
        const key = `${scope.category}:${scope.eventId ?? ""}`
        const missionIds = scope.missionIds === undefined
            ? undefined
            : [...new Set(scope.missionIds.filter(isSafeMissionId))]
        const existing = scopes.get(key)
        if (!existing) {
            scopes.set(key, { category: scope.category, eventId: scope.eventId, missionIds })
            continue
        }
        if (existing.missionIds === undefined || missionIds === undefined) {
            scopes.set(key, { category: scope.category, eventId: scope.eventId })
            continue
        }
        scopes.set(key, {
            category: scope.category,
            eventId: scope.eventId,
            missionIds: [...new Set([...existing.missionIds, ...missionIds])],
        })
    }
    return [...scopes.values()]
}

function getRequestedMissionIds(scope: MissionSettlementScope): number[] {
    const categoryMissionIds = getMissionIdsByCategory(scope.category)
    if (scope.category === 2 || scope.missionIds === undefined) {
        return [...new Set(categoryMissionIds.filter(isSafeMissionId))]
    }
    const categoryMissionIdSet = new Set(categoryMissionIds)
    return [...new Set(scope.missionIds.filter(missionId =>
        isSafeMissionId(missionId) && categoryMissionIdSet.has(missionId),
    ))]
}

function isDailyCoreMission(pattern: string): boolean {
    return /^single_battle_play(?:_[23])?$/.test(pattern)
        || /^multi_battle_play(?:_[23])?$/.test(pattern)
        || /^use_dash(?:_[23])?$/.test(pattern)
        || pattern === "daily_quest_stamina_use_2024_02"
}

function applyDailyCompletionProgress(missions: EvaluatedMission[]): void {
    const dailyMissions = missions.filter(mission => mission.category === 2)
    if (dailyMissions.length === 0) return

    const completedCoreCount = dailyMissions.filter(mission => {
        const pattern = getMissionPattern(2, mission.missionId)
        return isDailyCoreMission(pattern)
            && isMissionProgressComplete(2, mission.missionId, mission.progress)
    }).length

    for (const mission of dailyMissions) {
        if (!getMissionPattern(2, mission.missionId).startsWith("daily_quest_all_clear")) continue
        mission.progress = Math.max(mission.dbProgress, completedCoreCount)
    }
}

export function settleMissionCategories(
    playerId: number,
    categories: readonly (number | MissionSettlementScope)[],
    evaluationTime: Date,
    observer?: MissionSettlementObserver,
): MissionSettlementResult {
    const preparedScopes = mergeSettlementScopes(categories).map(scope => {
        const requestedMissionIds = getRequestedMissionIds(scope)
        return {
            category: scope.category,
            candidateCount: requestedMissionIds.length,
            enabledMissionIds: requestedMissionIds.filter(missionId =>
                isMissionEnabledAt(scope.category, missionId, evaluationTime, scope.eventId),
            ),
        }
    })
    if (!preparedScopes.some(scope => scope.enabledMissionIds.length > 0)) {
        for (const scope of preparedScopes) {
            observer?.onCategoryCandidates?.(scope.category, scope.candidateCount)
        }
        return {
            missionInfo: [],
            itemList: {},
            characterList: [],
            equipmentList: [],
            degreeIds: [],
            passCardPoints: {},
        }
    }

    return getDb().transaction(() => {
        const candidateByKey = new Map<string, { category: number, missionId: number }>()
        for (const scope of preparedScopes) {
            for (const missionId of scope.enabledMissionIds) {
                candidateByKey.set(`${scope.category}:${missionId}`, {
                    category: scope.category,
                    missionId,
                })
            }
        }
        const catalog = getMissionCatalog()
        const session = new MissionEvaluationSession({
            playerId,
            evaluationTime,
            catalog,
            requirementRegistry: getMissionFactRequirementRegistry(catalog),
            candidates: [...candidateByKey.values()],
            orchestratorFacts: [{ kind: "player" }],
            loaders: createProductionMissionFactLoaderRegistry(),
            observer: observer?.onMissionFactLoaderCall === undefined
                ? undefined
                : { onLoaderCall: key => observer.onMissionFactLoaderCall?.(key) },
        })
        let player
        try {
            player = session.getFact({ kind: "player" })
        } catch (error) {
            if (error instanceof Error
                && error.message === `Mission evaluation player ${playerId} not found`) {
                throw new Error(`Player ${playerId} not found during mission settlement.`)
            }
            throw error
        }

        const evaluatedMissions: EvaluatedMission[] = []
        const evaluatedMissionKeys = new Set<string>()
        for (const { category, candidateCount, enabledMissionIds } of preparedScopes) {
            observer?.onCategoryCandidates?.(category, candidateCount)
            if (enabledMissionIds.length === 0) continue

            const computer = getComputer(category)
            const context = (category === 1 || category === 2 || category === 4 || category === 5
                || category === 6 || category === 10)
                && computer.buildContextFromSession !== undefined
                ? computer.buildContextFromSession(session, category, enabledMissionIds)
                : computer.buildContext(playerId, category, evaluationTime, enabledMissionIds)
            const persisted = getPlayerCategoryMissionsSync(playerId, category)
            for (const missionId of enabledMissionIds) {
                const missionKey = `${category}:${missionId}`
                if (evaluatedMissionKeys.has(missionKey)) continue
                evaluatedMissionKeys.add(missionKey)
                const current = persisted[String(missionId)]
                const dbProgress = current?.progress ?? 0
                const computed = computer.compute(missionId, context, dbProgress)
                observer?.onMissionComputed?.(category, missionId)
                evaluatedMissions.push({
                    category,
                    missionId,
                    progress: Math.max(0, dbProgress, Number.isFinite(computed) ? computed : 0),
                    receivedStages: current?.stages ?? [],
                    dbProgress,
                })
            }
        }
        applyDailyCompletionProgress(evaluatedMissions)

        const granter = new MissionRewardGranter(playerId, player)
        const missionInfo: MissionSettlementInfo[] = []
        for (const mission of evaluatedMissions) {
            if (mission.progress === mission.dbProgress) continue
            observer?.onMissionProgressChanged?.(mission.category, mission.missionId)
            updatePlayerCategoryMissionSync(
                playerId,
                mission.category,
                mission.missionId,
                mission.progress,
            )
        }

        for (const mission of evaluatedMissions) {
            for (const stage of getCompletedStageNumbers(
                mission.category,
                mission.missionId,
                mission.progress,
            )) {
                if (!Array.isArray(mission.receivedStages)
                    && mission.receivedStages[String(stage)] === true) continue

                const definition = getCategoryMissionRewardStageDefinition(
                    mission.category,
                    mission.missionId,
                    stage,
                )
                if (!definition) continue
                updatePlayerCategoryMissionStageSync(
                    playerId,
                    mission.category,
                    stage,
                    mission.missionId,
                    true,
                )
                const passCardEventId = mission.category >= 6 && mission.category <= 8
                    ? getMissionMasterDefinition(mission.category, mission.missionId)?.eventId
                    : undefined
                granter.grant(definition.rewards, { passCardEventId })
                missionInfo.push({
                    mission_category_id: mission.category,
                    mission_id: mission.missionId,
                    mission_reward_id: definition.missionRewardId,
                })
            }
        }
        granter.persistPlayer()
        return {
            missionInfo,
            itemList: granter.itemList,
            characterList: granter.characterList,
            equipmentList: granter.equipmentList,
            degreeIds: granter.degreeList,
            passCardPoints: granter.passCardPoints,
            ...(granter.hasPlayerChanges() ? { userInfo: granter.getUserInfo() } : {}),
        }
    })()
}
