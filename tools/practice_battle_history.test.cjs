require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Database = require("better-sqlite3")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "practice-history-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db

const schema12Database = new Database(path.join(databaseDirectory, "wdfp_data.db"))
schema12Database.pragma("user_version = 12")
schema12Database.close()

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getPlayerPracticeBattleHistorySync,
    insertPlayerPracticeBattleHistorySync,
} = require("../src/data/domains/practice-battle-history")
const {
    buildPracticeBattleHistoryRecord,
} = require("../src/lib/quest/practice-battle-history")

db = initializeDatabase()
assert.equal(db.pragma("user_version", { simple: true }), 20)

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `practice-history-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

const record = buildPracticeBattleHistoryRecord({
    playerId,
    playId: "practice-history-play-1",
    categoryId: 15,
    questId: 1,
    finishKind: 0,
    createdAt: new Date("2024-08-14T12:34:56.000Z"),
    elapsedTimeMs: 90_000,
    score: 12_345,
    clearRank: 5,
    party: {
        characters: [{ id: 101 }, { id: 102 }, null],
        unison_characters: [{ id: 201 }, null, null],
        equipments: [{ id: 301 }, null, null],
        ability_soul_ids: [401, null, null],
    },
    statistics: {
        zones: [
            {
                damage_deal_total: 100.5,
                members: [{ origin_damage: 60 }, { origin_damage: 20 }, null],
            },
            {
                damage_deal_total: 200,
                members: [{ origin_damage: 70 }, { origin_damage: 30 }, null],
            },
        ],
    },
    equipmentList: {
        301: { level: 3, enhancementLevel: 4, protection: false, stack: 1 },
    },
})

assert.equal(record.category_id, 15)
assert.equal(record.total_damage, 300.5)
assert.equal(record.character_1_total_damage, 130)
assert.equal(record.character_2_total_damage, 50)
assert.equal(record.equipment_level_1, 3)
assert.equal(record.enhancement_level_1, 4)
assert.equal(record.create_time, "2024-08-14 12:34:56")

assert.equal(insertPlayerPracticeBattleHistorySync(record), true)
assert.equal(insertPlayerPracticeBattleHistorySync(record), false)
assert.equal(insertPlayerPracticeBattleHistorySync({
    ...record,
    playId: "practice-history-play-2",
    quest_id: 2,
    create_time: "2024-08-14 12:35:56",
}), true)
const history = getPlayerPracticeBattleHistorySync(playerId)
assert.equal(history.length, 2)
assert.equal(Object.keys(history[0]).length, 29)
assert.equal(history[0].quest_id, 2)
assert.equal("playerId" in history[0], false)
assert.equal("playId" in history[0], false)

for (let index = 0; index < 101; index++) {
    assert.equal(insertPlayerPracticeBattleHistorySync({
        ...record,
        playId: `practice-history-retention-${index}`,
        quest_id: 1000 + index,
        create_time: `2024-08-15 00:${String(index % 60).padStart(2, "0")}:00`,
    }), true)
}
const retainedHistory = getPlayerPracticeBattleHistorySync(playerId, 100)
assert.equal(retainedHistory.length, 100)
assert.equal(retainedHistory[0].quest_id, 1100)

const otherAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `practice-history-other-${randomUUID()}`,
    status: "normal",
})
const otherPlayerId = insertDefaultPlayerSync(otherAccount.id).id
assert.deepEqual(getPlayerPracticeBattleHistorySync(otherPlayerId), [])

assert.throws(() => buildPracticeBattleHistoryRecord({
    ...record,
    categoryId: 27,
    createdAt: new Date("2024-08-14T12:34:56.000Z"),
    party: { characters: [], unison_characters: [], equipments: [], ability_soul_ids: [] },
    statistics: { zones: [{ damage_deal_total: 1 }] },
    equipmentList: {},
}), /category|identity/)

console.log("practice battle history tests passed")
cleanup()
process.removeListener("exit", cleanup)
