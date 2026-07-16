const assert = require("node:assert/strict")
const Database = require("better-sqlite3")

function testVersion4BackfillValidation() {
    const database = new Database(":memory:")
    database.exec(`
        CREATE TABLE players_characters (
            id INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            PRIMARY KEY (id, player_id)
        );
        CREATE TABLE players_category_mission_stages (
            category INTEGER NOT NULL,
            id,
            status INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            mission_id
        );
        CREATE TABLE players_character_awake_unlocks (
            player_id INTEGER NOT NULL,
            character_id INTEGER NOT NULL,
            board_index INTEGER NOT NULL,
            awake_level INTEGER NOT NULL,
            PRIMARY KEY (player_id, character_id, board_index)
        );
    `)
    database.prepare(`
        INSERT INTO players_characters (id, player_id)
        VALUES (341005, 1), (0, 1), (-1, 1), (1, 1)
    `).run()

    const insertReceipt = database.prepare(`
        INSERT INTO players_category_mission_stages
            (category, id, status, player_id, mission_id)
        VALUES (9, ?, 1, 1, ?)
    `)
    for (const [missionId, stageId] of [
        [100, 1], [101, 1], [102, 1], [103, 1], [104, 1], [105, 1],
        [106, 1], [107, 1], [108, 1], [109, 1], [110, 1], [0, 1],
        [-111, 1], [112.5, 1], [113, 0], [114, -1], [115, 1.5],
    ]) {
        insertReceipt.run(stageId, missionId)
    }

    const syntheticRewards = {
        "100": { "1": [["1001", "0", "341005", "1", "1"]] },
        "101": { "1": [["1011", "0", "341006", "2", "1"]] },
        "102": { "1": [["1021", false, "341005", "3", "1"]] },
        "103": { "1": [["1031", 0, "341005", "4", "1"]] },
        "104": { "1": [["1041", "0", "", "5", "1"]] },
        "105": { "1": [["1051", "0", "341005", "", "1"]] },
        "106": { "1": [["1061", "0", "341005", "6", null]] },
        "107": { "1": [["1071", "0", "341005", "-1", "1"]] },
        "108": { "1": [["1081", "0", "341005", "7", "1.5"]] },
        "109": { "1": [["1091", "0", "341005", "8", "NaN"]] },
        "110": { "1": [["1101", "0", "341005", "9007199254740992", "1"]] },
        "": { "1": [["01", "0", "341005", "9", "1"]] },
        "-111": { "1": [["-1111", "0", "341005", "10", "1"]] },
        "112.5": { "1": [["11251", "0", "341005", "11", "1"]] },
        "113": { "": [["1130", "0", "341005", "12", "1"]] },
        "114": { "-1": [["114-1", "0", "341005", "13", "1"]] },
        "115": { "1.5": [["11515", "0", "341005", "14", "1"]] },
    }

    const assetPath = require.resolve("../assets/mission_char_awake_reward.json")
    const updaterPath = require.resolve("../out/data/updaters/wdfpData")
    const originalRewards = require(assetPath)
    require.cache[assetPath].exports = syntheticRewards
    delete require.cache[updaterPath]

    try {
        const { updateAfterInit } = require(updaterPath)
        updateAfterInit(database, 3)
        updateAfterInit(database, 3)

        assert.deepEqual(database.prepare(`
            SELECT player_id, character_id, board_index, awake_level
            FROM players_character_awake_unlocks
            ORDER BY player_id, character_id, board_index
        `).all(), [{
            player_id: 1,
            character_id: 341005,
            board_index: 1,
            awake_level: 1,
        }])
    } finally {
        require.cache[assetPath].exports = originalRewards
        delete require.cache[updaterPath]
        database.close()
    }
}

testVersion4BackfillValidation()

const { getDb } = require("../out/data/db")
const {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} = require("../out/data/domains/character_awake")

const db = getDb()
const player = db.prepare(`
    SELECT player_id AS id
    FROM players_characters
    WHERE id = 341005
    ORDER BY player_id
    LIMIT 1
`).get()

if (!player) {
    console.log("character awake unlock tests skipped: no player owns character 341005")
    process.exit(0)
}

const originalUnlockRows = db.prepare(`
    SELECT player_id, character_id, board_index, awake_level
    FROM players_character_awake_unlocks
    WHERE player_id = ? AND character_id = 341005
    ORDER BY board_index
`).all(player.id)

db.exec("BEGIN")
try {
    const playerId = player.id
    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
    `).run(playerId)

    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, 341005, 1, 1), true)
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, 341005, 1, 0), false)
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 1 })
    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, 341005, 1, 2), true)
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("341005"), { 1: 2 })

    console.log("character awake unlock tests passed")
} finally {
    db.exec("ROLLBACK")
    const restoredUnlockRows = db.prepare(`
        SELECT player_id, character_id, board_index, awake_level
        FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
        ORDER BY board_index
    `).all(player.id)
    assert.deepEqual(restoredUnlockRows, originalUnlockRows)
}
