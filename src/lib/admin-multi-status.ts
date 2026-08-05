import type { CompatibilityDifference } from "../multi/compatibility"
import type { MultiRuntimeStatus } from "../multi/runtime/status"

const MAX_REJECTION_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_REJECTION_TTL_MS = 60 * 60 * 1000
const MAX_DIFFERENCES = 6
const MAX_DIAGNOSTIC_VALUE_LENGTH = 32
const SENSITIVE_VALUE_PATTERN = /bearer|token|secret|session|credential/i
const HASH_LIKE_VALUE_PATTERN = /^[a-f0-9]{16,}$/i
const COMPATIBILITY_FIELDS = new Set<string>([
    "multiProtocolVersion",
    "APP_VER",
    "RES_VER",
    "cdnTargetVersion",
    "contentDigest",
    "modeDigest",
])
const VERSION_VALUE_FIELDS = new Set<string>([
    "APP_VER",
    "RES_VER",
    "cdnTargetVersion",
])

export interface AdminMultiAuthorityStatus {
    readonly activeRooms: number
    readonly activeBattleFacts: number
    readonly finalizedBattleFacts: number
}

export interface CompatibilityRejectionDifference {
    readonly field: string
    readonly different: true
    readonly required?: string
    readonly received?: string
}

export interface CompatibilityRejectionSummary {
    readonly code: "INCOMPATIBLE_ROOM"
    readonly differences: readonly CompatibilityRejectionDifference[]
    readonly timestamp: string
}

export interface CompatibilityRejectionInput {
    readonly code: "INCOMPATIBLE_ROOM"
    readonly differences?: readonly (
        CompatibilityDifference
        | CompatibilityRejectionDifference
        | {
            readonly field?: unknown
            readonly required?: unknown
            readonly received?: unknown
            readonly host?: unknown
            readonly guest?: unknown
        }
    )[]
}

export interface AdminMultiStatus {
    readonly mode: MultiRuntimeStatus["mode"]
    readonly state: MultiRuntimeStatus["state"]
    readonly coordinator: MultiRuntimeStatus["coordinator"]
    readonly hub: MultiRuntimeStatus["hub"]
    readonly tcp: MultiRuntimeStatus["tcp"]
    readonly activeRooms: number | null
    readonly battleFacts: {
        readonly active: number
        readonly finalized: number
    } | null
    readonly latestCompatibilityRejection: CompatibilityRejectionSummary | null
}

export interface BuildAdminMultiStatusInput {
    readonly runtime: MultiRuntimeStatus
    readonly authority: AdminMultiAuthorityStatus | null
    readonly latestCompatibilityRejection: CompatibilityRejectionSummary | null
}

export class CompatibilityRejectionStore {
    private readonly now: () => number
    private readonly ttlMs: number
    private latest: { summary: CompatibilityRejectionSummary; expiresAt: number } | null = null

    constructor(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
        this.now = options.now ?? Date.now
        this.ttlMs = options.ttlMs ?? DEFAULT_REJECTION_TTL_MS
        if (!Number.isSafeInteger(this.ttlMs)
            || this.ttlMs <= 0
            || this.ttlMs > MAX_REJECTION_TTL_MS) {
            throw new TypeError("compatibility rejection TTL is invalid")
        }
    }

    record(input: CompatibilityRejectionInput): void {
        const timestampMs = this.now()
        const summary = sanitizeRejection(input, new Date(timestampMs).toISOString())
        if (summary === null) return
        this.latest = Object.freeze({
            summary,
            expiresAt: timestampMs + this.ttlMs,
        })
    }

    get(): CompatibilityRejectionSummary | null {
        if (this.latest === null) return null
        if (this.latest.expiresAt <= this.now()) {
            this.latest = null
            return null
        }
        return this.latest.summary
    }
}

export const multiCompatibilityRejections = new CompatibilityRejectionStore()

export function recordMultiCompatibilityRejection(input: CompatibilityRejectionInput): void {
    multiCompatibilityRejections.record(input)
}

export function buildAdminMultiStatus(input: BuildAdminMultiStatusInput): AdminMultiStatus {
    const authority = sanitizeAuthority(input.authority)
    const rejection = input.latestCompatibilityRejection === null
        ? null
        : sanitizeRejection(
            input.latestCompatibilityRejection as unknown as CompatibilityRejectionInput,
            input.latestCompatibilityRejection.timestamp,
        )
    return Object.freeze({
        mode: input.runtime.mode,
        state: input.runtime.state,
        coordinator: Object.freeze({
            kind: input.runtime.coordinator.kind,
            available: input.runtime.coordinator.available === true,
        }),
        hub: input.runtime.hub === null ? null : Object.freeze({
            available: input.runtime.hub.available === true,
            endpoint: sanitizeEndpoint(input.runtime.hub.endpoint),
        }),
        tcp: Object.freeze({
            available: input.runtime.tcp.available === true,
            endpoint: sanitizeEndpoint(input.runtime.tcp.endpoint),
        }),
        activeRooms: authority?.activeRooms ?? null,
        battleFacts: authority === null ? null : Object.freeze({
            active: authority.activeBattleFacts,
            finalized: authority.finalizedBattleFacts,
        }),
        latestCompatibilityRejection: rejection,
    })
}

function sanitizeAuthority(value: AdminMultiAuthorityStatus | null): AdminMultiAuthorityStatus | null {
    if (value === null) return null
    const counts = [value.activeRooms, value.activeBattleFacts, value.finalizedBattleFacts]
    if (!counts.every(count => Number.isSafeInteger(count) && count >= 0)) return null
    return Object.freeze({
        activeRooms: value.activeRooms,
        activeBattleFacts: value.activeBattleFacts,
        finalizedBattleFacts: value.finalizedBattleFacts,
    })
}

function sanitizeRejection(
    input: CompatibilityRejectionInput,
    timestamp: string,
): CompatibilityRejectionSummary | null {
    if (!isRecord(input) || input.code !== "INCOMPATIBLE_ROOM") return null
    const parsedTimestamp = new Date(timestamp)
    if (!Number.isFinite(parsedTimestamp.getTime())) return null
    const differences: CompatibilityRejectionDifference[] = []
    for (const candidate of input.differences ?? []) {
        if (differences.length >= MAX_DIFFERENCES) break
        if (!isRecord(candidate)) continue
        const field = candidate.field
        const required = candidate.required ?? candidate.host
        const received = candidate.received ?? candidate.guest
        if (typeof field !== "string" || !COMPATIBILITY_FIELDS.has(field)) continue
        const difference: {
            field: string
            different: true
            required?: string
            received?: string
        } = {
            field,
            different: true,
        }
        if (VERSION_VALUE_FIELDS.has(field)) {
            const safeRequired = diagnosticVersionValue(required)
            const safeReceived = diagnosticVersionValue(received)
            if (safeRequired !== null && safeReceived !== null) {
                difference.required = safeRequired
                difference.received = safeReceived
            }
        }
        differences.push(Object.freeze(difference))
    }
    return Object.freeze({
        code: "INCOMPATIBLE_ROOM",
        differences: Object.freeze(differences),
        timestamp: parsedTimestamp.toISOString(),
    })
}

function diagnosticVersionValue(value: unknown): string | null {
    return typeof value === "string"
        && value.length <= MAX_DIAGNOSTIC_VALUE_LENGTH
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
        && !SENSITIVE_VALUE_PATTERN.test(value)
        && !HASH_LIKE_VALUE_PATTERN.test(value)
        ? value
        : null
}

function sanitizeEndpoint(value: string | null): string | null {
    if (value === null || value.length > 256) return null
    if (/^https?:\/\//.test(value)) {
        try {
            const url = new URL(value)
            if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
                return null
            }
            return url.href
        } catch {
            return null
        }
    }
    return /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{1,5}$/.test(value)
        ? value
        : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}
