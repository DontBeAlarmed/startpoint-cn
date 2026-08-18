import { upsertPlayerCharacterAwakeUnlockSync } from "../../data/domains/character_awake"
import {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} from "../../data/domains/mission"
import { getPlayerSync } from "../../data/domains/player"
import { getDb } from "../../data/db"
import { buildManaBoardAwakeCharacterList } from "../character-helpers"
import { MissionRewardGranter } from "./grants"
import { getAwakeMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers } from "./stages"
import { getCharacterIdFromMission } from "./character-queries"
import { createCharacterAwakeEligibilityResolver } from "./awake-eligibility"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import { getMissionCatalog, type MissionCatalog } from "./mission-catalog"
import {
    prepareMissionSettlement,
    selectMissionSettlementCandidates,
} from "./settlement-prepare"
import { evaluateMissionCandidates } from "./settlement-evaluate"
import {
    settleAwakeMissionEvaluationWithInvalidations,
} from "./awake-evaluation-settlement"
import type {
    MissionEvaluationResult,
    PreparedMissionSettlement,
} from "./settlement"
import type { FactKey } from "./facts/fact-key"
import type { MissionSettlementRewardDependencies } from "./settlement-write"

export interface AwakeMissionComputedProgress {
    missionId: number
    progress: number
}

export interface AwakeMissionInfo {
    mission_category_id: 9
    mission_id: number
    mission_reward_id: number
}

export interface AwakeMissionSettlementResult {
    missionInfo: AwakeMissionInfo[]
    itemList: Record<string, number>
    characterList: Record<string, unknown>[]
    equipmentList: Object[]
    degreeIds: number[]
    passCardPoints: Record<string, number>
    userInfo?: Record<string, number>
}

export interface AwakeMissionSettlementEvaluation {
    readonly prepared: PreparedMissionSettlement
    readonly evaluation: MissionEvaluationResult
    readonly settlement: AwakeMissionSettlementResult
    readonly invalidatedFactKeys: readonly FactKey[]
}

export interface AwakeBattleMissionSettlementParams {
    readonly playerId: number
    readonly questAccomplished: boolean
    readonly characterIds: readonly number[]
    readonly directlyChangedMissionIds: readonly number[]
    readonly evaluationTime: Date
}

function emptyAwakeMissionSettlement(): AwakeMissionSettlementResult {
    return {
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        passCardPoints: {},
    }
}

export function getAwakeBattleMissionIds(
    characterIds: readonly number[],
    directlyChangedMissionIds: readonly number[] = [],
    catalog: MissionCatalog = getMissionCatalog(),
): number[] {
    const characterIdSet = new Set(characterIds.filter(characterId =>
        Number.isSafeInteger(characterId) && characterId > 0,
    ))
    const candidates = [...characterIdSet]
        .flatMap(characterId => catalog.getAwakeMissionIdsByCharacter(characterId))
    for (const missionId of directlyChangedMissionIds) {
        if (Number.isSafeInteger(missionId)
            && missionId > 0
            && catalog.getDefinition(9, missionId) !== undefined) {
            candidates.push(missionId)
        }
    }
    return [...new Set(candidates)].sort((left, right) => left - right)
}

export function settleAwakeMissionCandidates(
    playerId: number,
    missionIds: readonly number[],
    evaluationTime: Date,
    dependencies: MissionSettlementRewardDependencies = {},
): AwakeMissionSettlementResult {
    return settleAwakeMissionCandidatesWithEvaluation(
        playerId,
        missionIds,
        evaluationTime,
        undefined,
        dependencies,
    )
        ?.settlement ?? emptyAwakeMissionSettlement()
}

export function settleAwakeMissionCandidatesWithEvaluation(
    playerId: number,
    missionIds: readonly number[],
    evaluationTime: Date,
    resolver?: CharacterAwakeEligibilityResolver,
    dependencies: MissionSettlementRewardDependencies = {},
): AwakeMissionSettlementEvaluation | null {
    if (missionIds.length === 0) return null
    const candidates = getAwakeBattleMissionIds([], missionIds)
    if (candidates.length === 0) return null
    const categories = [{ category: 9, missionIds: candidates }]
    const selection = selectMissionSettlementCandidates(categories, evaluationTime)
    if (selection.candidates.length === 0) return null
    return getDb().transaction(() => {
        const prepared = prepareMissionSettlement(
            playerId,
            categories,
            evaluationTime,
            undefined,
            selection,
        )
        const evaluation = evaluateMissionCandidates(prepared)
        const settled = settleAwakeMissionEvaluationWithInvalidations(
            evaluation,
            resolver ?? createCharacterAwakeEligibilityResolver(playerId, evaluationTime),
            undefined,
            dependencies,
        )
        return {
            prepared,
            evaluation,
            settlement: settled.settlement,
            invalidatedFactKeys: settled.invalidatedFactKeys,
        }
    })()
}

export function settleAwakeBattleMissions(
    params: AwakeBattleMissionSettlementParams,
    dependencies: MissionSettlementRewardDependencies = {},
): AwakeMissionSettlementResult {
    if (!params.questAccomplished) return emptyAwakeMissionSettlement()
    const missionIds = getAwakeBattleMissionIds(
        params.characterIds,
        params.directlyChangedMissionIds,
    )
    if (missionIds.length === 0) return emptyAwakeMissionSettlement()
    return settleAwakeMissionCandidates(
        params.playerId,
        missionIds,
        params.evaluationTime,
        dependencies,
    )
}

export function settleAwakeMissionRewards(
    playerId: number,
    progressList: AwakeMissionComputedProgress[],
    resolver: CharacterAwakeEligibilityResolver = createCharacterAwakeEligibilityResolver(playerId),
): AwakeMissionSettlementResult {
    const progressByMissionId = new Map<number, number>()
    for (const entry of progressList) {
        const currentProgress = progressByMissionId.get(entry.missionId)
        if (currentProgress === undefined || entry.progress > currentProgress) {
            progressByMissionId.set(entry.missionId, entry.progress)
        }
    }
    const aggregatedProgressList = [...progressByMissionId]
        .map(([missionId, progress]) => ({ missionId, progress }))
        .filter(({ missionId }) => resolver.isNewUnlockEligible(
            Number(getCharacterIdFromMission(missionId)),
            missionId,
        ))

    const player = getPlayerSync(playerId)
    if (!player) throw new Error(`Player ${playerId} not found during CharacterAwake settlement.`)

    const persistedMissions = getPlayerCategoryMissionsSync(playerId, 9)
    const granter = new MissionRewardGranter(playerId, player)
    const missionInfo: AwakeMissionInfo[] = []
    const unlockMap = new Map<string, Record<number, number>>()

    getDb().transaction(() => {
        for (const entry of aggregatedProgressList) {
            updatePlayerCategoryMissionSync(playerId, 9, entry.missionId, entry.progress)
        }

        for (const entry of aggregatedProgressList) {
            const persistedStages = persistedMissions[String(entry.missionId)]?.stages
            for (const stage of getCompletedStageNumbers(9, entry.missionId, entry.progress)) {
                if (!Array.isArray(persistedStages) && persistedStages?.[String(stage)] === true) continue

                const definition = getAwakeMissionRewardStageDefinition(entry.missionId, stage)
                if (!definition) continue

                updatePlayerCategoryMissionStageSync(playerId, 9, stage, entry.missionId, true)
                granter.grant(definition.rewards)
                missionInfo.push({
                    mission_category_id: 9,
                    mission_id: entry.missionId,
                    mission_reward_id: definition.missionRewardId,
                })

                if (definition.specialReward) {
                    const special = definition.specialReward
                    if (upsertPlayerCharacterAwakeUnlockSync(
                        playerId,
                        special.characterId,
                        special.boardIndex,
                        special.awakeLevel
                    )) {
                        const levels = unlockMap.get(String(special.characterId)) ?? {}
                        levels[special.boardIndex] = Math.max(levels[special.boardIndex] ?? 0, special.awakeLevel)
                        unlockMap.set(String(special.characterId), levels)
                    }
                }
            }
        }

        granter.persistPlayer()
    })()

    const unlockCharacterList = buildManaBoardAwakeCharacterList(
        resolver.characters,
        unlockMap
    )
    const characterList = [
        ...(granter.characterList as Record<string, unknown>[]),
        ...unlockCharacterList,
    ]

    return {
        missionInfo,
        itemList: granter.itemList,
        characterList,
        equipmentList: granter.equipmentList,
        degreeIds: granter.degreeList,
        passCardPoints: {},
        ...(granter.hasPlayerChanges() ? { userInfo: granter.getUserInfo() } : {}),
    }
}
