import { getTimeOffset, realDateFromServerTime, realToVirtual } from "../utils"

export const EXP_POOL_GAIN_INTERVAL_MS = 60 * 1000
// 客户端真值（config_iosbundled 解码）：上限 2,000,000,000、显示上限 999,999,999。
// 旧值 100000 会让管理面板设置的亿级池在一次 ≥60s 间隔的登录后被砍到 10 万
//（2026-10-21 维护者裁决对齐客户端）。
export const EXP_POOL_MAX = 2_000_000_000

const LEGACY_ANCHOR_TOLERANCE_MS = 5 * EXP_POOL_GAIN_INTERVAL_MS
// 追平窗口与余额上限解耦：原 MAX_CATCH_UP_MS = EXP_POOL_MAX × 60s 随上限
// 放大后≈3800 年，会让 normalizeImportedExpPoolAnchor 的 legacy 锚点迁移
// 启发式全部失效（2 年前的虚拟锚点落入"可追平"窗口→登录一次性追平海量经验）。
// 窗口保持原量级（6e9 ms ≈ 69 天真实跨度），只约束"锚点回拨可安全重建"的
// 判定，不约束余额。
const MAX_CATCH_UP_MS = 100_000 * EXP_POOL_GAIN_INTERVAL_MS

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
