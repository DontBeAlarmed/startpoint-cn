import type { CoordinatorResult, MultiCoordinatorOrigin } from "../coordinator/contracts"
import type { MultiHubControlStatus, MultiHubTcpEndpoint } from "../hub/control-routes"
import type { RuntimeTcpServiceConfig } from "../../runtime/config"
import { getRealNowMs } from "../../runtime/time/game-time"

export type MultiClientFallbackState = "remote" | "probing" | "local" | "degraded"

export const CLIENT_FALLBACK_TCP_CONFIG = Object.freeze({
    host: "127.0.0.1",
    port: 8003,
})

const DEFAULT_PROBE_COOLDOWN_MS = 1_000

export interface ClientFallbackDependencies {
    readonly now?: () => number
    readonly isRemoteAvailable?: () => boolean
    readonly tcpConfig?: RuntimeTcpServiceConfig
    readonly probeControlStatus: () => Promise<CoordinatorResult<MultiHubControlStatus>>
    readonly startTcp: (
        config: RuntimeTcpServiceConfig,
        onFatalError: () => void,
    ) => Promise<unknown>
    readonly stopTcp: () => Promise<unknown> | unknown
    readonly isTcpListening: () => boolean
    readonly probeCooldownMs?: number
}

export class ClientFallbackController {
    private readonly now: () => number
    private readonly probeCooldownMs: number
    private readonly tcpConfig: RuntimeTcpServiceConfig
    private state: MultiClientFallbackState = "remote"
    private lastProbeAt: number | null = null
    private probePromise: Promise<MultiCoordinatorOrigin> | null = null
    private tcpAttempted = false
    private tcpFailed = false

    constructor(private readonly dependencies: ClientFallbackDependencies) {
        this.now = dependencies.now ?? getRealNowMs
        this.probeCooldownMs = dependencies.probeCooldownMs ?? DEFAULT_PROBE_COOLDOWN_MS
        this.tcpConfig = Object.freeze({
            ...(dependencies.tcpConfig ?? CLIENT_FALLBACK_TCP_CONFIG),
        })
        if (!Number.isSafeInteger(this.probeCooldownMs) || this.probeCooldownMs < 0) {
            throw new TypeError("Client fallback probe cooldown must be a non-negative safe integer")
        }
    }

    getState(): MultiClientFallbackState {
        return this.state
    }

    async resolveNewRoomOrigin(): Promise<MultiCoordinatorOrigin> {
        if (this.shouldUseCachedRemote()) return "remote"
        if (this.shouldUseCachedLocal()) return "local"
        if (this.probePromise !== null) return this.probePromise

        let tracked!: Promise<MultiCoordinatorOrigin>
        tracked = this.probeAndSelect().finally(() => {
            if (this.probePromise === tracked) this.probePromise = null
        })
        this.probePromise = tracked
        return tracked
    }

    getTcpEndpoint(remoteEndpoint: MultiHubTcpEndpoint | null): MultiHubTcpEndpoint | null {
        if (this.state === "local" || this.state === "degraded") {
            return this.safeListening() ? Object.freeze({
                host: this.tcpConfig.publicHost ?? this.tcpConfig.host,
                port: this.tcpConfig.port,
            }) : null
        }
        return remoteEndpoint
    }

    isLocalTcpListening(): boolean {
        return this.safeListening()
    }

    async stop(): Promise<void> {
        if (!this.tcpAttempted) return
        await this.dependencies.stopTcp()
        this.tcpAttempted = false
        this.tcpFailed = false
        this.state = "remote"
        this.lastProbeAt = null
    }

    private async probeAndSelect(): Promise<MultiCoordinatorOrigin> {
        this.state = "probing"
        let result: CoordinatorResult<MultiHubControlStatus>
        try {
            result = await this.dependencies.probeControlStatus()
        } catch {
            result = { ok: false, error: "HUB_UNAVAILABLE" }
        }
        this.lastProbeAt = this.now()

        if (result.ok && result.value.tcpAvailable !== false) {
            this.state = "remote"
            return "remote"
        }

        await this.ensureLocalTcp()
        return "local"
    }

    private async ensureLocalTcp(): Promise<void> {
        if (this.safeListening()) {
            this.state = "local"
            return
        }

        this.tcpAttempted = true
        this.tcpFailed = false
        try {
            await this.dependencies.startTcp(
                this.tcpConfig,
                () => {
                    this.tcpFailed = true
                    this.state = "degraded"
                },
            )
        } catch {
            this.tcpFailed = true
            this.state = "degraded"
            return
        }
        this.state = this.safeListening() ? "local" : "degraded"
    }

    private shouldUseCachedRemote(): boolean {
        return this.state === "remote"
            && this.lastProbeAt !== null
            && (this.dependencies.isRemoteAvailable?.() ?? true)
            && this.now() - this.lastProbeAt < this.probeCooldownMs
    }

    private shouldUseCachedLocal(): boolean {
        return (this.state === "local" || this.state === "degraded")
            && this.lastProbeAt !== null
            && this.now() - this.lastProbeAt < this.probeCooldownMs
    }

    private safeListening(): boolean {
        try {
            return !this.tcpFailed && this.dependencies.isTcpListening()
        } catch {
            return false
        }
    }
}
