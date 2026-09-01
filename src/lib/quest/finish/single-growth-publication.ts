import { publishCharacterGrowthOwnerStateBestEffort } from "../../character-growth/owner-publication"
import type { LegacyAwakeRewardResult } from "../../mission/awake-reward-facts"
import type { MissionSettlementRewardDependencies } from "../../mission/settlement-write"
import { prepareSingleAwakePublication, settleSingleMissionEvaluations } from "./single-mission-publication"

export interface PrepareSingleGrowthPublicationInput {
    readonly playerId: number
    readonly partyCharacterIds: readonly number[]
    readonly evaluationTime: Date
    readonly questAccomplished: boolean
    readonly directAwakeMissionIds: readonly number[]
    readonly directDegreeMissionIds: readonly number[]
    readonly rewardDependencies: MissionSettlementRewardDependencies
    readonly characterLists: readonly (readonly Record<string, unknown>[])[]
    readonly legacyRewardResults: readonly (LegacyAwakeRewardResult | null | undefined)[]
    readonly manaObtained: number
    readonly questCategory: number
    readonly questPreviouslyCompleted: boolean
}

export function prepareSingleGrowthPublication(input: PrepareSingleGrowthPublicationInput) {
    const missionEvaluation = settleSingleMissionEvaluations({
        playerId: input.playerId,
        partyCharacterIds: input.partyCharacterIds,
        evaluationTime: input.evaluationTime,
        questAccomplished: input.questAccomplished,
        directAwakeMissionIds: input.directAwakeMissionIds,
        directDegreeMissionIds: input.directDegreeMissionIds,
        rewardDependencies: input.rewardDependencies,
    })
    const publication = prepareSingleAwakePublication({
        characterLists: [
            ...input.characterLists,
            missionEvaluation.missionSettlement.characterList as Record<string, unknown>[],
            missionEvaluation.awakeMissionSettlement.characterList as Record<string, unknown>[],
        ],
        invalidatedFactKeys: missionEvaluation.invalidatedFactKeys,
        legacyRewardResults: input.legacyRewardResults,
        manaObtained: input.manaObtained,
        questCategory: input.questCategory,
        questAccomplished: input.questAccomplished,
        questPreviouslyCompleted: input.questPreviouslyCompleted,
        directAwakeMissionIds: [
            ...input.directAwakeMissionIds,
            ...missionEvaluation.awakeMissionIds,
        ],
        evaluatedAwakeUnlocks: missionEvaluation.evaluatedAwakeUnlocks,
    })
    return { ...missionEvaluation, publication }
}

export function publishPreparedSingleGrowthPublication(input: {
    readonly playerId: number
    readonly partyCharacterIds: readonly number[]
    readonly evaluationTime: Date
    readonly publication: ReturnType<typeof prepareSingleAwakePublication>
}): Record<string, unknown>[] {
    return publishCharacterGrowthOwnerStateBestEffort(
        input.playerId,
        input.partyCharacterIds,
        input.publication.characterLists,
        {
            invalidatedFactKeys: input.publication.invalidatedFactKeys,
            directMissionIds: input.publication.directMissionIds,
            evaluatedAwakeUnlocks: input.publication.evaluatedAwakeUnlocks,
        },
        "single-finish",
        input.evaluationTime,
    ).characterList
}
