import {
    buildAdminMultiStatus,
} from "../../lib/admin-multi-status"
import {
    resolveMultiHubCredentialsPath,
    RuntimeConfigError,
    type RuntimeEnvironment,
} from "../../runtime/config"
import { MultiHubCredentialStore } from "../hub/credential-store"
import { unavailableMultiRuntimeStatus } from "../runtime/status"
import { MultiManagementService } from "./service"
import type { MultiManagementMode } from "./types"

export interface OfflineMultiManagementOptions {
    readonly projectRoot: string
    readonly env?: RuntimeEnvironment
}

function managementMode(value: string | undefined): MultiManagementMode {
    const mode = value ?? "embedded"
    if (mode === "embedded" || mode === "host" || mode === "client") return mode
    throw new RuntimeConfigError()
}

export function createOfflineMultiManagementService({
    projectRoot,
    env = process.env,
}: OfflineMultiManagementOptions): MultiManagementService {
    return new MultiManagementService({
        mode: managementMode(env.MULTI_MODE),
        credentials: new MultiHubCredentialStore({
            credentialsPath: resolveMultiHubCredentialsPath(env, projectRoot),
        }),
        getStatus: () => buildAdminMultiStatus({
            runtime: unavailableMultiRuntimeStatus(),
            authority: null,
            latestCompatibilityRejection: null,
        }),
        probe: async () => ({ ok: false, error: "HUB_UNAVAILABLE" }),
    })
}
