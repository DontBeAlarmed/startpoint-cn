const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
require("ts-node/register/transpile-only")

const db = new Database(":memory:")
db.exec(`
    CREATE TABLE players_quest_progress (
        section INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        finished INTEGER NOT NULL,
        unlocked INTEGER NOT NULL DEFAULT 0,
        high_score INTEGER,
        clear_rank INTEGER,
        best_elapsed_time_ms INTEGER,
        leader_character_id INTEGER,
        multi_clear_count INTEGER NOT NULL DEFAULT 0,
        host_finished INTEGER,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (section, quest_id, player_id)
    );
`)

const dbModulePath = require.resolve("../src/data/db")
require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: { getDb: () => db },
}

const quest = require("../src/data/domains/quest")
const playerSerializer = require("../src/data/utils/serialize-player")
let hostFinishPersistence = {}
try {
    hostFinishPersistence = require("../src/lib/quest/host-finish-persistence")
} catch {
    // The first TDD run intentionally reaches this branch before the module exists.
}

assert.equal(typeof playerSerializer.serializePlayerQuestProgress, "function")
assert.equal(typeof hostFinishPersistence.ensureQuestHostFinishedStorageSync, "function")
assert.deepEqual(playerSerializer.serializePlayerQuestProgress({
    questId: 200076002,
    finished: true,
    hostFinished: true,
}), {
    best_elapsed_time_ms: undefined,
    clear_rank: undefined,
    finished: true,
    high_score: 0,
    quest_id: 200076002,
    unlocked: undefined,
    host_finished: true,
})

quest.insertPlayerQuestProgressSync(17, 7, {
    questId: 200076002,
    finished: true,
    hostFinished: false,
})
assert.equal(quest.getPlayerSingleQuestProgressSync(17, 7, 200076002).hostFinished, false)

quest.updatePlayerQuestProgressSync(17, 7, {
    questId: 200076002,
    hostFinished: true,
})
assert.equal(quest.getPlayerSingleQuestProgressSync(17, 7, 200076002).hostFinished, true)

quest.insertPlayerQuestProgressSync(17, 7, {
    questId: 200076005,
    finished: true,
})
assert.equal(quest.getPlayerSingleQuestProgressSync(17, 7, 200076005).hostFinished, undefined)
assert.deepEqual(
    quest.getPlayerQuestProgressSync(17)["7"].map(progress => [progress.questId, progress.hostFinished]),
    [[200076002, true], [200076005, undefined]],
)

db.close()

const legacyDb = new Database(":memory:")
legacyDb.exec(`
    CREATE TABLE players_quest_progress (
        section INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        finished INTEGER NOT NULL
    );
    INSERT INTO players_quest_progress VALUES (7, 200076002, 1);
    INSERT INTO players_quest_progress VALUES (8, 200076005, 1);
    INSERT INTO players_quest_progress VALUES (7, 200076006, 0);
    INSERT INTO players_quest_progress VALUES (1, 11010003, 1);
`)
hostFinishPersistence.ensureQuestHostFinishedStorageSync(legacyDb)
assert.deepEqual(
    legacyDb.prepare(`
        SELECT section, quest_id, host_finished
        FROM players_quest_progress
        ORDER BY quest_id
    `).all(),
    [
        { section: 1, quest_id: 11010003, host_finished: null },
        { section: 7, quest_id: 200076002, host_finished: 1 },
        { section: 8, quest_id: 200076005, host_finished: 1 },
        { section: 7, quest_id: 200076006, host_finished: null },
    ],
)
legacyDb.prepare(`
    INSERT INTO players_quest_progress (section, quest_id, finished, host_finished)
    VALUES (7, 200076008, 1, NULL)
`).run()
hostFinishPersistence.ensureQuestHostFinishedStorageSync(legacyDb)
assert.equal(
    legacyDb.prepare(`SELECT host_finished FROM players_quest_progress WHERE quest_id = 200076008`).get().host_finished,
    null,
)
legacyDb.close()
console.log("quest host finish tests passed")
