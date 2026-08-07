"use strict"

const net = require("node:net")
const { performance } = require("node:perf_hooks")

function closeSocket(socket) {
    if (!socket || socket.destroyed) return Promise.resolve()
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            socket.destroy()
            resolve()
        }, 1000)
        socket.once("close", () => {
            clearTimeout(timer)
            resolve()
        })
        socket.end()
    })
}

function waitForFrame(state, timeoutMs) {
    if (state.frames.length > 0) return Promise.resolve(state.frames.shift())
    return new Promise((resolve, reject) => {
        let waiter
        const timer = setTimeout(() => {
            const index = state.waiters.indexOf(waiter)
            if (index >= 0) state.waiters.splice(index, 1)
            reject(new Error("TCP frame timeout"))
        }, timeoutMs)
        waiter = frame => {
            clearTimeout(timer)
            resolve(frame)
        }
        state.waiters.push(waiter)
    })
}

function parseFrames(buffer, onFrame) {
    let remaining = buffer
    while (remaining.includes("\0")) {
        const separator = remaining.indexOf("\0")
        const raw = remaining.slice(0, separator)
        remaining = remaining.slice(separator + 1)
        if (!raw.trim()) continue
        onFrame(JSON.parse(raw))
    }
    return remaining
}

async function connectClient({ connectionId, port, roomNumber, timeoutMs, viewerId }) {
    const state = { buffer: "", frames: [], waiters: [] }
    const startedAt = performance.now()
    let socket = null
    try {
        socket = await new Promise((resolve, reject) => {
            const candidate = net.createConnection({ host: "127.0.0.1", port })
            candidate.setEncoding("utf8")
            candidate.on("data", chunk => {
                try {
                    state.buffer = parseFrames(state.buffer + chunk, frame => {
                        const waiter = state.waiters.shift()
                        if (waiter) waiter(frame)
                        else state.frames.push(frame)
                    })
                } catch (error) {
                    reject(error)
                }
            })
            candidate.once("connect", () => resolve(candidate))
            candidate.once("error", reject)
        })

        socket.write(`${JSON.stringify({
            connection_id: connectionId,
            questCategory: 1,
            questId: 1,
            room_number: roomNumber,
            socklet: "cooperation_room",
            viewerId,
        })}\0`)
        const handshake = await waitForFrame(state, timeoutMs)
        if (!Array.isArray(handshake) || handshake[0] !== 0) {
            throw new Error("TCP handshake was denied")
        }
        const handshakeMs = performance.now() - startedAt

        const heartbeatStartedAt = performance.now()
        socket.write("[0,[4]]\0")
        const heartbeat = await waitForFrame(state, timeoutMs)
        if (!Array.isArray(heartbeat) || heartbeat[0] !== 1 || heartbeat[1]?.[0] !== 11) {
            throw new Error("TCP heartbeat was not acknowledged")
        }
        return {
            connectionId,
            heartbeatMs: performance.now() - heartbeatStartedAt,
            handshakeMs,
            roomNumber,
            socket,
            viewerId,
        }
    } catch (error) {
        await closeSocket(socket)
        return {
            connectionId,
            error: String(error?.message ?? error),
            heartbeatMs: null,
            handshakeMs: null,
            roomNumber,
            socket: null,
            viewerId,
        }
    }
}

module.exports = { closeSocket, connectClient }
