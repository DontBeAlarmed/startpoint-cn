"use strict"

const assert = require("node:assert/strict")
const net = require("node:net")
const test = require("node:test")

const {
    MultiHubProcessHarness,
} = require("./helpers/multi-hub-process-harness")

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function settleWithin(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("socket 终止后 waiter 仍等待各自的超时 timer")),
            timeoutMs,
        )
        promise.then(
            value => {
                clearTimeout(timer)
                resolve(value)
            },
            error => {
                clearTimeout(timer)
                reject(error)
            },
        )
    })
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            server.off("error", reject)
            resolve()
        })
    })
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        if (!server.listening) {
            resolve()
            return
        }
        server.close(error => error ? reject(error) : resolve())
    })
}

async function waitFor(condition, message, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(10)
    }
    assert.fail(message)
}

function activeTrackedHandles(tracked) {
    return process._getActiveHandles().filter(handle => tracked.has(handle))
}

async function assertTrackedHandlesClosed(tracked) {
    await waitFor(
        () => activeTrackedHandles(tracked).length === 0,
        "测试创建的 TCP handle 未在限定时间内关闭",
    )
}

async function openTestPeer(t, label) {
    const harness = new MultiHubProcessHarness()
    const acceptedSockets = new Set()
    const server = net.createServer(socket => {
        acceptedSockets.add(socket)
        socket.on("close", () => acceptedSockets.delete(socket))
    })
    let cleanupPromise
    const cleanup = () => {
        if (!cleanupPromise) cleanupPromise = (async () => {
            for (const socket of acceptedSockets) socket.destroy()
            await harness.cleanup()
            await closeServer(server)
        })()
        return cleanupPromise
    }
    t.after(cleanup)
    try {
        await listen(server)
        const peer = await harness.openTcp(label, server.address().port, { label })
        await waitFor(() => acceptedSockets.size === 1, "测试 TCP 服务未接受连接")
        return { cleanup, peer, server, serverSocket: [...acceptedSockets][0] }
    } catch (error) {
        await cleanup()
        throw error
    }
}

async function assertConcurrentWaitersReject(peer, terminate, expectedError) {
    const timeoutMs = 500
    const waiters = [1, 2, 3].map(index => peer.waitFor(
        message => message[0] === 99 && message[1] === index,
        timeoutMs,
    ))
    const waiterTimers = peer.waiters.map(waiter => waiter.timer)
    const settled = Promise.allSettled(waiters)

    terminate()

    const result = await settleWithin(settled, 100)
    assert.equal(result.length, waiters.length)
    for (const outcome of result) {
        assert.equal(outcome.status, "rejected")
        if (expectedError) assert.equal(outcome.reason, expectedError)
    }
    assert.equal(peer.waiters.length, 0)
    for (const timer of waiterTimers) assert.equal(timer._destroyed, true)
}

test("remote close immediately settles every waiter and cleanup closes tracked handles", async t => {
    const { cleanup, server, peer, serverSocket } = await openTestPeer(t, "remote-close")
    const tracked = new Set([server, peer.socket, serverSocket])
    try {
        await assertConcurrentWaitersReject(peer, () => serverSocket.destroy())
        const terminalError = peer.terminalError
        await assert.rejects(peer.waitFor(() => true), error => error === terminalError)
        await peer.close()
        await peer.close()
        assert.equal(peer.terminalError, terminalError)
    } finally {
        serverSocket.destroy()
        await cleanup()
        await cleanup()
    }
    await assertTrackedHandlesClosed(tracked)
})

test("socket error deterministically settles concurrent waiters only once", async t => {
    const { cleanup, server, peer, serverSocket } = await openTestPeer(t, "socket-error")
    const tracked = new Set([server, peer.socket, serverSocket])
    const socketError = new Error("test socket failure")
    try {
        await assertConcurrentWaitersReject(
            peer,
            () => peer.socket.destroy(socketError),
            socketError,
        )
        peer.socket.emit("error", new Error("duplicate socket failure"))
        await assert.rejects(peer.waitFor(() => true), error => error === socketError)
        await peer.close()
        await peer.close()
        assert.equal(peer.terminalError, socketError)
    } finally {
        serverSocket.destroy()
        await cleanup()
        await cleanup()
    }
    await assertTrackedHandlesClosed(tracked)
})
