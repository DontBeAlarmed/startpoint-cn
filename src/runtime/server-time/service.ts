import {
    getTimeOffset,
    setServerTimeOffset,
} from "../../utils"
import {
    parseServerTimePackage,
    ServerTimeStore,
    ServerTimeStoreError,
} from "./store"
import {
    ServerTimePackage,
    ServerTimeSnapshot,
    ServerTimeState,
} from "./types"

const DEFAULT_SERVER_TIME_MS = Date.parse("2024-08-14T12:00:00.000Z")

export interface ServerTimeServiceOptions {
    readonly store?: ServerTimeStore
    readonly now?: () => number
}

export interface ServerTimeNowOptions {
    readonly nowMs?: number
}

export class ServerTimeServiceError extends Error {
    constructor(readonly code: "INVALID_SERVER_TIME_STATE", message: string = code) {
        super(message)
        this.name = "ServerTimeServiceError"
    }
}

function invalidState(message = "invalid server time state"): never {
    throw new ServerTimeServiceError("INVALID_SERVER_TIME_STATE", message)
}

function assertNowMs(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs)) return invalidState("invalid current time")
    return nowMs
}

export class ServerTimeService {
    private readonly store: ServerTimeStore
    private readonly now: () => number
    private state: ServerTimeState | null = null

    constructor(options: ServerTimeServiceOptions = {}) {
        this.store = options.store ?? new ServerTimeStore()
        this.now = options.now ?? Date.now
    }

    restore(options: ServerTimeNowOptions = {}): ServerTimeSnapshot {
        const nowMs = this.resolveNow(options)
        let state: ServerTimeState | null
        try {
            state = this.store.read()
        } catch (error) {
            if (error instanceof ServerTimeStoreError) return invalidState(error.message)
            throw error
        }

        if (state === null) {
            const legacyOffset = this.store.readLegacyOffset()
            state = legacyOffset === null
                ? this.createState("offset", DEFAULT_SERVER_TIME_MS - nowMs, nowMs)
                : this.createState("offset", legacyOffset, nowMs)
            this.store.write(state)
        }

        return this.applyAfterPersist(state, nowMs)
    }

    setAbsoluteTime(targetMs: number, options: ServerTimeNowOptions = {}): ServerTimeSnapshot {
        const nowMs = this.resolveNow(options)
        if (!Number.isSafeInteger(targetMs)) return invalidState("invalid target time")
        const offsetMs = targetMs - nowMs
        if (!Number.isSafeInteger(offsetMs)) return invalidState("invalid time offset")
        const state = this.createState("offset", offsetMs, nowMs)
        this.store.write(state)
        return this.applyAfterPersist(state, nowMs)
    }

    setSystemTime(options: ServerTimeNowOptions = {}): ServerTimeSnapshot {
        const nowMs = this.resolveNow(options)
        const state = this.createState("system", 0, nowMs)
        this.store.write(state)
        return this.applyAfterPersist(state, nowMs)
    }

    importPackage(value: unknown, options: ServerTimeNowOptions = {}): ServerTimeSnapshot {
        const nowMs = this.resolveNow(options)
        let state: ServerTimeState
        try {
            const candidate = value !== null
                && typeof value === "object"
                && !Array.isArray(value)
                ? value as Record<string, unknown>
                : null
            const packageValue = candidate !== null
                && Object.keys(candidate).length === 4
                && Object.prototype.hasOwnProperty.call(candidate, "serverTimeMs")
                ? {
                    mode: candidate.mode,
                    offsetMs: candidate.offsetMs,
                    generatedAt: candidate.generatedAt,
                }
                : candidate
            state = parseServerTimePackage(JSON.stringify(packageValue))
        } catch (error) {
            if (error instanceof ServerTimeStoreError) return invalidState(error.message)
            throw error
        }
        this.store.write(state)
        return this.applyAfterPersist(state, nowMs)
    }

    exportPackage(options: ServerTimeNowOptions = {}): ServerTimeSnapshot {
        const nowMs = this.resolveNow(options)
        const offsetMs = getTimeOffset()
        const state = this.createState(
            offsetMs === null ? "system" : "offset",
            offsetMs ?? 0,
            nowMs,
        )
        this.state = state
        return this.snapshot(state, nowMs)
    }

    getState(options: ServerTimeNowOptions = {}): ServerTimeSnapshot {
        const nowMs = this.resolveNow(options)
        const current = this.state ?? this.createState(
            getTimeOffset() === null ? "system" : "offset",
            getTimeOffset() ?? 0,
            nowMs,
        )
        return this.snapshot(current, nowMs)
    }

    private resolveNow(options: ServerTimeNowOptions): number {
        return assertNowMs(options.nowMs ?? this.now())
    }

    private createState(
        mode: ServerTimeState["mode"],
        offsetMs: number,
        nowMs: number,
    ): ServerTimeState {
        const generatedAt = new Date(nowMs).toISOString()
        return Object.freeze({ mode, offsetMs, generatedAt })
    }

    private applyAfterPersist(state: ServerTimeState, nowMs: number): ServerTimeSnapshot {
        setServerTimeOffset(state.mode === "system" ? null : state.offsetMs)
        this.state = state
        return this.snapshot(state, nowMs)
    }

    private snapshot(state: ServerTimeState, nowMs: number): ServerTimeSnapshot {
        return Object.freeze({
            ...state,
            serverTimeMs: nowMs + state.offsetMs,
        })
    }
}

export { DEFAULT_SERVER_TIME_MS }
