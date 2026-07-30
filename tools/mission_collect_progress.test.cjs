require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-collect-progress-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    givePlayerItemSync,
    getPlayerCollectedItemTotalSync,
    getPlayerItemSync,
    updatePlayerItemSync,
} = require("../src/data/domains/item")
const {
    getPlayerClearedCollectItemEventMissionListSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
const { serializePlayerData } = require("../src/data/utils/serialize-player")
const {
    CollectComputer,
    getCollectMissionItemId,
} = require("../src/lib/mission/collect-progress")

initializeDatabase()
db = getDb()

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

const playerId = createPlayer("mission-collect")
assert.equal(getCollectMissionItemId(1500), 80001)
assert.equal(getPlayerCollectedItemTotalSync(playerId, 80001), 0)

assert.equal(givePlayerItemSync(playerId, 80001, 10), 10)
assert.equal(getPlayerCollectedItemTotalSync(playerId, 80001), 10)

updatePlayerItemSync(playerId, 80001, 3)
assert.equal(getPlayerItemSync(playerId, 80001), 3)
assert.equal(getPlayerCollectedItemTotalSync(playerId, 80001), 10)

assert.equal(givePlayerItemSync(playerId, 80001, 4), 7)
assert.equal(getPlayerCollectedItemTotalSync(playerId, 80001), 14)

const collectContext = CollectComputer.buildContext(playerId, 4)
assert.equal(CollectComputer.compute(1500, collectContext, 0), 14)

assert.throws(() => db.transaction(() => {
    givePlayerItemSync(playerId, 80001, 5)
    throw new Error("injected collect rollback")
})(), /injected collect rollback/)
assert.equal(getPlayerItemSync(playerId, 80001), 7)
assert.equal(getPlayerCollectedItemTotalSync(playerId, 80001), 14)

updatePlayerCategoryMissionSync(playerId, 4, 1500, 50)
updatePlayerCategoryMissionStageSync(playerId, 4, 1, 1500, true)
assert.deepEqual(getPlayerClearedCollectItemEventMissionListSync(playerId), { "1500": 1 })

const mergedPlayer = getMergedPlayerDataSync(playerId)
assert.notEqual(mergedPlayer, null)
const serialized = serializePlayerData(mergedPlayer)
assert.deepEqual(serialized.cleared_collect_item_event_mission_list, { "1500": 1 })

console.log("mission collect progress tests passed")
cleanup()
process.removeListener("exit", cleanup)
