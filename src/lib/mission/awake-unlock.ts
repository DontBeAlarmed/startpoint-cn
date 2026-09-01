import { getPlayerCategoryMissionsSync } from "../../data/domains/mission"
import { getDb } from "../../data/db"
import { getCharacterIdFromMission } from "./character-queries"
import { buildAwakeContext } from "./computer-awake"
import { getComputer } from "./registry"
import { getMissionIdsByCategory } from "./stages"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import {
    assertAwakeRequestContext,
    createAwakeRequestContext,
    isAwakeRequestContext,
    type AwakeRequestContext,
} from "./awake-request-context"
import {
    reconcileAwakeUnlocksFromProgressCore as reconcileAwakeUnlocksFromProgressCoreInGrowth,
    type AwakeUnlockProgress,
    type AwakeUnlockReconciliationResult,
} from "../character-growth/facts/awake-unlock-facts"

export type { AwakeUnlockProgress, AwakeUnlockReconciliationResult }

export function reconcileAwakeUnlocksFromProgressCore(
    playerId: number,
    progressList: readonly AwakeUnlockProgress[],
    resolver?: CharacterAwakeEligibilityResolver,
    context?: AwakeRequestContext,
): AwakeUnlockReconciliationResult {
    return reconcileAwakeUnlocksFromProgressCoreInGrowth(
        playerId,
        progressList,
        resolver,
        context,
    )
}

export function reconcileAwakeUnlocksFromProgress(
    playerId: number,
    progressList: readonly AwakeUnlockProgress[],
    resolver?: CharacterAwakeEligibilityResolver,
    context?: AwakeRequestContext,
): AwakeUnlockReconciliationResult {
    return getDb().transaction(() => reconcileAwakeUnlocksFromProgressCore(
        playerId,
        progressList,
        resolver,
        context,
    ))()
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
