require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-pass-facts-db-"))
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
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { recordMissionBattleFacts } = require("../src/lib/mission/battle-facts")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-pass-facts-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const player = getPlayerSync(playerId)
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

function context(overrides = {}) {
    return {
        playerId,
        questCategory: 7,
        questId: 200015001,
        questAccomplished: true,
        clearTime: 1000,
        clearRank: 5,
        party: { characters: [], unison_characters: [] },
        statistics: {
            clear_phase: 1,
            party: { characters: [], unison_characters: [] },
            zones: [],
        },
        player,
        questPreviouslyCompleted: false,
        questProgress: null,
        isMulti: true,
        isMultiHost: true,
        ...overrides,
    }
}

recordMissionBattleFacts(context(), evaluationTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[15]?.progress, 1)

recordMissionBattleFacts(context({ questAccomplished: false }), evaluationTime)
recordMissionBattleFacts(context({ questCategory: 8 }), evaluationTime)
recordMissionBattleFacts(context({ questId: 200016001 }), evaluationTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[15]?.progress, 1)

recordMissionBattleFacts(context({ questCategory: 2, questId: 1025001 }), evaluationTime)
assert.equal(getPlayerCategoryMissionsSync(playerId, 8)[16]?.progress, 1)

console.log("mission pass battle fact tests passed")
cleanup()
process.removeListener("exit", cleanup)
