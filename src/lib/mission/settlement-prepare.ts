import { ensurePlayerPassCardLoginProgressSync } from "../../data/domains/pass-card"
import { getPlayerSync } from "../../data/domains/player"
import { getPlayerQuestProgressSync } from "../../data/domains/quest"
import { getMissionMasterDefinition } from "./master-data"
import { isMissionEnabledAt } from "./patterns"
import {
    buildPeriodicSnapshotData,
    getPassWeekSnapshotType,
    getSnapshots,
    takeSnapshot,
} from "./snapshot"
import { getMissionIdsByCategory } from "./stages"
import { getMissionCatalog } from "./mission-catalog"
import type {
    MissionSettlementObserver,
    MissionSettlementScope,
    PreparedMissionPassResult,
    PreparedMissionSettlement,
    PreparedMissionSettlementCandidate,
    PreparedMissionSettlementScope,
} from "./settlement"

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
    const categoryMissionIds = scope.category === 9
        ? getMissionCatalog().getMissionIds(9)
        : getMissionIdsByCategory(scope.category)
    if (scope.category === 2 || scope.missionIds === undefined) {
        return [...new Set(categoryMissionIds.filter(isSafeMissionId))]
    }
    const categoryMissionIdSet = new Set(categoryMissionIds)
    return [...new Set(scope.missionIds.filter(missionId =>
        isSafeMissionId(missionId) && categoryMissionIdSet.has(missionId),
    ))]
}

function freezeScope(
    scope: MissionSettlementScope,
    candidateCount: number,
    enabledMissionIds: readonly number[],
): PreparedMissionSettlementScope {
    return Object.freeze({
        category: scope.category,
        ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
        candidateCount,
        enabledMissionIds: Object.freeze([...enabledMissionIds]),
    })
}

function freezePassResult(
    weeklyEventIds: readonly number[],
    loginEventIds: readonly number[],
): PreparedMissionPassResult {
    return Object.freeze({
        weeklyEventIds: Object.freeze([...weeklyEventIds]),
        loginEventIds: Object.freeze([...loginEventIds]),
    })
}

function eventIdsForCandidates(
    candidates: readonly PreparedMissionSettlementCandidate[],
    category: 7 | 8,
): number[] {
    const eventIds = new Set<number>()
    for (const candidate of candidates) {
        if (candidate.category !== category) continue
        const definition = getMissionMasterDefinition(candidate.category, candidate.missionId)
        if (!definition || !Number.isSafeInteger(definition.eventId) || definition.eventId! <= 0) continue
        if (category === 8 && definition.patternType !== 0) continue
        eventIds.add(definition.eventId!)
    }
    return [...eventIds]
}

export interface MissionSettlementSelection {
    readonly evaluationTime: string
    readonly scopes: readonly PreparedMissionSettlementScope[]
    readonly candidates: readonly PreparedMissionSettlementCandidate[]
}

export function selectMissionSettlementCandidates(
    categories: readonly (number | MissionSettlementScope)[],
    evaluationTime: Date,
    observer?: MissionSettlementObserver,
): MissionSettlementSelection {
    const evaluationTimeMs = evaluationTime.getTime()
    if (!Number.isFinite(evaluationTimeMs)) {
        throw new TypeError("Mission settlement evaluationTime must be a valid Date")
    }
    const fixedEvaluationTime = new Date(evaluationTimeMs)
    const scopes = mergeSettlementScopes(categories).map(scope => {
        const requestedMissionIds = getRequestedMissionIds(scope)
        const enabledMissionIds = requestedMissionIds.filter(missionId =>
            isMissionEnabledAt(scope.category, missionId, fixedEvaluationTime, scope.eventId),
        )
        observer?.onCategoryCandidates?.(scope.category, requestedMissionIds.length)
        return freezeScope(scope, requestedMissionIds.length, enabledMissionIds)
    })
    const candidatesByKey = new Map<string, PreparedMissionSettlementCandidate>()
    for (const scope of scopes) {
        for (const missionId of scope.enabledMissionIds) {
            const candidate = Object.freeze({ category: scope.category, missionId })
            candidatesByKey.set(`${candidate.category}:${candidate.missionId}`, candidate)
        }
    }
    return Object.freeze({
        evaluationTime: fixedEvaluationTime.toISOString(),
        scopes: Object.freeze(scopes),
        candidates: Object.freeze([...candidatesByKey.values()]),
    })
}

function prepareSelectedMissionSettlement(
    playerId: number,
    selection: MissionSettlementSelection,
): PreparedMissionSettlement {
    const { candidates } = selection
    const weeklyEventIds = eventIdsForCandidates(candidates, 7)
    const loginEventIds = eventIdsForCandidates(candidates, 8)

    let player = null
    const weeklySnapshotTypes = weeklyEventIds.map(getPassWeekSnapshotType)
    const existingWeeklySnapshots = getSnapshots(playerId, weeklySnapshotTypes)
    const missingWeeklySnapshotTypes = weeklySnapshotTypes.filter(snapshotType => (
        !existingWeeklySnapshots.has(snapshotType)
    ))
    if (missingWeeklySnapshotTypes.length > 0) {
        player = getPlayerSync(playerId)
        if (!player) throw new Error(`Player ${playerId} not found during mission settlement.`)
        const questProgress = getPlayerQuestProgressSync(playerId)
        const totalQuestClears = Object.values(questProgress)
            .flat()
            .filter(quest => quest.finished)
            .length
        const snapshotData = buildPeriodicSnapshotData(playerId, player, totalQuestClears)
        for (const snapshotType of missingWeeklySnapshotTypes) {
            takeSnapshot(playerId, snapshotType, snapshotData)
        }
    }
    for (const eventId of loginEventIds) {
        player ??= getPlayerSync(playerId)
        if (!player) throw new Error(`Player ${playerId} not found during mission settlement.`)
        ensurePlayerPassCardLoginProgressSync(playerId, eventId, player.totalLoginDays ?? 0)
    }

    return Object.freeze({
        playerId,
        evaluationTime: selection.evaluationTime,
        scopes: selection.scopes,
        candidates,
        passPreparation: freezePassResult(weeklyEventIds, loginEventIds),
    })
}

export function prepareMissionSettlement(
    playerId: number,
    categories: readonly (number | MissionSettlementScope)[],
    evaluationTime: Date,
    observer?: MissionSettlementObserver,
    selected?: MissionSettlementSelection,
): PreparedMissionSettlement {
    return prepareSelectedMissionSettlement(
        playerId,
        selected ?? selectMissionSettlementCandidates(categories, evaluationTime, observer),
    )
}
