import { deletePlayerCharacterAwakeUnlocksSync, getPlayerCharacterAwakeUnlocksSync, upsertPlayerCharacterAwakeUnlockSync } from "../../data/domains/character_awake"
import type { CharacterAwakeUnlockMap } from "../../data/domains/character_awake"
import { getPlayerCategoryMissionsSync } from "../../data/domains/mission"
import { getDb } from "../../data/db"
import { getCharacterIdFromMission } from "./character-queries"
import { buildAwakeContext } from "./computer-awake"
import { getComputer } from "./registry"
import { getAwakeMissionRewardStageDefinition } from "./rewards"
import { getCompletedStageNumbers, getMissionIdsByCategory } from "./stages"
import { createCharacterAwakeEligibilityResolver } from "./awake-eligibility"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import {
    assertAwakeRequestContext,
    createAwakeRequestContext,
    isAwakeRequestContext,
    type AwakeRequestContext,
} from "./awake-request-context"
import { consumeAwakeRequestContextWrite } from "./awake-request-context-state"

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
        consumeAwakeRequestContextWrite(context, playerId, progressList)
    }
    const effectiveResolver = context?.resolver
        ?? resolver
        ?? createCharacterAwakeEligibilityResolver(playerId)
    const contextUnlocks = context?.readUnlocks()
    const changed: CharacterAwakeUnlockMap = new Map()
    const removed: CharacterAwakeUnlockMap = new Map()

    const nextUnlocks = getDb().transaction((): CharacterAwakeUnlockMap => {
        const unlocks = contextUnlocks ?? getPlayerCharacterAwakeUnlocksSync(playerId)
        const next: CharacterAwakeUnlockMap = new Map(
            [...unlocks].map(([characterId, levels]) => [characterId, { ...levels }]),
        )
        for (const [characterId, levels] of unlocks) {
            const numericCharacterId = Number(characterId)
            if (effectiveResolver.getBaseReadiness(numericCharacterId) !== "not-ready") continue
            if (effectiveResolver.hasPositiveManaNodeAwakeLevel(numericCharacterId)) continue
            if (deletePlayerCharacterAwakeUnlocksSync(playerId, numericCharacterId)) {
                removed.set(characterId, { ...levels })
                next.delete(characterId)
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

                const allLevels = next.get(characterId) ?? {}
                allLevels[specialReward.boardIndex] = Math.max(
                    allLevels[specialReward.boardIndex] ?? 0,
                    specialReward.awakeLevel,
                )
                next.set(characterId, allLevels)
            }
        }
        return next
    })()

    return {
        all: nextUnlocks,
        changed,
        removed,
    }
}

function isCharacterAwakeEligibilityResolver(
    value: unknown,
): value is CharacterAwakeEligibilityResolver {
    if (value === null || typeof value !== "object") return false
    const resolver = value as Partial<CharacterAwakeEligibilityResolver>
    return typeof resolver.characters === "object"
        && typeof resolver.manaNodes === "object"
        && typeof resolver.manaNodeAwakeLevels === "object"
        && resolver.evaluationTime instanceof Date
        && typeof resolver.getBaseReadiness === "function"
        && typeof resolver.hasPositiveManaNodeAwakeLevel === "function"
        && typeof resolver.isNewUnlockEligible === "function"
}

function evaluateLegacyAwakeUnlocks(
    playerId: number,
    candidateCharacterIds: readonly number[] | undefined,
    resolver: CharacterAwakeEligibilityResolver,
): readonly AwakeUnlockProgress[] {
    if (candidateCharacterIds?.length === 0) return []
    const ownedCharacters = resolver.characters
    const persistedMissions = getPlayerCategoryMissionsSync(playerId, 9)
    const candidateIds = candidateCharacterIds
        ? new Set(candidateCharacterIds.map(String))
        : null
    const computer = getComputer(9)
    const context = buildAwakeContext(playerId, ownedCharacters)
    const progressList: AwakeUnlockProgress[] = []
    for (const missionId of getMissionIdsByCategory(9)) {
        const characterId = getCharacterIdFromMission(missionId)
        if (!ownedCharacters[characterId] || (candidateIds && !candidateIds.has(characterId))) {
            continue
        }
        if (!resolver.isNewUnlockEligible(Number(characterId), missionId)) continue
        progressList.push({
            missionId,
            progress: computer.compute(
                missionId,
                context,
                persistedMissions[String(missionId)]?.progress ?? 0,
            ),
        })
    }
    return progressList
}

export function reconcileAwakeUnlocks(
    playerId: number,
    candidateCharacterIds?: readonly number[],
    resolverOrContext?: CharacterAwakeEligibilityResolver | AwakeRequestContext,
): AwakeUnlockReconciliationResult {
    if (resolverOrContext !== undefined && !isAwakeRequestContext(resolverOrContext)) {
        if (!isCharacterAwakeEligibilityResolver(resolverOrContext)) {
            throw new TypeError("Awake context or resolver is invalid")
        }
        return reconcileAwakeUnlocksFromProgress(
            playerId,
            evaluateLegacyAwakeUnlocks(playerId, candidateCharacterIds, resolverOrContext),
            resolverOrContext,
        )
    }

    const requestContext = resolverOrContext ?? createAwakeRequestContext({
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
