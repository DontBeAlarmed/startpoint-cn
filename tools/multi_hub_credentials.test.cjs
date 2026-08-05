"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const {
    MultiHubCredentialStore,
} = require("../src/multi/hub/credential-store")
const { CredentialReloader } = require("../src/multi/hub/credential-reloader")
const {
    acquireMultiHubCredentialLock,
    withMultiHubCredentialLock,
} = require("../src/multi/hub/credential-lock")

function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-hub-credentials-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const credentialsPath = path.join(root, "private", "credentials.json")
    return {
        credentialsPath,
        root,
        store: new MultiHubCredentialStore({ credentialsPath, ...options }),
    }
}

const concurrentWorker = String.raw`
const fs = require("node:fs")
const { randomBytes } = require("node:crypto")
require("ts-node/register/transpile-only")
const { MultiHubCredentialStore } = require("./src/multi/hub/credential-store")
const [credentialsPath, action, value, readyPath, goPath] = process.argv.slice(1)
const sleep = milliseconds => Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds,
)
fs.writeFileSync(readyPath, "ready", { mode: 0o600 })
while (!fs.existsSync(goPath)) sleep(5)
const options = { credentialsPath }
if (action === "create") {
    options.generateToken = () => {
        sleep(200)
        return randomBytes(32).toString("hex")
    }
} else {
    options.now = () => {
        sleep(200)
        return new Date()
    }
}
const store = new MultiHubCredentialStore(options)
const result = action === "create" ? store.create(value) : store.revoke(value)
process.stdout.write(JSON.stringify({ credentialId: result.credentialId }))
`

function runCredentialWorker(credentialsPath, action, value, readyPath, goPath) {
    const child = spawn(process.execPath, [
        "-e",
        concurrentWorker,
        credentialsPath,
        action,
        value,
        readyPath,
        goPath,
    ], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
    return {
        child,
        completed: new Promise(resolve => {
            child.once("close", status => resolve({ status, stderr, stdout }))
        }),
    }
}

async function waitForFiles(paths, workers) {
    for (let attempt = 0; attempt < 1_000; attempt++) {
        if (paths.every(filePath => fs.existsSync(filePath))) return
        const exited = workers.find(worker => worker.child.exitCode !== null)
        if (exited) assert.fail(`worker exited before start barrier: ${(await exited.completed).stderr}`)
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail(`workers did not reach start barrier: ${paths.join(", ")}`)
}

async function runConcurrentCredentialOperations(root, credentialsPath, operations) {
    const goPath = path.join(root, "go")
    const workers = operations.map(([action, value], index) => runCredentialWorker(
        credentialsPath,
        action,
        value,
        path.join(root, `ready-${index}`),
        goPath,
    ))
    const readyPaths = workers.map((_worker, index) => path.join(root, `ready-${index}`))
    try {
        await waitForFiles(readyPaths, workers)
        fs.writeFileSync(goPath, "go", { mode: 0o600 })
        const results = await Promise.all(workers.map(worker => worker.completed))
        for (const result of results) assert.equal(result.status, 0, result.stderr)
        return results
    } finally {
        for (const worker of workers) {
            if (worker.child.exitCode === null) worker.child.kill()
        }
    }
}

test("create returns plaintext once while the private table stores only its digest", t => {
    const { credentialsPath, store } = fixture(t)
    const issued = store.create("node-b")

    assert.match(issued.credentialId, /^[0-9a-f]{32}$/)
    assert.match(issued.token, /^[0-9a-f]{64}$/)
    assert.equal(issued.label, "node-b")
    assert.equal(issued.revokedAt, null)
    const persistedText = fs.readFileSync(credentialsPath, "utf8")
    const persisted = JSON.parse(persistedText)
    assert.deepEqual(Object.keys(persisted).sort(), ["credentials", "schemaVersion"])
    assert.equal(persisted.schemaVersion, 1)
    assert.deepEqual(Object.keys(persisted.credentials[0]).sort(), [
        "createdAt",
        "credentialId",
        "label",
        "revokedAt",
        "tokenDigest",
    ])
    assert.match(persisted.credentials[0].tokenDigest, /^[0-9a-f]{64}$/)
    assert.equal(persistedText.includes(issued.token), false)
    assert.equal(store.authenticate(issued.token)?.credentialId, issued.credentialId)
    assert.equal(store.authenticate("b".repeat(64)), null)
    assert.deepEqual(store.list(), [{
        credentialId: issued.credentialId,
        label: "node-b",
        createdAt: issued.createdAt,
        revokedAt: null,
    }])
})

test("credential lock is a private sibling and times out while its owner is active", t => {
    const { credentialsPath, root } = fixture(t)
    const lock = acquireMultiHubCredentialLock(credentialsPath, {
        timeoutMs: 20,
        pollIntervalMs: 2,
    })
    const lockPath = `${credentialsPath}.lock`

    assert.equal(lock.lockPath, lockPath)
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600)
    assert.throws(
        () => acquireMultiHubCredentialLock(credentialsPath, {
            timeoutMs: 20,
            pollIntervalMs: 2,
        }),
        { code: "MULTI_HUB_CREDENTIAL_LOCK_TIMEOUT" },
    )
    lock.release()
    assert.equal(fs.existsSync(lockPath), false)
    assert.equal(fs.readdirSync(root).some(name => name.endsWith(".lock")), false)
})

test("credential lock waits for an owner record being published", t => {
    const { credentialsPath } = fixture(t)
    const lockPath = `${credentialsPath}.lock`
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, "", { mode: 0o600 })
    let clock = 0
    let published = false

    assert.throws(() => acquireMultiHubCredentialLock(credentialsPath, {
        isProcessAlive: () => true,
        now: () => clock,
        pollIntervalMs: 1,
        sleep(milliseconds) {
            clock += milliseconds
            if (published) return
            published = true
            fs.writeFileSync(lockPath, JSON.stringify({
                schemaVersion: 1,
                ownerToken: "c".repeat(32),
                pid: process.pid,
                createdAt: 0,
            }))
        },
        timeoutMs: 5,
    }), { code: "MULTI_HUB_CREDENTIAL_LOCK_TIMEOUT" })
})

test("credential lock recovers a stale dead owner without deleting its successor", t => {
    const { credentialsPath } = fixture(t)
    const stale = acquireMultiHubCredentialLock(credentialsPath, {
        now: () => 1_000,
        ownerToken: "a".repeat(32),
        pid: 999_999,
    })
    const recovered = acquireMultiHubCredentialLock(credentialsPath, {
        isProcessAlive: () => false,
        now: () => 10_000,
        ownerToken: "b".repeat(32),
        pid: process.pid,
        staleMs: 1_000,
        timeoutMs: 20,
    })

    assert.throws(
        () => stale.release(),
        { code: "MULTI_HUB_CREDENTIAL_LOCK_REPLACED" },
    )
    assert.equal(fs.existsSync(recovered.lockPath), true)
    recovered.release()
    assert.equal(fs.existsSync(recovered.lockPath), false)
})

test("credential lock releases its own file when the operation throws", t => {
    const { credentialsPath } = fixture(t)
    const failure = new Error("operation failed")

    assert.throws(
        () => withMultiHubCredentialLock(credentialsPath, () => { throw failure }),
        error => error === failure,
    )
    assert.equal(fs.existsSync(`${credentialsPath}.lock`), false)
})

test("independent credentials revoke separately and repeated revoke is idempotent", t => {
    let clock = Date.parse("2026-08-05T00:00:00.000Z")
    const { credentialsPath, store } = fixture(t, {
        now: () => new Date(clock),
    })
    const first = store.create("node-a")
    clock += 1_000
    const second = store.create("node-b")
    clock += 1_000

    const revoked = store.revoke(first.credentialId)
    const bytesAfterRevoke = fs.readFileSync(credentialsPath)
    clock += 1_000
    const repeated = store.revoke(first.credentialId)

    assert.deepEqual(repeated, revoked)
    assert.deepEqual(fs.readFileSync(credentialsPath), bytesAfterRevoke)
    assert.equal(store.authenticate(first.token), null)
    assert.equal(store.authenticate(second.token)?.credentialId, second.credentialId)
    assert.equal(store.list().find(item => item.credentialId === second.credentialId).revokedAt, null)
})

test("new tables use 0600 and updates preserve existing permissions", t => {
    const { credentialsPath, store } = fixture(t)
    store.create("node-a")
    assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600)

    fs.chmodSync(credentialsPath, 0o400)
    store.create("node-b")
    assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o400)
})

test("atomic replacement failure preserves the previous credential table", t => {
    const target = fixture(t)
    target.store.create("node-a")
    const original = fs.readFileSync(target.credentialsPath)
    const token = "d".repeat(64)
    const failingStore = new MultiHubCredentialStore({
        credentialsPath: target.credentialsPath,
        generateToken: () => token,
        replaceFile(temporaryPath, credentialsPath) {
            assert.equal(fs.readFileSync(temporaryPath, "utf8").includes(token), false)
            assert.equal(fs.readFileSync(`${credentialsPath}.lock`, "utf8").includes(token), false)
            throw Object.assign(new Error("replace failed"), { code: "EIO" })
        },
    })

    assert.throws(() => failingStore.create("node-b"), error => error.code === "EIO")
    assert.deepEqual(fs.readFileSync(target.credentialsPath), original)
    assert.deepEqual(
        fs.readdirSync(path.dirname(target.credentialsPath)).sort(),
        [path.basename(target.credentialsPath)],
    )
})

test("strict loading rejects malformed, ambiguous, and unsupported tables", t => {
    const { credentialsPath } = fixture(t)
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
    const baseEntry = {
        credentialId: "a".repeat(32),
        label: "node-a",
        tokenDigest: "b".repeat(64),
        createdAt: "2026-08-05T00:00:00.000Z",
        revokedAt: null,
    }
    const invalidTables = [
        { schemaVersion: 2, credentials: [] },
        { schemaVersion: 1, credentials: [], extra: true },
        { schemaVersion: 1, credentials: [{ ...baseEntry, label: "" }] },
        { schemaVersion: 1, credentials: [{ ...baseEntry, label: "node\u0000a" }] },
        { schemaVersion: 1, credentials: [{ ...baseEntry, label: "node\u0085a" }] },
        { schemaVersion: 1, credentials: [{ ...baseEntry, tokenDigest: "xyz" }] },
        { schemaVersion: 1, credentials: [{ ...baseEntry, createdAt: "yesterday" }] },
        { schemaVersion: 1, credentials: [baseEntry, { ...baseEntry }] },
        {
            schemaVersion: 1,
            credentials: [baseEntry, { ...baseEntry, credentialId: "c".repeat(32) }],
        },
        {
            schemaVersion: 1,
            credentials: [{
                ...baseEntry,
                revokedAt: "2026-08-04T00:00:00.000Z",
            }],
        },
    ]

    for (const table of invalidTables) {
        fs.writeFileSync(credentialsPath, `${JSON.stringify(table)}\n`, { mode: 0o600 })
        const store = new MultiHubCredentialStore({ credentialsPath })
        assert.throws(() => store.list(), { code: "INVALID_MULTI_HUB_CREDENTIALS" })
    }
    fs.writeFileSync(credentialsPath, "{", { mode: 0o600 })
    assert.throws(
        () => new MultiHubCredentialStore({ credentialsPath }).list(),
        { code: "INVALID_MULTI_HUB_CREDENTIALS" },
    )
})

test("credential labels and revocation require exact non-empty values", t => {
    const { store } = fixture(t)
    for (const label of [
        "",
        " ",
        "\n",
        "node\u0000a",
        "node\u001fa",
        "node\u007fa",
        "node\u0085a",
        "node\u009fa",
        "node\na",
    ]) {
        assert.throws(
            () => store.create(label),
            { code: "INVALID_MULTI_HUB_CREDENTIAL_LABEL" },
        )
    }
    const issued = store.create("node-a")
    for (const credentialId of ["", issued.credentialId.slice(0, -1), `${issued.credentialId}0`]) {
        assert.throws(() => store.revoke(credentialId))
    }
})

test("a generated token collision is rejected without changing the table", t => {
    let sequence = 0
    const token = "a".repeat(64)
    const { credentialsPath, store } = fixture(t, {
        generateToken: () => token,
        generateCredentialId: () => (++sequence).toString(16).padStart(32, "0"),
    })
    store.create("node-a")
    const original = fs.readFileSync(credentialsPath)

    assert.throws(
        () => store.create("node-b"),
        { code: "DUPLICATE_MULTI_HUB_TOKEN" },
    )
    assert.deepEqual(fs.readFileSync(credentialsPath), original)
})

test("concurrent create processes preserve both credentials", async t => {
    const { credentialsPath, root } = fixture(t)

    await runConcurrentCredentialOperations(root, credentialsPath, [
        ["create", "node-a"],
        ["create", "node-b"],
    ])

    const listed = new MultiHubCredentialStore({ credentialsPath }).list()
    assert.deepEqual(listed.map(item => item.label).sort(), ["node-a", "node-b"])
    assert.equal(fs.existsSync(`${credentialsPath}.lock`), false)
    assert.equal(fs.readdirSync(path.dirname(credentialsPath)).some(name => name.endsWith(".tmp")), false)
})

test("concurrent revoke processes preserve both revocations", async t => {
    const { credentialsPath, root, store } = fixture(t)
    const first = store.create("node-a")
    const second = store.create("node-b")

    await runConcurrentCredentialOperations(root, credentialsPath, [
        ["revoke", first.credentialId],
        ["revoke", second.credentialId],
    ])

    const listed = new MultiHubCredentialStore({ credentialsPath }).list()
    assert.equal(listed.every(item => item.revokedAt !== null), true)
    assert.equal(fs.existsSync(`${credentialsPath}.lock`), false)
    assert.equal(fs.readdirSync(path.dirname(credentialsPath)).some(name => name.endsWith(".tmp")), false)
})

test("management CLI uses only the injected private table and never reprints secrets", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-hub-cli-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const credentialsPath = path.join(root, "credentials.json")
    const env = {
        ...process.env,
        MULTI_HUB_CREDENTIALS_FILE: credentialsPath,
    }
    const run = (...args) => spawnSync(
        process.execPath,
        ["tools/manage_multi_hub_token.cjs", ...args],
        { cwd: projectRoot, encoding: "utf8", env },
    )

    const created = run("create", "node-b")
    assert.equal(created.status, 0, created.stderr)
    assert.match(created.stdout, /credentialId/)
    assert.match(created.stdout, /node-b/)
    assert.match(created.stdout, /[0-9a-f]{64}/)
    const issuedToken = created.stdout.match(/[0-9a-f]{64}/)[0]
    const credentialId = JSON.parse(created.stdout).credentialId
    assert.equal(fs.readFileSync(credentialsPath, "utf8").includes(issuedToken), false)

    const listed = run("list")
    assert.equal(listed.status, 0, listed.stderr)
    assert.equal(listed.stdout.includes(issuedToken), false)
    assert.doesNotMatch(listed.stdout, /tokenDigest|"token"/)
    const listedCredentialId = JSON.parse(listed.stdout)[0].credentialId
    assert.equal(listedCredentialId, credentialId)

    const revoked = run("revoke", credentialId)
    assert.equal(revoked.status, 0, revoked.stderr)
    assert.equal(revoked.stdout.includes(issuedToken), false)
    assert.doesNotMatch(revoked.stdout, /tokenDigest|"token"/)
    assert.equal(fs.readdirSync(root).some(name => /sqlite|\.env/i.test(name)), false)

    const invalid = run("create", "")
    assert.notEqual(invalid.status, 0)

    const clientCredentialsPath = path.join(root, "client-credentials.json")
    const clientCreate = spawnSync(
        process.execPath,
        ["tools/manage_multi_hub_token.cjs", "create", "must-not-exist"],
        {
            cwd: projectRoot,
            encoding: "utf8",
            env: {
                ...env,
                MULTI_MODE: "client",
                MULTI_HUB_CREDENTIALS_FILE: clientCredentialsPath,
            },
        },
    )
    assert.notEqual(clientCreate.status, 0)
    assert.equal(fs.existsSync(clientCredentialsPath), false)
})

test("credential reloader skips unchanged files and atomically adopts valid snapshots", t => {
    const { credentialsPath, store } = fixture(t)
    const first = store.create("node-a")
    let reads = 0
    const warnings = []
    const reloader = new CredentialReloader({
        credentialsPath,
        intervalMs: 10,
        readFile(filePath) {
            reads++
            return fs.readFileSync(filePath, "utf8")
        },
        warn: warning => warnings.push(warning),
    })

    assert.equal(reloader.reloadIfChanged(), true)
    assert.equal(reads, 1)
    assert.equal(reloader.authenticate(first.token)?.credentialId, first.credentialId)
    assert.equal(reloader.reloadIfChanged(), false)
    assert.equal(reads, 1)

    const second = store.create("node-b")
    assert.equal(reloader.reloadIfChanged(), true)
    assert.equal(reads, 2)
    assert.equal(reloader.authenticate(second.token)?.credentialId, second.credentialId)
    assert.deepEqual(reloader.getStatus(), { total: 2, enabled: 2 })
    assert.deepEqual(warnings, [])
})

test("credential reloader retains the previous snapshot after malformed changes", t => {
    const { credentialsPath, store } = fixture(t)
    const issued = store.create("node-a")
    const warnings = []
    const reloader = new CredentialReloader({
        credentialsPath,
        intervalMs: 10,
        warn: warning => warnings.push(warning),
    })
    reloader.reloadIfChanged()

    fs.writeFileSync(credentialsPath, `{ "secret": "${issued.token}" }\n`, { mode: 0o600 })
    assert.equal(reloader.reloadIfChanged(), false)
    assert.equal(reloader.authenticate(issued.token)?.credentialId, issued.credentialId)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].includes(issued.token), false)
    assert.equal(warnings[0].includes(credentialsPath), false)
    assert.equal(reloader.reloadIfChanged(), false)
    assert.equal(warnings.length, 1)
})

test("credential reloader distinguishes initial missing state from a deleted valid snapshot", t => {
    const { credentialsPath, store } = fixture(t)
    const warnings = []
    const reloader = new CredentialReloader({
        credentialsPath,
        intervalMs: 10,
        warn: warning => warnings.push(warning),
    })

    assert.equal(reloader.reloadIfChanged(), false)
    assert.deepEqual(reloader.getStatus(), { total: 0, enabled: 0 })
    const first = store.create("node-a")
    assert.equal(reloader.reloadIfChanged(), true)
    assert.ok(reloader.authenticate(first.token))

    fs.unlinkSync(credentialsPath)
    assert.equal(reloader.reloadIfChanged(), false)
    assert.ok(reloader.authenticate(first.token))
    assert.deepEqual(reloader.getStatus(), { total: 1, enabled: 1 })
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].includes(credentialsPath), false)
    assert.equal(warnings[0].includes(first.token), false)

    const second = store.create("node-b")
    assert.equal(reloader.reloadIfChanged(), true)
    assert.equal(reloader.authenticate(first.token), null)
    assert.ok(reloader.authenticate(second.token))

    store.revoke(second.credentialId)
    assert.equal(reloader.reloadIfChanged(), true)
    assert.equal(reloader.isCredentialEnabled(second.credentialId), false)
    assert.equal(reloader.authenticate(second.token), null)
})

test("credential reloader treats a previously loaded empty table as a valid snapshot", t => {
    const { credentialsPath } = fixture(t)
    const warnings = []
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
    fs.writeFileSync(credentialsPath, JSON.stringify({
        schemaVersion: 1,
        credentials: [],
    }), { mode: 0o600 })
    const reloader = new CredentialReloader({
        credentialsPath,
        intervalMs: 10,
        warn: warning => warnings.push(warning),
    })

    assert.equal(reloader.reloadIfChanged(), true)
    assert.deepEqual(reloader.getStatus(), { total: 0, enabled: 0 })
    fs.unlinkSync(credentialsPath)
    assert.equal(reloader.reloadIfChanged(), false)
    assert.deepEqual(reloader.getStatus(), { total: 0, enabled: 0 })
    assert.equal(warnings.length, 1)
})

test("credential reloader starts empty, hot-loads creation and preserves peers on revoke", t => {
    const { credentialsPath, store } = fixture(t)
    const reloader = new CredentialReloader({
        credentialsPath,
        intervalMs: 10,
        warn: () => {},
    })

    assert.equal(reloader.reloadIfChanged(), false)
    assert.deepEqual(reloader.getStatus(), { total: 0, enabled: 0 })
    const first = store.create("node-a")
    const second = store.create("node-b")
    assert.equal(reloader.reloadIfChanged(), true)
    assert.ok(reloader.authenticate(first.token))
    assert.ok(reloader.authenticate(second.token))

    store.revoke(first.credentialId)
    assert.equal(reloader.reloadIfChanged(), true)
    assert.equal(reloader.isCredentialEnabled(first.credentialId), false)
    assert.equal(reloader.isCredentialEnabled(second.credentialId), true)
    assert.equal(reloader.authenticate(first.token), null)
    assert.ok(reloader.authenticate(second.token))
})
