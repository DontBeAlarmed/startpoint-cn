import { getDb } from "../data/db"

export type PlayerGrantResource = "freeMana" | "freeVmoney" | "expPool"

export interface PlayerResourceGrantState {
    readonly playerId: number
    readonly freeMana: number
    readonly freeVmoney: number
    readonly expPool: number
}

export interface MutablePlayerResourceGrantState {
    readonly playerId: number
    freeMana: number
    freeVmoney: number
    expPool: number
}

export interface PlayerResourceGrantDelta {
    readonly resource: PlayerGrantResource
    readonly requestedAmount: number
    readonly beforeAmount: number
    readonly afterAmount: number
}

export class PlayerResourceGrantError extends Error {
    readonly field: PlayerGrantResource | "playerId" | "totalManaObtained"

    constructor(field: PlayerResourceGrantError["field"], message?: string) {
        super(message ?? `Invalid Player resource grant: ${field}`)
        this.name = "PlayerResourceGrantError"
        this.field = field
    }
}

function positivePlayerId(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new PlayerResourceGrantError("playerId")
    }
    return value
}

function amount(value: unknown, field: PlayerGrantResource): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new PlayerResourceGrantError(field)
    }
    return value
}

export function createPlayerResourceGrantState(
    value: PlayerResourceGrantState,
): MutablePlayerResourceGrantState {
    return {
        playerId: positivePlayerId(value.playerId),
        freeMana: amount(value.freeMana, "freeMana"),
        freeVmoney: amount(value.freeVmoney, "freeVmoney"),
        expPool: amount(value.expPool, "expPool"),
    }
}

export function grantPlayerResource(
    state: MutablePlayerResourceGrantState,
    resource: PlayerGrantResource,
    requestedAmount: number,
): PlayerResourceGrantDelta {
    const requested = amount(requestedAmount, resource)
    if (requested === 0) throw new PlayerResourceGrantError(resource)
    const beforeAmount = state[resource]
    const afterAmount = beforeAmount + requested
    if (!Number.isSafeInteger(afterAmount)) throw new PlayerResourceGrantError(resource)
    state[resource] = afterAmount
    return Object.freeze({ resource, requestedAmount: requested, beforeAmount, afterAmount })
}

export function snapshotPlayerResourceGrantState(
    state: PlayerResourceGrantState,
): PlayerResourceGrantState {
    return Object.freeze({ ...createPlayerResourceGrantState(state) })
}

export function persistPlayerResourceGrantsWithinTransactionSync(
    before: PlayerResourceGrantState,
    after: PlayerResourceGrantState,
): void {
    if (!getDb().inTransaction) {
        throw new PlayerResourceGrantError("playerId", "Player resource grant requires a transaction")
    }
    const normalizedBefore = createPlayerResourceGrantState(before)
    const normalizedAfter = createPlayerResourceGrantState(after)
    if (normalizedBefore.playerId !== normalizedAfter.playerId) {
        throw new PlayerResourceGrantError("playerId")
    }
    const manaDelta = normalizedAfter.freeMana - normalizedBefore.freeMana
    if (!Number.isSafeInteger(manaDelta) || manaDelta < 0
        || normalizedAfter.freeVmoney < normalizedBefore.freeVmoney
        || normalizedAfter.expPool < normalizedBefore.expPool) {
        throw new PlayerResourceGrantError("freeMana")
    }
    if (manaDelta === 0
        && normalizedAfter.freeVmoney === normalizedBefore.freeVmoney
        && normalizedAfter.expPool === normalizedBefore.expPool) return

    const result = getDb().prepare(`
        UPDATE players
        SET free_vmoney = ?, free_mana = ?, exp_pool = ?,
            total_mana_obtained = total_mana_obtained + ?
        WHERE id = ?
          AND free_vmoney = ?
          AND free_mana = ?
          AND exp_pool = ?
          AND typeof(total_mana_obtained) = 'integer'
          AND total_mana_obtained >= 0
          AND total_mana_obtained <= ? - ?
    `).run(
        normalizedAfter.freeVmoney,
        normalizedAfter.freeMana,
        normalizedAfter.expPool,
        manaDelta,
        normalizedAfter.playerId,
        normalizedBefore.freeVmoney,
        normalizedBefore.freeMana,
        normalizedBefore.expPool,
        Number.MAX_SAFE_INTEGER,
        manaDelta,
    )
    if (result.changes !== 1) {
        throw new PlayerResourceGrantError(
            "totalManaObtained",
            "Player resource grant did not update one valid Player row",
        )
    }
}
