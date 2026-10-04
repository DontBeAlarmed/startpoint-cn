import { getDb } from "../../data/db"
import { getFactKeyId, type FactKey } from "./facts/fact-key"
import type { Player } from "../../data/types"
import type { PlannedItemOverflowDisposition } from "../item-overflow"
import { evaluateMissionCandidates } from "./settlement-evaluate"
import {
    prepareMissionSettlement,
    selectMissionSettlementCandidates,
} from "./settlement-prepare"
import {
    settleMissionEvaluationWithInvalidations,
    type MissionSettlementRewardDependencies,
} from "./settlement-write"
import { getMissionCatalog } from "./mission-catalog"
import { getMissionFactRequirementRegistry } from "./requirements/registry"
import type { MissionRef } from "./requirements/types"

// 官方依次结算语义(2026-10-03 用户取证):A 完成发放的奖励使 B 达标时,
// B 在同一请求内连锁结算。当前主数据下 S+ 通关的材料奖励链会驱动
// 33/67/68/66 与 player 族共 11 条任务在第 4 轮完成,初始 + 4 级联为
// 实测收敛点;上限同时防未来主数据自激励循环。
const MAX_SETTLEMENT_CASCADE_ROUNDS = 5

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
    itemOverflowDispositions?: readonly PlannedItemOverflowDisposition[]
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

export interface MissionSettlementEvaluation {
    readonly prepared: PreparedMissionSettlement
    readonly evaluation: MissionEvaluationResult
    readonly settlement: MissionSettlementResult
    readonly invalidatedFactKeys: readonly FactKey[]
}

export function settleMissionCategories(
    playerId: number,
    categories: readonly (number | MissionSettlementScope)[],
    evaluationTime: Date,
    observer?: MissionSettlementObserver,
    dependencies?: MissionSettlementRewardDependencies,
): MissionSettlementResult {
    const result = settleMissionCategoriesWithEvaluation(
        playerId,
        categories,
        evaluationTime,
        observer,
        dependencies,
    )
    return result?.settlement ?? {
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        passCardPoints: {},
    }
}

export function settleMissionCategoriesWithEvaluation(
    playerId: number,
    categories: readonly (number | MissionSettlementScope)[],
    evaluationTime: Date,
    observer?: MissionSettlementObserver,
    dependencies?: MissionSettlementRewardDependencies,
): MissionSettlementEvaluation | null {
    const selection = selectMissionSettlementCandidates(categories, evaluationTime, observer)
    if (selection.candidates.length === 0) {
        return null
    }

    const runCascade = () => {
        const first = runSettlementRound(
            playerId,
            categories,
            evaluationTime,
            observer,
            dependencies,
            selection,
        )
        if (first === null) {
            return null
        }
        let settlement = first.settlement
        const invalidatedByFactId = new Map<string, FactKey>()
        for (const key of first.invalidatedFactKeys) {
            invalidatedByFactId.set(getFactKeyId(key), key)
        }
        let rounds = 1
        let capReached = false
        while (true) {
            if (settlement.missionInfo.length === 0) break
            if (rounds >= MAX_SETTLEMENT_CASCADE_ROUNDS) {
                capReached = true
                break
            }
            const cascadeCategories = cascadeScopesForInvalidations(categories, [...invalidatedByFactId.values()])
            const next = runSettlementRound(
                playerId,
                cascadeCategories,
                evaluationTime,
                undefined,
                dependencies,
                undefined,
            )
            if (next === null || next.settlement.missionInfo.length === 0) break
            settlement = mergeSettlementResults(settlement, next.settlement)
            for (const key of next.invalidatedFactKeys) {
                invalidatedByFactId.set(getFactKeyId(key), key)
            }
            rounds += 1
        }
        if (capReached) {
            console.warn(
                `[MISSION] settlement cascade reached the ${MAX_SETTLEMENT_CASCADE_ROUNDS}-round cap (player=${playerId})`
                + ` pending=${settlement.missionInfo.length}`,
            )
        }
        return {
            prepared: first.prepared,
            evaluation: first.evaluation,
            settlement,
            invalidatedFactKeys: [...invalidatedByFactId.values()],
        }
    }
    // 事务口径:调用方已有事务时各轮以 savepoint 并入(与调用方原子);
    // 无外层事务时单事务包裹全部轮次(级联中途失败整体回滚)。
    return getDb().inTransaction ? runCascade() : getDb().transaction(() => runCascade())()
}

function runSettlementRound(
    playerId: number,
    categories: readonly (number | MissionSettlementScope)[],
    evaluationTime: Date,
    observer: MissionSettlementObserver | undefined,
    dependencies: MissionSettlementRewardDependencies | undefined,
    selection: ReturnType<typeof selectMissionSettlementCandidates> | undefined,
): MissionSettlementEvaluation | null {
    const resolvedSelection = selection
        ?? selectMissionSettlementCandidates(categories, evaluationTime, observer)
    if (resolvedSelection.candidates.length === 0) {
        return null
    }
    return getDb().transaction(() => {
        const prepared = prepareMissionSettlement(
            playerId,
            categories,
            evaluationTime,
            undefined,
            resolvedSelection,
        )
        const evaluation = evaluateMissionCandidates(prepared, observer, dependencies?.factSeeds)
        const settled = settleMissionEvaluationWithInvalidations(evaluation, observer, dependencies)
        return {
            prepared,
            evaluation,
            settlement: settled.settlement,
            invalidatedFactKeys: settled.invalidatedFactKeys,
        }
    })()
}

/** 奖励失效的事实键 → 受影响任务:级联轮按此收窄范围(同 category 内求并)。 */
function cascadeScopesForInvalidations(
    categories: readonly (number | MissionSettlementScope)[],
    invalidatedFactKeys: readonly FactKey[],
): MissionSettlementScope[] {
    if (invalidatedFactKeys.length === 0) return []
    const registry = getMissionFactRequirementRegistry(getMissionCatalog())
    const scopes: MissionSettlementScope[] = []
    for (const scope of categories) {
        const category = typeof scope === "number" ? scope : scope.category
        // 周期快照差值类(每日 2/周常 10/Pass 6/7/8)不随奖励入账变化,
        // 级联轮重评估是纯浪费——跳过
        if ([2, 6, 7, 8, 10].includes(category)) continue
        const missionIds = new Set<number>()
        for (const key of invalidatedFactKeys) {
            for (const ref of registry.getMissionsForFact(key)) {
                if (ref.category === category) missionIds.add(ref.missionId)
            }
        }
        scopes.push({
            category,
            ...(typeof scope !== "number" && scope.eventId !== undefined
                ? { eventId: scope.eventId }
                : {}),
            missionIds: [...missionIds].sort((left, right) => left - right),
        })
    }
    return scopes
}

function mergeSettlementResults(
    left: MissionSettlementResult,
    right: MissionSettlementResult,
): MissionSettlementResult {
    const itemList: Record<string, number> = { ...left.itemList }
    for (const [itemId, afterAmount] of Object.entries(right.itemList)) {
        itemList[itemId] = afterAmount
    }
    const passCardPoints: Record<string, number> = { ...left.passCardPoints }
    for (const [key, point] of Object.entries(right.passCardPoints)) {
        passCardPoints[key] = point
    }
    return {
        missionInfo: [...left.missionInfo, ...right.missionInfo],
        itemList,
        characterList: [...left.characterList, ...right.characterList],
        equipmentList: [...left.equipmentList, ...right.equipmentList],
        degreeIds: [...new Set([...left.degreeIds, ...right.degreeIds])],
        passCardPoints,
        ...(left.userInfo || right.userInfo
            ? { userInfo: { ...left.userInfo, ...right.userInfo } }
            : {}),
        itemOverflowDispositions: [
            ...(left.itemOverflowDispositions ?? []),
            ...(right.itemOverflowDispositions ?? []),
        ],
    }
}
