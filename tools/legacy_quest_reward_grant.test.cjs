"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const BetterSqlite3 = require("better-sqlite3")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-quest-reward-grant-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { getPlayerEquipmentSync } = require("../src/data/domains/equipment")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { givePlayerRewardSync, givePlayerRewardsSync } = require("../src/lib/quest")
const { RewardType } = require("../src/lib/types/rewards")

const ITEM_ID = 14002
const EQUIPMENT_ID = 3010006
const CHARACTER_ID = 341005
const CHARACTER_COMPENSATION_ITEM_ID = 14010

let database

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

function rewardState(playerId) {
    const player = getPlayerSync(playerId)
    return {
        freeMana: player.freeMana,
        freeVmoney: player.freeVmoney,
        expPool: player.expPool,
        totalManaObtained: player.totalManaObtained,
        item: getPlayerItemSync(playerId, ITEM_ID),
        equipment: getPlayerEquipmentSync(playerId, EQUIPMENT_ID),
        character: getPlayerCharacterSync(playerId, CHARACTER_ID),
    }
}

test.before(() => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath),
    })
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("empty legacy batch preserves its no-player and no-transaction result", () => {
    assert.deepEqual(givePlayerRewardsSync(999999, []), {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    })
})

test("reachable legacy rewards require the source transaction and fail before writes", () => {
    const playerId = createPlayer("transaction-required")
    const before = rewardState(playerId)

    assert.throws(
        () => givePlayerRewardsSync(playerId, [
            { type: RewardType.ITEM, id: ITEM_ID, count: 2 },
            { type: RewardType.MANA, count: 3 },
            { type: RewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 1 },
        ]),
        error => error?.name === "RewardGrantTransactionRequiredError",
    )
    assert.deepEqual(rewardState(playerId), before)
})

test("legacy projection keeps absolute Item accumulation and reads fresh currency per call", () => {
    const playerId = createPlayer("legacy-projection")
    const before = rewardState(playerId)
    let first
    let second

    database.transaction(() => {
        first = givePlayerRewardsSync(playerId, [
            { type: RewardType.ITEM, id: ITEM_ID, count: 2 },
            { type: RewardType.ITEM, id: ITEM_ID, count: 1 },
            { type: RewardType.MANA, count: 3 },
            { type: RewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 1 },
        ])
        second = givePlayerRewardSync(playerId, { type: RewardType.MANA, count: 4 })
    })()

    assert.deepEqual(first.user_info, { free_mana: 3, free_vmoney: 0, exp_pool: 0 })
    assert.equal(first.items[ITEM_ID], 5)
    assert.equal(first.equipment_list.length, 1)
    assert.deepEqual(first.joined_character_id_list, [])
    assert.deepEqual(second.user_info, { free_mana: 4, free_vmoney: 0, exp_pool: 0 })

    const after = rewardState(playerId)
    assert.equal(after.item, 3)
    assert.equal(after.equipment.stack, 0)
    assert.equal(after.freeMana, before.freeMana + 7)
    assert.equal(after.totalManaObtained, before.totalManaObtained + 7)
})

test("legacy Character projection hides joined IDs and reports duplicate compensation delta", () => {
    const playerId = createPlayer("character-projection")
    let result

    database.transaction(() => {
        result = givePlayerRewardsSync(playerId, [
            { type: RewardType.CHARACTER, id: CHARACTER_ID },
            { type: RewardType.CHARACTER, id: CHARACTER_ID },
        ])
    })()

    assert.equal(result.character_list.length, 1)
    assert.equal(result.character_list[0].character_id, CHARACTER_ID)
    assert.deepEqual(result.joined_character_id_list, [])
    assert.deepEqual(result.items, { [CHARACTER_COMPENSATION_ITEM_ID]: 1 })
    assert.equal(getPlayerItemSync(playerId, CHARACTER_COMPENSATION_ITEM_ID), 1)
})

test("source transaction rollback restores every legacy reward domain", () => {
    const playerId = createPlayer("source-rollback")
    const before = rewardState(playerId)

    assert.throws(
        () => database.transaction(() => {
            givePlayerRewardsSync(playerId, [
                { type: RewardType.ITEM, id: ITEM_ID, count: 2 },
                { type: RewardType.MANA, count: 3 },
                { type: RewardType.EQUIPMENT, id: EQUIPMENT_ID, count: 1 },
                { type: RewardType.CHARACTER, id: CHARACTER_ID },
            ])
            throw new Error("rollback legacy quest rewards")
        })(),
        /rollback legacy quest rewards/,
    )
    assert.deepEqual(rewardState(playerId), before)
})
