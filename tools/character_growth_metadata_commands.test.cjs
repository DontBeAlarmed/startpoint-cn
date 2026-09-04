"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-metadata-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const {
    setCharacterIllustrationSettings,
    setCharacterProtection,
} = require("../src/lib/character-growth/commands/set-character-metadata")
const { setCharacterExBoostWithinTransactionSync } = require("../src/lib/character-growth/commands/set-ex-boost")
const { clearPlayerCharactersExBoostSync } = require("../src/data/domains/character")

initializeDatabase()
const db = getDb()

const PROTAGONIST_ID = 1

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `metadata-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

test.after(() => {
    if (db.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("setCharacterProtection toggles owned ids and skips unknown ones", () => {
    const playerId = createPlayer()

    const updated = setCharacterProtection({
        playerId,
        characterIds: [PROTAGONIST_ID, 999999, PROTAGONIST_ID],
        protection: true,
    })

    assert.deepEqual(updated.map(row => row.characterId), [PROTAGONIST_ID])
    assert.equal(updated[0].character.protection, true)
    assert.equal(getPlayerCharacterSync(playerId, PROTAGONIST_ID).protection, true)

    setCharacterProtection({ playerId, characterIds: [PROTAGONIST_ID], protection: false })
    assert.equal(getPlayerCharacterSync(playerId, PROTAGONIST_ID).protection, false)
})

test("setCharacterIllustrationSettings persists the six-slot whitelist value", () => {
    const playerId = createPlayer()

    setCharacterIllustrationSettings({
        playerId,
        characterId: PROTAGONIST_ID,
        illustrationSettings: [1, 0, 2, 0, 0, 3],
    })
    assert.deepEqual(
        getPlayerCharacterSync(playerId, PROTAGONIST_ID).illustrationSettings,
        [1, 0, 2, 0, 0, 3],
    )

    assert.throws(
        () => setCharacterIllustrationSettings({
            playerId,
            characterId: PROTAGONIST_ID,
            illustrationSettings: [1, 2, 3],
        }),
        error => error.code === "INVALID_REQUEST",
    )
    assert.throws(
        () => setCharacterIllustrationSettings({
            playerId,
            characterId: PROTAGONIST_ID,
            illustrationSettings: [1, 0, 2, 0, 0, -1],
        }),
        error => error.code === "INVALID_REQUEST",
    )
    assert.throws(
        () => setCharacterIllustrationSettings({
            playerId,
            characterId: 999999,
            illustrationSettings: [0, 0, 0, 0, 0, 0],
        }),
        error => error.code === "CHARACTER_NOT_OWNED",
    )
})

test("setCharacterExBoostWithinTransactionSync writes the pair and reports the update time", () => {
    const playerId = createPlayer()

    const result = getDb().transaction(() => setCharacterExBoostWithinTransactionSync({
        playerId,
        characterId: PROTAGONIST_ID,
        statusId: 3,
        abilityIdList: [101, 102],
    }))()

    assert.ok(result.updateTime instanceof Date)
    const character = getPlayerCharacterSync(playerId, PROTAGONIST_ID)
    assert.equal(character.exBoost.statusId, 3)
    assert.deepEqual(character.exBoost.abilityIdList, [101, 102])

    assert.throws(
        () => getDb().transaction(() => setCharacterExBoostWithinTransactionSync({
            playerId,
            characterId: 999999,
            statusId: 3,
            abilityIdList: [101],
        }))(),
        error => error.code === "CHARACTER_NOT_OWNED",
    )
    assert.throws(
        () => getDb().transaction(() => setCharacterExBoostWithinTransactionSync({
            playerId,
            characterId: PROTAGONIST_ID,
            statusId: 0,
            abilityIdList: [101],
        }))(),
        error => error.code === "INVALID_REQUEST",
    )
})

test("clearPlayerCharactersExBoostSync clears only populated rows", () => {
    const playerId = createPlayer()
    db.prepare(`
        UPDATE players_characters
        SET ex_boost_status_id = 3, ex_boost_ability_id_list = '101,102'
        WHERE player_id = ? AND id = ?
    `).run(playerId, PROTAGONIST_ID)

    const cleared = clearPlayerCharactersExBoostSync(playerId)

    assert.equal(cleared, 1)
    const character = getPlayerCharacterSync(playerId, PROTAGONIST_ID)
    assert.equal(character.exBoost, undefined)
    assert.equal(clearPlayerCharactersExBoostSync(playerId), 0)
})
