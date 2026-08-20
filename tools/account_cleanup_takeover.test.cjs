"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const bcrypt = require("bcryptjs")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-cleanup-takeover-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync, getAccountSync, getAccountPlayersSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertDeviceBindingSync } = require("../src/data/domains/session")
const {
    getAccountCleanupSettingsSync,
    getAccountCleanupSummarySync,
    runDueAccountCleanupSync,
    setAccountAdminNoteSync,
    setAccountCleanupPolicySync,
    updateAccountCleanupSettingsSync,
} = require("../src/lib/account-cleanup")
const { installTakeoverUdidGuard } = require("../src/lib/takeover-access")
const takeoverRoutes = require("../src/routes/cn/takeOver").default

function createAccount(label) {
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: label,
        status: "normal",
    })
}

function createViewer(accountId, viewerId) {
    getDb().prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, 2)
    `).run(String(viewerId), accountId, "2099-12-31T23:59:59.000Z")
}

function responseJson(response) {
    return JSON.parse(response.payload)
}

test.before(() => {
    data.initializeDatabase()
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test("account cleanup defaults to retain and deletes only due unmarked accounts", () => {
    assert.equal(getAccountCleanupSettingsSync().defaultPolicy, "retain")

    const retained = createAccount("cleanup-retained")
    const scheduled = createAccount("cleanup-scheduled")
    setAccountCleanupPolicySync(scheduled.id, "delete_after_timeout", new Date("2026-08-20T00:00:00.000Z"))
    assert.equal(getAccountCleanupSummarySync(scheduled.id).cleanupPolicy, "delete_after_timeout")
    assert.ok(getAccountCleanupSummarySync(scheduled.id).cleanupDueAt)

    setAccountAdminNoteSync(scheduled.id, "保留")
    assert.equal(runDueAccountCleanupSync(new Date("2026-08-24T00:00:00.000Z")), 0)
    assert.ok(getAccountSync(scheduled.id))

    setAccountAdminNoteSync(scheduled.id, null, new Date("2026-08-20T00:00:00.000Z"))
    assert.equal(runDueAccountCleanupSync(new Date("2026-08-24T00:00:00.000Z")), 1)
    assert.equal(getAccountSync(scheduled.id), null)
    assert.ok(getAccountSync(retained.id))

    updateAccountCleanupSettingsSync("delete_after_timeout", 3 * 24 * 60 * 60 * 1000)
    const defaultScheduled = createAccount("cleanup-default-scheduled")
    assert.equal(getAccountSync(defaultScheduled.id).cleanupPolicy, "delete_after_timeout")
    updateAccountCleanupSettingsSync("retain", 3 * 24 * 60 * 60 * 1000)
})

test("takeover deletes an unmarked source and preserves a marked source", async t => {
    const target = createAccount("takeover-target")
    const targetPlayer = insertDefaultPlayerSync(target.id)
    const targetViewer = 300000001
    createViewer(target.id, targetViewer)
    getDb().prepare(`UPDATE accounts SET takeover_password_hash = ?, takeover_udid = ? WHERE id = ?`)
        .run(bcrypt.hashSync("Abc12345", 4), "old-target-udid", target.id)

    const source = createAccount("takeover-source")
    const sourcePlayer = insertDefaultPlayerSync(source.id)
    const sourceViewer = 300000002
    createViewer(source.id, sourceViewer)
    insertDeviceBindingSync(880001, source.id)

    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, _reply, payload, done) => {
        done(null, typeof payload === "string" ? payload : JSON.stringify(payload))
    })
    installTakeoverUdidGuard(app)
    app.register(takeoverRoutes, { prefix: "/api/index.php" })
    app.post("/api/index.php/guard-test", async () => ({ ok: true }))
    await app.ready()
    t.after(() => app.close())

    const preview = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over/get_user_data_by_take_over_data",
        headers: { "content-type": "application/json", udid: "new-udid" },
        payload: { viewer_id: sourceViewer, input_viewer_id: targetViewer, input_password: "Abc12345" },
    })
    assert.equal(preview.statusCode, 200, preview.payload)
    assert.equal(responseJson(preview).data.linked_user.viewer_id, targetViewer)

    const transferred = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over/take_over_by_take_over_data",
        headers: { "content-type": "application/json", udid: "new-udid" },
        payload: {
            viewer_id: sourceViewer,
            input_viewer_id: targetViewer,
            input_password: "Abc12345",
            device_id: 880001,
        },
    })
    assert.equal(transferred.statusCode, 200)
    assert.equal(responseJson(transferred).data.abolished_viewer_id, sourceViewer)
    assert.equal(getAccountSync(source.id), null)
    assert.deepEqual(getAccountPlayersSync(target.id), [targetPlayer.id])
    assert.equal(getDb().prepare(`SELECT account_id FROM device_bindings WHERE device_id = 880001`).get().account_id, target.id)

    const oldAccess = await app.inject({
        method: "POST",
        url: "/api/index.php/guard-test",
        headers: { "content-type": "application/json", udid: "old-target-udid" },
        payload: { viewer_id: targetViewer },
    })
    assert.equal(responseJson(oldAccess).data_headers.result_code, 516)

    const markedSource = createAccount("takeover-marked-source")
    const markedPlayer = insertDefaultPlayerSync(markedSource.id)
    const markedViewer = 300000003
    createViewer(markedSource.id, markedViewer)
    insertDeviceBindingSync(880002, markedSource.id)
    setAccountAdminNoteSync(markedSource.id, "朋友账号")

    const preserved = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over/take_over_by_take_over_data",
        headers: { "content-type": "application/json", udid: "newer-udid" },
        payload: {
            viewer_id: markedViewer,
            input_viewer_id: targetViewer,
            input_password: "Abc12345",
            device_id: 880002,
        },
    })
    assert.equal(preserved.statusCode, 200)
    assert.equal(getAccountSync(markedSource.id).cleanupState, "orphaned")
    assert.equal(getDb().prepare(`SELECT 1 FROM device_bindings WHERE account_id = ?`).get(markedSource.id), undefined)
    assert.equal(getAccountPlayersSync(markedSource.id)[0], markedPlayer.id)
})

console.log("account cleanup and takeover tests loaded")
