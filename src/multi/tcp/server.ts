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
import {
    startRoomCleanup,
    stopRoomCleanup,
    type RoomCleanupOptions,
} from "../room/manager"
import { startLobbyLifecycle, stopLobbyLifecycle } from "./lobby-lifecycle"
import {
    configureNpcRecruitmentTiming,
    configureReconnectGraceMs,
    resetNpcRecruitmentTiming,
    type NpcRecruitmentTiming,
} from "./lobby"
import {
    embeddedAdmissionRegistry,
    type AdmissionProvider,
} from "../admission/registry"
import { clearReliableSendState } from "./reliable-send"

export const SESSION_PORT = 8003
export const SESSION_HOST = "127.0.0.1"
export const DEFAULT_SESSION_SHUTDOWN_TIMEOUT_MS = 5000

function positiveEnvironmentInteger(name: string, fallback: number, minimum = 1): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10)
    return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

export const DEFAULT_SESSION_HANDSHAKE_TIMEOUT_MS = positiveEnvironmentInteger(
    "SESSION_HANDSHAKE_TIMEOUT_MS",
    15_000,
)
export const DEFAULT_SESSION_MAX_FRAME_BYTES = positiveEnvironmentInteger(
    "SESSION_MAX_FRAME_BYTES",
    256 * 1024,
    1024,
)
export const DEFAULT_SESSION_MAX_BUFFER_BYTES = positiveEnvironmentInteger(
    "SESSION_MAX_BUFFER_BYTES",
    1024 * 1024,
    DEFAULT_SESSION_MAX_FRAME_BYTES,
)
export const DEFAULT_SESSION_KEEPALIVE_INITIAL_DELAY_MS = positiveEnvironmentInteger(
    "SESSION_TCP_KEEPALIVE_MS",
    10_000,
)
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
    handshakeTimeoutMs?: number
    maxFrameBytes?: number
    maxBufferBytes?: number
    keepAliveInitialDelayMs?: number
    roomCleanup?: RoomCleanupOptions
    npcRecruitment?: NpcRecruitmentTiming
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
    readonly handshakeTimeoutMs: number
    readonly maxFrameBytes: number
    readonly maxBufferBytes: number
    readonly keepAliveInitialDelayMs: number
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
    clearReliableSendState(socket)
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
    try {
        const lobby = require("./lobby") as {
            handleInvalidNodeSession?: (candidate: net.Socket) => boolean
        }
        if (lobby.handleInvalidNodeSession?.(socket)) return true
    } catch (error) {
        console.error(`[TCP] invalid node session cleanup failed: code=${failureCode(error) ?? "UNKNOWN"}`)
    }
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
        && !socket.writableEnded
}

function trackHandshake(
    context: ServerContext,
    socket: net.Socket,
    data: any,
    handshakeHandler: NonNullable<SessionServerOptions["handleHandshake"]>,
): Promise<void> {
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
    return tracked
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

    socket.setNoDelay(true)
    socket.setKeepAlive(true, context.keepAliveInitialDelayMs)
    socket.setEncoding("utf8")
    let buffer = ""
    let bufferBytes = 0
    let handshakeDone = false
    let handshakePending: Promise<void> | null = null
    let isBattleSocket = false
    let protocolClosed = false

    const clearHandshakeTimer = (): void => clearTimeout(handshakeTimer)
    const closeForProtocolViolation = (reason: string): void => {
        if (protocolClosed) return
        protocolClosed = true
        buffer = ""
        bufferBytes = 0
        clearHandshakeTimer()
        console.warn(`[TCP] protocol violation: reason=${reason}`)
        socket.destroy()
    }
    const handshakeTimer = setTimeout(() => {
        if (!handshakeDone) closeForProtocolViolation("handshake_timeout")
    }, context.handshakeTimeoutMs)
    handshakeTimer.unref()

    const processBuffer = (): void => {
        if (protocolClosed || handshakePending !== null || !isAccepting(context, socket)) return
        while (isAccepting(context, socket) && buffer.includes("\0")) {
            const index = buffer.indexOf("\0")
            const raw = buffer.substring(0, index)
            buffer = buffer.substring(index + 1)
            bufferBytes -= Buffer.byteLength(raw) + 1
            if (Buffer.byteLength(raw) > context.maxFrameBytes) {
                closeForProtocolViolation("frame_too_large")
                return
            }
            if (raw.trim().length === 0) continue

            let data: any
            try {
                data = JSON.parse(raw)
            } catch {
                closeForProtocolViolation("invalid_json")
                return
            }

            try {
                if (!handshakeDone) {
                    if (
                        data === null
                        || typeof data !== "object"
                        || Array.isArray(data)
                        || typeof data.socklet !== "string"
                        || data.socklet.length === 0
                    ) {
                        closeForProtocolViolation("invalid_handshake")
                        return
                    }
                    handshakeDone = true
                    clearHandshakeTimer()
                    isBattleSocket = data.socklet === "cooperation_battle"
                    socket.pause()
                    const pending = trackHandshake(context, socket, data, handshakeHandler)
                    handshakePending = pending
                    void pending.then(() => {
                        if (handshakePending !== pending) return
                        handshakePending = null
                        if (!isAccepting(context, socket)) {
                            buffer = ""
                            return
                        }
                        socket.resume()
                        processBuffer()
                    })
                    return
                } else {
                    if (rejectInvalidNodeSession(context, socket)) break
                    if (isBattleSocket) {
                        handleBattleMessage(socket, data)
                    } else {
                        const lobby = require("./lobby")
                        lobby.handleMessage(socket, data)
                    }
                }
            } catch {
                closeForProtocolViolation("message_rejected")
                return
            }
        }
        if (hasOversizedBufferedFrame(buffer, context.maxFrameBytes)) {
            closeForProtocolViolation("unterminated_frame_too_large")
        }
    }

    socket.on("data", (chunk: string) => {
        if (protocolClosed || !isAccepting(context, socket)) return
        buffer += chunk
        bufferBytes += Buffer.byteLength(chunk)
        if (bufferBytes > context.maxBufferBytes) {
            closeForProtocolViolation("receive_buffer_too_large")
            return
        }
        if (hasOversizedBufferedFrame(buffer, context.maxFrameBytes)) {
            closeForProtocolViolation("frame_too_large")
            return
        }
        processBuffer()
    })

    socket.on("close", () => {
        clearHandshakeTimer()
        buffer = ""
        bufferBytes = 0
        handshakePending = null
        console.log("[TCP] connection closed")
        cleanupAcceptedSocket(socket)
    })

    socket.on("error", error => {
        clearHandshakeTimer()
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

function stopSessionLifecycles(): void {
    stopRoomCleanup()
    stopLobbyLifecycle()
    resetNpcRecruitmentTiming()
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

function positiveInteger(value: number | undefined, fallback: number, minimum = 1): number {
    return Number.isFinite(value) ? Math.max(minimum, Math.trunc(value!)) : fallback
}

function hasOversizedBufferedFrame(buffer: string, maxFrameBytes: number): boolean {
    let start = 0
    while (true) {
        const end = buffer.indexOf("\0", start)
        const raw = end === -1 ? buffer.substring(start) : buffer.substring(start, end)
        if (Buffer.byteLength(raw) > maxFrameBytes) return true
        if (end === -1) return false
        start = end + 1
    }
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
        stopSessionLifecycles()
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
    stopSessionLifecycles()
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
    const maxFrameBytes = positiveInteger(
        options.maxFrameBytes,
        DEFAULT_SESSION_MAX_FRAME_BYTES,
    )
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
        handshakeTimeoutMs: positiveInteger(
            options.handshakeTimeoutMs,
            DEFAULT_SESSION_HANDSHAKE_TIMEOUT_MS,
        ),
        maxFrameBytes,
        maxBufferBytes: positiveInteger(
            options.maxBufferBytes,
            DEFAULT_SESSION_MAX_BUFFER_BYTES,
            maxFrameBytes,
        ),
        keepAliveInitialDelayMs: positiveInteger(
            options.keepAliveInitialDelayMs,
            DEFAULT_SESSION_KEEPALIVE_INITIAL_DELAY_MS,
        ),
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
                startRoomCleanup(options.roomCleanup)
                configureReconnectGraceMs(options.roomCleanup?.reconnectGraceMs)
                configureNpcRecruitmentTiming(options.npcRecruitment)
                startLobbyLifecycle()
                startNodeSessionChecks(context)
            } catch (error) {
                recordFailure("startup", error)
                stopSessionLifecycles()
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
    stopSessionLifecycles()
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
