"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

// Boots src/server.ts with the content snapshot module stubbed out. The stub
// asserts that the legacy global entry passes expectedGameCalendarUtcOffsetMinutes
// (sourced from parseGameCalendarUtcOffsetMinutes) into initializeContentSnapshot
// before the sentinel error short-circuits bootstrap ahead of fastify.listen.
function runGlobalEntryProbe(t, envOverrides) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "global-embedded-startup-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const probe = String.raw`
require("ts-node/register/transpile-only")
let installedSnapshot = null
class ContentSnapshotError extends Error {
    constructor(code, message) {
        super(code + ": " + message)
        this.name = "ContentSnapshotError"
        this.code = code
    }
}
const snapshotModulePath = require.resolve("./src/content/runtime/content-snapshot")
require.cache[snapshotModulePath] = {
    id: snapshotModulePath,
    filename: snapshotModulePath,
    loaded: true,
    exports: {
        ContentSnapshotError,
        getContentSnapshot() {
            if (installedSnapshot === null) {
                throw new ContentSnapshotError(
                    "CONTENT_SNAPSHOT_NOT_INITIALIZED",
                    "startup probe",
                )
            }
            return installedSnapshot
        },
        async initializeContentSnapshot(options) {
            installedSnapshot = { marker: "installed" }
            const assert = require("node:assert/strict")
            assert.equal(
                options && options.expectedGameCalendarUtcOffsetMinutes,
                Number(process.env.PROBE_EXPECTED_CALENDAR_OFFSET),
                "server.ts must pass expectedGameCalendarUtcOffsetMinutes into initializeContentSnapshot",
            )
            throw new Error("GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION")
        },
    },
}
const adminModulePath = require.resolve("./src/runtime/admin")
require.cache[adminModulePath] = {
    id: adminModulePath,
    filename: adminModulePath,
    loaded: true,
    exports: {
        registerAdminUi() {},
    },
}
require("./src/server")
`
    const env = {
        ...process.env,
        DATA_DIR: path.join(root, "data"),
        CONTENT_DIR: path.join(root, "content"),
        CONTENT_RUNTIME_DIR: path.join(projectRoot, "assets"),
        LISTEN_HOST: "127.0.0.1",
        LISTEN_PORT: "0",
        ...envOverrides,
    }
    delete env.WDFP_DATABASE_DIR
    delete env.CONTENT_STORE_DIR
    delete env.CONTENT_STATE_DIR

    return spawnSync(process.execPath, ["-e", probe], {
        cwd: projectRoot,
        encoding: "utf8",
        env,
        timeout: 60_000,
    })
}

test("global server constructs Embedded context before content snapshot initialization", t => {
    const result = runGlobalEntryProbe(t, {
        PROBE_EXPECTED_CALENDAR_OFFSET: "480",
    })
    const output = `${result.stdout}\n${result.stderr}`

    assert.equal(result.status, 1, output)
    assert.match(output, /GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION/)
    assert.doesNotMatch(output, /CONTENT_SNAPSHOT_NOT_INITIALIZED/)
    assert.equal(result.error, undefined)
})

test("global server rejects a 540 release under the default 480 calendar policy", t => {
    // The legacy entry must source the parsed env offset (540) into the
    // snapshot constraint instead of letting the provider default to 480;
    // ContentRepository then fails a 540-built release against that 480
    // runtime policy before the port opens. The probe asserts the parsed
    // value actually reaches initializeContentSnapshot.
    const result = runGlobalEntryProbe(t, {
        GAME_CALENDAR_UTC_OFFSET_MINUTES: "+540",
        PROBE_EXPECTED_CALENDAR_OFFSET: "540",
    })
    const output = `${result.stdout}\n${result.stderr}`

    assert.equal(result.status, 1, output)
    assert.match(output, /GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION/)
})

test("global server fails closed on an invalid calendar offset before content loads", t => {
    const result = runGlobalEntryProbe(t, {
        GAME_CALENDAR_UTC_OFFSET_MINUTES: "not-a-number",
    })
    const output = `${result.stdout}\n${result.stderr}`

    assert.equal(result.status, 1, output)
    assert.match(output, /GameCalendarError: invalid game calendar UTC offset minutes/)
    assert.doesNotMatch(output, /GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION/)
})
