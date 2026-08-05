export type MultiRuntimeMode = "embedded" | "host" | "client"
export type MultiRuntimeState = "ready" | "degraded" | "unavailable"

export interface MultiCoordinatorStatus {
    readonly kind: "local" | "remote"
    readonly available: boolean
}

export interface MultiEndpointStatus {
    readonly available: boolean
    readonly endpoint: string | null
}

export interface MultiRuntimeStatus {
    readonly mode: MultiRuntimeMode
    readonly state: MultiRuntimeState
    readonly coordinator: MultiCoordinatorStatus
    readonly hub: MultiEndpointStatus | null
    readonly tcp: MultiEndpointStatus
}

export function freezeMultiRuntimeStatus(status: MultiRuntimeStatus): MultiRuntimeStatus {
    return Object.freeze({
        ...status,
        coordinator: Object.freeze({ ...status.coordinator }),
        hub: status.hub === null ? null : Object.freeze({ ...status.hub }),
        tcp: Object.freeze({ ...status.tcp }),
    })
}

export function unavailableMultiRuntimeStatus(
    mode: MultiRuntimeMode = "embedded",
): MultiRuntimeStatus {
    const remote = mode === "client"
    return freezeMultiRuntimeStatus({
        mode,
        state: "unavailable",
        coordinator: { kind: remote ? "remote" : "local", available: false },
        hub: null,
        tcp: { available: false, endpoint: null },
    })
}
