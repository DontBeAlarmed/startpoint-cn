"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Sqlite = require("better-sqlite3")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-save-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterManaNodeAwakeLevelSync,
} = require("../src/data/domains/character")
const { upsertPlayerCharacterAwakeUnlockSync } = require("../src/data/domains/character_awake")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    exportPlayerSaveV2Sync,
    restorePlayerSaveV2Sync,
} = require("../src/data/player-save/v2")
const {
    CHARACTER_GROWTH_SAVE_TABLE_NAMES,
} = require("../src/lib/character-growth/save/project-growth-state")
const {
    validateCharacterGrowthSaveState,
} = require("../src/lib/character-growth/save/validate-growth-state")
const { getCharacterManaNodesSync } = require("../src/lib/assets")

let db
const sqlStatements = []

test.before(() => {
    data.initializeDatabase({
        databaseFactory: databasePath => new Sqlite(databasePath, {
            verbose: sql => sqlStatements.push(sql),
        }),
    })
    db = getDb()
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

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

function tableRows(playerId) {
    return Object.fromEntries(CHARACTER_GROWTH_SAVE_TABLE_NAMES.map(table => {
        const columns = db.pragma(`table_info(${table})`)
        const primaryKey = columns
            .filter(column => column.pk > 0)
            .sort((left, right) => left.pk - right.pk)
            .map(column => column.name)
        const order = primaryKey.length === 0 ? "" : ` ORDER BY ${primaryKey.join(", ")}`
        return [table, db.prepare(`SELECT * FROM ${table} WHERE player_id = ?${order}`).all(playerId)]
    }))
}

function snapshotGrowth(snapshot) {
    return Object.fromEntries(CHARACTER_GROWTH_SAVE_TABLE_NAMES.map(table => [
        table,
        snapshot.domains.core.tables[table].map(source => {
            const row = { ...source }
            delete row.player_id
            return row
        }),
    ]))
}

test("save validator reports one minimal representative from each Growth boundary", () => {
    const valid = {
        players_characters: [{
            id: 1,
            entry_count: 1,
            exp: 0,
            stack: 0,
            over_limit_step: 0,
            evolution_level: 0,
            protection: 0,
            mana_board_index: 1,
        }],
        players_characters_bond_tokens: [{ character_id: 1, mana_board_index: 1, status: 2 }],
        players_characters_mana_nodes: [{ character_id: 1, value: 101, awake_level: 0 }],
        players_character_awake_unlocks: [{ character_id: 1, board_index: 1, awake_level: 1 }],
    }
    const contentFactsLoader = () => ({
        rarity: 4,
        boardCount: 2,
        boardNodeIds: new Map([[1, new Set([101])], [2, new Set([201])]]),
        secondBoardAvailable: true,
    })
    assert.deepEqual(validateCharacterGrowthSaveState(valid, { contentFactsLoader }), {
        valid: true,
        errors: [],
    })

    const invalid = structuredClone(valid)
    invalid.players_characters[0].entry_count = -1
    invalid.players_characters[0].exp = -1
    invalid.players_characters[0].mana_board_index = 3
    invalid.players_characters_bond_tokens = [
        { character_id: 999, mana_board_index: 3, status: 7 },
    ]
    invalid.players_characters_mana_nodes = [
        { character_id: 1, value: 999, awake_level: 0 },
        { character_id: 1, value: 201, awake_level: 1 },
    ]
    invalid.players_character_awake_unlocks = [
        { character_id: 999, board_index: 2, awake_level: 0 },
    ]
    const result = validateCharacterGrowthSaveState(invalid, { contentFactsLoader })
    assert.equal(result.valid, false)
    const signatures = result.errors.map(error => `${error.table}.${error.field}`)
    assert.ok(signatures.includes("players_characters.exp"))
    assert.ok(signatures.includes("players_characters.entry_count"))
    assert.ok(signatures.includes("players_characters.mana_board_index"))
    assert.ok(signatures.includes("players_characters_bond_tokens.character_id"))
    assert.ok(signatures.includes("players_characters_bond_tokens.status"))
    assert.ok(signatures.includes("players_characters_mana_nodes.value"))
    assert.ok(signatures.includes("players_characters_mana_nodes.awake_level"))
    assert.ok(signatures.includes("players_character_awake_unlocks.character_id"))
    assert.ok(signatures.includes("players_character_awake_unlocks.board_index"))
    assert.ok(signatures.includes("players_character_awake_unlocks.awake_level"))
})

test("save validator rejects one representative unreachable official Growth terminal state", () => {
    const invalid = {
        players_characters: [{
            id: 1,
            entry_count: 0,
            exp: Number.MAX_SAFE_INTEGER,
            stack: 0,
            over_limit_step: 999,
            evolution_level: 999,
            protection: 0,
            mana_board_index: 1,
        }],
        players_characters_bond_tokens: [
            { character_id: 1, mana_board_index: 1, status: 0 },
            { character_id: 1, mana_board_index: 2, status: 1 },
        ],
        players_characters_mana_nodes: [
            { character_id: 1, value: 101, awake_level: 0 },
            { character_id: 1, value: 201, awake_level: 0 },
        ],
        players_character_awake_unlocks: [],
    }
    const result = validateCharacterGrowthSaveState(invalid, {
        contentFactsLoader: () => ({
            rarity: 4,
            boardCount: 2,
            boardNodeIds: new Map([[1, new Set([101])], [2, new Set([201])]]),
            secondBoardAvailable: true,
        }),
    })
    assert.equal(result.valid, false)
    const signatures = result.errors.map(error => `${error.table}.${error.field}`)
    assert.ok(signatures.includes("players_characters.entry_count"))
    assert.ok(signatures.includes("players_characters.over_limit_step"))
    assert.ok(signatures.includes("players_characters.exp"))
    assert.ok(signatures.includes("players_characters_mana_nodes.value"))
    assert.ok(signatures.includes("players_characters_bond_tokens.status"))
    assert.equal(signatures.includes("players_characters.evolution_level"), false)

    const awakeInvalid = {
        players_characters: [{
            id: 1,
            entry_count: 1,
            exp: 0,
            stack: 0,
            over_limit_step: 0,
            evolution_level: 999,
            protection: 0,
            mana_board_index: 1,
        }],
        players_characters_bond_tokens: [{ character_id: 1, mana_board_index: 1, status: 0 }],
        players_characters_mana_nodes: [{ character_id: 1, value: 101, awake_level: 2 }],
        players_character_awake_unlocks: [{ character_id: 1, board_index: 1, awake_level: 1 }],
    }
    const awakeContent = () => ({
        rarity: 4,
        boardCount: 1,
        boardNodeIds: new Map([[1, new Set([101, 102])]]),
        secondBoardAvailable: false,
    })
    const awakeResult = validateCharacterGrowthSaveState(awakeInvalid, {
        contentFactsLoader: awakeContent,
    })
    assert.ok(awakeResult.errors.some(error => (
        error.table === "players_character_awake_unlocks"
        && error.reason.includes("completed board 1")
    )))
    assert.ok(awakeResult.errors.some(error => (
        error.table === "players_characters_mana_nodes"
        && error.reason.includes("exceeds board 1 unlock level")
    )))

    awakeInvalid.players_characters_mana_nodes[0].awake_level = 1
    awakeInvalid.players_character_awake_unlocks = []
    const missingUnlock = validateCharacterGrowthSaveState(awakeInvalid, {
        contentFactsLoader: awakeContent,
    })
    assert.ok(missingUnlock.errors.some(error => (
        error.table === "players_characters_mana_nodes"
        && error.reason.includes("requires a board 1 unlock")
    )))
})

test("v2 rejects invalid Growth before replacing any target rows", () => {
    const sourceId = createPlayer("growth-invalid-source")
    const targetId = createPlayer("growth-invalid-target")
    db.prepare("UPDATE players_characters SET exp = 777 WHERE player_id = ? AND id = 1").run(targetId)
    const invalid = exportPlayerSaveV2Sync(sourceId)
    invalid.domains.core.tables.players_characters[0].mana_board_index = 99
    const before = tableRows(targetId)
    sqlStatements.length = 0

    assert.throws(
        () => restorePlayerSaveV2Sync(invalid, targetId),
        /Character Growth save is invalid.*mana_board_index/,
    )
    assert.deepEqual(
        sqlStatements.filter(sql => /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.trim())),
        [],
    )
    assert.deepEqual(tableRows(targetId), before)
})

test("valid v2 Growth restore round-trips without field drift", () => {
    const sourceId = createPlayer("growth-roundtrip-source")
    const targetId = createPlayer("growth-roundtrip-target")
    db.prepare(`
        UPDATE players_characters
        SET exp = 1234, stack = 2, protection = 1
        WHERE player_id = ? AND id = 1
    `).run(sourceId)
    const boardOneNodeIds = Object.keys(getCharacterManaNodesSync(1, 1)).map(Number)
    insertPlayerCharacterManaNodesSync(sourceId, 1, boardOneNodeIds)
    updatePlayerCharacterManaNodeAwakeLevelSync(sourceId, 1, 2201, 1)
    upsertPlayerCharacterAwakeUnlockSync(sourceId, 1, 1, 1)

    const source = exportPlayerSaveV2Sync(sourceId)
    restorePlayerSaveV2Sync(structuredClone(source), targetId)
    const restored = exportPlayerSaveV2Sync(targetId)
    assert.deepEqual(snapshotGrowth(restored), snapshotGrowth(source))
})
