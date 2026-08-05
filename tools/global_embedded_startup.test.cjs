"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

test("global server constructs Embedded context before content snapshot initialization", t => {
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
        async initializeContentSnapshot() {
            installedSnapshot = { marker: "installed" }
            throw new Error("GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION")
        },
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
    }
    delete env.WDFP_DATABASE_DIR
    delete env.CONTENT_STORE_DIR
    delete env.CONTENT_STATE_DIR

    const result = spawnSync(process.execPath, ["-e", probe], {
        cwd: projectRoot,
        encoding: "utf8",
        env,
        timeout: 60_000,
    })
    const output = `${result.stdout}\n${result.stderr}`

    assert.equal(result.status, 1, output)
    assert.match(output, /GLOBAL_EMBEDDED_REACHED_CONTENT_INITIALIZATION/)
    assert.doesNotMatch(output, /CONTENT_SNAPSHOT_NOT_INITIALIZED/)
    assert.equal(result.error, undefined)
})
