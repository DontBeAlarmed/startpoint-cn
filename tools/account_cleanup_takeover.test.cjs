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

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => { restoreContentSnapshot() })

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

test("takeover source must be anchored to the requesting device binding", async t => {
    const target = createAccount("takeover-anchor-target")
    const targetPlayer = insertDefaultPlayerSync(target.id)
    const targetViewer = 300000011
    createViewer(target.id, targetViewer)
    getDb().prepare(`UPDATE accounts SET takeover_password_hash = ?, takeover_udid = ? WHERE id = ?`)
        .run(bcrypt.hashSync("Abc12345", 4), "anchor-old-udid", target.id)

    const victim = createAccount("takeover-anchor-victim")
    const victimPlayer = insertDefaultPlayerSync(victim.id)
    const victimViewer = 300000012
    createViewer(victim.id, victimViewer)
    insertDeviceBindingSync(880011, victim.id)

    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, _reply, payload, done) => {
        done(null, typeof payload === "string" ? payload : JSON.stringify(payload))
    })
    installTakeoverUdidGuard(app)
    app.register(takeoverRoutes, { prefix: "/api/index.php" })
    await app.ready()
    t.after(() => app.close())

    // Knowing a victim viewer_id must not be enough to abolish the victim
    // account: an unbound device id has no device-local source.
    const attack = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over/take_over_by_take_over_data",
        headers: { "content-type": "application/json", udid: "attacker-udid" },
        payload: {
            viewer_id: victimViewer,
            input_viewer_id: targetViewer,
            input_password: "Abc12345",
            device_id: 999999,
        },
    })
    assert.equal(attack.statusCode, 200)
    assert.equal(responseJson(attack).data.abolished_viewer_id, 0)
    assert.ok(getAccountSync(victim.id))
    assert.deepEqual(getAccountPlayersSync(victim.id), [victimPlayer.id])
    assert.equal(getDb().prepare(
        "SELECT account_id FROM device_bindings WHERE device_id = 999999",
    ).get().account_id, target.id)
    assert.equal(getDb().prepare(
        "SELECT account_id FROM device_bindings WHERE device_id = 880011",
    ).get().account_id, victim.id)

    // A viewer session that disagrees with the device binding must not turn
    // the bound account into a source either.
    const other = createAccount("takeover-anchor-other")
    const otherPlayer = insertDefaultPlayerSync(other.id)
    const otherViewer = 300000013
    createViewer(other.id, otherViewer)
    const mismatch = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over/take_over_by_take_over_data",
        headers: { "content-type": "application/json", udid: "mismatch-udid" },
        payload: {
            viewer_id: otherViewer,
            input_viewer_id: targetViewer,
            input_password: "Abc12345",
            device_id: 880011,
        },
    })
    assert.equal(mismatch.statusCode, 200)
    assert.equal(responseJson(mismatch).data.abolished_viewer_id, 0)
    assert.ok(getAccountSync(other.id))
    assert.deepEqual(getAccountPlayersSync(other.id), [otherPlayer.id])

    // A fresh device without a local account transfers nothing and just binds.
    const fresh = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over/take_over_by_take_over_data",
        headers: { "content-type": "application/json", udid: "fresh-udid" },
        payload: {
            input_viewer_id: targetViewer,
            input_password: "Abc12345",
            device_id: 999998,
        },
    })
    assert.equal(fresh.statusCode, 200)
    assert.equal(responseJson(fresh).data.abolished_viewer_id, 0)
    assert.equal(getDb().prepare(
        "SELECT account_id FROM device_bindings WHERE device_id = 999998",
    ).get().account_id, target.id)

    // A wrong password leaves every account and binding untouched.
    const bindingsBeforeFailure = JSON.stringify(getDb().prepare(
        "SELECT device_id, account_id FROM device_bindings ORDER BY device_id",
    ).all())
    const wrongPassword = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over/take_over_by_take_over_data",
        headers: { "content-type": "application/json", udid: "wrong-udid" },
        payload: {
            viewer_id: victimViewer,
            input_viewer_id: targetViewer,
            input_password: "WrongPass1",
            device_id: 880011,
        },
    })
    assert.equal(responseJson(wrongPassword).data_headers.result_code, 3204)
    assert.ok(getAccountSync(victim.id))
    assert.ok(getAccountSync(target.id))
    assert.equal(JSON.stringify(getDb().prepare(
        "SELECT device_id, account_id FROM device_bindings ORDER BY device_id",
    ).all()), bindingsBeforeFailure)

    // Repeating the takeover from the device now bound to the target must not
    // treat the target as its own source.
    const repeat = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over/take_over_by_take_over_data",
        headers: { "content-type": "application/json", udid: "fresh-udid" },
        payload: {
            viewer_id: targetViewer,
            input_viewer_id: targetViewer,
            input_password: "Abc12345",
            device_id: 999999,
        },
    })
    assert.equal(repeat.statusCode, 200)
    assert.equal(responseJson(repeat).data.abolished_viewer_id, 0)
    assert.ok(getAccountSync(target.id))
    assert.deepEqual(getAccountPlayersSync(target.id), [targetPlayer.id])
})

test("takeover re-registration stays owned by the takeover_udid device", async t => {
    const owner = createAccount("takeover-reregister-owner")
    const ownerViewer = 300000021
    createViewer(owner.id, ownerViewer)
    getDb().prepare(`UPDATE accounts SET takeover_password_hash = ?, takeover_udid = ? WHERE id = ?`)
        .run(bcrypt.hashSync("OwnerPass1", 4), "owner-udid", owner.id)

    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, _reply, payload, done) => {
        done(null, typeof payload === "string" ? payload : JSON.stringify(payload))
    })
    installTakeoverUdidGuard(app)
    app.register(takeoverRoutes, { prefix: "/api/index.php" })
    await app.ready()
    t.after(() => app.close())

    const credentialsBefore = JSON.stringify(getDb().prepare(
        "SELECT takeover_password_hash, takeover_udid FROM accounts WHERE id = ?",
    ).get(owner.id))

    // Knowing the victim viewer id is not enough to overwrite existing
    // takeover credentials: the 516 guard rejects foreign devices before the
    // handler runs.
    const attacker = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over_register/register_take_over_data",
        headers: { "content-type": "application/json", udid: "attacker-udid" },
        payload: { viewer_id: ownerViewer, input_password: "Attacker99" },
    })
    assert.equal(attacker.statusCode, 200)
    assert.equal(responseJson(attacker).data_headers.result_code, 516)
    assert.equal(JSON.stringify(getDb().prepare(
        "SELECT takeover_password_hash, takeover_udid FROM accounts WHERE id = ?",
    ).get(owner.id)), credentialsBefore, "foreign device must not overwrite credentials")

    // The device holding the takeover udid may legitimately reset its password.
    const ownerReset = await app.inject({
        method: "POST",
        url: "/api/index.php/take_over_register/register_take_over_data",
        headers: { "content-type": "application/json", udid: "owner-udid" },
        payload: { viewer_id: ownerViewer, input_password: "NewOwner88" },
    })
    assert.equal(ownerReset.statusCode, 200)
    assert.equal(responseJson(ownerReset).data_headers.result_code, 1)
    assert.equal(responseJson(ownerReset).data.registered_viewer_id, ownerViewer)
    const afterReset = getDb().prepare(
        "SELECT takeover_password_hash, takeover_udid FROM accounts WHERE id = ?",
    ).get(owner.id)
    assert.equal(afterReset.takeover_udid, "owner-udid")
    assert.ok(bcrypt.compareSync("NewOwner88", afterReset.takeover_password_hash))
    assert.equal(bcrypt.compareSync("OwnerPass1", afterReset.takeover_password_hash), false)
})

console.log("account cleanup and takeover tests loaded")
