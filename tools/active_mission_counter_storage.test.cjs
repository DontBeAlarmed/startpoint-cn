require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-counter-db-"))
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
    getActiveMissionCountersSync,
    incrementActiveMissionGachaCharacterCountSync,
    incrementActiveMissionUsedManaCountSync,
} = require("../src/data/domains/active_mission_counters")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `active-mission-counter-${Date.now()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

assert.deepEqual(getActiveMissionCountersSync(playerId), {
    totalUsedManaCount: 0,
    totalGachaCharacterCount: 0,
})
incrementActiveMissionUsedManaCountSync(playerId, 120)
incrementActiveMissionGachaCharacterCountSync(playerId, 3)
incrementActiveMissionGachaCharacterCountSync(playerId, 2)
assert.deepEqual(getActiveMissionCountersSync(playerId), {
    totalUsedManaCount: 120,
    totalGachaCharacterCount: 5,
})

console.log("active mission counter storage tests passed")
cleanup()
process.removeListener("exit", cleanup)
