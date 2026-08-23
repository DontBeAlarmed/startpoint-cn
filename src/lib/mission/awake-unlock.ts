import { deletePlayerCharacterAwakeUnlocksSync, getPlayerCharacterAwakeUnlocksSync, upsertPlayerCharacterAwakeUnlockSync } from "../../data/domains/character_awake"
import type { CharacterAwakeUnlockMap } from "../../data/domains/character_awake"
import { getDb } from "../../data/db"
import { getCharacterIdFromMission } from "./character-queries"
import { getAwakeMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers } from "./stages"
import { createCharacterAwakeEligibilityResolver } from "./awake-eligibility"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import {
    assertAwakeRequestContext,
    createAwakeRequestContext,
    type AwakeRequestContext,
} from "./awake-request-context"

export interface AwakeUnlockReconciliationResult {
    all: CharacterAwakeUnlockMap
    changed: CharacterAwakeUnlockMap
    removed: CharacterAwakeUnlockMap
}

export interface AwakeUnlockProgress {
    missionId: number
    progress: number
}

export function reconcileAwakeUnlocksFromProgress(
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
    }
    const effectiveResolver = context?.resolver
        ?? resolver
        ?? createCharacterAwakeEligibilityResolver(playerId)
    const unlocks = context?.readUnlocks() ?? getPlayerCharacterAwakeUnlocksSync(playerId)
    const nextUnlocks: CharacterAwakeUnlockMap = new Map(
        [...unlocks].map(([characterId, levels]) => [characterId, { ...levels }]),
    )
    const changed: CharacterAwakeUnlockMap = new Map()
    const removed: CharacterAwakeUnlockMap = new Map()

    getDb().transaction(() => {
        for (const [characterId, levels] of unlocks) {
            const numericCharacterId = Number(characterId)
            if (effectiveResolver.getBaseReadiness(numericCharacterId) !== "not-ready") continue
            if (effectiveResolver.hasPositiveManaNodeAwakeLevel(numericCharacterId)) continue
            if (deletePlayerCharacterAwakeUnlocksSync(playerId, numericCharacterId)) {
                removed.set(characterId, { ...levels })
                nextUnlocks.delete(characterId)
            }
        }

        for (const entry of progressList) {
            const characterId = getCharacterIdFromMission(entry.missionId)
            if (!effectiveResolver.isNewUnlockEligible(Number(characterId), entry.missionId)) continue

            for (const stage of getCompletedStageNumbers(9, entry.missionId, entry.progress)) {
                const specialReward = getAwakeMissionRewardStageDefinition(entry.missionId, stage)?.specialReward
                if (!specialReward || String(specialReward.characterId) !== characterId) continue
                if (!upsertPlayerCharacterAwakeUnlockSync(
                    playerId,
                    specialReward.characterId,
                    specialReward.boardIndex,
                    specialReward.awakeLevel
                )) continue

                const levels = changed.get(characterId) ?? {}
                levels[specialReward.boardIndex] = Math.max(
                    levels[specialReward.boardIndex] ?? 0,
                    specialReward.awakeLevel
                )
                changed.set(characterId, levels)

                const allLevels = nextUnlocks.get(characterId) ?? {}
                allLevels[specialReward.boardIndex] = Math.max(
                    allLevels[specialReward.boardIndex] ?? 0,
                    specialReward.awakeLevel,
                )
                nextUnlocks.set(characterId, allLevels)
            }
        }
    })()

    unlocks.clear()
    for (const [characterId, levels] of nextUnlocks) {
        unlocks.set(characterId, levels)
    }

    return {
        all: unlocks,
        changed,
        removed,
    }
}

export function reconcileAwakeUnlocks(
    playerId: number,
    candidateCharacterIds?: readonly number[],
    context?: AwakeRequestContext,
): AwakeUnlockReconciliationResult {
    const requestContext = context ?? createAwakeRequestContext({
        playerId,
        candidateCharacterIds,
    })
    assertAwakeRequestContext(requestContext, playerId)
    return reconcileAwakeUnlocksFromProgress(
        playerId,
        requestContext.evaluate(candidateCharacterIds),
        requestContext.resolver,
        requestContext,
    )
}
