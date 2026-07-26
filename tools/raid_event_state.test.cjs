require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "raid-event-state-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getRaidEventBossStateSync,
    getPlayerRaidEventSync,
    getPlayerRaidEventQuestCountsSync,
    incrementPlayerRaidEventQuestKillCountSync,
    upsertPlayerRaidEventSync,
    upsertRaidEventBossStateSync,
} = require("../src/data/domains/raidEvent")

try {
    initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "raid-event-state",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id

    assert.equal(getRaidEventBossStateSync(4), null)
    upsertRaidEventBossStateSync(4, { weightedKillCount: 123, totalKillCount: 7 })
    assert.deepEqual(getRaidEventBossStateSync(4), { weightedKillCount: 123, totalKillCount: 7 })

    assert.equal(incrementPlayerRaidEventQuestKillCountSync(playerId, 4, 4001), 1)
    assert.equal(incrementPlayerRaidEventQuestKillCountSync(playerId, 4, 4001), 2)
    assert.equal(incrementPlayerRaidEventQuestKillCountSync(playerId, 4, 4002), 1)
    assert.deepEqual(getPlayerRaidEventQuestCountsSync(playerId, 4), {
        4001: 2,
        4002: 1,
    })

    upsertPlayerRaidEventSync(playerId, 5, 200, 200)
    getDb().prepare("DROP TABLE raid_event_boss_states").run()
    closeDatabase()
    initializeDatabase()
    assert.equal(getRaidEventBossStateSync(5), null, "旧累计权重不得迁成 Boss 击破数")
    assert.deepEqual(getPlayerRaidEventSync(playerId, 5), {
        eventId: 5,
        totalKillCount: 0,
        receivedUpTo: 0,
    })

    upsertRaidEventBossStateSync(5, { weightedKillCount: 12, totalKillCount: 3 })
    upsertPlayerRaidEventSync(playerId, 5, 3, 3)
    closeDatabase()
    initializeDatabase()
    assert.deepEqual(getRaidEventBossStateSync(5), { weightedKillCount: 12, totalKillCount: 3 })
    assert.equal(getPlayerRaidEventSync(playerId, 5).receivedUpTo, 3)
} finally {
    closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

console.log("raid event state tests passed")
