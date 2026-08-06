"use strict"

// cn-server lifecycle ordering, entered through the production composition.
//
// The dependency object under test is built by
// createContentLifecycleDependencies() — the same function cn-server spreads
// into its runtime-coordinator dependencies. A test that called
// initializeContentAndModes() directly could not notice cn-server dropping
// that call; this one loses its subject and fails.
//
// Snapshot, HTTP listen and multiplayer start are spies, so no port is bound.

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { EventEmitter } = require("node:events")
const { createHash } = require("node:crypto")

const registry = require("../src/modes/registry")
const { createContentLifecycleDependencies } = require("../src/modes/cn-lifecycle")
const { createRuntimeCoordinator } = require("../src/runtime/lifecycle")

function tempModesDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-modes-lifecycle-"))
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

function installModule(dir, fileName, name) {
    const source = `export const modeManifest = {
    apiVersion: ${registry.MODE_API_VERSION},
    name: ${JSON.stringify(name)},
    capability: ${JSON.stringify(name + "@1")},
}

export function register() {
    return {}
}
`
    fs.writeFileSync(path.join(dir, fileName), source)
    fs.writeFileSync(
        path.join(dir, "modes-allowlist.json"),
        JSON.stringify({
            [fileName]: createHash("sha256").update(Buffer.from(source)).digest("hex"),
        }),
    )
}

function buildCoordinator(dir, trace) {
    const config = {
        assetProvider: { mode: "local" },
        http: {},
        multi: { mode: "embedded", tcp: {} },
    }
    // Exactly what cn-server composes for the content step.
    const contentDependencies = createContentLifecycleDependencies({
        projectRoot: dir,
        initializeContentSnapshot: () => {
            trace.push("content-snapshot")
            return Promise.resolve()
        },
        env: { MODES_DIR: dir },
        log: () => {},
    })
    return createRuntimeCoordinator({
        loadConfig: () => config,
        configureHttp: () => {},
        initializeDatabase: () => {},
        restoreServerTime: () => {},
        ...contentDependencies,
        initializeContent: async currentConfig => {
            const loaded = await contentDependencies.initializeContent(currentConfig)
            trace.push(`modes-loaded:${registry.listModeCapabilities().join(",")}`)
            return loaded
        },
        readyHttp: async () => {},
        listenHttp: async () => {
            trace.push(`http-listen:${registry.listModeCapabilities().join(",")}`)
        },
        closeHttp: async () => {},
        forceCloseHttp: () => {},
        startMulti: async () => {
            trace.push(`multi-start:${registry.listModeCapabilities().join(",")}`)
        },
        stopMulti: async () => {},
        checkpointDatabase: () => {},
        closeDatabase: () => {},
        getDatabaseHealth: () => ({ status: "ok" }),
        isHttpListening: () => true,
        getMultiStatus: () => ({
            mode: "embedded",
            state: "ready",
            coordinator: { kind: "local", available: true },
            hub: null,
            tcp: { available: true, endpoint: "127.0.0.1:8003" },
        }),
        processTarget: new EventEmitter(),
        setExitCode: () => {},
        log: () => {},
    })
}

test("boot order is snapshot → modes → multiplayer start → HTTP listen", async () => {
    const dir = tempModesDir()
    installModule(dir, "lifecycle.mjs", "lifecycle-fixture")
    registry.resetModesForTest()

    const trace = []
    const coordinator = buildCoordinator(dir, trace)
    await coordinator.start()

    assert.deepEqual(trace, [
        "content-snapshot",
        "modes-loaded:lifecycle-fixture@1",
        // Multiplayer context must exist before HTTP route registration.
        "multi-start:lifecycle-fixture@1",
        "http-listen:lifecycle-fixture@1",
    ])

    await coordinator.stop?.()
    registry.resetModesForTest()
})

test("an empty modes dir still boots in the same order with nothing registered", async () => {
    const dir = tempModesDir()
    registry.resetModesForTest()

    const trace = []
    const coordinator = buildCoordinator(dir, trace)
    await coordinator.start()

    assert.deepEqual(trace, [
        "content-snapshot",
        "modes-loaded:",
        "multi-start:",
        "http-listen:",
    ])
    assert.deepEqual(registry.listModeCapabilities(), [])

    await coordinator.stop?.()
})
