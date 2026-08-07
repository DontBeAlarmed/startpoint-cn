import type { AdminMultiStatus } from "../../lib/admin-multi-status"
import type {
    IssuedMultiHubCredential,
    MultiHubCredential,
} from "../hub/credential-store"
import type { MultiRuntimeAuthenticationDiagnostics } from "../runtime/service"
import {
    CLIENT_MULTI_MANAGEMENT_UNAVAILABLE,
    type MultiAuthenticationDiagnostics,
    type MultiAuthenticationCredentialHint,
    type MultiAuthenticationRejectionSummary,
    type MultiManagementDependencies,
    type MultiManagementServiceContract,
    type MultiProbeResult,
} from "./types"

const CREDENTIAL_ID_PATTERN = /^[0-9a-f]{32}$/
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/

function cloneAndFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) {
        return Object.freeze(value.map(item => cloneAndFreeze(item))) as T
    }

    const clone: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
        clone[key] = cloneAndFreeze(child)
    }
    return Object.freeze(clone) as T
}

export class MultiManagementError extends Error {
    readonly code: typeof CLIENT_MULTI_MANAGEMENT_UNAVAILABLE

    constructor(code: typeof CLIENT_MULTI_MANAGEMENT_UNAVAILABLE) {
        super(code)
        this.name = "MultiManagementError"
        this.code = code
    }
}

export class MultiManagementService implements MultiManagementServiceContract {
    private readonly dependencies: MultiManagementDependencies
    private readonly now: () => number

    constructor(dependencies: MultiManagementDependencies) {
        this.dependencies = dependencies
        this.now = dependencies.now ?? Date.now
    }

    createCredential(label: string): IssuedMultiHubCredential {
        this.assertHostManagementAvailable()
        return cloneAndFreeze(this.dependencies.credentials.create(label))
    }

    listCredentials(): readonly MultiHubCredential[] {
        this.assertHostManagementAvailable()
        return cloneAndFreeze(this.dependencies.credentials.list())
    }

    revokeCredential(credentialId: string): MultiHubCredential {
        this.assertHostManagementAvailable()
        return cloneAndFreeze(this.dependencies.credentials.revoke(credentialId))
    }

    async getStatus(): Promise<AdminMultiStatus> {
        return cloneAndFreeze(await this.dependencies.getStatus())
    }

    async probeHub(): Promise<MultiProbeResult> {
        const checkedAt = this.readCheckedAt()
        if (this.dependencies.mode !== "client") {
            return Object.freeze({ state: "not_applicable", checkedAt })
        }
        if (checkedAt === null) return Object.freeze({ state: "unavailable", checkedAt })

        try {
            const result = await this.dependencies.probe()
            if (!result.ok) return Object.freeze({ state: "unavailable", checkedAt })
            return Object.freeze({
                state: result.value.tcpAvailable === false ? "degraded" : "ready",
                checkedAt,
            })
        } catch {
            return Object.freeze({ state: "unavailable", checkedAt })
        }
    }

    getAuthenticationDiagnostics(): MultiAuthenticationDiagnostics {
        if (this.dependencies.mode === "embedded") {
            return cloneAndFreeze({
                mode: "embedded",
                clientState: null,
                rejections: [],
            })
        }

        const diagnostics = this.dependencies.getAuthenticationDiagnostics()
        if (this.dependencies.mode === "client") {
            return cloneAndFreeze({
                mode: "client",
                clientState: readClientAuthenticationState(diagnostics),
                rejections: [],
            })
        }

        const credentialHints = createCredentialHintMap(this.dependencies.credentials.list())
        return cloneAndFreeze({
            mode: "host",
            clientState: null,
            rejections: projectAuthenticationRejections(
                readHostRejections(diagnostics),
                credentialHints,
            ),
        })
    }

    private assertHostManagementAvailable(): void {
        if (this.dependencies.mode === "client") {
            throw new MultiManagementError(CLIENT_MULTI_MANAGEMENT_UNAVAILABLE)
        }
    }

    private readCheckedAt(): string | null {
        try {
            const milliseconds = this.now()
            if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return null
            const date = new Date(milliseconds)
            return Number.isFinite(date.getTime()) ? date.toISOString() : null
        } catch {
            return null
        }
    }
}

function readClientAuthenticationState(
    diagnostics: MultiRuntimeAuthenticationDiagnostics,
): "authentication_rejected" | null {
    try {
        return diagnostics !== null
            && typeof diagnostics === "object"
            && diagnostics.clientState === "authentication_rejected"
            ? "authentication_rejected"
            : null
    } catch {
        return null
    }
}

function readHostRejections(
    diagnostics: MultiRuntimeAuthenticationDiagnostics,
): readonly unknown[] {
    try {
        return diagnostics !== null
            && typeof diagnostics === "object"
            && Array.isArray(diagnostics.hostRejections)
            ? diagnostics.hostRejections
            : []
    } catch {
        return []
    }
}

function createCredentialHintMap(values: unknown): Map<string, MultiAuthenticationCredentialHint> {
    const hints = new Map<string, MultiAuthenticationCredentialHint>()
    let candidates: readonly unknown[]
    try {
        if (!Array.isArray(values)) return hints
        candidates = values
    } catch {
        return hints
    }

    let length: number
    try {
        length = candidates.length
    } catch {
        return hints
    }
    for (let index = 0; index < length; index += 1) {
        try {
            const candidate = candidates[index]
            if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
                continue
            }
            const credentialId = (candidate as { credentialId?: unknown }).credentialId
            const label = (candidate as { label?: unknown }).label
            if (typeof credentialId !== "string"
                || !CREDENTIAL_ID_PATTERN.test(credentialId)
                || typeof label !== "string") {
                continue
            }
            hints.set(credentialId, { label, shortId: credentialId.slice(0, 8) })
        } catch {
            // A malformed provider value is not allowed across the public boundary.
        }
    }
    return hints
}

function projectAuthenticationRejections(
    events: readonly unknown[],
    credentialHints: ReadonlyMap<string, MultiAuthenticationCredentialHint>,
): MultiAuthenticationDiagnostics["rejections"] {
    const projected: MultiAuthenticationRejectionSummary[] = []
    let length: number
    try {
        length = events.length
    } catch {
        return projected
    }
    for (let index = 0; index < length; index += 1) {
        try {
            const summary = projectAuthenticationRejection(events[index], credentialHints)
            if (summary !== null) projected.push(summary)
        } catch {
            // A malformed event collection is not allowed across the public boundary.
        }
    }
    return projected
}

function projectAuthenticationRejection(
    event: unknown,
    credentialHints: ReadonlyMap<string, MultiAuthenticationCredentialHint>,
): MultiAuthenticationDiagnostics["rejections"][number] | null {
    try {
        if (event === null || typeof event !== "object" || Array.isArray(event)) return null
        const timestamp = normalizeDiagnosticTimestamp(
            (event as { timestamp?: unknown }).timestamp,
        )
        const reason = (event as { reason?: unknown }).reason
        if (timestamp === null) return null
        if (reason !== "malformed" && reason !== "unknown" && reason !== "revoked") return null

        let credential: MultiAuthenticationCredentialHint | null = null
        if (reason === "revoked") {
            const credentialId = (event as { credentialId?: unknown }).credentialId
            if (typeof credentialId === "string" && CREDENTIAL_ID_PATTERN.test(credentialId)) {
                credential = credentialHints.get(credentialId) ?? null
            }
        }
        return {
            timestamp,
            reason,
            credential,
        }
    } catch {
        return null
    }
}

function normalizeDiagnosticTimestamp(value: unknown): string | null {
    if (typeof value !== "string") return null
    const match = ISO_TIMESTAMP_PATTERN.exec(value)
    if (match === null) return null

    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())
        || date.getUTCFullYear() !== year
        || date.getUTCMonth() + 1 !== month
        || date.getUTCDate() !== day
        || date.getUTCHours() !== hour
        || date.getUTCMinutes() !== minute
        || date.getUTCSeconds() !== second) {
        return null
    }
    return date.toISOString()
}

export { CLIENT_MULTI_MANAGEMENT_UNAVAILABLE }
