import {
    createAwakeRequestContext,
    type AwakeRequestContext,
} from "./awake-request-context"
import { collectAwakeCandidateCharacterIds } from "./awake-candidate-character-ids"
import type { AwakeMissionSeeds } from "./awake-request-context-scope"
import { reconcileAwakeUnlockCharacterListBestEffort } from "./awake-unlock-response"

export function createAwakeRequestContextBestEffort(
    playerId: number,
    candidateCharacterIds: readonly number[],
    scope: AwakeMissionSeeds = {},
): AwakeRequestContext | null {
    try {
        return createAwakeRequestContext({
            playerId,
            candidateCharacterIds,
            invalidatedFactKeys: scope.invalidatedFactKeys,
            directMissionIds: scope.directMissionIds,
        })
    } catch (cause) {
        const error = cause instanceof Error
            ? cause
            : new Error("Unknown Awake context creation error")
        console.error("[awake-unlock] Failed to create publication context.", error)
        return null
    }
}

export function publishAwakeCharacterListBestEffort(
    playerId: number,
    explicitCharacterIds: readonly number[],
    characterLists: readonly (readonly Record<string, unknown>[])[],
    scope: AwakeMissionSeeds = {},
): Record<string, unknown>[] {
    const existingCharacterList = characterLists.flatMap(characterList => characterList)
    const candidateCharacterIds = collectAwakeCandidateCharacterIds(
        explicitCharacterIds,
        characterLists,
    )
    const awakeContext = createAwakeRequestContextBestEffort(
        playerId,
        candidateCharacterIds,
        scope,
    )
    return awakeContext === null
        ? existingCharacterList
        : reconcileAwakeUnlockCharacterListBestEffort(
            playerId,
            existingCharacterList,
            { context: awakeContext },
        )
}
