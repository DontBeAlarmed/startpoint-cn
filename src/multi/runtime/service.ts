import * as http from "node:http"

import type { MultiRuntimeConfig, RuntimeNetworkServiceConfig } from "../../runtime/config"
import type { CoordinatorResult } from "../coordinator/contracts"
import type { MultiCoordinator } from "../coordinator/interface"
import {
    createEmbeddedMultiHttpContext,
    type MultiHttpContext,
} from "../http/context"
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

export interface MultiRuntimeFatal {
    readonly mode: MultiRuntimeConfig["mode"]
    readonly component: "tcp" | "hub"
}

export type MultiRuntimeFatalHandler = (failure: MultiRuntimeFatal) => void

export interface MultiRuntimeServiceDependencies {
    readonly startTcp: (
        config: RuntimeNetworkServiceConfig,
        onFatalError: FatalHandler,
    ) => Promise<unknown>
    readonly stopTcp: () => Promise<unknown> | unknown
    readonly isTcpListening: () => boolean
    readonly startHub: (
        config: RuntimeNetworkServiceConfig,
        onFatalError: FatalHandler,
    ) => Promise<unknown>
    readonly stopHub: () => Promise<unknown> | unknown
    readonly isHubListening: () => boolean
}

export interface MultiRuntimeService {
    start(config: MultiRuntimeConfig, onFatalError?: MultiRuntimeFatalHandler): Promise<void>
    stop(): Promise<void>
    getStatus(): MultiRuntimeStatus
    getHttpContext(): MultiHttpContext
}

function endpoint(host: string, port: number): string {
    return `${host.includes(":") ? `[${host}]` : host}:${port}`
}

function unavailableCoordinator(): MultiCoordinator {
    const unavailable = async <T>(): Promise<CoordinatorResult<T>> => ({
        ok: false,
        error: "HUB_UNAVAILABLE",
    })
    return Object.freeze({
        createRoom: unavailable,
        searchRoom: unavailable,
        prepareRoom: unavailable,
        selectRoom: unavailable,
        disbandRoom: unavailable,
        startBattle: unavailable,
        finalizeBattle: unavailable,
        getBattleStatus: unavailable,
        getRoomStatus: unavailable,
    })
}

function createUnavailableHttpContext(): MultiHttpContext {
    const embedded = createEmbeddedMultiHttpContext()
    const coordinator = unavailableCoordinator()
    return Object.freeze({
        ...embedded,
        coordinator,
        settlementVerifier: Object.freeze({
            getBattleStatus: coordinator.getBattleStatus,
        }),
    })
}

class HubControlListener {
    private server: http.Server | null = null

    isListening = (): boolean => this.server?.listening === true

    start = (
        config: RuntimeNetworkServiceConfig,
        onFatalError: FatalHandler,
    ): Promise<void> => new Promise((resolve, reject) => {
        if (this.server !== null) {
            reject(new Error("Hub control listener already started"))
            return
        }
        const server = http.createServer((_request, response) => {
            response.writeHead(404).end()
        })
        this.server = server
        let starting = true
        server.on("error", error => {
            if (starting) {
                this.server = null
                reject(error)
                return
            }
            onFatalError(error)
        })
        server.listen(config.port, config.host, () => {
            starting = false
            resolve()
        })
    })

    stop = async (): Promise<void> => {
        const server = this.server
        if (server === null) return
        if (!server.listening) {
            if (this.server === server) this.server = null
            return
        }
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve())
        })
        if (this.server === server) this.server = null
    }
}

function defaultDependencies(): MultiRuntimeServiceDependencies {
    const hub = new HubControlListener()
    return {
        startTcp: (config, onFatalError) => startSessionServer({
            ...config,
            onFatalError: () => onFatalError(new Error("session server unavailable")),
        }),
        stopTcp: stopSessionServer,
        isTcpListening: isSessionServerListening,
        startHub: hub.start,
        stopHub: hub.stop,
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
        this.context = config.mode === "client"
            ? createUnavailableHttpContext()
            : createEmbeddedMultiHttpContext()
        this.tcpFailed = false
        this.hubFailed = false
        this.fatalReported = false
        if (config.mode === "client") return

        this.tcpAttempted = true
        try {
            await this.dependencies.startTcp(
                config.tcp,
                () => this.handleFatal(generation, config, "tcp", onFatalError),
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
            return freezeMultiRuntimeStatus({
                mode: config.mode,
                state: "degraded",
                coordinator: { kind: "remote", available: false },
                hub: { available: false, endpoint: config.hubUrl.href },
                tcp: { available: false, endpoint: null },
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
            this.config = null
            this.context = null
            this.tcpFailed = false
            this.hubFailed = false
            this.fatalReported = false
        }
        if (failures.length > 0) throw failures[0]
    }
}

export function createMultiRuntimeService(
    dependencies: MultiRuntimeServiceDependencies = defaultDependencies(),
): MultiRuntimeService {
    return new Service(dependencies)
}
