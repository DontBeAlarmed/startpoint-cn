"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pass-point-change-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    addPlayerPassCardPointSync,
    addPlayerPassCardPointWithChangeSync,
    getPlayerPassCardStateSync,
} = require("../src/data/domains/pass-card")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")

initializeDatabase()
const db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `pass-point-change-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

function rowCount(eventId) {
    return db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_pass_cards
        WHERE player_id = ? AND event_id = ?
    `).get(playerId, eventId).count
}

test("maxPoint zero leaves an absent Pass state absent and unchanged", () => {
    assert.deepEqual(
        addPlayerPassCardPointWithChangeSync(playerId, 901, 10, 0),
        { point: 0, changed: false },
    )
    assert.equal(rowCount(901), 0)
    assert.equal(getPlayerPassCardStateSync(playerId, 901).point, 0)
})

test("an existing capped Pass state remains unchanged", () => {
    assert.equal(addPlayerPassCardPointSync(playerId, 902, 100, 100), 100)
    assert.deepEqual(
        addPlayerPassCardPointWithChangeSync(playerId, 902, 10, 100),
        { point: 100, changed: false },
    )
    assert.equal(rowCount(902), 1)
})

test("amount zero returns the real absent Pass point without initializing a row", () => {
    assert.deepEqual(
        addPlayerPassCardPointWithChangeSync(playerId, 903, 0, 100),
        { point: 0, changed: false },
    )
    assert.equal(rowCount(903), 0)
})

test("amount zero returns the real existing Pass point", () => {
    assert.equal(addPlayerPassCardPointSync(playerId, 904, 40, 100), 40)
    assert.deepEqual(
        addPlayerPassCardPointWithChangeSync(playerId, 904, 0, 100),
        { point: 40, changed: false },
    )
    assert.equal(getPlayerPassCardStateSync(playerId, 904).point, 40)
})

test("normal Pass insert and update report actual changes", () => {
    assert.deepEqual(
        addPlayerPassCardPointWithChangeSync(playerId, 905, 10, 100),
        { point: 10, changed: true },
    )
    assert.deepEqual(
        addPlayerPassCardPointWithChangeSync(playerId, 905, 5, 100),
        { point: 15, changed: true },
    )
    assert.equal(rowCount(905), 1)
})

test("an existing point above the current limit is returned unchanged", () => {
    assert.equal(addPlayerPassCardPointSync(playerId, 906, 200), 200)
    assert.deepEqual(
        addPlayerPassCardPointWithChangeSync(playerId, 906, 10, 100),
        { point: 200, changed: false },
    )
    assert.equal(getPlayerPassCardStateSync(playerId, 906).point, 200)
})

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
