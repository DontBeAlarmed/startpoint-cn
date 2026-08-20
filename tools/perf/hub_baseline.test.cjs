"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { parseArgs, runHubBaseline } = require("./hub_baseline.cjs")
const { assertSameEndpoint } = require("./hub_baseline_helpers.cjs")

test("validates Hub baseline arguments", () => {
    assert.deepEqual(parseArgs([
        "--rooms", "25",
        "--timeout-ms", "1000",
        "--fault-mode", "client-disconnect",
        "--output", "/tmp/hub-report.json",
    ]), {
        faultMode: "client-disconnect",
        output: "/tmp/hub-report.json",
        rooms: 25,
        timeoutMs: 1000,
    })
    assert.throws(() => parseArgs(["--rooms", "0"]), /rooms must be a positive integer/)
    assert.throws(() => parseArgs(["--rooms", "9007199254740992"]), /rooms must be a positive integer/)
    assert.throws(() => parseArgs(["--fault-mode", "invalid"]), /unknown fault mode/)
    assert.throws(() => parseArgs(["--unknown", "1"]), /unknown argument/)
})

test("rejects mismatched Host and Client TCP endpoints", () => {
    assert.doesNotThrow(() => assertSameEndpoint(
        { host: "127.0.0.1", port: 8003 },
        { host: "127.0.0.1", port: 8003 },
    ))
    assert.throws(() => assertSameEndpoint(
        { host: "127.0.0.1", port: 8003 },
        { host: "127.0.0.1", port: 9003 },
    ), /different TCP endpoints/)
})

test("runs one remote room through Host, Client, and Hub", { timeout: 120_000 }, async () => {
    const result = await runHubBaseline({ rooms: 1, timeoutMs: 5_000 })

    assert.deepEqual(result.workload, {
        faultMode: "none",
        rooms: 1,
        timeoutMs: 5_000,
        totalPeers: 2,
    })
    assert.equal(result.summary.completedRooms, 1)
    assert.equal(result.summary.errors, 0)
    assert.equal(result.summary.totalRooms, 1)
    assert.ok(result.summary.p50PrepareMs >= 0)
    assert.ok(result.summary.p95PrepareMs >= 0)
    assert.ok(result.summary.p99PrepareMs >= 0)
    assert.ok(result.summary.p50HandshakeMs >= 0)
    assert.ok(result.summary.p95HandshakeMs >= 0)
    assert.ok(result.summary.p99HandshakeMs >= 0)
    assert.ok(result.summary.p50HeartbeatMs >= 0)
    assert.ok(result.summary.p95HeartbeatMs >= 0)
    assert.ok(result.summary.p99HeartbeatMs >= 0)
    assert.equal(result.summary.peakPeers, 2)
    assert.equal(result.summary.activePeersAfterCleanup, 0)
    assert.equal(result.summary.remainingRooms, 0)
})

test("cleans multiple remote rooms after abrupt Client disconnects", { timeout: 120_000 }, async () => {
    const result = await runHubBaseline({
        faultMode: "client-disconnect",
        rooms: 2,
        timeoutMs: 5_000,
    })

    assert.deepEqual(result.workload, {
        faultMode: "client-disconnect",
        rooms: 2,
        timeoutMs: 5_000,
        totalPeers: 4,
    })
    assert.equal(result.summary.completedRooms, 2)
    assert.equal(result.summary.errors, 0)
    assert.equal(result.summary.faultsInjected, 2)
    assert.equal(result.summary.peakPeers, 4)
    assert.equal(result.summary.activePeersAfterCleanup, 0)
    assert.equal(result.summary.remainingRooms, 0)
    assert.equal(result.summary.activeProcessesAfterCleanup, 0)
    assert.equal(result.summary.temporaryRootExistsAfterCleanup, false)
})
