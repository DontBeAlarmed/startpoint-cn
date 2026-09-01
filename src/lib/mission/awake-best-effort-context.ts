import {
    createCharacterGrowthPublicationContextBestEffort,
    publishCharacterGrowthOwnerStateBestEffort,
} from "../character-growth/owner-publication"
import {
    type AwakeRequestContext,
} from "./awake-request-context"
import type { AwakeMissionSeeds } from "./awake-request-context-scope"

export function createAwakeRequestContextBestEffort(
    playerId: number,
    candidateCharacterIds: readonly number[],
    scope: AwakeMissionSeeds = {},
): AwakeRequestContext | null {
    try {
        return createCharacterGrowthPublicationContextBestEffort(
            playerId,
            candidateCharacterIds,
            scope,
        )
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
    return publishCharacterGrowthOwnerStateBestEffort(
        playerId,
        explicitCharacterIds,
        characterLists,
        scope,
        "mission/legacy-awake-publication",
    ).characterList
}
