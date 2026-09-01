import { getContentSnapshot } from "../../../content/runtime/content-snapshot"
import {
    getAwakeBattleMissionIds,
    reconcileActiveMissionFacts,
    settleAwakeMissionCandidatesWithEvaluation,
    settleMissionCategoriesWithEvaluation,
} from "../../mission"
import { buildBattleMissionSettlementScopes } from "../../mission/battle-facts"
import {
    getAwakeFactKeysFromLegacyRewardResults,
    type LegacyAwakeRewardResult,
} from "../../mission/awake-reward-facts"
import type { FactKey } from "../../mission/facts/fact-key"
import type { MissionSettlementResult } from "../../mission/settlement"
import type { MissionSettlementRewardDependencies } from "../../mission/settlement-write"
import { QuestCategory } from "../../types"

const emptySettlement = (): MissionSettlementResult => ({
    missionInfo: [], itemList: {}, characterList: [], equipmentList: [],
    degreeIds: [], passCardPoints: {},
})

export function settleSingleMissionEvaluations(input: {
    readonly playerId: number
    readonly partyCharacterIds: readonly number[]
    readonly evaluationTime: Date
    readonly questAccomplished: boolean
    readonly directAwakeMissionIds: readonly number[]
    readonly directDegreeMissionIds: readonly number[]
    readonly rewardDependencies: MissionSettlementRewardDependencies
}) {
    const missionEvaluation = settleMissionCategoriesWithEvaluation(
        input.playerId,
        buildBattleMissionSettlementScopes(
            input.partyCharacterIds,
            input.directDegreeMissionIds,
        ),
        input.evaluationTime,
        undefined,
        input.rewardDependencies,
    )
    const awakeMissionEvaluation = input.questAccomplished
        ? settleAwakeMissionCandidatesWithEvaluation(
            input.playerId,
            getAwakeBattleMissionIds(input.partyCharacterIds, input.directAwakeMissionIds),
            input.evaluationTime,
            undefined,
            input.rewardDependencies,
        )
        : null
    return {
        missionSettlement: missionEvaluation?.settlement ?? emptySettlement(),
        awakeMissionSettlement: awakeMissionEvaluation?.settlement ?? emptySettlement(),
        awakeMissionIds: awakeMissionEvaluation?.evaluation.missions.map(mission => mission.missionId) ?? [],
        evaluatedAwakeUnlocks: awakeMissionEvaluation === null ? undefined : {
            progressList: awakeMissionEvaluation.evaluation.missions.map(mission => ({
                missionId: mission.missionId,
                progress: mission.finalProgress,
            })),
            resolver: awakeMissionEvaluation.resolver,
        },
        activeMissionList: reconcileActiveMissionFacts({
            playerId: input.playerId,
            repository: getContentSnapshot().repository,
            now: input.evaluationTime,
        }),
        invalidatedFactKeys: [
            ...(missionEvaluation?.invalidatedFactKeys ?? []),
            ...(awakeMissionEvaluation?.invalidatedFactKeys ?? []),
        ] as readonly FactKey[],
    }
}

export function prepareSingleAwakePublication(input: {
    readonly characterLists: readonly (readonly Record<string, unknown>[])[]
    readonly invalidatedFactKeys: readonly FactKey[]
    readonly legacyRewardResults: readonly (LegacyAwakeRewardResult | null | undefined)[]
    readonly manaObtained: number
    readonly questCategory: number
    readonly questAccomplished: boolean
    readonly questPreviouslyCompleted: boolean
    readonly directAwakeMissionIds: readonly number[]
    readonly evaluatedAwakeUnlocks?: {
        readonly progressList: readonly { readonly missionId: number; readonly progress: number }[]
        readonly resolver: import("../../mission/awake-eligibility").CharacterAwakeEligibilityResolver
    }
}) {
    const invalidatedFactKeys: FactKey[] = [
        ...input.invalidatedFactKeys,
        ...getAwakeFactKeysFromLegacyRewardResults(...input.legacyRewardResults),
        ...(input.manaObtained > 0 ? [{ kind: "player" as const }] : []),
        ...(input.questAccomplished
            && input.questCategory === QuestCategory.CHARACTER
            && !input.questPreviouslyCompleted
            ? [{ kind: "questProgress" as const, sections: [QuestCategory.CHARACTER] }]
            : []),
    ]
    return {
        characterLists: input.characterLists,
        invalidatedFactKeys,
        directMissionIds: input.directAwakeMissionIds,
        evaluatedAwakeUnlocks: input.evaluatedAwakeUnlocks,
    }
}
