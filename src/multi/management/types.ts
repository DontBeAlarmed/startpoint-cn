import type { AdminMultiStatus } from "../../lib/admin-multi-status"
import type { CoordinatorResult } from "../coordinator/contracts"
import type { MultiHubControlStatus } from "../hub/control-routes"
import type {
    IssuedMultiHubCredential,
    MultiHubCredential,
    MultiHubCredentialStore,
} from "../hub/credential-store"

export type MultiManagementMode = "embedded" | "host" | "client"

export type MultiProbeState =
    | "ready"
    | "degraded"
    | "unavailable"
    | "not_applicable"

export const CLIENT_MULTI_MANAGEMENT_UNAVAILABLE =
    "CLIENT_MULTI_MANAGEMENT_UNAVAILABLE" as const

export type MultiManagementErrorCode = typeof CLIENT_MULTI_MANAGEMENT_UNAVAILABLE

export interface MultiProbeResult {
    readonly state: MultiProbeState
    readonly checkedAt: string | null
}

export interface MultiManagementDependencies {
    readonly mode: MultiManagementMode
    readonly credentials: Pick<MultiHubCredentialStore, "create" | "list" | "revoke">
    readonly getStatus: () => Promise<AdminMultiStatus> | AdminMultiStatus
    readonly probe: () => Promise<CoordinatorResult<MultiHubControlStatus>>
        | CoordinatorResult<MultiHubControlStatus>
    readonly now?: () => number
}

export interface MultiManagementServiceContract {
    createCredential(label: string): IssuedMultiHubCredential
    listCredentials(): readonly MultiHubCredential[]
    revokeCredential(credentialId: string): MultiHubCredential
    getStatus(): Promise<AdminMultiStatus>
    probeHub(): Promise<MultiProbeResult>
}
