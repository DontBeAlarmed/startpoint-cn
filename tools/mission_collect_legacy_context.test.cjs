"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-collect-legacy-context-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const {
    installBundledGameplaySnapshot,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreBundledSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const masterData = require("../src/lib/mission/master-data")
const { CollectComputer } = require("../src/lib/mission/collect-progress")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

test.after(() => {
    if (db.open) db.close()
    restoreBundledSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

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

test("legacy context precomputes only requested selectors or all valid Category 4 selectors", () => {
    const playerId = createPlayer("collect-legacy-selection")
    const selected = CollectComputer.buildContext(
        playerId,
        4,
        evaluationTime,
        [1500, 1574, 1653],
    )
    const full = CollectComputer.buildContext(playerId, 4, evaluationTime)

    assert.deepEqual([...selected.collectMissionItemIds], [[1500, 80001], [1574, 80002]])
    assert.equal(full.collectMissionItemIds.size, 279)
    assert.equal(full.collectMissionItemIds.get(1500), 80001)
    assert.equal(full.collectMissionItemIds.has(1653), false)
})

test("legacy compute is Catalog and DB free after context build and snapshot replacement", () => {
    const playerId = createPlayer("collect-legacy-pure")
    givePlayerItemSync(playerId, 80001, 11)
    givePlayerItemSync(playerId, 80002, 29)
    const context = CollectComputer.buildContext(playerId, 4, evaluationTime, [1500])
    const changedCollectTable = structuredClone(require("../assets/mission_collect_item.json"))
    changedCollectTable[1500][0][14] = "80002"
    const restoreChangedSnapshot = installBundledGameplaySnapshot({
        tableOverrides: { "mission_collect_item.json": changedCollectTable },
    })
    const originalDefinition = masterData.getMissionMasterDefinition
    const originalPrepare = db.prepare.bind(db)
    let catalogCalls = 0
    let dbCalls = 0
    masterData.getMissionMasterDefinition = (...args) => {
        catalogCalls++
        return originalDefinition(...args)
    }
    db.prepare = statement => {
        dbCalls++
        return originalPrepare(statement)
    }
    try {
        assert.equal(CollectComputer.compute(1500, context, 0), 11)
        assert.equal(CollectComputer.compute(1574, context, 7), 7)
    } finally {
        masterData.getMissionMasterDefinition = originalDefinition
        db.prepare = originalPrepare
        restoreChangedSnapshot()
    }

    assert.equal(catalogCalls, 0)
    assert.equal(dbCalls, 0)
})
