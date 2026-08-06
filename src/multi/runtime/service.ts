import type { MultiRuntimeConfig, RuntimeNetworkServiceConfig } from "../../runtime/config"
import {
    buildAdminMultiStatus,
    multiCompatibilityRejections,
    recordMultiCompatibilityRejection,
    type AdminMultiAuthorityStatus,
    type AdminMultiStatus,
} from "../../lib/admin-multi-status"
import { AdmissionRegistry } from "../admission/registry"
import type { CoordinatorResult, NodeSessionId } from "../coordinator/contracts"
import {
    EMBEDDED_NODE_SESSION_ID,
    EmbeddedMultiCoordinator,
} from "../coordinator/embedded"
import { RemoteMultiCoordinator } from "../coordinator/remote"
import { HubClient } from "../hub/client"
import { CredentialReloader } from "../hub/credential-reloader"
import { IdempotencyCache } from "../hub/idempotency"
import { NodeSessionRegistry } from "../hub/node-sessions"
import {
    MultiHubControlServer,
} from "../hub/server"
import type { MultiHubControlRoutesOptions } from "../hub/control-routes"
import type { MultiHubControlStatus } from "../hub/control-routes"
import {
    createEmbeddedMultiHttpContext,
    type MultiHttpContext,
} from "../http/context"
import { listActiveRooms } from "../room/manager"
import { sessionManager } from "../state/SessionManager"
import {
    isSessionServerListening,
    startSessionServer,
    stopSessionServer,
} from "../tcp/server"
import {
    freezeMultiRuntimeStatus,
    type MultiRuntimeStatus,
    unavailableMultiRuntimeStatus,
} from "./status"

type FatalHandler = (error: unknown) => void
const REMOTE_PENDING_NODE_SESSION_ID = "remote-pending" as NodeSessionId

export interface MultiRuntimeFatal {
    readonly mode: MultiRuntimeConfig["mode"]
    readonly component: "tcp" | "hub"
}

export type MultiRuntimeFatalHandler = (failure: MultiRuntimeFatal) => void

interface MultiRuntimeHostServices extends MultiHubControlRoutesOptions {
    readonly admissionRegistry: AdmissionRegistry
}

export interface MultiRuntimeServiceDependencies {
    readonly startTcp: (
        config: RuntimeNetworkServiceConfig,
        onFatalError: FatalHandler,
        hostServices?: MultiRuntimeHostServices,
    ) => Promise<unknown>
    readonly stopTcp: () => Promise<unknown> | unknown
    readonly isTcpListening: () => boolean
    readonly startHub: (
        config: RuntimeNetworkServiceConfig,
        onFatalError: FatalHandler,
        hostServices?: MultiRuntimeHostServices,
    ) => Promise<unknown>
    readonly stopHub: () => Promise<unknown> | unknown
    readonly isHubListening: () => boolean
    readonly createRemoteCoordinator?: (
        config: Extract<MultiRuntimeConfig, { readonly mode: "client" }>,
    ) => RemoteMultiCoordinator
}

export interface MultiRuntimeService {
    start(config: MultiRuntimeConfig, onFatalError?: MultiRuntimeFatalHandler): Promise<void>
    stop(): Promise<void>
    getStatus(): MultiRuntimeStatus
    getAdminStatus(): Promise<AdminMultiStatus>
    probeControlStatus(): Promise<CoordinatorResult<MultiHubControlStatus>>
    getHttpContext(): MultiHttpContext
}

function endpoint(host: string, port: number): string {
    return `${host.includes(":") ? `[${host}]` : host}:${port}`
}

function createRemoteHttpContext(coordinator: RemoteMultiCoordinator): MultiHttpContext {
    const embedded = createEmbeddedMultiHttpContext({
        coordinator,
        coordinatorOrigin: "remote",
    })
    return Object.freeze({
        ...embedded,
        snapshotProvider: Object.freeze({
            ...embedded.snapshotProvider,
            getParticipant: (viewerId: number) => ({
                nodeSessionId: coordinator.getNodeSessionId()
                    ?? REMOTE_PENDING_NODE_SESSION_ID,
                viewerId,
            }),
        }),
        admissionIssuer: coordinator,
        tcpEndpoint: () => coordinator.getTcpEndpoint(),
    })
}

function defaultDependencies(): MultiRuntimeServiceDependencies {
    const hub = new MultiHubControlServer()
    return {
        startTcp: (config, onFatalError, hostServices) => startSessionServer({
            ...config,
            admissionProvider: hostServices?.admissionRegistry,
            validateNodeSession: hostServices
                ? nodeSessionId => nodeSessionId === EMBEDDED_NODE_SESSION_ID
                    || hostServices.nodeSessions.isValid(nodeSessionId)
                : undefined,
            onFatalError: () => onFatalError(new Error("session server unavailable")),
        }),
        stopTcp: stopSessionServer,
        isTcpListening: isSessionServerListening,
        startHub: (config, onFatalError, hostServices) => {
            if (!hostServices) return Promise.reject(new Error("Hub services unavailable"))
            return hub.start(config, hostServices, onFatalError)
        },
        stopHub: () => hub.stop(),
        isHubListening: hub.isListening,
    }
}

class Service implements MultiRuntimeService {
    private config: MultiRuntimeConfig | null = null
    private context: MultiHttpContext | null = null
    private tcpAttempted = false
    private hubAttempted = false
    private tcpFailed = false
    private hubFailed = false
    private generation = 0
    private fatalReported = false
    private startPromise: Promise<void> | null = null
    private stopPromise: Promise<void> | null = null
    private hostServices: MultiRuntimeHostServices | null = null
    private remoteCoordinator: RemoteMultiCoordinator | null = null

    constructor(private readonly dependencies: MultiRuntimeServiceDependencies) {}

    start(
        config: MultiRuntimeConfig,
        onFatalError?: MultiRuntimeFatalHandler,
    ): Promise<void> {
        if (this.startPromise !== null && this.stopPromise === null) return this.startPromise
        if (this.config !== null && this.stopPromise === null) {
            return Promise.reject(new Error("multiplayer runtime already started"))
        }
        const generation = ++this.generation
        const priorStop = this.stopPromise
        let tracked!: Promise<void>
        tracked = this.runStart(generation, config, onFatalError, priorStop).finally(() => {
            if (this.startPromise === tracked) this.startPromise = null
        })
        this.startPromise = tracked
        return tracked
    }

    stop(): Promise<void> {
        this.generation += 1
        if (this.stopPromise !== null) return this.stopPromise
        const pendingStart = this.startPromise
        let tracked!: Promise<void>
        tracked = this.runStop(pendingStart).finally(() => {
            if (this.stopPromise === tracked) this.stopPromise = null
        })
        this.stopPromise = tracked
        return tracked
    }

    private async runStart(
        generation: number,
        config: MultiRuntimeConfig,
        onFatalError: MultiRuntimeFatalHandler | undefined,
        priorStop: Promise<void> | null,
    ): Promise<void> {
        if (priorStop !== null) await priorStop
        if (generation !== this.generation) return
        this.config = config
        if (config.mode === "host") {
            this.remoteCoordinator = null
            const admissionRegistry = new AdmissionRegistry()
            const coordinator = new EmbeddedMultiCoordinator({
                allowRemoteParticipants: true,
                onCompatibilityRejection: recordMultiCompatibilityRejection,
            })
            const credentialReloader = new CredentialReloader({
                credentialsPath: config.credentialsPath,
            })
            const nodeSessions = new NodeSessionRegistry({
                isCredentialEnabled: credentialId => (
                    credentialReloader.isCredentialEnabled(credentialId)
                ),
                onInvalidated: nodeSessionId => {
                    admissionRegistry.removeByNodeSession(nodeSessionId)
                    coordinator.cleanupNodeSession(nodeSessionId)
                },
            })
            this.hostServices = Object.freeze({
                coordinator,
                credentialReloader,
                nodeSessions,
                admissionIssuer: admissionRegistry,
                admissionRegistry,
                idempotency: new IdempotencyCache(),
                getTcpEndpoint: () => (
                    !this.tcpFailed && this.safeListening(this.dependencies.isTcpListening)
                        ? Object.freeze({
                            host: config.tcp.publicHost ?? config.tcp.host,
                            port: config.tcp.port,
                        })
                        : null
                ),
                getDiagnostics: () => ({
                    ...localAuthorityStatus(),
                    latestCompatibilityRejection: multiCompatibilityRejections.get(),
                }),
            })
            credentialReloader.start()
            nodeSessions.start()
            this.context = createEmbeddedMultiHttpContext({
                coordinator,
                admissionRegistry,
            })
        } else {
            this.hostServices = null
            if (config.mode === "client") {
                this.remoteCoordinator = this.dependencies.createRemoteCoordinator?.(config)
                    ?? new RemoteMultiCoordinator(new HubClient({
                        hubUrl: config.hubUrl,
                        token: config.token,
                    }))
                this.context = createRemoteHttpContext(this.remoteCoordinator)
            } else {
                this.remoteCoordinator = null
                this.context = createEmbeddedMultiHttpContext({
                    coordinator: new EmbeddedMultiCoordinator({
                        onCompatibilityRejection: recordMultiCompatibilityRejection,
                    }),
                })
            }
        }
        this.tcpFailed = false
        this.hubFailed = false
        this.fatalReported = false
        if (config.mode === "client") return

        this.tcpAttempted = true
        try {
            await this.dependencies.startTcp(
                config.tcp,
                () => this.handleFatal(generation, config, "tcp", onFatalError),
                this.hostServices ?? undefined,
            )
        } catch (error) {
            this.tcpFailed = true
            if (generation !== this.generation) {
                await this.stopStartedComponents()
                return
            }
            if (config.mode === "embedded") throw error
        }
        if (generation !== this.generation) {
            await this.stopStartedComponents()
            return
        }
        if (config.mode !== "host") return

        this.hubAttempted = true
        try {
            await this.dependencies.startHub(
                config.hub,
                () => this.handleFatal(generation, config, "hub", onFatalError),
                this.hostServices ?? undefined,
            )
        } catch {
            this.hubFailed = true
        }
        if (generation !== this.generation) await this.stopStartedComponents()
    }

    getStatus(): MultiRuntimeStatus {
        const config = this.config
        if (config === null) return unavailableMultiRuntimeStatus()
        if (config.mode === "client") {
            const coordinatorAvailable = this.remoteCoordinator?.isAvailable() === true
            const tcp = this.remoteCoordinator?.getTcpEndpoint() ?? null
            return freezeMultiRuntimeStatus({
                mode: config.mode,
                state: coordinatorAvailable && tcp !== null ? "ready" : "degraded",
                coordinator: { kind: "remote", available: coordinatorAvailable },
                hub: { available: coordinatorAvailable, endpoint: config.hubUrl.href },
                tcp: {
                    available: tcp !== null,
                    endpoint: tcp === null ? null : endpoint(tcp.host, tcp.port),
                },
            })
        }

        const tcpAvailable = !this.tcpFailed && this.safeListening(this.dependencies.isTcpListening)
        const tcpEndpoint = endpoint(
            config.mode === "host" ? config.tcp.publicHost ?? config.tcp.host : config.tcp.host,
            config.tcp.port,
        )
        if (config.mode === "embedded") {
            return freezeMultiRuntimeStatus({
                mode: config.mode,
                state: tcpAvailable ? "ready" : "degraded",
                coordinator: { kind: "local", available: true },
                hub: null,
                tcp: { available: tcpAvailable, endpoint: tcpEndpoint },
            })
        }

        const hubAvailable = !this.hubFailed && this.safeListening(this.dependencies.isHubListening)
        return freezeMultiRuntimeStatus({
            mode: config.mode,
            state: tcpAvailable && hubAvailable ? "ready" : "degraded",
            coordinator: { kind: "local", available: true },
            hub: {
                available: hubAvailable,
                endpoint: `http://${endpoint(config.hub.host, config.hub.port)}`,
            },
            tcp: { available: tcpAvailable, endpoint: tcpEndpoint },
        })
    }

    async getAdminStatus(): Promise<AdminMultiStatus> {
        const generation = this.generation
        const config = this.config
        const context = this.context
        const remoteCoordinator = this.remoteCoordinator
        if (config?.mode !== "client" || remoteCoordinator === null) {
            return this.buildCurrentAdminStatus()
        }

        let controlStatus: MultiHubControlStatus | null = null
        try {
            controlStatus = await remoteCoordinator.getExistingSessionControlStatus()
        } catch {
            // Diagnostics are observational; a failed sample must not affect runtime state.
        }
        if (generation !== this.generation
            || config !== this.config
            || context !== this.context
            || remoteCoordinator !== this.remoteCoordinator) {
            return this.buildCurrentAdminStatus()
        }
        const authority = authorityFromControlStatus(controlStatus)
        const latestCompatibilityRejection = controlStatus?.latestCompatibilityRejection
            ?? multiCompatibilityRejections.get()
        return buildAdminMultiStatus({
            runtime: this.getStatus(),
            authority,
            latestCompatibilityRejection,
        })
    }

    private buildCurrentAdminStatus(): AdminMultiStatus {
        const runtime = this.getStatus()
        const authority = this.config !== null
            && this.config.mode !== "client"
            && runtime.coordinator.available
            ? localAuthorityStatus()
            : null
        return buildAdminMultiStatus({
            runtime,
            authority,
            latestCompatibilityRejection: multiCompatibilityRejections.get(),
        })
    }

    async probeControlStatus(): Promise<CoordinatorResult<MultiHubControlStatus>> {
        const generation = this.generation
        const config = this.config
        const remoteCoordinator = this.remoteCoordinator
        if (config?.mode !== "client" || remoteCoordinator === null) {
            return Object.freeze({ ok: false, error: "HUB_UNAVAILABLE" })
        }

        try {
            const result = await remoteCoordinator.getControlStatus()
            if (generation !== this.generation
                || config !== this.config
                || remoteCoordinator !== this.remoteCoordinator) {
                return Object.freeze({ ok: false, error: "HUB_UNAVAILABLE" })
            }
            return result
        } catch {
            return Object.freeze({ ok: false, error: "HUB_UNAVAILABLE" })
        }
    }

    getHttpContext(): MultiHttpContext {
        if (this.context === null) throw new Error("multiplayer runtime is not initialized")
        return this.context
    }

    private safeListening(check: () => boolean): boolean {
        try {
            return check()
        } catch {
            return false
        }
    }

    private handleFatal(
        generation: number,
        config: MultiRuntimeConfig,
        component: MultiRuntimeFatal["component"],
        onFatalError?: MultiRuntimeFatalHandler,
    ): void {
        if (generation !== this.generation || this.config !== config) return
        if (component === "tcp") this.tcpFailed = true
        else this.hubFailed = true
        if (this.fatalReported) return
        this.fatalReported = true
        onFatalError?.(Object.freeze({ mode: config.mode, component }))
    }

    private async runStop(pendingStart: Promise<void> | null): Promise<void> {
        if (pendingStart !== null) {
            try {
                await pendingStart
            } catch {
                // Startup errors are reported to the startup caller; stop still retries cleanup.
            }
        }
        await this.stopStartedComponents()
    }

    private async stopStartedComponents(): Promise<void> {
        const failures: unknown[] = []
        if (this.hubAttempted) {
            try {
                await this.dependencies.stopHub()
                this.hubAttempted = false
            } catch (error) {
                failures.push(error)
            }
        }
        if (this.tcpAttempted) {
            try {
                await this.dependencies.stopTcp()
                this.tcpAttempted = false
            } catch (error) {
                failures.push(error)
            }
        }
        if (!this.hubAttempted && !this.tcpAttempted) {
            this.hostServices?.credentialReloader.stop()
            this.hostServices?.nodeSessions.stop()
            this.hostServices?.nodeSessions.clear()
            this.hostServices = null
            this.remoteCoordinator = null
            this.config = null
            this.context = null
            this.tcpFailed = false
            this.hubFailed = false
            this.fatalReported = false
        }
        if (failures.length > 0) throw failures[0]
    }
}

function localAuthorityStatus(): AdminMultiAuthorityStatus {
    const facts = sessionManager.getBattleFactCounts()
    return Object.freeze({
        activeRooms: listActiveRooms().length,
        activeBattleFacts: facts.active,
        finalizedBattleFacts: facts.finalized,
    })
}

function authorityFromControlStatus(
    status: MultiHubControlStatus | null,
): AdminMultiAuthorityStatus | null {
    if (status === null
        || status.activeRooms === undefined
        || status.activeBattleFacts === undefined
        || status.finalizedBattleFacts === undefined
        || !Object.prototype.hasOwnProperty.call(status, "latestCompatibilityRejection")) return null
    return Object.freeze({
        activeRooms: status.activeRooms,
        activeBattleFacts: status.activeBattleFacts,
        finalizedBattleFacts: status.finalizedBattleFacts,
    })
}

export function createMultiRuntimeService(
    dependencies: MultiRuntimeServiceDependencies = defaultDependencies(),
): MultiRuntimeService {
    return new Service(dependencies)
}
