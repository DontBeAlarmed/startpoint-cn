import type { CompatibilityDifference } from "../multi/compatibility"
import type { MultiRuntimeStatus } from "../multi/runtime/status"
import { sanitizeDiagnosticVersion } from "./diagnostic-version"
import { getRealNowMs } from "../runtime/time/game-time"

const MAX_REJECTION_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_REJECTION_TTL_MS = 60 * 60 * 1000
const MAX_DIFFERENCES = 6
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

export interface AdminMultiLifecycleStatus {
    readonly closingRooms: number
    readonly closingOldestAgeMs: number
    readonly sweptClosing: number
    readonly lastSweptClosingAtMs: number | null
    readonly forcedDismissCloses: number
    readonly lastForcedClose: {
        readonly roomNumber: string
        readonly ageMs: number
        readonly atMs: number
    } | null
    readonly drift: AdminLifecycleDriftStatus | null
    readonly rejections: AdminMultiLifecycleRejections | null
}

export interface AdminLifecycleDriftSample {
    readonly roomNumber: string
    readonly atMs: number
    readonly detail: string
}

export interface AdminLifecycleDriftInvariant {
    readonly current: number
    readonly total: number
    readonly lastAtMs: number | null
    readonly samples: readonly AdminLifecycleDriftSample[]
}

export interface AdminLifecycleDriftStatus {
    readonly checkedAtMs: number
    readonly roomWithoutKernel: AdminLifecycleDriftInvariant
    readonly kernelWithoutRoomActive: AdminLifecycleDriftInvariant
    readonly kernelClosingOrphans: AdminLifecycleDriftInvariant
    readonly memberNotInKernel: AdminLifecycleDriftInvariant
    readonly memberNotInKernelNpcRooms: AdminLifecycleDriftInvariant
    readonly viewerMultipleRoomClients: AdminLifecycleDriftInvariant
    readonly closingPastDeadline: AdminLifecycleDriftInvariant
}

export interface AdminMultiLifecycleRejections {
    readonly total: number
    readonly byReason: Readonly<Record<string, number>>
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
    readonly lifecycle: AdminMultiLifecycleStatus | null
    readonly latestCompatibilityRejection: CompatibilityRejectionSummary | null
}

export interface BuildAdminMultiStatusInput {
    readonly runtime: MultiRuntimeStatus
    readonly authority: AdminMultiAuthorityStatus | null
    readonly latestCompatibilityRejection: CompatibilityRejectionSummary | null
    readonly lifecycle?: AdminMultiLifecycleStatus | null
}

export class CompatibilityRejectionStore {
    private readonly now: () => number
    private readonly ttlMs: number
    private latest: { summary: CompatibilityRejectionSummary; expiresAt: number } | null = null

    constructor(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
        this.now = options.now ?? getRealNowMs
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
        lifecycle: sanitizeLifecycle(input.lifecycle ?? null),
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

function sanitizeLifecycle(value: AdminMultiLifecycleStatus | null): AdminMultiLifecycleStatus | null {
    if (value === null) return null
    const counts = [
        value.closingRooms,
        value.closingOldestAgeMs,
        value.sweptClosing,
        value.forcedDismissCloses,
    ]
    if (!counts.every(count => Number.isSafeInteger(count) && count >= 0)) return null
    const lastForcedClose = value.lastForcedClose
    const safeLastForcedClose = lastForcedClose !== null
        && /^\d{6}$/.test(lastForcedClose.roomNumber)
        && Number.isSafeInteger(lastForcedClose.ageMs)
        && lastForcedClose.ageMs >= 0
        && Number.isSafeInteger(lastForcedClose.atMs)
        && lastForcedClose.atMs >= 0
        ? Object.freeze({
            roomNumber: lastForcedClose.roomNumber,
            ageMs: lastForcedClose.ageMs,
            atMs: lastForcedClose.atMs,
        })
        : null
    const lastSweptClosingAtMs = value.lastSweptClosingAtMs === null
        || (Number.isSafeInteger(value.lastSweptClosingAtMs) && value.lastSweptClosingAtMs >= 0)
        ? value.lastSweptClosingAtMs
        : null
    return Object.freeze({
        closingRooms: value.closingRooms,
        closingOldestAgeMs: value.closingOldestAgeMs,
        sweptClosing: value.sweptClosing,
        lastSweptClosingAtMs,
        forcedDismissCloses: value.forcedDismissCloses,
        lastForcedClose: safeLastForcedClose,
        drift: sanitizeLifecycleDrift((value as { readonly drift?: unknown }).drift ?? null),
        rejections: sanitizeLifecycleRejections(
            (value as { readonly rejections?: unknown }).rejections ?? null,
        ),
    })
}

const LIFECYCLE_DRIFT_INVARIANT_KEYS = [
    "roomWithoutKernel",
    "kernelWithoutRoomActive",
    "kernelClosingOrphans",
    "memberNotInKernel",
    "memberNotInKernelNpcRooms",
    "viewerMultipleRoomClients",
    "closingPastDeadline",
] as const
const MAX_DRIFT_SAMPLES = 8
const MAX_DRIFT_DETAIL_LENGTH = 120
const DRIFT_IDENTITY_PATTERN = /viewer:|session:|token|device/i
const MAX_REJECTION_REASON_ENTRIES = 32
const REJECTION_REASON_KEY_PATTERN = /^[\w.-]{1,64}$/

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function sanitizeLifecycleDrift(value: unknown): AdminLifecycleDriftStatus | null {
    if (!isRecord(value)) return null
    if (!isNonNegativeSafeInteger(value.checkedAtMs)) return null
    const invariants: Partial<Record<(typeof LIFECYCLE_DRIFT_INVARIANT_KEYS)[number], AdminLifecycleDriftInvariant>> = {}
    for (const key of LIFECYCLE_DRIFT_INVARIANT_KEYS) {
        const invariant = sanitizeDriftInvariant(value[key])
        if (invariant === null) return null
        invariants[key] = invariant
    }
    return Object.freeze({
        checkedAtMs: value.checkedAtMs,
        ...invariants,
    } as AdminLifecycleDriftStatus)
}

function sanitizeDriftInvariant(value: unknown): AdminLifecycleDriftInvariant | null {
    if (!isRecord(value)) return null
    if (!isNonNegativeSafeInteger(value.current) || !isNonNegativeSafeInteger(value.total)) return null
    const lastAtMs = value.lastAtMs === null || isNonNegativeSafeInteger(value.lastAtMs)
        ? value.lastAtMs as number | null
        : null
    if (value.lastAtMs !== null && lastAtMs === null) return null
    if (!Array.isArray(value.samples)) return null
    const samples: AdminLifecycleDriftSample[] = []
    for (const candidate of value.samples.slice(0, MAX_DRIFT_SAMPLES)) {
        if (!isRecord(candidate)) continue
        const roomNumber = candidate.roomNumber
        if (typeof roomNumber !== "string") continue
        if (roomNumber !== "" && !/^\d{6}$/.test(roomNumber)) continue
        if (!isNonNegativeSafeInteger(candidate.atMs)) continue
        if (typeof candidate.detail !== "string") continue
        if (candidate.detail.length > MAX_DRIFT_DETAIL_LENGTH) continue
        if (DRIFT_IDENTITY_PATTERN.test(candidate.detail)) continue
        samples.push(Object.freeze({
            roomNumber,
            atMs: candidate.atMs,
            detail: candidate.detail,
        }))
    }
    return Object.freeze({
        current: value.current,
        total: value.total,
        lastAtMs,
        samples: Object.freeze(samples),
    })
}

function sanitizeLifecycleRejections(value: unknown): AdminMultiLifecycleRejections | null {
    if (!isRecord(value)) return null
    if (!isNonNegativeSafeInteger(value.total)) return null
    if (!isRecord(value.byReason)) return null
    const entries = Object.entries(value.byReason)
    if (entries.length > MAX_REJECTION_REASON_ENTRIES) return null
    const byReason: Record<string, number> = {}
    for (const [reason, count] of entries) {
        if (!REJECTION_REASON_KEY_PATTERN.test(reason)) return null
        if (!isNonNegativeSafeInteger(count)) return null
        byReason[reason] = count
    }
    return Object.freeze({
        total: value.total,
        byReason: Object.freeze(byReason),
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
            const safeRequired = sanitizeDiagnosticVersion(required)
            const safeReceived = sanitizeDiagnosticVersion(received)
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
