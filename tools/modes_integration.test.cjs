"use strict"

// Real wiring, not a re-creation of it: these tests drive the same
// initializeContentAndModes() composition cn-server hands to the runtime
// coordinator, the production played-party read path, and a real transaction.
// Fixture modules live in temp dirs — modes.d/ ships empty.

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createHash } = require("node:crypto")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wf-modes-integration-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    insertPlayerRushEventPlayedPartySync,
    insertPlayerRushEventSync,
} = require("../src/data/domains/rushEvent")
const { getSerializedPlayerRushEventPlayedPartiesSync } = require("../src/lib/rush")
const registry = require("../src/modes/registry")
const { initializeContentAndModes } = require("../src/modes/boot")

initializeDatabase()
db = getDb()

const EVENT_ID = 700099
let playerSeq = 0

function installModule(dir, fileName, source) {
    fs.writeFileSync(path.join(dir, fileName), source)
    fs.writeFileSync(
        path.join(dir, "modes-allowlist.json"),
        JSON.stringify({
            [fileName]: createHash("sha256").update(Buffer.from(source)).digest("hex"),
        }),
    )
}

function tempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

function moduleSource(name, body) {
    return `export const modeManifest = {
    apiVersion: ${registry.MODE_API_VERSION},
    name: ${JSON.stringify(name)},
    capability: ${JSON.stringify(name + "@1")},
}

export function register() {
    return {
        ${body}
    }
}
`
}

/** Boots through the exact composition cn-server uses. */
async function boot(dir, { snapshot = async () => {}, log = () => {} } = {}) {
    registry.resetModesForTest()
    return initializeContentAndModes({
        projectRoot: dir,
        initializeContentSnapshot: snapshot,
        env: { MODES_DIR: dir },
        log,
    })
}

function seedPlayerWithPlayedParty() {
    playerSeq += 1
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `modes-integration-${Date.now()}-${playerSeq}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertPlayerRushEventSync(playerId, {
        eventId: EVENT_ID,
        endlessBattleNextRound: 1,
        activeRushBattleFolderId: null,
        endlessBattleMaxRound: null,
        endlessBattleMaxRoundTime: null,
        endlessBattleMaxRoundCharacterIds: [null, null, null],
        endlessBattleMaxRoundCharacterEvolutionImgLvls: [null, null, null],
    })
    insertPlayerRushEventPlayedPartySync(playerId, EVENT_ID, {
        battleType: 0,
        round: 1,
        characterIds: [111, 222, null],
        unisonCharacterIds: [null, null, null],
        equipmentIds: [null, null, null],
        abilitySoulIds: [null, null, null],
        evolutionImgLevels: [null, null, null],
        unisonEvolutionImgLevels: [null, null, null],
    })
    return playerId
}

test("the boot composition loads modules only after the content snapshot", async () => {
    const dir = tempDir("wf-modes-boot-")
    installModule(dir, "boot.mjs", moduleSource("boot-fixture", ""))
    const order = []
    const loaded = await boot(dir, {
        snapshot: async () => { order.push("snapshot") },
        log: () => { order.push("module-log") },
    })
    assert.deepEqual(loaded, ["boot-fixture"])
    assert.equal(order[0], "snapshot", "snapshot must be ready before modules register")
    assert.deepEqual(registry.listModeCapabilities(), ["boot-fixture@1"])
    registry.resetModesForTest()
})

test("an empty modes dir boots clean and leaves every dispatch a no-op", async () => {
    const dir = tempDir("wf-modes-empty-")
    const logs = []
    const loaded = await boot(dir, { log: m => logs.push(m) })
    assert.deepEqual(loaded, [])
    assert.deepEqual(registry.listModeCapabilities(), [])
    assert.deepEqual(logs, [])

    const playerId = seedPlayerWithPlayedParty()
    const entries = Object.values(
        getSerializedPlayerRushEventPlayedPartiesSync(playerId, EVENT_ID).folderParties,
    )
    assert.equal(entries.length, 1)
    assert.equal(entries[0].character_id_1, 111, "no module → response untouched")
})

test("an installed module rewrites played parties on the production read path", async () => {
    const playerId = seedPlayerWithPlayedParty()

    registry.resetModesForTest()
    const before = Object.values(
        getSerializedPlayerRushEventPlayedPartiesSync(playerId, EVENT_ID).folderParties,
    )
    assert.equal(before[0].character_id_1, 111)

    const dir = tempDir("wf-modes-parties-")
    installModule(dir, "unlock.mjs", moduleSource("unlock-fixture", `
        onRushPartiesSerialized(context) {
            for (const party of Object.values(context.folderParties)) {
                party.character_id_1 = null
                party.character_id_2 = null
            }
        },`))
    assert.deepEqual(await boot(dir), ["unlock-fixture"])

    const after = Object.values(
        getSerializedPlayerRushEventPlayedPartiesSync(playerId, EVENT_ID).folderParties,
    )
    // Ids cleared by the module, entry count preserved: the client derives
    // both character locking and the round number from this list.
    assert.equal(after.length, 1)
    assert.equal(after[0].character_id_1, null)
    assert.equal(after[0].character_id_2, null)
    registry.resetModesForTest()
})

test("a settlement module throwing rolls back writes made in the same transaction", async () => {
    const playerId = seedPlayerWithPlayedParty()
    const dir = tempDir("wf-modes-rollback-")
    installModule(dir, "rollback.mjs", moduleSource("rollback-fixture", `
        onRushFinish() { throw new Error("settlement bug") },`))
    assert.deepEqual(await boot(dir), ["rollback-fixture"])

    const readName = () => db
        .prepare("SELECT name FROM players WHERE id = ?").get(playerId).name
    const original = readName()

    // Mirrors the finish handler: base writes and the mode dispatch share one
    // transaction, so a module fault must undo the base writes too.
    assert.throws(() => {
        getDb().transaction(() => {
            db.prepare("UPDATE players SET name = ? WHERE id = ?").run("written-by-base", playerId)
            registry.dispatchModeRushFinish({}, {
                apiVersion: registry.MODE_API_VERSION,
                table: () => { throw new Error("unused") },
                log: () => {},
                server: {},
            })
        })()
    }, /settlement bug/)

    assert.equal(readName(), original, "base write must have rolled back with the module fault")
    registry.resetModesForTest()
})
