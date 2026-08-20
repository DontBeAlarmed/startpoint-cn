import {
    getTimeOffset,
    realDateFromServerTime,
    realToVirtual,
} from "../../utils"

export interface GameTimeContext {
    readonly realNowMs: number
    readonly virtualNowMs: number
    readonly realNow: Date
    readonly virtualNow: Date
}

/** Capture both clocks once so a business operation does not mix request-time samples. */
export function getGameTimeContext(realNowMs = Date.now()): GameTimeContext {
    const virtualNowMs = realNowMs + (getTimeOffset() ?? 0)
    return Object.freeze({
        realNowMs,
        virtualNowMs,
        realNow: new Date(realNowMs),
        virtualNow: new Date(virtualNowMs),
    })
}

export function getRealNowMs(): number {
    return Date.now()
}

export function getVirtualNowMs(): number {
    return getGameTimeContext().virtualNowMs
}

export function getRealNow(): Date {
    return new Date(getRealNowMs())
}

export function getVirtualNow(): Date {
    return new Date(getVirtualNowMs())
}

export function getRealElapsedSeconds(anchorMs: number, nowMs = getRealNowMs()): number {
    return Math.max(0, Math.floor((nowMs - anchorMs) / 1000))
}

export function getVirtualElapsedSeconds(anchorMs: number, nowMs = getVirtualNowMs()): number {
    return Math.max(0, Math.floor((nowMs - anchorMs) / 1000))
}

export function realDateToClientTimestamp(date: Date): number {
    return realToVirtual(date)
}

export function clientTimestampToRealDate(serverTime: number): Date {
    return realDateFromServerTime(serverTime)
}
