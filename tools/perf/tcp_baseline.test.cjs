"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { parseArgs, runTcpBaseline } = require("./tcp_baseline.cjs")

test("validates the TCP ladder arguments", () => {
    assert.deepEqual(parseArgs([
        "--rooms", "25",
        "--clients-per-room", "3",
        "--timeout-ms", "1000",
        "--output", "/tmp/tcp-report.json",
    ]), {
        clientsPerRoom: 3,
        output: "/tmp/tcp-report.json",
        rooms: 25,
        timeoutMs: 1000,
    })
    assert.throws(() => parseArgs(["--clients-per-room", "4"]), /cannot exceed 3/)
})

test("runs a real three-client TCP room and cleans every session", async () => {
    const result = await runTcpBaseline({
        clientsPerRoom: 3,
        rooms: 1,
        timeoutMs: 2000,
    })

    assert.deepEqual(result.workload, {
        clientsPerRoom: 3,
        rooms: 1,
        totalClients: 3,
        timeoutMs: 2000,
    })
    assert.equal(result.summary.completed, 3)
    assert.equal(result.summary.errors, 0)
    assert.ok(result.summary.p95ConnectMs >= 0)
    assert.ok(result.summary.p95HeartbeatMs >= 0)
    assert.equal(result.summary.peakActiveSockets, 3)
    assert.equal(result.summary.activeSocketsAfterCleanup, 0)
    assert.equal(result.summary.remainingRooms, 0)
})
