const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
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
const { getPlayerItemSync } = require("../out/data/domains/item")
const { insertAccountSync } = require("../out/data/domains/account")
const { insertDefaultPlayerCharacterSync } = require("../out/data/domains/character")
const { insertDefaultPlayerSync } = require("../out/data/domains/player")
const {
    reconcileAwakeUnlockCharacterList,
    reconcileAwakeUnlocks,
    reconcileAwakeUnlocksFromProgress,
} = require("../out/lib/mission")
const awakeUnlockModule = require("../out/lib/mission/awake-unlock")
const missionRegistry = require("../out/lib/mission/registry")

const db = getDb()
const idpId = `character-awake-unlock-test-${randomUUID()}`

db.exec("BEGIN")
try {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    insertDefaultPlayerCharacterSync(playerId, 341005)

    db.prepare(`
        DELETE FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9
    `).run(playerId)
    db.prepare(`
        DELETE FROM players_category_missions
        WHERE player_id = ? AND category = 9
    `).run(playerId)
    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, 341005, 5, 0, 0, 0, 0)
        ON CONFLICT(player_id, character_id) DO UPDATE SET clear_count = 5
    `).run(playerId)

    assert.equal(upsertPlayerCharacterAwakeUnlockSync(playerId, 341005, 1, 1), true)
    const originalGetComputer = missionRegistry.getComputer
    missionRegistry.getComputer = () => {
        throw new Error("candidate=[] must not build a mission context")
    }
    try {
        const emptyCandidateReconciliation = reconcileAwakeUnlocks(playerId, [])
        assert.deepEqual(emptyCandidateReconciliation.all, new Map([["341005", { 1: 1 }]]))
        assert.equal(emptyCandidateReconciliation.changed.size, 0)
    } finally {
        missionRegistry.getComputer = originalGetComputer
    }
    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)

    assert.equal(typeof reconcileAwakeUnlocksFromProgress, "function")
    const authoritativeProgress = [
        { missionId: 3410051, progress: 1 },
        { missionId: 3410052, progress: 5 },
        { missionId: 3410053, progress: 5 },
        { missionId: 3410054, progress: 3 },
    ]
    const expectedUnlocks = new Map([["341005", { 1: 1 }]])
    const originalGetComputerForProgress = missionRegistry.getComputer
    missionRegistry.getComputer = () => {
        throw new Error("fromProgress must not build a mission context")
    }
    try {
        const emptyProgressReconciliation = reconcileAwakeUnlocksFromProgress(playerId, [])
        assert.equal(emptyProgressReconciliation.changed.size, 0)
        assert.equal(emptyProgressReconciliation.all.size, 0)

        const fromProgressReconciliation = reconcileAwakeUnlocksFromProgress(playerId, authoritativeProgress)
        assert.deepEqual(fromProgressReconciliation.changed, expectedUnlocks)
        assert.deepEqual(fromProgressReconciliation.all, expectedUnlocks)

        const repeatedProgressReconciliation = reconcileAwakeUnlocksFromProgress(playerId, authoritativeProgress)
        assert.equal(repeatedProgressReconciliation.changed.size, 0)
        assert.deepEqual(repeatedProgressReconciliation.all, expectedUnlocks)
    } finally {
        missionRegistry.getComputer = originalGetComputerForProgress
    }

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)

    const itemAmountsBefore = Object.fromEntries(
        [13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])
    )
    const firstReconciliation = reconcileAwakeUnlocks(playerId, [341005])

    assert.deepEqual(firstReconciliation.changed, expectedUnlocks)
    assert.deepEqual(firstReconciliation.all, expectedUnlocks)
    assert.equal(firstReconciliation.changed.has("341006"), false)
    assert.equal(firstReconciliation.all.size, 1)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_missions
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.deepEqual(
        Object.fromEntries([13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])),
        itemAmountsBefore
    )

    const secondReconciliation = reconcileAwakeUnlocks(playerId, [341005])
    assert.equal(secondReconciliation.changed.size, 0)
    assert.deepEqual(secondReconciliation.all, expectedUnlocks)

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ?
    `).run(playerId)
    const fullReconciliation = reconcileAwakeUnlocks(playerId)
    assert.deepEqual(fullReconciliation.changed, expectedUnlocks)
    assert.deepEqual(fullReconciliation.all, expectedUnlocks)

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

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
    `).run(playerId)
    assert.equal(db.prepare(`
        SELECT clear_count
        FROM players_character_quest_clears
        WHERE player_id = ? AND character_id = 341005
    `).get(playerId).clear_count, 5)

    const endpointBondTokenList = [{ mana_board_index: 2, status: 1 }]
    const existingCharacterList = [{
        character_id: 341005,
        exp: 123,
        bond_token_list: endpointBondTokenList,
        mana_board_awake: {
            1: 0,
            2: 1,
            4: "invalid",
            5: Number.NaN,
            6: Number.POSITIVE_INFINITY,
            7: -1,
            8: 1.5,
            0: 1,
            "-1": 1,
            invalid: 1,
        },
    }, {
        character_id: 341005,
        exp: 999,
        stack: 7,
        update_time: "newer-endpoint-value",
        mana_board_awake: { 2: 2, 3: 1, 4: 2 },
    }]
    const mergedCharacterList = reconcileAwakeUnlockCharacterList(playerId, existingCharacterList)
    const mergedMew = mergedCharacterList.find(entry => entry.character_id === 341005)
    assert.equal(mergedCharacterList.filter(entry => entry.character_id === 341005).length, 1)
    assert.equal(mergedMew.exp, 999)
    assert.equal(mergedMew.stack, 7)
    assert.equal(mergedMew.update_time, "newer-endpoint-value")
    assert.strictEqual(mergedMew.bond_token_list, endpointBondTokenList)
    assert.deepEqual(mergedMew.mana_board_awake, { 1: 1, 2: 2, 3: 1, 4: 2 })

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
    `).run(playerId)
    const appendedCharacterList = reconcileAwakeUnlockCharacterList(playerId, [])
    assert.equal(appendedCharacterList.length, 1)
    assert.equal(appendedCharacterList[0].character_id, 341005)
    assert.equal(typeof appendedCharacterList[0].join_time, "string")
    assert.equal(typeof appendedCharacterList[0].update_time, "string")
    assert.deepEqual(appendedCharacterList[0].mana_board_awake, { 1: 1 })

    const unchangedCharacterList = [
        { character_id: 341005, exp: 1 },
        { character_id: 341005, exp: 2 },
    ]
    assert.strictEqual(
        reconcileAwakeUnlockCharacterList(playerId, unchangedCharacterList),
        unchangedCharacterList
    )
    assert.deepEqual(unchangedCharacterList, [
        { character_id: 341005, exp: 1 },
        { character_id: 341005, exp: 2 },
    ])

    db.prepare(`
        DELETE FROM players_character_awake_unlocks
        WHERE player_id = ? AND character_id = 341005
    `).run(playerId)
    const originalReconcileAwakeUnlocks = awakeUnlockModule.reconcileAwakeUnlocks
    awakeUnlockModule.reconcileAwakeUnlocks = () => ({
        all: new Map(),
        changed: new Map([
            ["341006", { 1: 1 }],
            ["999999", { 1: 1 }],
        ]),
    })
    try {
        assert.deepEqual(reconcileAwakeUnlockCharacterList(playerId, []), [])
    } finally {
        awakeUnlockModule.reconcileAwakeUnlocks = originalReconcileAwakeUnlocks
    }

    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_missions
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM players_category_mission_stages
        WHERE player_id = ? AND category = 9
    `).get(playerId).count, 0)
    assert.deepEqual(
        Object.fromEntries([13, 14, 15, 16].map(itemId => [itemId, getPlayerItemSync(playerId, itemId) ?? 0])),
        itemAmountsBefore
    )

    console.log("character awake unlock tests passed")
} finally {
    db.exec("ROLLBACK")
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM accounts
        WHERE idp_id = ?
    `).get(idpId).count, 0)
}
