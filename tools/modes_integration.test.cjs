"use strict"

// Real wiring: an installed fixture module must actually receive events from
// the production code path, and boot must register modules before the server
// starts listening. Fixtures live in a temp dir — nothing ships in modes.d/.

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createHash } = require("node:crypto")
const { EventEmitter } = require("node:events")

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
const { loadModes } = require("../src/modes/loader")
const { createRuntimeCoordinator } = require("../src/runtime/lifecycle")

initializeDatabase()
db = getDb()

const EVENT_ID = 700099

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

test("an installed module rewrites played parties on the production read path", async () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `modes-integration-${Date.now()}`,
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

    // Baseline: with no module installed the ids reach the client untouched.
    registry.resetModesForTest()
    const before = getSerializedPlayerRushEventPlayedPartiesSync(playerId, EVENT_ID)
    const beforeEntries = Object.values(before.folderParties)
    assert.equal(beforeEntries.length, 1)
    assert.equal(beforeEntries[0].character_id_1, 111)

    const dir = tempDir("wf-modes-integration-")
    installModule(dir, "unlock.mjs", `export function register() {
    return {
        apiVersion: ${registry.MODE_API_VERSION},
        name: "unlock-fixture",
        capability: "unlock-fixture@1",
        onRushPartiesSerialized(context) {
            for (const party of Object.values(context.folderParties)) {
                party.character_id_1 = null
                party.character_id_2 = null
            }
        },
    }
}
`)
    registry.resetModesForTest()
    const loaded = await loadModes({ projectRoot: dir, env: { MODES_DIR: dir }, log: () => {} })
    assert.deepEqual(loaded, ["unlock-fixture"])

    const after = getSerializedPlayerRushEventPlayedPartiesSync(playerId, EVENT_ID)
    const afterEntries = Object.values(after.folderParties)
    // Ids cleared by the module, entry count preserved: the client derives
    // both character locking and the round number from this list.
    assert.equal(afterEntries.length, 1)
    assert.equal(afterEntries[0].character_id_1, null)
    assert.equal(afterEntries[0].character_id_2, null)
    registry.resetModesForTest()
})

test("boot registers modules before the server starts listening", async () => {
    const dir = tempDir("wf-modes-boot-")
    installModule(dir, "boot.mjs", `export function register() {
    return {
        apiVersion: ${registry.MODE_API_VERSION},
        name: "boot-fixture",
        capability: "boot-fixture@1",
    }
}
`)
    registry.resetModesForTest()

    const order = []
    const config = { assetProvider: { mode: "local" }, http: {}, tcp: {} }
    const coordinator = createRuntimeCoordinator({
        loadConfig: () => config,
        configureHttp: () => {},
        initializeDatabase: () => {},
        restoreTimeOffset: () => {},
        // Same composition shape as cn-server: snapshot first, then modules.
        initializeContent: async () => {
            order.push("content")
            await loadModes({ projectRoot: dir, env: { MODES_DIR: dir }, log: () => {} })
            order.push(`modes:${registry.listModeCapabilities().join(",")}`)
        },
        readyHttp: async () => {},
        listenHttp: async () => {
            order.push(`listen:${registry.listModeCapabilities().join(",")}`)
        },
        closeHttp: async () => {},
        forceCloseHttp: () => {},
        startTcp: async () => {
            order.push("tcp")
            return { close: () => {} }
        },
        stopTcp: async () => {},
        processTarget: new EventEmitter(),
        setExitCode: () => {},
        log: () => {},
    })

    await coordinator.start()
    assert.deepEqual(order.slice(0, 3), [
        "content",
        "modes:boot-fixture@1",
        "listen:boot-fixture@1",
    ])
    await coordinator.stop?.()
    registry.resetModesForTest()
})
