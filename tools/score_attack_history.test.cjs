require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "score-attack-history-db-"))
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
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getPlayerScoreAttackBattleHistorySync,
    insertPlayerScoreAttackBattleHistorySync,
} = require("../src/data/domains/score-attack-history")
const {
    buildScoreAttackBattleHistoryRecord,
} = require("../src/lib/quest/score-attack-history")

db = initializeDatabase()
assert.equal(db.pragma("user_version", { simple: true }), 22)

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `score-history-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id

const record = buildScoreAttackBattleHistoryRecord({
    playerId,
    eventId: 1,
    playId: "score-history-play-1",
    categoryId: 27,
    questId: 1001,
    finishKind: 0,
    createdAt: new Date("2024-08-14T12:34:56.000Z"),
    elapsedTimeMs: 90_000,
    score: 2_426_000_000,
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

assert.deepEqual(record, {
    playerId,
    eventId: 1,
    playId: "score-history-play-1",
    ability_soul_id_1: 401,
    ability_soul_id_2: null,
    ability_soul_id_3: null,
    category_id: 27,
    character_1_total_damage: 130,
    character_2_total_damage: 50,
    character_3_total_damage: null,
    character_id_1: 101,
    character_id_2: 102,
    character_id_3: null,
    clear_rank: 5,
    create_time: "2024-08-14 12:34:56",
    elapsed_time_ms: 90_000,
    enhancement_level_1: 4,
    enhancement_level_2: null,
    enhancement_level_3: null,
    equipment1_id: 301,
    equipment2_id: null,
    equipment3_id: null,
    equipment_level_1: 3,
    equipment_level_2: null,
    equipment_level_3: null,
    finish_kind: 0,
    quest_id: 1001,
    score: 2_426_000_000,
    total_damage: 300.5,
    unison_character_id_1: 201,
    unison_character_id_2: null,
    unison_character_id_3: null,
})

assert.equal(insertPlayerScoreAttackBattleHistorySync(record), true)
assert.equal(insertPlayerScoreAttackBattleHistorySync(record), false)
assert.deepEqual(getPlayerScoreAttackBattleHistorySync(playerId, 1), [
    Object.fromEntries(Object.entries(record).filter(([key]) => !["playerId", "eventId", "playId"].includes(key))),
])
assert.deepEqual(getPlayerScoreAttackBattleHistorySync(playerId, 2), [])

assert.throws(() => buildScoreAttackBattleHistoryRecord({
    ...record,
    categoryId: 27,
    questId: 1001,
    finishKind: 0,
    elapsedTimeMs: 90_000,
    clearRank: 5,
    createdAt: new Date("2024-08-14T12:34:56.000Z"),
    party: { characters: [], unison_characters: [], equipments: [], ability_soul_ids: [] },
    statistics: { zones: [{ damage_deal_total: -1 }] },
    equipmentList: {},
}), /damage_deal_total/)

console.log("score attack history tests passed")
cleanup()
process.removeListener("exit", cleanup)
