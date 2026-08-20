"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-cleanup-admin-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { insertAccountSync, getAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const serverRoutes = require("../src/routes/web_api/server").default

function createAccount(label) {
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: label,
        status: "normal",
    })
}

test.before(() => data.initializeDatabase())
test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})
test("account cleanup admin API exposes settings and executes explicit lifecycle actions", async t => {
    const account = createAccount("admin-cleanup")
    insertDefaultPlayerSync(account.id)
    const app = Fastify({ logger: false })
    app.register(serverRoutes, { prefix: "/api/server" })
    await app.ready()
    t.after(() => app.close())

    const initial = await app.inject({ method: "GET", url: "/api/server/accountCleanup" })
    assert.equal(initial.statusCode, 200)
    assert.equal(initial.json().settings.defaultPolicy, "retain")
    assert.equal(initial.json().accounts.some(row => row.accountId === account.id), true)

    const configured = await app.inject({
        method: "POST",
        url: "/api/server/accountCleanup/settings",
        headers: { "content-type": "application/json" },
        payload: { defaultPolicy: "delete_after_timeout", timeoutMs: 1000 },
    })
    assert.equal(configured.statusCode, 200)
    assert.equal(configured.json().settings.defaultPolicy, "delete_after_timeout")

    const marked = await app.inject({
        method: "POST",
        url: "/api/server/accountCleanup/account",
        headers: { "content-type": "application/json" },
        payload: { accountId: account.id, note: "保留账号", policy: "delete_after_timeout" },
    })
    assert.equal(marked.statusCode, 200)
    assert.equal(marked.json().account.adminNote, "保留账号")

    const cleared = await app.inject({
        method: "POST",
        url: "/api/server/accountCleanup/account",
        headers: { "content-type": "application/json" },
        payload: { accountId: account.id, note: null },
    })
    assert.equal(cleared.statusCode, 200)
    assert.equal(cleared.json().account.adminNote, null)

    getDb().prepare("UPDATE accounts SET cleanup_due_at = ? WHERE id = ?")
        .run(new Date(0).toISOString(), account.id)
    const swept = await app.inject({ method: "POST", url: "/api/server/accountCleanup/run" })
    assert.deepEqual(swept.json(), { ok: true, deleted: 1 })
    assert.equal(getAccountSync(account.id), null)

    const missing = await app.inject({
        method: "POST",
        url: "/api/server/accountCleanup/delete",
        headers: { "content-type": "application/json" },
        payload: { accountId: account.id },
    })
    assert.equal(missing.statusCode, 404)
})
