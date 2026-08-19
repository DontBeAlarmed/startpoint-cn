import type {
    MultiRuntimeTuningConfig,
    RuntimeNetworkServiceConfig,
} from "../../runtime/config"
import type { AdmissionProvider } from "../admission/registry"
import { EMBEDDED_NODE_SESSION_ID } from "../coordinator/embedded"
import type { SessionServerOptions } from "../tcp/server"

export interface SessionOptionsHostServices {
    readonly admissionRegistry: AdmissionProvider
    readonly nodeSessions: {
        isValid(nodeSessionId: string): boolean
    }
}

export function buildSessionServerOptions(
    config: RuntimeNetworkServiceConfig,
    onFatalError: (error: unknown) => void,
    hostServices?: SessionOptionsHostServices,
    tuning?: MultiRuntimeTuningConfig,
): SessionServerOptions {
    return {
        ...config,
        transportTuning: tuning?.transport,
        battleTuning: tuning?.battle,
        roomCleanup: tuning?.roomCleanup,
        npcRecruitment: tuning?.npcRecruitment,
        admissionProvider: hostServices?.admissionRegistry,
        validateNodeSession: hostServices
            ? nodeSessionId => nodeSessionId === EMBEDDED_NODE_SESSION_ID
                || hostServices.nodeSessions.isValid(nodeSessionId)
            : undefined,
        onFatalError: () => onFatalError(new Error("session server unavailable")),
    }
}
