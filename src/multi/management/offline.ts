import {
    buildAdminMultiStatus,
} from "../../lib/admin-multi-status"
import {
    RuntimeConfigError,
    type RuntimeEnvironment,
} from "../../runtime/config"
import { unavailableMultiRuntimeStatus } from "../runtime/status"
import { createMultiManagementCredentialProvider } from "./credentials"
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
    const mode = managementMode(env.MULTI_MODE)
    return new MultiManagementService({
        mode,
        credentials: createMultiManagementCredentialProvider({ mode, env, projectRoot }),
        getStatus: () => buildAdminMultiStatus({
            runtime: unavailableMultiRuntimeStatus(),
            authority: null,
            latestCompatibilityRejection: null,
        }),
        probe: async () => ({ ok: false, error: "HUB_UNAVAILABLE" }),
        getAuthenticationDiagnostics: () => ({
            clientState: null,
            hostRejections: [],
        }),
    })
}
