import type { AdminMultiStatus } from "../../lib/admin-multi-status"
import type {
    IssuedMultiHubCredential,
    MultiHubCredential,
} from "../hub/credential-store"
import {
    CLIENT_MULTI_MANAGEMENT_UNAVAILABLE,
    type MultiManagementDependencies,
    type MultiManagementServiceContract,
    type MultiProbeResult,
} from "./types"

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

export { CLIENT_MULTI_MANAGEMENT_UNAVAILABLE }
