import { getDb } from "../../data/db"
import type { CharacterAwakeEligibilityResolver } from "./awake-eligibility"
import {
    assertAwakeRequestContext,
    createAwakeRequestContext,
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
