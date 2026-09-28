import { getDb } from "../../data/db"
import {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionStageSync,
    updatePlayerActiveMissionSync,
} from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import type { ActiveMissionProgressDelta } from "./active-core"
import {
    createActiveMissionFactSession,
    createProductionActiveMissionFactDomains,
    type ActiveMissionFactObserver,
} from "./active-fact-session"
import {
    runActiveMissionReconciliation,
    type ActiveMissionEventEligibilityContext,
} from "./active-reconciliation-runner"
import { getActiveMissionPlan } from "./active-plan"

export {
    estimateActiveMissionCharacterLevel,
} from "./active-fact-evaluator"
export type {
    ActiveMissionFactCharacter,
    ActiveMissionFactQuestProgress,
    ActiveMissionFactState,
} from "./active-fact-evaluator"
export {
    matchesRawActiveMissionQuestRange as matchesActiveMissionQuestRange,
    resolveRawActiveMissionQuestIds as resolveActiveMissionQuestIds,
} from "./active-quest-range"
export type { ActiveMissionEventEligibilityContext }

export interface ReconcileActiveMissionFactsInput {
    readonly playerId: number
    readonly now: number | Date
    readonly observer?: ActiveMissionFactObserver
    readonly isEventEligible?: (context: ActiveMissionEventEligibilityContext) => boolean
    /** Current player row when the caller already holds it (same synchronous request). */
    readonly playerOverride?: NonNullable<ReturnType<typeof getPlayerSync>>
}

export interface ActiveMissionReconciliationResult {
    readonly deltas: ActiveMissionProgressDelta[]
    readonly activeMissions: ReturnType<typeof getPlayerActiveMissionsSync>
}

export function reconcileActiveMissionFactsWithResult(
    input: ReconcileActiveMissionFactsInput,
): ActiveMissionReconciliationResult {
    return getDb().transaction(() => (
        reconcileActiveMissionFactsWithinTransaction(input)
    ))()
}

/**
 * In-transaction reconciliation core. The caller owns the transaction: this
 * runs after the caller's authoritative writes and throws on failure so the
 * business transaction rolls back together with the fixed point.
 */
export function reconcileActiveMissionFactsWithinTransaction(
    input: ReconcileActiveMissionFactsInput,
): ActiveMissionReconciliationResult {
    const player = input.playerOverride ?? getPlayerSync(input.playerId)
    if (!player) {
        throw new Error(`Player ${input.playerId} does not exist.`)
    }
    const plan = getActiveMissionPlan()
    const session = createActiveMissionFactSession({
        playerId: input.playerId,
        plan,
        observer: input.observer,
        domains: createProductionActiveMissionFactDomains(player),
    })
    const result = runActiveMissionReconciliation({
        playerId: input.playerId,
        now: input.now,
        observer: input.observer,
        isEventEligible: input.isEventEligible,
        plan,
        session,
        updateMission: (missionId, progress) => {
            updatePlayerActiveMissionSync(input.playerId, missionId, progress)
        },
        updateStage: (missionId, stage) => {
            updatePlayerActiveMissionStageSync(
                input.playerId,
                stage,
                missionId,
                false,
            )
        },
    })
    return {
        deltas: result.deltas,
        activeMissions: result.activeMissions as ReturnType<typeof getPlayerActiveMissionsSync>,
    }
}

export function reconcileActiveMissionFacts(
    input: ReconcileActiveMissionFactsInput,
): ActiveMissionProgressDelta[] {
    return reconcileActiveMissionFactsWithResult(input).deltas
}
