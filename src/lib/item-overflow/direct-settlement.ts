import { getDb } from "../../data/db"
import { getPlayerSync } from "../../data/domains/player"
import {
    persistPlayerResourceGrantsWithinTransactionSync,
    type PlayerResourceGrantState,
} from "../player-resource-grant"
import { createRewardGrantItemOverflowPolicy } from "../reward-grant-item-overflow"
import type { PlannedItemOverflowDisposition } from "./disposition"

export interface DirectItemOverflow {
    readonly itemId: number
    readonly amount: number
}

export interface SettleDirectItemOverflowsInput {
    readonly playerId: number
    readonly overflows: readonly DirectItemOverflow[]
    readonly now?: Date
}

export interface DirectItemOverflowSettlement {
    readonly dispositions: readonly PlannedItemOverflowDisposition[]
    readonly freeManaAfter: number
}

function positiveSafeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`)
    }
    return value
}

export function settleDirectItemOverflowsWithinTransactionSync(
    input: SettleDirectItemOverflowsInput,
): DirectItemOverflowSettlement {
    if (!getDb().inTransaction) {
        throw new Error("direct Item overflow settlement requires an active transaction")
    }
    const playerId = positiveSafeInteger(input.playerId, "playerId")
    if (!Array.isArray(input.overflows)) {
        throw new TypeError("overflows must be an array")
    }
    const overflows = input.overflows.map((overflow, index) => {
        if (!overflow || typeof overflow !== "object") {
            throw new TypeError(`overflows[${index}] must be an object`)
        }
        return Object.freeze({
            itemId: positiveSafeInteger(overflow.itemId, `overflows[${index}].itemId`),
            amount: positiveSafeInteger(overflow.amount, `overflows[${index}].amount`),
        })
    })
    const player = getPlayerSync(playerId)
    if (player === null) throw new Error(`Player ${playerId} is missing during Item overflow.`)
    const before: PlayerResourceGrantState = {
        playerId,
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
    }
    if (overflows.length === 0) {
        return Object.freeze({ dispositions: Object.freeze([]), freeManaAfter: before.freeMana })
    }
    const policy = createRewardGrantItemOverflowPolicy(playerId, input.now, player.paidMana)
    const dispositions: PlannedItemOverflowDisposition[] = []
    let freeManaAfter = before.freeMana
    for (const overflow of overflows) {
        const disposition = policy.planOverflow(
            overflow.itemId,
            overflow.amount,
            freeManaAfter,
        )
        dispositions.push(disposition)
        if (disposition.kind === "sold") freeManaAfter = disposition.manaAfter
    }
    persistPlayerResourceGrantsWithinTransactionSync(before, {
        ...before,
        freeMana: freeManaAfter,
    })
    for (const disposition of dispositions) policy.finalizeOverflow(disposition)
    return Object.freeze({
        dispositions: Object.freeze(dispositions),
        freeManaAfter,
    })
}
