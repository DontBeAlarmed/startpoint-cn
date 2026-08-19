import * as net from "net"
import { DEFAULT_MULTI_TRANSPORT_TUNING } from "../runtime/tuning"

export type ReliableSendResult = "sent" | "queued" | "closed"

export interface ReliableSendTuning {
    readonly maxMessages: number
    readonly maxBytes: number
    readonly maxAgeMs: number
}

interface QueuedFrame {
    readonly frame: string
    readonly bytes: number
}

interface SocketSendState {
    readonly queue: QueuedFrame[]
    queuedBytes: number
    blockedSince: number
    drainListening: boolean
    timeout: NodeJS.Timeout | null
}

const DEFAULT_RELIABLE_SEND_TUNING: ReliableSendTuning = Object.freeze({
    maxMessages: DEFAULT_MULTI_TRANSPORT_TUNING.sendQueueMaxMessages,
    maxBytes: DEFAULT_MULTI_TRANSPORT_TUNING.sendQueueMaxBytes,
    maxAgeMs: DEFAULT_MULTI_TRANSPORT_TUNING.sendQueueMaxAgeMs,
})

let reliableSendTuning = DEFAULT_RELIABLE_SEND_TUNING

function assertSafeInteger(
    name: string,
    value: number,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`)
    }
}

export function configureReliableSendTuning(tuning: ReliableSendTuning): void {
    assertSafeInteger("maxMessages", tuning.maxMessages, 1)
    assertSafeInteger("maxBytes", tuning.maxBytes, 1024)
    assertSafeInteger("maxAgeMs", tuning.maxAgeMs, 1, 2_147_483_647)
    reliableSendTuning = Object.freeze({ ...tuning })
}

export function resetReliableSendTuning(): void {
    reliableSendTuning = DEFAULT_RELIABLE_SEND_TUNING
}

const socketStates = new WeakMap<net.Socket, SocketSendState>()
const cleanupAttached = new WeakSet<net.Socket>()

function clearTimeoutFor(state: SocketSendState): void {
    if (state.timeout !== null) clearTimeout(state.timeout)
    state.timeout = null
}

function resetBackpressure(state: SocketSendState): void {
    clearTimeoutFor(state)
    state.blockedSince = 0
}

function clearQueue(state: SocketSendState): void {
    state.queue.length = 0
    state.queuedBytes = 0
}

function ensureState(socket: net.Socket): SocketSendState {
    let state = socketStates.get(socket)
    if (state) return state
    state = {
        queue: [],
        queuedBytes: 0,
        blockedSince: 0,
        drainListening: false,
        timeout: null,
    }
    socketStates.set(socket, state)
    if (!cleanupAttached.has(socket) && typeof socket.once === "function") {
        cleanupAttached.add(socket)
        socket.once("close", () => clearReliableSendState(socket))
    }
    return state
}

function retireSlowSocket(
    socket: net.Socket,
    state: SocketSendState,
    reason: "queue_limit" | "backpressure_timeout",
): void {
    const queuedMessages = state.queue.length
    const queuedBytes = state.queuedBytes
    clearTimeoutFor(state)
    clearQueue(state)
    console.warn(
        `[TCP] slow connection removed: reason=${reason}`
        + ` queuedMessages=${queuedMessages} queuedBytes=${queuedBytes}`,
    )
    if (!socket.destroyed) socket.destroy()
}

function armTimeout(socket: net.Socket, state: SocketSendState): void {
    clearTimeoutFor(state)
    const remaining = Math.max(
        1,
        reliableSendTuning.maxAgeMs - (Date.now() - state.blockedSince),
    )
    state.timeout = setTimeout(() => {
        if (socketStates.get(socket) !== state || socket.destroyed) return
        retireSlowSocket(socket, state, "backpressure_timeout")
    }, remaining)
    state.timeout.unref()
}

function beginBackpressure(socket: net.Socket, state: SocketSendState): void {
    if (state.blockedSince === 0) state.blockedSince = Date.now()
    listenForDrain(socket, state)
    armTimeout(socket, state)
}

function listenForDrain(socket: net.Socket, state: SocketSendState): void {
    if (state.drainListening || socket.destroyed) return
    state.drainListening = true
    socket.once("drain", () => {
        if (socketStates.get(socket) !== state || socket.destroyed) return
        state.drainListening = false
        clearTimeoutFor(state)

        if (!socket.writable) {
            clearQueue(state)
            resetBackpressure(state)
            socket.destroy()
            return
        }

        while (state.queue.length > 0 && socket.writable && !socket.destroyed) {
            const next = state.queue.shift()!
            state.queuedBytes -= next.bytes
            try {
                if (!socket.write(next.frame)) {
                    beginBackpressure(socket, state)
                    return
                }
            } catch {
                clearQueue(state)
                if (!socket.destroyed) socket.destroy()
                return
            }
        }

        if (state.queue.length > 0 && !socket.writable) {
            clearQueue(state)
            resetBackpressure(state)
            if (!socket.destroyed) socket.destroy()
            return
        }
        if (state.queue.length === 0) resetBackpressure(state)
    })
}

export function sendFrameReliably(socket: net.Socket, frame: string): ReliableSendResult {
    if (!socket.writable || socket.destroyed) return "closed"
    const state = ensureState(socket)

    if (state.blockedSince !== 0 || state.queue.length > 0) {
        const bytes = Buffer.byteLength(frame)
        if (
            state.queue.length + 1 > reliableSendTuning.maxMessages
            || state.queuedBytes + bytes > reliableSendTuning.maxBytes
        ) {
            retireSlowSocket(socket, state, "queue_limit")
            return "closed"
        }
        state.queue.push({ frame, bytes })
        state.queuedBytes += bytes
        beginBackpressure(socket, state)
        return "queued"
    }

    try {
        if (!socket.write(frame)) beginBackpressure(socket, state)
        return "sent"
    } catch {
        if (!socket.destroyed) socket.destroy()
        return "closed"
    }
}

export function clearReliableSendState(socket: net.Socket): void {
    const state = socketStates.get(socket)
    if (!state) return
    clearTimeoutFor(state)
    clearQueue(state)
    socketStates.delete(socket)
}

export function getReliableSendQueueStats(socket: net.Socket): {
    messages: number
    bytes: number
    blocked: boolean
} {
    const state = socketStates.get(socket)
    return {
        messages: state?.queue.length ?? 0,
        bytes: state?.queuedBytes ?? 0,
        blocked: (state?.blockedSince ?? 0) !== 0,
    }
}
