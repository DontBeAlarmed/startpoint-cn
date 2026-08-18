"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "non-multi-mixed-fixture-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let closeDatabase = () => false
let cleaned = false
function cleanup() {
    if (cleaned) return
    cleaned = true
    try {
        closeDatabase()
    } finally {
        fs.rmSync(databaseDirectory, { recursive: true, force: true })
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
        if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
        else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    }
}
process.once("exit", cleanup)
test.after(cleanup)

const {
    ENTRY_NAMES,
    FORMAL_ACTIVE_IDENTITIES,
    FORMAL_ENTRY_REQUESTS,
    FORMAL_INDEPENDENT_SAVES,
} = require("./non_multi_mixed_metrics.cjs")
const {
    createIdentityPoolPlan,
    seedNonMultiMixedFixture,
} = require("./non_multi_mixed_fixture.cjs")
const data = require("../../src/data")
const { getDb } = require("../../src/data/db")
const { insertAccountSync } = require("../../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
const { getSessionSync, insertDeviceBindingSync } = require("../../src/data/domains/session")
const { SessionType } = require("../../src/data/types")

closeDatabase = data.closeDatabase
data.initializeDatabase()
const db = getDb()

function clearIdentityTables() {
    db.prepare("DELETE FROM accounts").run()
}

test.beforeEach(clearIdentityTables)
test.afterEach(clearIdentityTables)

const dataApi = {
    getDb,
    insertAccountSync,
    insertDefaultPlayerSync,
    insertDeviceBindingSync,
}

function insertFixtureAccount(label) {
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: label,
        status: "normal",
    })
}

function identityState() {
    return {
        accounts: db.prepare("SELECT id, idp_id FROM accounts ORDER BY id").all(),
        players: db.prepare("SELECT id, account_id FROM players ORDER BY id").all(),
        deviceBindings: db.prepare(`
            SELECT device_id, account_id, name FROM device_bindings ORDER BY device_id
        `).all(),
        sessions: db.prepare(`
            SELECT token, account_id, expires, type FROM sessions ORDER BY token
        `).all(),
    }
}

function values(records, field) {
    return records.map(record => record[field])
}

function assertUniquePositiveSafeIntegers(records, field) {
    const ids = values(records, field)
    assert.equal(new Set(ids).size, records.length, `${field} must be unique`)
    for (const id of ids) {
        assert.equal(Number.isSafeInteger(id), true, `${field} must be a safe integer`)
        assert.ok(id > 0, `${field} must be positive`)
    }
}

function entryCounts(assignments) {
    return ENTRY_NAMES.map(entryName => assignments.filter(value => value === entryName).length)
}

test("small pools use deterministic balanced entry partitions", () => {
    const first = createIdentityPoolPlan({ independentSaves: 9, activeIdentities: 8 })
    const second = createIdentityPoolPlan({ independentSaves: 9, activeIdentities: 8 })

    assert.deepEqual(second, first)
    assert.equal(first.mode, "smoke")
    assert.deepEqual(first.entryRequests, [2, 1, 1, 1, 1, 1, 1])
    assert.deepEqual(first.entryAssignments, [
        "auth",
        "auth",
        "load",
        "mission-progress",
        "single-battle",
        "shop",
        "gacha",
        "mail",
        null,
    ])
    assert.ok(Object.isFrozen(first))
    assert.ok(Object.isFrozen(first.entryRequests))
    assert.ok(Object.isFrozen(first.entryAssignments))
})

test("pool requires one active identity for every entry", () => {
    assert.throws(
        () => createIdentityPoolPlan({ independentSaves: 7, activeIdentities: 6 }),
        /activeIdentities must be at least 7/,
    )

    const plan = createIdentityPoolPlan({ independentSaves: 7, activeIdentities: 7 })
    assert.deepEqual(plan.entryRequests, [1, 1, 1, 1, 1, 1, 1])
    assert.deepEqual(plan.entryAssignments, ENTRY_NAMES)
})

test("formal plan has 1000 independent slots and exact physical entry partitions", () => {
    const plan = createIdentityPoolPlan({
        independentSaves: FORMAL_INDEPENDENT_SAVES,
        activeIdentities: FORMAL_ACTIVE_IDENTITIES,
    })

    assert.equal(plan.mode, "formal")
    assert.equal(plan.entryAssignments.length, 1000)
    assert.deepEqual(plan.entryRequests, FORMAL_ENTRY_REQUESTS)
    assert.deepEqual(entryCounts(plan.entryAssignments), FORMAL_ENTRY_REQUESTS)
    assert.equal(plan.entryAssignments.slice(0, 86).every(name => name === "auth"), true)
    assert.equal(plan.entryAssignments.slice(86, 172).every(name => name === "load"), true)
    assert.equal(plan.entryAssignments.slice(600).every(name => name === null), true)
})

test("seed creates independent persisted identities and frozen caller snapshots", () => {
    const pool = seedNonMultiMixedFixture(dataApi, {
        independentSaves: 9,
        activeIdentities: 8,
    })

    assert.equal(pool.mode, "smoke")
    assert.equal(pool.identities.length, 9)
    assert.equal(pool.activeIdentities.length, 8)
    assert.equal(pool.inactiveIdentities.length, 1)
    assert.deepEqual(pool.entryRequests, [2, 1, 1, 1, 1, 1, 1])
    assert.deepEqual(values(pool.identities, "entryName"), [
        "auth",
        "auth",
        "load",
        "mission-progress",
        "single-battle",
        "shop",
        "gacha",
        "mail",
        null,
    ])

    for (const field of ["accountId", "playerId", "viewerId", "deviceId"]) {
        assertUniquePositiveSafeIntegers(pool.identities, field)
    }
    assert.equal(new Set(pool.identities).size, pool.identities.length)

    assert.ok(Object.isFrozen(pool))
    assert.ok(Object.isFrozen(pool.identities))
    assert.ok(Object.isFrozen(pool.activeIdentities))
    assert.ok(Object.isFrozen(pool.inactiveIdentities))
    assert.ok(Object.isFrozen(pool.entryRequests))
    assert.equal(pool.identities.every(Object.isFrozen), true)
    assert.throws(() => { pool.identities[0].accountId = -1 }, TypeError)
    assert.throws(() => { pool.activeIdentities.push(pool.identities[8]) }, TypeError)

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 9)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players").get().count, 9)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM device_bindings").get().count, 9)
    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE type = ?")
            .get(SessionType.VIEWER).count,
        9,
    )

    const selectPlayer = db.prepare("SELECT account_id FROM players WHERE id = ?")
    const selectBinding = db.prepare("SELECT account_id FROM device_bindings WHERE device_id = ?")
    const selectSession = db.prepare("SELECT account_id, type FROM sessions WHERE token = ?")
    for (const identity of pool.identities) {
        assert.equal(selectPlayer.get(identity.playerId).account_id, identity.accountId)
        assert.equal(selectBinding.get(identity.deviceId).account_id, identity.accountId)
        assert.deepEqual(selectSession.get(String(identity.viewerId)), {
            account_id: identity.accountId,
            type: SessionType.VIEWER,
        })
        assert.deepEqual(getSessionSync(String(identity.viewerId)), {
            token: String(identity.viewerId),
            accountId: identity.accountId,
            expires: new Date(0),
            type: SessionType.VIEWER,
        })
    }
})

test("seed rejects a pre-existing device binding without changing its account", () => {
    const existingAccount = insertFixtureAccount("existing-mixed-fixture-account")
    const existingDeviceId = 700000001
    insertDeviceBindingSync(existingDeviceId, existingAccount.id, "existing binding")
    const before = identityState()

    assert.throws(
        () => seedNonMultiMixedFixture(dataApi, {
            independentSaves: 7,
            activeIdentities: 7,
        }),
        /mixed fixture requires empty identity tables/,
    )

    assert.deepEqual(identityState(), before)
    assert.deepEqual(db.prepare(`
        SELECT device_id, account_id, name FROM device_bindings WHERE device_id = ?
    `).get(existingDeviceId), {
        device_id: existingDeviceId,
        account_id: existingAccount.id,
        name: "existing binding",
    })
})

test("repeated seed is rejected without changing the original pool", () => {
    const pool = seedNonMultiMixedFixture(dataApi, {
        independentSaves: 7,
        activeIdentities: 7,
    })
    const before = identityState()

    assert.throws(
        () => seedNonMultiMixedFixture(dataApi, {
            independentSaves: 7,
            activeIdentities: 7,
        }),
        /mixed fixture requires empty identity tables/,
    )

    assert.deepEqual(identityState(), before)
    for (const identity of pool.identities) {
        assert.equal(
            db.prepare("SELECT account_id FROM device_bindings WHERE device_id = ?")
                .get(identity.deviceId).account_id,
            identity.accountId,
        )
        assert.equal(
            db.prepare("SELECT account_id FROM sessions WHERE token = ?")
                .get(String(identity.viewerId)).account_id,
            identity.accountId,
        )
    }
})

test("seed rolls back all identity tables when the second player creation fails", () => {
    let playerInsertCalls = 0
    const failingDataApi = {
        ...dataApi,
        insertDefaultPlayerSync(accountId) {
            playerInsertCalls++
            if (playerInsertCalls === 2) throw new Error("injected second identity failure")
            return insertDefaultPlayerSync(accountId)
        },
    }
    const before = identityState()

    assert.throws(
        () => seedNonMultiMixedFixture(failingDataApi, {
            independentSaves: 7,
            activeIdentities: 7,
        }),
        /injected second identity failure/,
    )

    assert.equal(playerInsertCalls, 2)
    assert.deepEqual(identityState(), before)
})

test("invalid pool sizes fail closed before touching runtime dependencies", () => {
    const invalidProfiles = [
        { independentSaves: 0, activeIdentities: 1 },
        { independentSaves: 1, activeIdentities: 0 },
        { independentSaves: -1, activeIdentities: 1 },
        { independentSaves: 1, activeIdentities: -1 },
        { independentSaves: 1, activeIdentities: 2 },
        { independentSaves: 1.5, activeIdentities: 1 },
        { independentSaves: 2, activeIdentities: Number.MAX_SAFE_INTEGER + 1 },
    ]
    const runtime = new Proxy({}, {
        get() {
            throw new Error("runtime dependency accessed")
        },
    })

    for (const profile of invalidProfiles) {
        assert.throws(() => createIdentityPoolPlan(profile), /positive safe integers|cannot exceed/)
        assert.throws(
            () => seedNonMultiMixedFixture(runtime, profile),
            /positive safe integers|cannot exceed/,
        )
    }
})
