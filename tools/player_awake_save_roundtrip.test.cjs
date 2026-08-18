require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "player-awake-save-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharacterManaNodeAwakeLevelsSync,
    getPlayerCharactersManaNodeAwakeLevelsSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterManaNodeAwakeLevelSync,
} = require("../src/data/domains/character")
const {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} = require("../src/data/domains/character_awake")
const { insertDefaultPlayerSync, replacePlayerDataSync } = require("../src/data/domains/player")
const { reviveMergedPlayerDates } = require("../src/data/utils/date")
const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")

initializeDatabase()
db = getDb()

try {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `player-awake-save-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const characterId = 1
    const nodeIds = [2201, 2202]
    insertPlayerCharacterManaNodesSync(playerId, characterId, nodeIds)
    updatePlayerCharacterManaNodeAwakeLevelSync(playerId, characterId, nodeIds[0], 1)
    updatePlayerCharacterManaNodeAwakeLevelSync(playerId, characterId, nodeIds[1], 2)
    upsertPlayerCharacterAwakeUnlockSync(playerId, characterId, 1, 2)

    const exported = getMergedPlayerDataSync(playerId)
    assert.ok(exported)
    const jsonSave = JSON.parse(JSON.stringify(exported))
    assert.deepEqual(jsonSave.characterAwakeUnlocks, { 1: { 1: 2 } })
    assert.deepEqual(jsonSave.characterManaNodeAwakeLevels, { 1: { 2201: 1, 2202: 2 } })

    replacePlayerDataSync(reviveMergedPlayerDates(jsonSave))

    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId), new Map([
        ["1", { 1: 2 }],
    ]))
    assert.deepEqual(getPlayerCharactersManaNodeAwakeLevelsSync(playerId), {
        1: { 2201: 1, 2202: 2 },
    })
    assert.deepEqual(getPlayerCharacterManaNodeAwakeLevelsSync(playerId, characterId), {
        2201: 1,
        2202: 2,
    })
    const validSave = JSON.parse(JSON.stringify(getMergedPlayerDataSync(playerId)))
    const originalAwakeState = {
        unlocks: getPlayerCharacterAwakeUnlocksSync(playerId),
        nodeLevels: getPlayerCharactersManaNodeAwakeLevelsSync(playerId),
    }
    const originalPlayerName = db.prepare("SELECT name FROM players WHERE id = ?").get(playerId).name

    const invalidSaves = [
        {
            label: "negative unlock awake level",
            mutate(save) { save.characterAwakeUnlocks = { 1: { 1: -1 } } },
            error: /characterAwakeUnlocks.*awakeLevel.*positive safe integer/,
        },
        {
            label: "non-plain unlock map",
            mutate(save) { save.characterAwakeUnlocks = [] },
            error: /characterAwakeUnlocks.*plain object/,
        },
        {
            label: "null unlock map",
            mutate(save) { save.characterAwakeUnlocks = null },
            error: /characterAwakeUnlocks.*plain object/,
        },
        {
            label: "unknown unlock character",
            mutate(save) { save.characterAwakeUnlocks = { 999999: { 1: 1 } } },
            error: /characterAwakeUnlocks.*unknown character 999999/,
        },
        {
            label: "unknown unlock character with empty boards",
            mutate(save) { save.characterAwakeUnlocks = { 999999: {} } },
            error: /characterAwakeUnlocks.*unknown character 999999/,
        },
        {
            label: "negative node awake level",
            mutate(save) { save.characterManaNodeAwakeLevels = { 1: { 2201: -1 } } },
            error: /characterManaNodeAwakeLevels.*awakeLevel.*non-negative safe integer/,
        },
        {
            label: "null node awake map",
            mutate(save) { save.characterManaNodeAwakeLevels = null },
            error: /characterManaNodeAwakeLevels.*plain object/,
        },
        {
            label: "unknown mana node",
            mutate(save) { save.characterManaNodeAwakeLevels = { 1: { 999999: 3 } } },
            error: /characterManaNodeAwakeLevels.*unknown character\/node 1\/999999/,
        },
        {
            label: "unknown node-awake character with empty nodes",
            mutate(save) { save.characterManaNodeAwakeLevels = { 999999: {} } },
            error: /characterManaNodeAwakeLevels.*unknown character 999999/,
        },
    ]

    for (const fixture of invalidSaves) {
        const invalidSave = JSON.parse(JSON.stringify(validSave))
        invalidSave.player.name = `must-roll-back-${fixture.label}`
        fixture.mutate(invalidSave)
        const originalConsoleError = console.error
        console.error = () => {}
        try {
            assert.throws(
                () => replacePlayerDataSync(reviveMergedPlayerDates(invalidSave)),
                fixture.error,
                fixture.label,
            )
        } finally {
            console.error = originalConsoleError
        }
        assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId), originalAwakeState.unlocks)
        assert.deepEqual(getPlayerCharactersManaNodeAwakeLevelsSync(playerId), originalAwakeState.nodeLevels)
        assert.equal(db.prepare("SELECT name FROM players WHERE id = ?").get(playerId).name, originalPlayerName)
    }

    const legacySave = getMergedPlayerDataSync(playerId)
    delete legacySave.characterAwakeUnlocks
    delete legacySave.characterManaNodeAwakeLevels
    replacePlayerDataSync(reviveMergedPlayerDates(JSON.parse(JSON.stringify(legacySave))))
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId), new Map())
    assert.deepEqual(getPlayerCharactersManaNodeAwakeLevelsSync(playerId), {
        1: { 2201: 0, 2202: 0 },
    })
    assert.deepEqual(getPlayerCharacterManaNodeAwakeLevelsSync(playerId, characterId), {
        2201: 0,
        2202: 0,
    })

    console.log("player awake save roundtrip tests passed")
} finally {
    cleanup()
    process.removeListener("exit", cleanup)
}
