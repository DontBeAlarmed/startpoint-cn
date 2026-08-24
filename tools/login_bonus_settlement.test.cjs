"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "login-bonus-settlement-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: ["login_bonus_normal.json"],
})
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    confirmNormalLoginBonusShownSync,
    getPlayerNormalLoginBonusProgressSync,
    settleNormalLoginBonusSync,
} = require("../src/lib/login-bonus")

const catalog = require("../assets/login_bonus_normal.json")
let database

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function at(value) {
    return Date.parse(value)
}

test.before(() => {
    database = data.initializeDatabase()
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("Normal login reward grant is atomic and pending loads are idempotent", () => {
    const playerId = createPlayer("idempotent")
    const before = getPlayerSync(playerId)
    const virtualNowMs = at("2024-08-14T12:00:00.000Z")

    const first = settleNormalLoginBonusSync({ playerId, virtualNowMs, dailyResetHour: 5, catalog })
    const repeated = settleNormalLoginBonusSync({ playerId, virtualNowMs, dailyResetHour: 5, catalog })

    assert.equal(first.status, "granted")
    assert.deepEqual(first.bonus, {
        groupId: "normal_2022",
        index: 1,
        receivedAt: Math.floor(virtualNowMs / 1000),
    })
    assert.equal(first.grant.aggregate.user_info.free_vmoney, 50)
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney + 50)
    assert.equal(repeated.status, "pending")
    assert.deepEqual(repeated.bonus, first.bonus)
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney + 50)

    assert.deepEqual(getPlayerNormalLoginBonusProgressSync(playerId), {
        groupId: "normal_2022",
        lastGrantedIndex: 1,
        lastGrantedBusinessDay: "2024-08-14",
        receivedAt: Math.floor(virtualNowMs / 1000),
        shownAt: null,
    })
})

test("shown acknowledgement is idempotent and same-day load does not grant again", () => {
    const playerId = createPlayer("shown")
    const virtualNowMs = at("2024-08-14T12:00:00.000Z")
    settleNormalLoginBonusSync({ playerId, virtualNowMs, dailyResetHour: 5, catalog })

    assert.equal(confirmNormalLoginBonusShownSync(playerId, virtualNowMs + 1_000), true)
    assert.equal(confirmNormalLoginBonusShownSync(playerId, virtualNowMs + 2_000), false)
    assert.equal(
        settleNormalLoginBonusSync({ playerId, virtualNowMs, dailyResetHour: 5, catalog }).status,
        "none",
    )
})

test("Normal cursor advances through CDN rewards and wraps at the group end", () => {
    const playerId = createPlayer("cycle")
    const start = at("2024-08-14T12:00:00.000Z")
    const initial = getPlayerSync(playerId)
    const initialItem101 = getPlayerItemSync(playerId, 101) ?? 0
    const initialItem100000 = getPlayerItemSync(playerId, 100000) ?? 0
    const initialItem10001 = getPlayerItemSync(playerId, 10001) ?? 0

    const indices = []
    for (let day = 0; day < 5; day++) {
        const now = start + day * 86_400_000
        const result = settleNormalLoginBonusSync({ playerId, virtualNowMs: now, dailyResetHour: 5, catalog })
        indices.push(result.bonus.index)
        confirmNormalLoginBonusShownSync(playerId, now + 1_000)
    }

    assert.deepEqual(indices, [1, 2, 3, 4, 1])
    const player = getPlayerSync(playerId)
    assert.equal(player.freeVmoney, initial.freeVmoney + 100)
    assert.equal(player.freeMana, initial.freeMana + 1500)
    assert.equal(player.expPool, initial.expPool + 5000)
    assert.equal(getPlayerItemSync(playerId, 101), initialItem101 + 6)
    assert.equal(getPlayerItemSync(playerId, 100000), initialItem100000 + 25)
    assert.equal(getPlayerItemSync(playerId, 10001), initialItem10001 + 1)
})

test("active CDN group changes reset the cursor to index 1", () => {
    const playerId = createPlayer("group-change")
    const customCatalog = {
        old: {
            availableFromMs: at("2024-08-01T00:00:00.000Z"),
            availableUntilMs: at("2024-08-14T23:59:59.000Z"),
            entries: [
                { index: 1, rewards: [{ kind: 0, count: 10 }] },
                { index: 2, rewards: [{ kind: 0, count: 20 }] },
            ],
        },
        current: {
            availableFromMs: at("2024-08-15T00:00:00.000Z"),
            availableUntilMs: null,
            entries: [
                { index: 1, rewards: [{ kind: 0, count: 30 }] },
                { index: 2, rewards: [{ kind: 0, count: 40 }] },
            ],
        },
    }
    const firstMs = at("2024-08-14T12:00:00.000Z")
    const secondMs = at("2024-08-15T12:00:00.000Z")

    const first = settleNormalLoginBonusSync({
        playerId, virtualNowMs: firstMs, dailyResetHour: 5, catalog: customCatalog,
    })
    confirmNormalLoginBonusShownSync(playerId, firstMs + 1_000)
    const second = settleNormalLoginBonusSync({
        playerId, virtualNowMs: secondMs, dailyResetHour: 5, catalog: customCatalog,
    })

    assert.deepEqual([first.bonus.groupId, first.bonus.index], ["old", 1])
    assert.deepEqual([second.bonus.groupId, second.bonus.index], ["current", 1])
})

test("virtual time rollback and CDN gaps do not grant rewards", () => {
    const playerId = createPlayer("rollback")
    const laterMs = at("2024-08-15T12:00:00.000Z")
    settleNormalLoginBonusSync({ playerId, virtualNowMs: laterMs, dailyResetHour: 5, catalog })
    confirmNormalLoginBonusShownSync(playerId, laterMs + 1_000)
    const beforeRollback = getPlayerSync(playerId)

    assert.equal(settleNormalLoginBonusSync({
        playerId,
        virtualNowMs: at("2024-08-14T12:00:00.000Z"),
        dailyResetHour: 5,
        catalog,
    }).status, "none")
    assert.equal(settleNormalLoginBonusSync({
        playerId,
        virtualNowMs: at("2020-06-01T12:00:00.000Z"),
        dailyResetHour: 5,
        catalog,
    }).status, "none")
    assert.equal(getPlayerSync(playerId).freeVmoney, beforeRollback.freeVmoney)
})

test("late progress write failure rolls back the granted inventory", t => {
    const playerId = createPlayer("rollback-write")
    const before = getPlayerSync(playerId)
    database.exec(`
        CREATE TRIGGER fail_login_bonus_progress
        BEFORE INSERT ON players_login_bonus_progress
        WHEN NEW.player_id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'forced login bonus progress failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS fail_login_bonus_progress"))

    assert.throws(
        () => settleNormalLoginBonusSync({
            playerId,
            virtualNowMs: at("2024-08-14T12:00:00.000Z"),
            dailyResetHour: 5,
            catalog,
        }),
        /forced login bonus progress failure/i,
    )
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney)
    assert.equal(getPlayerNormalLoginBonusProgressSync(playerId), null)
})
