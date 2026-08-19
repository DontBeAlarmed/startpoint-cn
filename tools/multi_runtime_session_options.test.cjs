"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { EMBEDDED_NODE_SESSION_ID } = require("../src/multi/coordinator/embedded")
const { buildSessionServerOptions } = require("../src/multi/runtime/session-options")

const tuning = Object.freeze({
    transport: Object.freeze({
        handshakeTimeoutMs: 16000,
        maxFrameBytes: 524288,
        maxBufferBytes: 2097152,
        keepAliveInitialDelayMs: 11000,
        sendQueueMaxMessages: 768,
        sendQueueMaxBytes: 8388608,
        sendQueueMaxAgeMs: 17000,
    }),
    battle: Object.freeze({ loadingLeaseMs: 70000, heartbeatLeaseMs: 30000 }),
    roomCleanup: Object.freeze({
        incompleteExpiryMs: 120000,
        fullExpiryMs: 240000,
        intervalMs: 15000,
        reconnectGraceMs: 18000,
    }),
    npcRecruitment: Object.freeze({ joinDelayMs: 250, readyDelayMs: 75 }),
})

test("session options preserve runtime tuning references and host services", () => {
    const config = Object.freeze({ host: "127.0.0.1", port: 8003 })
    const admissionRegistry = Object.freeze({ consume: () => null })
    const checkedNodeSessions = []
    const hostServices = {
        admissionRegistry,
        nodeSessions: {
            isValid(nodeSessionId) {
                checkedNodeSessions.push(nodeSessionId)
                return nodeSessionId === "trusted-node"
            },
        },
    }
    const fatalErrors = []

    const options = buildSessionServerOptions(
        config,
        error => fatalErrors.push(error),
        hostServices,
        tuning,
    )

    assert.equal(options.host, config.host)
    assert.equal(options.port, config.port)
    assert.equal(options.transportTuning, tuning.transport)
    assert.equal(options.battleTuning, tuning.battle)
    assert.equal(options.roomCleanup, tuning.roomCleanup)
    assert.equal(options.npcRecruitment, tuning.npcRecruitment)
    assert.equal(options.admissionProvider, admissionRegistry)
    assert.equal(options.validateNodeSession(EMBEDDED_NODE_SESSION_ID), true)
    assert.deepEqual(checkedNodeSessions, [])
    assert.equal(options.validateNodeSession("trusted-node"), true)
    assert.equal(options.validateNodeSession("revoked-node"), false)
    assert.deepEqual(checkedNodeSessions, ["trusted-node", "revoked-node"])

    options.onFatalError({ stage: "runtime", code: null })
    assert.equal(fatalErrors.length, 1)
    assert.equal(fatalErrors[0] instanceof Error, true)
    assert.equal(fatalErrors[0].message, "session server unavailable")
})

test("session options omit host-only hooks without host services or tuning", () => {
    const options = buildSessionServerOptions(
        { host: "127.0.0.1", port: 8003 },
        () => {},
    )

    assert.equal(options.transportTuning, undefined)
    assert.equal(options.battleTuning, undefined)
    assert.equal(options.roomCleanup, undefined)
    assert.equal(options.npcRecruitment, undefined)
    assert.equal(options.admissionProvider, undefined)
    assert.equal(options.validateNodeSession, undefined)
})
