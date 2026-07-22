import type { FastifyInstance } from "fastify"

import type { AssetMode } from "../content/cdn/asset-mode"

export type RuntimePhase = "starting" | "ready" | "stopping" | "failed" | "stopped"

export interface RuntimeHealthState {
    readonly phase: RuntimePhase
    readonly bundleVersion: string
    readonly nodeVersion: string
    readonly database: {
        readonly ready: boolean
        readonly schema: number | null
    }
    readonly contentInitialized: boolean
    readonly httpListening: boolean
    readonly tcpListening: boolean
    readonly adminAvailable: boolean
    readonly assetMode: AssetMode
}

export interface RuntimeHealthBody {
    readonly contractVersion: 1
    readonly status: RuntimePhase
    readonly serverBundle: {
        readonly version: string
        readonly bundleId: null
    }
    readonly runtime: {
        readonly api: 1
        readonly node: string
    }
    readonly database: RuntimeHealthState["database"]
    readonly services: {
        readonly http: boolean
        readonly tcp: boolean
    }
    readonly admin: {
        readonly available: boolean
    }
    readonly assets: {
        readonly mode: AssetMode
        readonly status: "ready" | "not-ready" | "unknown"
        readonly minClientVersion: "1.4.54"
        readonly observedClientVersion: null
    }
}

export interface RuntimeHealthSnapshot {
    readonly statusCode: 200 | 503
    readonly body: RuntimeHealthBody
}

export function createRuntimeHealthSnapshot(state: RuntimeHealthState): RuntimeHealthSnapshot {
    const ready = state.phase === "ready"
        && state.database.ready
        && state.database.schema !== null
        && state.contentInitialized
        && state.httpListening
        && state.tcpListening
    const status = state.phase === "ready" && !ready ? "failed" : state.phase
    const assetStatus = state.assetMode === "client-owned"
        ? "unknown"
        : state.contentInitialized ? "ready" : "not-ready"

    return Object.freeze({
        statusCode: ready ? 200 : 503,
        body: Object.freeze({
            contractVersion: 1,
            status,
            serverBundle: Object.freeze({ version: state.bundleVersion, bundleId: null }),
            runtime: Object.freeze({ api: 1, node: state.nodeVersion }),
            database: Object.freeze({ ...state.database }),
            services: Object.freeze({
                http: state.httpListening,
                tcp: state.tcpListening,
            }),
            admin: Object.freeze({ available: state.adminAvailable }),
            assets: Object.freeze({
                mode: state.assetMode,
                status: assetStatus,
                minClientVersion: "1.4.54",
                observedClientVersion: null,
            }),
        }),
    })
}

export function registerRuntimeHealthRoute(
    fastify: FastifyInstance,
    getSnapshot: () => RuntimeHealthSnapshot,
): void {
    fastify.get("/healthz", (_request, reply) => {
        const snapshot = getSnapshot()
        reply.type("application/json").status(snapshot.statusCode).send(snapshot.body)
    })
}
