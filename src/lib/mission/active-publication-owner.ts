import { getDb } from "../../data/db"
import { getPlayerActiveMissionsSync } from "../../data/domains/mission"
import type { Player } from "../../data/types"
import type { ActiveMissionProgressDelta } from "./active-core"
import type { ActiveMissionFactObserver } from "./active-fact-session"
import { reconcileActiveMissionFactsWithinTransaction } from "./active-reconciliation"

export interface ActiveMissionOwnerPublicationInput {
    readonly playerId: number
    readonly now: number | Date
    readonly source: string
    readonly playerOverride?: Player
    readonly observer?: ActiveMissionFactObserver
}

export interface ActiveMissionOwnerPublicationResult {
    readonly activeMissionList: readonly ActiveMissionProgressDelta[]
    readonly activeMissions: ReturnType<typeof getPlayerActiveMissionsSync>
}

/**
 * H4 owner boundary: business owners call this after their last authoritative
 * write, inside the same transaction. The fixed point reads after-write facts,
 * converges Active Mission progress once, and returns the response delta. It
 * never opens its own transaction, never encodes an HTTP response, and never
 * swallows errors — a fixed-point failure rolls the business write back.
 */
export function publishActiveMissionOwnerStateWithinTransaction(
    input: ActiveMissionOwnerPublicationInput,
): ActiveMissionOwnerPublicationResult {
    if (!getDb().inTransaction) {
        throw new Error(
            `Active Mission owner publication (${input.source}) requires an open transaction.`,
        )
    }
    const result = reconcileActiveMissionFactsWithinTransaction({
        playerId: input.playerId,
        now: input.now,
        observer: input.observer,
        ...(input.playerOverride !== undefined
            ? { playerOverride: input.playerOverride }
            : {}),
    })
    return {
        activeMissionList: result.deltas,
        activeMissions: result.activeMissions,
    }
}
