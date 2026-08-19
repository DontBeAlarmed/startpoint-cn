import type { ReadonlyContentRepository } from "../../content/runtime/content-snapshot"
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
export { computeActiveMissionFactProgress } from "./active-fact-legacy-adapter"
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
    readonly repository: ReadonlyContentRepository
    readonly now: number | Date
    readonly observer?: ActiveMissionFactObserver
    readonly isEventEligible?: (context: ActiveMissionEventEligibilityContext) => boolean
}

export interface ActiveMissionReconciliationResult {
    readonly deltas: ActiveMissionProgressDelta[]
    readonly activeMissions: ReturnType<typeof getPlayerActiveMissionsSync>
}

export function reconcileActiveMissionFactsWithResult(
    input: ReconcileActiveMissionFactsInput,
): ActiveMissionReconciliationResult {
    return getDb().transaction(() => {
        const player = getPlayerSync(input.playerId)
        if (!player) {
            throw new Error(`Player ${input.playerId} does not exist.`)
        }
        const plan = getActiveMissionPlan(input.repository)
        const session = createActiveMissionFactSession({
            playerId: input.playerId,
            plan,
            observer: input.observer,
            domains: createProductionActiveMissionFactDomains(input.repository, player),
        })
        const result = runActiveMissionReconciliation({
            ...input,
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
    })()
}

export function reconcileActiveMissionFacts(
    input: ReconcileActiveMissionFactsInput,
): ActiveMissionProgressDelta[] {
    return reconcileActiveMissionFactsWithResult(input).deltas
}
