import { buildManaBoardAwakeCharacterList } from "../../character-helpers"
import {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} from "../../../data/domains/character_awake"
import type { CharacterAwakeUnlockMap } from "../../../data/domains/character_awake"
import { getCharacterIdFromMission } from "../../mission/character-queries"
import { getAwakeMissionRewardStageDefinition } from "../../mission/rewards"
import { getCompletedStageNumbers } from "../../mission/stages"
import { createCharacterAwakeEligibilityResolver } from "../../mission/awake-eligibility"
import type { CharacterAwakeEligibilityResolver } from "../../mission/awake-eligibility"
import {
    assertAwakeRequestContext,
    type AwakeRequestContext,
} from "../../mission/awake-request-context"
import { consumeAwakeRequestContextWrite } from "../../mission/awake-request-context-state"

export interface AwakeUnlockProgress {
    missionId: number
    progress: number
}

export interface AwakeUnlockReconciliationResult {
    all: CharacterAwakeUnlockMap
    changed: CharacterAwakeUnlockMap
}

export interface AwakeUnlockCharacterListPublicationResult
    extends AwakeUnlockReconciliationResult {
    characterList: Record<string, unknown>[]
}

function persistPermanentAwakeUnlocksFromProgress(
    playerId: number,
    progressList: readonly AwakeUnlockProgress[],
    resolver: CharacterAwakeEligibilityResolver,
): CharacterAwakeUnlockMap {
    const changed: CharacterAwakeUnlockMap = new Map()
    for (const entry of progressList) {
        const characterId = getCharacterIdFromMission(entry.missionId)
        if (!resolver.isNewUnlockEligible(Number(characterId), entry.missionId)) continue

        for (const stage of getCompletedStageNumbers(9, entry.missionId, entry.progress)) {
            const specialReward = getAwakeMissionRewardStageDefinition(entry.missionId, stage)?.specialReward
            if (!specialReward || String(specialReward.characterId) !== characterId) continue
            if (!upsertPlayerCharacterAwakeUnlockSync(
                playerId,
                specialReward.characterId,
                specialReward.boardIndex,
                specialReward.awakeLevel,
            )) continue

            const levels = changed.get(characterId) ?? {}
            levels[specialReward.boardIndex] = Math.max(
                levels[specialReward.boardIndex] ?? 0,
                specialReward.awakeLevel,
            )
            changed.set(characterId, levels)
        }
    }
    return changed
}

export function reconcileAwakeUnlocksFromProgressCore(
    playerId: number,
    progressList: readonly AwakeUnlockProgress[],
    resolver?: CharacterAwakeEligibilityResolver,
    context?: AwakeRequestContext,
): AwakeUnlockReconciliationResult {
    if (context) {
        assertAwakeRequestContext(context, playerId)
        if (resolver && resolver !== context.resolver) {
            throw new Error("Awake context resolver mismatch")
        }
        consumeAwakeRequestContextWrite(context, playerId, progressList)
    }
    const effectiveResolver = context?.resolver
        ?? resolver
        ?? createCharacterAwakeEligibilityResolver(playerId)
    const contextUnlocks = context?.readUnlocks()
    const unlocks = contextUnlocks ?? getPlayerCharacterAwakeUnlocksSync(playerId)
    const nextUnlocks: CharacterAwakeUnlockMap = new Map(
        [...unlocks].map(([characterId, levels]) => [characterId, { ...levels }]),
    )
    const changed = persistPermanentAwakeUnlocksFromProgress(
        playerId,
        progressList,
        effectiveResolver,
    )
    for (const [characterId, levels] of changed) {
        const allLevels = nextUnlocks.get(characterId) ?? {}
        for (const [boardIndex, awakeLevel] of Object.entries(levels)) {
            const index = Number(boardIndex)
            allLevels[index] = Math.max(allLevels[index] ?? 0, awakeLevel)
        }
        nextUnlocks.set(characterId, allLevels)
    }

    return {
        all: nextUnlocks,
        changed,
    }
}

function mergeManaBoardAwake(...values: unknown[]): Record<number, number> {
    const merged: Record<number, number> = {}

    for (const value of values) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue

        for (const [boardIndex, awakeLevel] of Object.entries(value)) {
            const index = Number(boardIndex)
            if (!Number.isSafeInteger(index) || index <= 0) continue
            if (typeof awakeLevel !== "number"
                || !Number.isSafeInteger(awakeLevel)
                || awakeLevel < 0) continue
            merged[index] = Math.max(merged[index] ?? 0, awakeLevel)
        }
    }

    return merged
}

export function mergeAwakeUnlockCharacterList(
    existing: readonly Record<string, unknown>[],
    updates: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
    const merged: Record<string, unknown>[] = []
    const indexByCharacterId = new Map<string, number>()

    for (const entry of existing) {
        const characterId = entry.character_id
        if (typeof characterId !== "number" && typeof characterId !== "string") {
            merged.push({ ...entry })
            continue
        }

        const key = String(characterId)
        const index = indexByCharacterId.get(key)
        if (index === undefined) {
            indexByCharacterId.set(key, merged.length)
            merged.push({ ...entry })
            continue
        }

        const previous = merged[index]
        merged[index] = {
            ...previous,
            ...entry,
            ...((previous.mana_board_awake !== undefined
                || entry.mana_board_awake !== undefined) ? {
                    mana_board_awake: mergeManaBoardAwake(
                        previous.mana_board_awake,
                        entry.mana_board_awake,
                    ),
                } : {}),
        }
    }

    for (const update of updates) {
        const key = String(update.character_id)
        const index = indexByCharacterId.get(key)
        if (index === undefined) {
            indexByCharacterId.set(key, merged.length)
            merged.push(update)
            continue
        }

        merged[index] = {
            ...update,
            ...merged[index],
            mana_board_awake: mergeManaBoardAwake(
                merged[index].mana_board_awake,
                update.mana_board_awake,
            ),
        }
    }

    return merged
}

export function publishAwakeUnlockCharacterListWithinTransaction(
    playerId: number,
    existing: readonly Record<string, unknown>[],
    context: AwakeRequestContext,
    candidateCharacterIds?: readonly number[],
): Record<string, unknown>[] {
    return publishAwakeUnlockCharacterListWithStateWithinTransaction(
        playerId,
        existing,
        context,
        candidateCharacterIds,
    ).characterList
}

export function publishAwakeUnlockCharacterListWithStateWithinTransaction(
    playerId: number,
    existing: readonly Record<string, unknown>[],
    context: AwakeRequestContext,
    candidateCharacterIds?: readonly number[],
): AwakeUnlockCharacterListPublicationResult {
    assertAwakeRequestContext(context, playerId)
    const reconciliation = reconcileAwakeUnlocksFromProgressCore(
        playerId,
        context.evaluate(candidateCharacterIds),
        context.resolver,
        context,
    )
    const updates = buildManaBoardAwakeCharacterList(
        context.resolver.characters,
        reconciliation.changed,
    )
    return {
        ...reconciliation,
        characterList: mergeAwakeUnlockCharacterList(existing, updates),
    }
}

export function publishEvaluatedAwakeUnlockCharacterListWithinTransaction(
    playerId: number,
    existing: readonly Record<string, unknown>[],
    progressList: readonly AwakeUnlockProgress[],
    resolver: CharacterAwakeEligibilityResolver,
): Record<string, unknown>[] {
    const changed = persistPermanentAwakeUnlocksFromProgress(
        playerId,
        progressList,
        resolver,
    )
    return mergeAwakeUnlockCharacterList(
        existing,
        buildManaBoardAwakeCharacterList(resolver.characters, changed),
    )
}
