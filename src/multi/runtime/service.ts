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
    start(config: MultiRuntimeConfig): Promise<void>
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
        this.server = null
        if (server === null || !server.listening) return
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve())
        })
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

    constructor(private readonly dependencies: MultiRuntimeServiceDependencies) {}

    async start(config: MultiRuntimeConfig): Promise<void> {
        this.config = config
        this.context = config.mode === "client"
            ? createUnavailableHttpContext()
            : createEmbeddedMultiHttpContext()
        this.tcpFailed = false
        this.hubFailed = false
        if (config.mode === "client") return

        this.tcpAttempted = true
        try {
            await this.dependencies.startTcp(config.tcp, () => { this.tcpFailed = true })
        } catch (error) {
            this.tcpFailed = true
            if (config.mode === "embedded") throw error
        }
        if (config.mode !== "host") return

        this.hubAttempted = true
        try {
            await this.dependencies.startHub(config.hub, () => { this.hubFailed = true })
        } catch {
            this.hubFailed = true
        }
    }

    async stop(): Promise<void> {
        const operations: Promise<unknown>[] = []
        if (this.hubAttempted) operations.push(Promise.resolve().then(() => this.dependencies.stopHub()))
        if (this.tcpAttempted) operations.push(Promise.resolve().then(() => this.dependencies.stopTcp()))
        const results = await Promise.allSettled(operations)
        this.hubAttempted = false
        this.tcpAttempted = false
        this.config = null
        this.context = null
        const failure = results.find(result => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
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
}

export function createMultiRuntimeService(
    dependencies: MultiRuntimeServiceDependencies = defaultDependencies(),
): MultiRuntimeService {
    return new Service(dependencies)
}
