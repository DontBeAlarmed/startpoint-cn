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
        return this.dependencies.credentials.create(label)
    }

    listCredentials(): readonly MultiHubCredential[] {
        this.assertHostManagementAvailable()
        return this.dependencies.credentials.list()
    }

    revokeCredential(credentialId: string): MultiHubCredential {
        this.assertHostManagementAvailable()
        return this.dependencies.credentials.revoke(credentialId)
    }

    async getStatus() {
        return this.dependencies.getStatus()
    }

    async probeHub(): Promise<MultiProbeResult> {
        const checkedAt = new Date(this.now()).toISOString()
        if (this.dependencies.mode !== "client") {
            return Object.freeze({ state: "not_applicable", checkedAt })
        }

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
}

export { CLIENT_MULTI_MANAGEMENT_UNAVAILABLE }
