import { getTimeOffset, realDateFromServerTime, realToVirtual } from "../utils"

export const EXP_POOL_GAIN_INTERVAL_MS = 60 * 1000
export const EXP_POOL_MAX = 100000

const LEGACY_ANCHOR_TOLERANCE_MS = 5 * EXP_POOL_GAIN_INTERVAL_MS
const MAX_CATCH_UP_MS = EXP_POOL_MAX * EXP_POOL_GAIN_INTERVAL_MS

export interface PooledExpCalculation {
    readonly expPool: number
    readonly expPooledTime: Date
    readonly earned: number
    readonly repaired: boolean
}

export function normalizeImportedExpPoolAnchor(
    persistedTime: Date,
    realNow: Date,
    timeOffsetMs: number | null | undefined = getTimeOffset(),
): Date {
    const nowMs = realNow.getTime()
    const rawAnchorMs = persistedTime.getTime()
    if (!Number.isFinite(nowMs) || !Number.isFinite(rawAnchorMs)) return new Date(nowMs)

    const offsetMs = offsetOrZero(timeOffsetMs)
    const realElapsedMs = nowMs - rawAnchorMs
    const virtualElapsedMs = nowMs + offsetMs - rawAnchorMs
    if (offsetMs !== 0
        && virtualElapsedMs >= 0
        && virtualElapsedMs <= MAX_CATCH_UP_MS + LEGACY_ANCHOR_TOLERANCE_MS
        && Math.abs(realElapsedMs) > MAX_CATCH_UP_MS + LEGACY_ANCHOR_TOLERANCE_MS) {
        return new Date(rawAnchorMs - offsetMs)
    }
    if (realElapsedMs < 0) return new Date(nowMs)
    if (offsetMs !== 0
        && realElapsedMs > MAX_CATCH_UP_MS + LEGACY_ANCHOR_TOLERANCE_MS
        && virtualElapsedMs < 0) {
        return new Date(nowMs)
    }
    return persistedTime
}

function offsetOrZero(offsetMs: number | null | undefined): number {
    return offsetMs ?? 0
}

/**
 * Calculates passive EXP using the real clock while keeping the client-facing
 * timestamp in the virtual server-time domain.
 *
 * Existing databases stored this field in the virtual domain. A legacy anchor
 * is migrated only when its virtual interpretation is recent but its real
 * interpretation is far outside the pool's catch-up window. Ambiguous or
 * future anchors are reset to now and keep the current balance.
 */
export function calculatePooledExpAtRealTime(
    expPool: number,
    expPooledTime: Date,
    realNow: Date,
    timeOffsetMs: number | null | undefined = getTimeOffset(),
): PooledExpCalculation {
    const nowMs = realNow.getTime()
    const rawAnchorMs = expPooledTime.getTime()
    const offsetMs = offsetOrZero(timeOffsetMs)

    if (!Number.isFinite(nowMs) || !Number.isFinite(rawAnchorMs)) {
        return {
            expPool,
            expPooledTime: new Date(nowMs),
            earned: 0,
            repaired: true,
        }
    }

    const virtualNowMs = nowMs + offsetMs
    const realElapsedMs = nowMs - rawAnchorMs
    const virtualElapsedMs = virtualNowMs - rawAnchorMs

    const normalizedAnchor = normalizeImportedExpPoolAnchor(expPooledTime, realNow, timeOffsetMs)
    let anchorMs = normalizedAnchor.getTime()
    let repaired = false

    if (anchorMs !== rawAnchorMs) {
        repaired = true
    } else if (realElapsedMs < 0) {
        // A clock adjustment or imported save placed the anchor in the future.
        anchorMs = nowMs
        repaired = true
    } else if (
        offsetMs !== 0
        && realElapsedMs > MAX_CATCH_UP_MS + LEGACY_ANCHOR_TOLERANCE_MS
        && virtualElapsedMs < 0
    ) {
        // A prior virtual date and a later server-time rollback cannot be
        // reconstructed safely. Preserve the balance and start a new anchor.
        anchorMs = nowMs
        repaired = true
    }

    const elapsedMs = Math.max(0, nowMs - anchorMs)
    const earned = elapsedMs < EXP_POOL_GAIN_INTERVAL_MS
        ? 0
        : Math.floor(elapsedMs / EXP_POOL_GAIN_INTERVAL_MS)
    const nextExpPool = Math.min(EXP_POOL_MAX, Math.max(0, expPool) + earned)

    if (earned === 0 && !repaired) {
        return {
            expPool,
            expPooledTime,
            earned: 0,
            repaired: false,
        }
    }

    return {
        expPool: nextExpPool,
        expPooledTime: new Date(nowMs),
        earned: Math.max(0, nextExpPool - Math.max(0, expPool)),
        repaired,
    }
}

export function expPoolRealDateToClientTimestamp(
    realDate: Date,
    timeOffsetMs: number | null | undefined = getTimeOffset(),
): number {
    if (timeOffsetMs === undefined) return realToVirtual(realDate)
    return Math.floor((realDate.getTime() + offsetOrZero(timeOffsetMs)) / 1000)
}

export function clientTimestampToExpPoolRealDate(
    clientTimestamp: number,
    timeOffsetMs: number | null | undefined = getTimeOffset(),
): Date {
    if (timeOffsetMs === undefined) return realDateFromServerTime(clientTimestamp)
    return new Date(clientTimestamp * 1000 - offsetOrZero(timeOffsetMs))
}
