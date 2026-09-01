const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
const fs = require("node:fs")
const { after } = require("node:test")
const os = require("node:os")
const path = require("node:path")
require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "carnival-rewards-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const { closeDatabase, initializeDatabase } = require("../src/data")
let cleaned = false
function cleanupDatabase() {
    if (cleaned) return
    try {
        closeDatabase()
    } finally {
        restoreContentSnapshot()
        fs.rmSync(databaseDirectory, { recursive: true, force: true })
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
        if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
        else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
        cleaned = true
    }
}

process.once("exit", cleanupDatabase)
after(() => {
    process.removeListener("exit", cleanupDatabase)
    cleanupDatabase()
})
const runtimeDatabase = initializeDatabase()

const carnivalDomain = require("../src/data/domains/carnivalEvent")
runtimeDatabase.pragma("foreign_keys = OFF")
runtimeDatabase.prepare(`
    INSERT INTO players_carnival_event_records
        (player_id, event_id, folder_id, best_score, previous_score,
            previous_character_ids, previous_unison_character_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(999, 250601, 1, 1000, 1000, "111015,111002,", "111117,111021,")
const incompletePartyRecord = carnivalDomain.getPlayerCarnivalEventRecordSync(999, 250601, 1)
assert.deepEqual(incompletePartyRecord.previousCharacterIds, [111015, 111002, null])
assert.deepEqual(incompletePartyRecord.previousUnisonCharacterIds, [111117, 111021, null])
runtimeDatabase.prepare("DELETE FROM players_carnival_event_records WHERE player_id = ?").run(999)
runtimeDatabase.pragma("foreign_keys = ON")

let carnivalRewards = {}
let carnivalPersistence = {}
let carnivalParser = {}
let carnivalSaveState = {}
let degreeTools = {}
try {
    carnivalRewards = require("../src/lib/carnival-rewards")
    carnivalPersistence = require("../src/lib/carnival-reward-persistence")
    carnivalParser = require("../src/lib/carnival-reward-parser")
    carnivalSaveState = require("../src/lib/carnival-save-state")
    degreeTools = require("../src/lib/degrees")
} catch {
    // The first TDD run intentionally reaches this branch before the module exists.
}

assert.equal(typeof carnivalRewards.parseCarnivalRewardRow, "function")
assert.equal(typeof carnivalRewards.getEligibleCarnivalRewards, "function")
assert.equal(typeof carnivalRewards.grantCarnivalRewards, "function")
assert.equal(typeof carnivalRewards.getCarnivalRewardDefinitions, "function")
assert.equal(typeof carnivalPersistence.getClaimedCarnivalRewardIdsSync, "function")
assert.equal(typeof carnivalPersistence.insertClaimedCarnivalRewardIdsSync, "function")
assert.equal(typeof carnivalPersistence.givePlayerDegreeSync, "function")
assert.equal(typeof carnivalPersistence.getPlayerDegreeIdsSync, "function")
assert.equal(typeof carnivalParser.parseCarnivalRewardRow, "function")
assert.equal(typeof carnivalSaveState.getCarnivalSaveStateSync, "function")
assert.equal(typeof carnivalSaveState.insertCarnivalSaveStateSync, "function")
assert.equal(typeof degreeTools.mergeOwnedDegreeIds, "function")

const definition = carnivalRewards.parseCarnivalRewardRow(1308, [
    "250604", "总计得分达到::score::", "3195000", "20001",
    "0", "1", "50",
    "1", "5060042", "1",
    "2", "", "100",
    "3", "", "10000",
    "4", "", "30000",
    "7", "61000", "1",
])

assert.deepEqual(definition, {
    id: 1308,
    eventId: 250604,
    score: 3195000,
    reasonId: 20001,
    rewards: [
        { kind: 0, id: 1, amount: 50 },
        { kind: 1, id: 5060042, amount: 1 },
        { kind: 2, amount: 100 },
        { kind: 3, amount: 10000 },
        { kind: 4, amount: 30000 },
        { kind: 7, id: 61000, amount: 1 },
    ],
})

assert.throws(
    () => carnivalParser.parseCarnivalRewardRow(9999, [
        "250604oops", "test", "100", "20001",
        "0", "1", "1",
    ]),
    /invalid event id/i,
)

assert.deepEqual(degreeTools.mergeOwnedDegreeIds(61000, [61000, 61020]), [1, 61000, 61020])

const { serializePlayerData } = require("../src/data/utils/serialize-player")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
const serializationAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: "carnival-rewards-serialization",
    status: "normal",
})
const serializationPlayerId = insertDefaultPlayerSync(serializationAccount.id).id
assert.equal(serializationPlayerId > 0, true)
updatePlayerSync({ id: serializationPlayerId, degreeId: 61000 })
const mergedPlayer = getMergedPlayerDataSync(serializationPlayerId)
assert.notEqual(mergedPlayer, null)
const serializedPlayer = serializePlayerData(mergedPlayer, {
    summonComSeconds: 9,
})
assert.equal(serializedPlayer.user_info.degree_id, 61000)
assert.equal(serializedPlayer.config.summon_com_seconds, 9)
assert.throws(
    () => carnivalParser.parseCarnivalRewardRow(9999, [
        "250604", "test", "100", "20001",
        "99", "1", "1",
    ]),
    /unsupported reward kind/i,
)

const definitions = [
    { ...definition, id: 1, score: 100 },
    { ...definition, id: 2, score: 200 },
    { ...definition, id: 3, score: 300 },
    { ...definition, id: 4, eventId: 250605, score: 100 },
]
assert.deepEqual(
    carnivalRewards.getEligibleCarnivalRewards(definitions, 250604, 300, new Set([2])).map(v => v.id),
    [1, 3],
)
const runtimeDefinitions = carnivalRewards.getCarnivalRewardDefinitions()
assert.equal(runtimeDefinitions.length, 1451)
assert.equal(new Set(runtimeDefinitions.map(value => value.eventId)).size, 19)
assert.equal(carnivalRewards.getCarnivalRewardDefinitions(250604).length, 79)

const writes = { items: [], equipment: [], degrees: [], player: null }
const grantDefinition = {
    ...definition,
    rewards: [...definition.rewards, { kind: 1, id: 5060042, amount: 2 }],
}
const grantResult = carnivalRewards.grantCarnivalRewards(17, [grantDefinition], {
    getPlayer: () => ({ freeVmoney: 10, freeMana: 20, expPool: 30, totalManaObtained: 40 }),
    giveItem: (_playerId, id, amount) => {
        writes.items.push([id, amount])
        return 500 + amount
    },
    giveEquipment: (_playerId, id, amount) => {
        writes.equipment.push([id, amount])
        return { id, stack: amount }
    },
    giveDegree: (_playerId, id) => {
        writes.degrees.push(id)
        return true
    },
    updatePlayer: value => { writes.player = value },
})

assert.deepEqual(writes.items, [[1, 50]])
assert.deepEqual(writes.equipment, [[5060042, 1], [5060042, 2]])
assert.deepEqual(writes.degrees, [61000])
assert.deepEqual(writes.player, {
    id: 17,
    freeVmoney: 110,
    freeMana: 10020,
    expPool: 30030,
    totalManaObtained: 10040,
})
assert.deepEqual(grantResult, {
    user_info: { free_vmoney: 100, free_mana: 10000, exp_pool: 30000 },
    item_list: { 1: 550 },
    equipment_list: [{ id: 5060042, stack: 2 }],
    new_degree_ids: [61000],
})

const db = new Database(":memory:")
db.exec(`
    CREATE TABLE players_carnival_event_rewards (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        reward_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, event_id, reward_id)
    );
    CREATE TABLE players_degrees (
        player_id INTEGER NOT NULL,
        degree_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, degree_id)
    );
    CREATE TABLE players_carnival_event_records (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        folder_id INTEGER NOT NULL,
        best_score INTEGER,
        previous_score INTEGER,
        previous_character_ids TEXT,
        previous_unison_character_ids TEXT,
        PRIMARY KEY (player_id, event_id, folder_id)
    );
`)
carnivalPersistence.insertClaimedCarnivalRewardIdsSync(db, 17, 250604, [1230, 1231, 1231])
assert.deepEqual(
    [...carnivalPersistence.getClaimedCarnivalRewardIdsSync(db, 17, 250604)].sort((a, b) => a - b),
    [1230, 1231],
)
assert.equal(carnivalPersistence.givePlayerDegreeSync(db, 17, 61030), true)
assert.equal(carnivalPersistence.givePlayerDegreeSync(db, 17, 61030), false)
assert.equal(carnivalPersistence.givePlayerDegreeSync(db, 17, 61020), true)
assert.deepEqual(carnivalPersistence.getPlayerDegreeIdsSync(db, 17), [61020, 61030])

db.prepare(`
    INSERT INTO players_carnival_event_records
        (player_id, event_id, folder_id, best_score, previous_score, previous_character_ids, previous_unison_character_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(17, 250604, 25060401, 3033723, 3033723, "1,,3", "4,5,")

const saveState = carnivalSaveState.getCarnivalSaveStateSync(db, 17)
assert.deepEqual(saveState, {
    carnivalEventRecords: [{
        eventId: 250604,
        folderId: 25060401,
        bestScore: 3033723,
        previousScore: 3033723,
        previousCharacterIds: [1, null, 3],
        previousUnisonCharacterIds: [4, 5, null],
    }],
    carnivalRewardClaims: [
        { eventId: 250604, rewardId: 1230 },
        { eventId: 250604, rewardId: 1231 },
    ],
    degreeIds: [61020, 61030],
})

db.prepare("DELETE FROM players_carnival_event_records WHERE player_id = ?").run(17)
db.prepare("DELETE FROM players_carnival_event_rewards WHERE player_id = ?").run(17)
db.prepare("DELETE FROM players_degrees WHERE player_id = ?").run(17)
carnivalSaveState.insertCarnivalSaveStateSync(db, 17, saveState)
assert.deepEqual(carnivalSaveState.getCarnivalSaveStateSync(db, 17), saveState)

assert.throws(() => db.transaction(() => {
    carnivalPersistence.insertClaimedCarnivalRewardIdsSync(db, 18, 250604, [1308])
    carnivalPersistence.givePlayerDegreeSync(db, 18, 61000)
    throw new Error("simulated Carnival settlement failure")
})(), /simulated Carnival settlement failure/)
assert.deepEqual(carnivalSaveState.getCarnivalSaveStateSync(db, 18), {
    carnivalEventRecords: [],
    carnivalRewardClaims: [],
    degreeIds: [],
})
db.close()

console.log("carnival reward tests passed")
