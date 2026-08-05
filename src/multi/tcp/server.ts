// Multi battle TCP session server
// Protocol: JSON messages delimited by null byte (\0)
// Post-handshake messages use typepacker format with useEnumIndex=true:
//   [index, param1, param2, ...]

import * as net from "net"
import {
    handleHandshake as defaultHandleHandshake,
    HandshakeLifecycleGuard,
} from "./handshake"
import { handleBattleMessage } from "./battle"
import { sessionManager } from "../state/SessionManager"
import { startRoomCleanup, stopRoomCleanup } from "../room/manager"
import { startLobbyLifecycle, stopLobbyLifecycle } from "./lobby-lifecycle"
import {
    embeddedAdmissionRegistry,
    type AdmissionProvider,
} from "../admission/registry"

export const SESSION_PORT = parseInt(process.env.SESSION_PORT || "8003")
export const SESSION_HOST = process.env.SESSION_HOST || "127.0.0.1"
export const DEFAULT_SESSION_SHUTDOWN_TIMEOUT_MS = 5000
export const DEFAULT_SESSION_ADMISSION_PROVIDER: AdmissionProvider = embeddedAdmissionRegistry

export type SessionServerPhase = "stopped" | "starting" | "listening" | "stopping" | "failed"
export type SessionServerFailureStage = "startup" | "runtime" | "shutdown"

export interface SessionServerFailure {
    readonly stage: SessionServerFailureStage
    readonly code: string | null
}

export interface SessionServerStatus {
    readonly phase: SessionServerPhase
    readonly listening: boolean
    readonly activeSockets: number
    readonly pendingHandshakes: number
    readonly lastFailure: SessionServerFailure | null
}

export interface SessionServerOptions {
    host?: string
    port?: number
    createServer?: (connectionListener: (socket: net.Socket) => void) => net.Server
    handleHandshake?: (
        socket: net.Socket,
        data: any,
        lifecycle: HandshakeLifecycleGuard,
    ) => Promise<void>
    admissionProvider?: AdmissionProvider
    validateNodeSession?: (nodeSessionId: string) => boolean
    nodeSessionCheckIntervalMs?: number
    /** Maximum shutdown wait for this generation's handshakes before sockets are retired. */
    shutdownTimeoutMs?: number
    onFatalError?: (failure: SessionServerFailure) => void
}

interface ServerContext {
    readonly server: net.Server
    readonly generation: number
    readonly shutdownTimeoutMs: number
    readonly onError: (error: Error) => void
    readonly onFatalError?: (failure: SessionServerFailure) => void
    readonly validateNodeSession?: (nodeSessionId: string) => boolean
    readonly nodeSessionCheckIntervalMs: number
    nodeSessionTimer: NodeJS.Timeout | null
    fatalStarted: boolean
    fatalSettled: boolean
    fatalTeardown: Promise<void> | null
}

interface StartAttempt {
    readonly context: ServerContext
    readonly promise: Promise<void>
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    settled: boolean
}

interface HandshakeRecord {
    readonly socket: net.Socket
    readonly generation: number
    promise: Promise<void>
    retired: boolean
}

let activeContext: ServerContext | null = null
let phase: SessionServerPhase = "stopped"
let generationSequence = 0
let startAttempt: StartAttempt | null = null
let stopPromise: Promise<void> | null = null
let lastFailure: SessionServerFailure | null = null
const stoppedPromise = Promise.resolve()
const acceptedSockets = new Set<net.Socket>()
const pendingHandshakes = new Set<HandshakeRecord>()
const socketHandshakes = new Map<net.Socket, HandshakeRecord>()
const LOGGABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
    "EACCES",
    "EADDRINUSE",
    "ECONNABORTED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "ERR_SERVER_NOT_RUNNING",
    "ETIMEDOUT",
])

function cleanupSession(socket: net.Socket): void {
    try {
        const lobby = require("./lobby") as {
            handleSocketDisconnect?: (candidate: net.Socket) => boolean
        }
        if (lobby.handleSocketDisconnect?.(socket)) return
        sessionManager.removeClientBySocket(socket)
    } catch (error) {
        console.error(`[TCP] session cleanup failed: code=${failureCode(error) ?? "UNKNOWN"}`)
    }
}

function cleanupAcceptedSocket(socket: net.Socket): void {
    if (!acceptedSockets.delete(socket)) return
    if (!socketHandshakes.has(socket)) cleanupSession(socket)
}

function hasValidNodeSession(context: ServerContext, socket: net.Socket): boolean {
    const validator = context.validateNodeSession
    if (!validator) return true
    const participant = sessionManager.getClientBySocket(socket)?.participant
    if (!participant) return true
    try {
        return validator(participant.nodeSessionId)
    } catch {
        return false
    }
}

function rejectInvalidNodeSession(context: ServerContext, socket: net.Socket): boolean {
    if (hasValidNodeSession(context, socket)) return false
    socket.destroy()
    return true
}

function startNodeSessionChecks(context: ServerContext): void {
    if (!context.validateNodeSession || context.nodeSessionTimer !== null) return
    context.nodeSessionTimer = setInterval(() => {
        if (activeContext !== context || phase !== "listening") return
        for (const socket of [...acceptedSockets]) rejectInvalidNodeSession(context, socket)
    }, context.nodeSessionCheckIntervalMs)
    context.nodeSessionTimer.unref()
}

function stopNodeSessionChecks(context: ServerContext): void {
    if (context.nodeSessionTimer === null) return
    clearInterval(context.nodeSessionTimer)
    context.nodeSessionTimer = null
}

function isAccepting(context: ServerContext, socket: net.Socket): boolean {
    return activeContext === context
        && phase === "listening"
        && acceptedSockets.has(socket)
        && !socket.destroyed
}

function trackHandshake(
    context: ServerContext,
    socket: net.Socket,
    data: any,
    handshakeHandler: NonNullable<SessionServerOptions["handleHandshake"]>,
): void {
    const lifecycle: HandshakeLifecycleGuard = Object.freeze({
        generation: context.generation,
        isAccepting: () => isAccepting(context, socket),
    })
    const record: HandshakeRecord = {
        socket,
        generation: context.generation,
        promise: stoppedPromise,
        retired: false,
    }
    let tracked: Promise<void>
    tracked = Promise.resolve()
        .then(() => handshakeHandler(socket, data, lifecycle))
        .then(() => {
            if (isAccepting(context, socket)) rejectInvalidNodeSession(context, socket)
        })
        .catch(error => {
            console.error(`[TCP] handshake failed: code=${failureCode(error) ?? "UNKNOWN"}`)
            socket.destroy()
        })
        .finally(() => {
            pendingHandshakes.delete(record)
            if (socketHandshakes.get(socket) === record) socketHandshakes.delete(socket)
            if (!acceptedSockets.has(socket) && !record.retired) cleanupSession(socket)
        })
    record.promise = tracked
    pendingHandshakes.add(record)
    socketHandshakes.set(socket, record)
}

function handleConnection(
    context: ServerContext,
    socket: net.Socket,
    handshakeHandler: NonNullable<SessionServerOptions["handleHandshake"]>,
): void {
    if (activeContext !== context || phase !== "listening") {
        socket.destroy()
        return
    }

    acceptedSockets.add(socket)
    console.log("[TCP] connection accepted")

    socket.setEncoding("utf8")
    let buffer = ""
    let handshakeDone = false
    let isBattleSocket = false

    socket.on("data", (chunk: string) => {
        if (!isAccepting(context, socket)) return

        buffer += chunk
        while (isAccepting(context, socket) && buffer.includes("\0")) {
            const index = buffer.indexOf("\0")
            const raw = buffer.substring(0, index)
            buffer = buffer.substring(index + 1)
            if (raw.trim().length === 0) continue

            try {
                const data = JSON.parse(raw)
                if (!handshakeDone && data.socklet) {
                    handshakeDone = true
                    isBattleSocket = data.socklet === "cooperation_battle"
                    trackHandshake(context, socket, data, handshakeHandler)
                } else if (handshakeDone) {
                    if (rejectInvalidNodeSession(context, socket)) break
                    if (isBattleSocket) {
                        handleBattleMessage(socket, data)
                    } else {
                        const lobby = require("./lobby")
                        lobby.handleMessage(socket, data)
                    }
                }
            } catch (error) {
                console.error(`[TCP] parse failed: code=${failureCode(error) ?? "UNKNOWN"}`)
            }
        }
    })

    socket.on("close", () => {
        console.log("[TCP] connection closed")
        cleanupAcceptedSocket(socket)
    })

    socket.on("error", error => {
        console.error(`[TCP] socket error: code=${failureCode(error) ?? "UNKNOWN"}`)
        cleanupAcceptedSocket(socket)
        socket.destroy()
    })
}

function destroyAcceptedSockets(): void {
    for (const socket of [...acceptedSockets]) {
        socket.destroy()
        cleanupAcceptedSocket(socket)
    }
}

function settleStart(context: ServerContext, error?: Error): void {
    const attempt = startAttempt
    if (!attempt || attempt.context !== context || attempt.settled) return
    attempt.settled = true
    startAttempt = null
    if (error) attempt.reject(error)
    else attempt.resolve()
}

function finalizeContext(context: ServerContext): void {
    stopNodeSessionChecks(context)
    context.server.off("error", context.onError)
    if (activeContext === context) activeContext = null
}

function failureCode(error: unknown): string | null {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return typeof code === "string" && LOGGABLE_FAILURE_CODES.has(code) ? code : null
}

function recordFailure(stage: SessionServerFailureStage, error: unknown): void {
    lastFailure = Object.freeze({ stage, code: failureCode(error) })
}

function handlePersistentServerError(context: ServerContext, error: Error): void {
    if (activeContext !== context) return
    if (context.fatalStarted) {
        console.error(`[TCP] server error during fatal teardown: code=${failureCode(error) ?? "UNKNOWN"}`)
        return
    }
    if (phase === "starting") {
        recordFailure("startup", error)
        settleStart(context, error)
        stopRoomCleanup()
        stopLobbyLifecycle()
        destroyAcceptedSockets()
        phase = "failed"
        if (!context.server.listening) {
            finalizeContext(context)
        } else {
            void closeServer(context).then(
                () => finalizeContext(context),
                closeError => {
                    console.error(`[TCP] failed to close after startup error: code=${failureCode(closeError) ?? "UNKNOWN"}`)
                    if (!context.server.listening) finalizeContext(context)
                },
            )
        }
        return
    }
    if (phase === "listening") {
        void beginFatalTeardown(context, error).catch(() => {
            // Application lifecycle observes the same rejection through stopSessionServer().
        })
        return
    }
    console.error(`[TCP] session server error: code=${failureCode(error) ?? "UNKNOWN"}`)
}

function closeServer(context: ServerContext): Promise<void> {
    const target = context.server
    return new Promise((resolve, reject) => {
        let settled = false
        const cleanup = (): void => {
            target.off("error", onCloseError)
        }
        const settle = (error?: Error): void => {
            if (settled) return
            settled = true
            cleanup()
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error)
            else resolve()
        }
        const onCloseError = (error: Error): void => settle(error)
        target.on("error", onCloseError)
        try {
            target.close(error => settle(error ?? undefined))
        } catch (error) {
            settle(error as Error)
        }
    })
}

function retireHandshake(record: HandshakeRecord): void {
    if (record.retired) return
    record.retired = true
    pendingHandshakes.delete(record)
    if (socketHandshakes.get(record.socket) === record) socketHandshakes.delete(record.socket)
    cleanupSession(record.socket)
}

async function waitForHandshakes(context: ServerContext): Promise<void> {
    const records = [...pendingHandshakes].filter(record => record.generation === context.generation)
    if (records.length === 0) return

    let resolveTimeout!: (result: "timeout") => void
    const timeoutPromise = new Promise<"timeout">(resolve => {
        resolveTimeout = resolve
    })
    const timeout = setTimeout(() => resolveTimeout("timeout"), context.shutdownTimeoutMs)
    timeout.unref()
    try {
        const result = await Promise.race([
            Promise.allSettled(records.map(record => record.promise)).then(() => "settled" as const),
            timeoutPromise,
        ])
        if (result === "timeout") {
            console.warn(`[TCP] handshake shutdown timed out: generation=${context.generation} pending=${records.length}`)
            for (const record of records) retireHandshake(record)
        }
    } finally {
        clearTimeout(timeout)
    }
}

function beginFatalTeardown(context: ServerContext, error: Error): Promise<void> {
    if (context.fatalTeardown) return context.fatalTeardown

    context.fatalStarted = true
    recordFailure("runtime", error)
    phase = "failed"
    console.error(`[TCP] fatal session server error: code=${failureCode(error) ?? "UNKNOWN"}`)
    stopRoomCleanup()
    stopLobbyLifecycle()
    destroyAcceptedSockets()

    const closePromise = closeServer(context)
    const operation = Promise.allSettled([
        waitForHandshakes(context),
        closePromise,
    ]).then(results => {
        const closeResult = results[1]
        if (closeResult.status === "rejected") {
            console.error(`[TCP] fatal teardown close failed: code=${failureCode(closeResult.reason) ?? "UNKNOWN"}`)
            if (!context.server.listening) finalizeContext(context)
            throw closeResult.reason
        }
        if (!context.server.listening) finalizeContext(context)
    })

    context.fatalTeardown = operation.finally(() => {
        context.fatalSettled = true
    })
    if (context.onFatalError && lastFailure?.stage === "runtime") {
        try {
            context.onFatalError(lastFailure)
        } catch {
            console.error("[TCP] application fatal callback failed")
        }
    }
    return context.fatalTeardown
}

export function getSessionServerStatus(): SessionServerStatus {
    return Object.freeze({
        phase,
        listening: phase === "listening" && activeContext?.server.listening === true,
        activeSockets: acceptedSockets.size,
        pendingHandshakes: pendingHandshakes.size,
        lastFailure,
    })
}

export function isSessionServerListening(): boolean {
    return getSessionServerStatus().listening
}

export function startSessionServer(options: SessionServerOptions = {}): Promise<void> {
    if (phase === "starting" && startAttempt) return startAttempt.promise
    if (phase === "listening") return stoppedPromise
    if (phase === "stopping") return Promise.reject(new Error("Session server is stopping"))
    if (activeContext) return Promise.reject(new Error("Session server must be stopped before restarting"))

    lastFailure = null
    phase = "starting"
    const createServer = options.createServer ?? net.createServer
    const handshakeHandler = options.handleHandshake ?? ((socket, data, lifecycle) => (
        defaultHandleHandshake(socket, data, lifecycle, {
            admissionProvider: options.admissionProvider ?? DEFAULT_SESSION_ADMISSION_PROVIDER,
        })
    ))
    const generation = ++generationSequence
    let context!: ServerContext
    let createdServer: net.Server
    try {
        createdServer = createServer(socket => handleConnection(context, socket, handshakeHandler))
    } catch (error) {
        recordFailure("startup", error)
        phase = "failed"
        return Promise.reject(error)
    }

    const onError = (error: Error): void => handlePersistentServerError(context, error)
    context = {
        server: createdServer,
        generation,
        shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SESSION_SHUTDOWN_TIMEOUT_MS,
        onError,
        onFatalError: options.onFatalError,
        validateNodeSession: options.validateNodeSession,
        nodeSessionCheckIntervalMs: options.nodeSessionCheckIntervalMs ?? 1_000,
        nodeSessionTimer: null,
        fatalStarted: false,
        fatalSettled: false,
        fatalTeardown: null,
    }
    activeContext = context
    createdServer.on("error", onError)

    let resolveStart!: () => void
    let rejectStart!: (error: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
        resolveStart = resolve
        rejectStart = reject
    })
    startAttempt = {
        context,
        promise,
        resolve: resolveStart,
        reject: rejectStart,
        settled: false,
    }

    try {
        createdServer.listen(options.port ?? SESSION_PORT, options.host ?? SESSION_HOST, () => {
            if (activeContext !== context || phase !== "starting") return
            try {
                startRoomCleanup()
                startLobbyLifecycle()
                startNodeSessionChecks(context)
            } catch (error) {
                recordFailure("startup", error)
                stopRoomCleanup()
                stopLobbyLifecycle()
                settleStart(context, error as Error)
                phase = "failed"
                void closeServer(context).then(
                    () => finalizeContext(context),
                    closeError => {
                        console.error(`[TCP] failed to close after lifecycle startup error: code=${failureCode(closeError) ?? "UNKNOWN"}`)
                        if (!context.server.listening) finalizeContext(context)
                    },
                )
                return
            }
            phase = "listening"
            settleStart(context)
            console.log("[TCP] session server listening")
        })
    } catch (error) {
        recordFailure("startup", error)
        settleStart(context, error as Error)
        phase = "failed"
        finalizeContext(context)
    }

    return promise
}

export function stopSessionServer(): Promise<void> {
    if (phase === "stopping" && stopPromise) return stopPromise
    const context = activeContext
    stopRoomCleanup()
    stopLobbyLifecycle()
    if (!context) {
        phase = "stopped"
        return stoppedPromise
    }
    if (context.fatalStarted && !context.fatalSettled && context.fatalTeardown) {
        return context.fatalTeardown
    }

    phase = "stopping"
    settleStart(context, new Error("Session server startup was stopped"))
    const closePromise = closeServer(context)
    destroyAcceptedSockets()

    const operation = Promise.allSettled([
        waitForHandshakes(context),
        closePromise,
    ]).then(results => {
        const closeResult = results[1]
        if (closeResult.status === "rejected") throw closeResult.reason
        finalizeContext(context)
        phase = "stopped"
    }).catch(error => {
        recordFailure("shutdown", error)
        if (!context.server.listening) finalizeContext(context)
        phase = "failed"
        throw error
    })

    let tracked: Promise<void>
    tracked = operation.then(
        () => {
            if (stopPromise === tracked) stopPromise = null
        },
        error => {
            if (stopPromise === tracked) stopPromise = null
            throw error
        },
    )
    stopPromise = tracked
    return tracked
}
