"use strict"

const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { describe, test } = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

// Each probe boots src/server.ts under ts-node, which re-transpiles the whole
// server graph from scratch (~15-25s, ts-node 10 has no persistent transpile
// cache). Three sequential probes blow the quick:protocol per-file timeout in
// tools/test-workflow/run.cjs whenever the group runs under load, so the
// probes run concurrently inside this file instead. The per-probe kill stays
// under the group's 120s budget so a pathological hang fails this file with
// the captured output instead of the runner's generic timeout message.
const PROBE_TIMEOUT_MS = 100_000

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

    // Asynchronous spawn (not spawnSync) so concurrent probes in this file do
    // not serialize on the blocking event loop. The child always settles the
    // promise: server.ts exits 1 on every probe path (sentinel, stub assertion
    // failure, invalid env all land in bootstrap().catch -> process.exit(1)),
    // spawn errors reject, and the timer SIGKILLs any pathological hang with
    // the captured output attached before the runner's 60s file timeout hits.
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", probe], {
            cwd: projectRoot,
            env,
        })
        let stdout = ""
        let stderr = ""
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            child.kill("SIGKILL")
            reject(new Error(
                `global entry probe did not exit within ${PROBE_TIMEOUT_MS}ms\n${stdout}${stderr}`,
            ))
        }, PROBE_TIMEOUT_MS)
        child.stdout.on("data", chunk => { stdout += chunk })
        child.stderr.on("data", chunk => { stderr += chunk })
        child.on("error", error => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(error)
        })
        child.on("close", code => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ status: code, stdout, stderr })
        })
    })
}

describe("global embedded startup probes", { concurrency: true }, () => {
    test("global server constructs Embedded context before content snapshot initialization", async t => {
        const result = await runGlobalEntryProbe(t, {
            PROBE_EXPECTED_CALENDAR_OFFSET: "480",
        })
        const output = `${result.stdout}\n${result.stderr}`

        assert.equal(result.status, 1, output)
        assert.match(output, /GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION/)
        assert.doesNotMatch(output, /CONTENT_SNAPSHOT_NOT_INITIALIZED/)
    })

    test("global server rejects a 540 release under the default 480 calendar policy", async t => {
        // The legacy entry must source the parsed env offset (540) into the
        // snapshot constraint instead of letting the provider default to 480;
        // ContentRepository then fails a 540-built release against that 480
        // runtime policy before the port opens. The probe asserts the parsed
        // value actually reaches initializeContentSnapshot.
        const result = await runGlobalEntryProbe(t, {
            GAME_CALENDAR_UTC_OFFSET_MINUTES: "+540",
            PROBE_EXPECTED_CALENDAR_OFFSET: "540",
        })
        const output = `${result.stdout}\n${result.stderr}`

        assert.equal(result.status, 1, output)
        assert.match(output, /GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION/)
    })

    test("global server fails closed on an invalid calendar offset before content loads", async t => {
        const result = await runGlobalEntryProbe(t, {
            GAME_CALENDAR_UTC_OFFSET_MINUTES: "not-a-number",
        })
        const output = `${result.stdout}\n${result.stderr}`

        assert.equal(result.status, 1, output)
        assert.match(output, /GameCalendarError: invalid game calendar UTC offset minutes/)
        assert.doesNotMatch(output, /GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION/)
    })
})
