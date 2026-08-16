import { getDb } from "../../data/db"
import type { FactKey } from "./facts/fact-key"
import type { Player } from "../../data/types"
import { evaluateMissionCandidates } from "./settlement-evaluate"
import {
    prepareMissionSettlement,
    selectMissionSettlementCandidates,
} from "./settlement-prepare"
import { settleMissionEvaluation } from "./settlement-write"

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

export interface PreparedMissionSettlementScope {
    readonly category: number
    readonly eventId?: number
    readonly candidateCount: number
    readonly enabledMissionIds: readonly number[]
}

export interface PreparedMissionSettlementCandidate {
    readonly category: number
    readonly missionId: number
}

export interface PreparedMissionPassResult {
    readonly weeklyEventIds: readonly number[]
    readonly loginEventIds: readonly number[]
}

export interface PreparedMissionSettlement {
    readonly playerId: number
    readonly evaluationTime: string
    readonly scopes: readonly PreparedMissionSettlementScope[]
    readonly candidates: readonly PreparedMissionSettlementCandidate[]
    readonly passPreparation: PreparedMissionPassResult
}

export type MissionSettlementPlayerSnapshot = {
    readonly [Key in keyof Player]: Player[Key] extends Date ? string : Player[Key]
}

export interface EvaluatedMissionResult {
    readonly category: number
    readonly missionId: number
    readonly declaredFactDependencies: readonly FactKey[]
    readonly dbProgress: number
    readonly computedProgress: number
    readonly finalProgress: number
    readonly receivedStages: readonly number[]
}

export interface MissionEvaluationObserverSummary {
    readonly candidateCount: number
    readonly computeCount: number
    readonly loaderCalls: readonly FactKey[]
}

export interface MissionEvaluationResult {
    readonly playerId: number
    readonly evaluationTime: string
    readonly player: MissionSettlementPlayerSnapshot
    readonly missions: readonly EvaluatedMissionResult[]
    readonly observer: MissionEvaluationObserverSummary
}

export function settleMissionCategories(
    playerId: number,
    categories: readonly (number | MissionSettlementScope)[],
    evaluationTime: Date,
    observer?: MissionSettlementObserver,
): MissionSettlementResult {
    const selection = selectMissionSettlementCandidates(categories, evaluationTime, observer)
    if (selection.candidates.length === 0) {
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
        const prepared = prepareMissionSettlement(
            playerId,
            categories,
            evaluationTime,
            undefined,
            selection,
        )
        const evaluation = evaluateMissionCandidates(prepared, observer)
        return settleMissionEvaluation(evaluation, observer)
    })()
}
