"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const {
    MultiHubCredentialStore,
} = require("../src/multi/hub/credential-store")

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

test("new and replaced credential tables remain owner-readable only", t => {
    const { credentialsPath, store } = fixture(t)
    store.create("node-a")
    assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600)

    fs.chmodSync(credentialsPath, 0o644)
    store.create("node-b")
    assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600)
})

test("atomic replacement failure preserves the previous credential table", t => {
    const target = fixture(t)
    target.store.create("node-a")
    const original = fs.readFileSync(target.credentialsPath)
    const failingStore = new MultiHubCredentialStore({
        credentialsPath: target.credentialsPath,
        replaceFile() {
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
    for (const label of ["", " ", "\n"]) assert.throws(() => store.create(label))
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
    assert.match(listedCredentialId, /^[0-9a-f]{8}\.\.\.$/)
    assert.notEqual(listedCredentialId, credentialId)

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
