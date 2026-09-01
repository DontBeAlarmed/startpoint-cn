import { buildManaBoardAwakeCharacterList } from "../character-helpers"
import { getDb } from "../../data/db"
import { reconcileAwakeUnlocksFromProgressCore } from "./awake-unlock"
import { mergeAwakeUnlockCharacterList } from "../character-growth/facts/awake-unlock-facts"
import {
    assertAwakeRequestContext,
    createAwakeRequestContext,
    type AwakeRequestContext,
} from "./awake-request-context"

export interface ReconcileAwakeUnlockCharacterListOptions {
    readonly candidateCharacterIds?: readonly number[]
    readonly context?: AwakeRequestContext
}

function reconcileAwakeUnlockCharacterListCore(
    playerId: number,
    existing: Record<string, unknown>[],
    options: ReconcileAwakeUnlockCharacterListOptions = {},
): Record<string, unknown>[] {
    const context = options.context ?? createAwakeRequestContext({
        playerId,
        candidateCharacterIds: options.candidateCharacterIds,
    })
    assertAwakeRequestContext(context, playerId)
    return getDb().transaction(() => {
        const { changed } = reconcileAwakeUnlocksFromProgressCore(
            playerId,
            context.evaluate(options.candidateCharacterIds),
            context.resolver,
            context,
        )
        const updates = buildManaBoardAwakeCharacterList(
            context.resolver.characters,
            changed,
        )
        return mergeAwakeUnlockCharacterList(existing, updates)
    })()
}

export function reconcileAwakeUnlockCharacterListStrict(
    playerId: number,
    existing: Record<string, unknown>[],
    options?: ReconcileAwakeUnlockCharacterListOptions,
): Record<string, unknown>[] {
    return reconcileAwakeUnlockCharacterListCore(playerId, existing, options)
}

export function reconcileAwakeUnlockCharacterListBestEffort(
    playerId: number,
    existing: Record<string, unknown>[],
    options?: ReconcileAwakeUnlockCharacterListOptions,
): Record<string, unknown>[] {
    try {
        return reconcileAwakeUnlockCharacterListCore(playerId, existing, options)
    } catch (cause) {
        const error = cause instanceof Error
            ? cause
            : new Error("Unknown awake unlock publication error")
        console.error("[awake-unlock] Failed to publish character unlocks.", error)
        return existing
    }
}

export const reconcileAwakeUnlockCharacterList = reconcileAwakeUnlockCharacterListBestEffort
