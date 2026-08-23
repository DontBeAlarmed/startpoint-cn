"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const BetterSqlite3 = require("better-sqlite3")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "post-commit-awake-owner-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync, getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerCategoryMissionsSync, updatePlayerCategoryMissionSync } = require("../src/data/domains/mission")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} = require("../src/data/domains/character_awake")
const { givePlayerCharacterSync } = require("../src/lib/character")
const { publishAwakeCharacterListBestEffort } = require("../src/lib/mission/awake-best-effort-context")

let database
let sqlStatements = null

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `post-commit-awake-${label}-${Date.now()}-${Math.random()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function withPublicationFailure(playerId, operation) {
    database.exec(`
        CREATE TRIGGER reject_post_commit_awake_cleanup
        BEFORE DELETE ON players_character_awake_unlocks
        WHEN OLD.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'injected post-commit publication failure'); END;
    `)
    try {
        sqlStatements = []
        return operation()
    } finally {
        database.exec("DROP TRIGGER IF EXISTS reject_post_commit_awake_cleanup")
    }
}

function prepareStaleUnlock(playerId) {
    givePlayerCharacterSync(playerId, 1)
    upsertPlayerCharacterAwakeUnlockSync(playerId, 1, 1, 1)
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("1"), { 1: 1 })
}

test.before(() => {
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: statement => {
                if (sqlStatements !== null) sqlStatements.push(statement)
            },
        }),
    })
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("post-commit publication failure preserves a committed owner and original empty response", () => {
    const playerId = createPlayer("empty-reward")
    prepareStaleUnlock(playerId)
    const beforeMana = getPlayerSync(playerId).freeMana

    const response = withPublicationFailure(playerId, () => {
        database.transaction(() => updatePlayerSync({ id: playerId, freeMana: beforeMana + 7 }))()
        return publishAwakeCharacterListBestEffort(playerId, [], [[]])
    })

    assert.deepEqual(response, [])
    assert.equal(getPlayerSync(playerId).freeMana, beforeMana + 7)
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("1"), { 1: 1 })
    assert.equal(sqlStatements.some(statement => /DELETE FROM players_character_awake_unlocks/i.test(statement)), true)
})

test("post-commit publication failure keeps duplicate-character compensation and response", () => {
    const playerId = createPlayer("duplicate-character")
    prepareStaleUnlock(playerId)
    const duplicate = givePlayerCharacterSync(playerId, 1)
    assert.ok(duplicate?.character)
    const beforeItemCount = getPlayerItemSync(playerId, duplicate.item.id) ?? 0

    const response = withPublicationFailure(playerId, () => {
        database.transaction(() => givePlayerItemSync(playerId, duplicate.item.id, 3))()
        return publishAwakeCharacterListBestEffort(
            playerId,
            [1],
            [[duplicate.character]],
        )
    })

    assert.deepEqual(response, [duplicate.character])
    assert.equal(getPlayerItemSync(playerId, duplicate.item.id), beforeItemCount + 3)
    assert.equal(getPlayerCharacterSync(playerId, 1).stack, 2)
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("1"), { 1: 1 })
})

test("post-commit publication failure keeps a newly granted character candidate", () => {
    const playerId = createPlayer("new-character")
    prepareStaleUnlock(playerId)
    const granted = {
        character_id: 341005,
        entry_count: 1,
    }
    const beforeCharacters = getPlayerCharactersSync(playerId)

    const response = withPublicationFailure(playerId, () => {
        database.transaction(() => {
            updatePlayerCategoryMissionSync(playerId, 9, 3410051, 1)
            givePlayerCharacterSync(playerId, 341005)
        })()
        return publishAwakeCharacterListBestEffort(playerId, [341005], [[granted]])
    })

    assert.deepEqual(response, [granted])
    assert.equal(Object.keys(getPlayerCharactersSync(playerId)).length, Object.keys(beforeCharacters).length + 1)
    assert.equal(getPlayerCategoryMissionsSync(playerId, 9)[3410051].progress, 1)
    assert.deepEqual(getPlayerCharacterAwakeUnlocksSync(playerId).get("1"), { 1: 1 })
})

test("Mana item sell uses cleanup-only candidate facts", () => {
    const itemSource = fs.readFileSync(path.join(__dirname, "../src/routes/api/item.ts"), "utf8")
    const sellBlock = itemSource.slice(itemSource.indexOf('fastify.post("/sell"'))
    assert.match(sellBlock, /publishAwakeCharacterListBestEffort\(playerId, \[\], \[\[\]\]\)/)
    const publicationLine = sellBlock.match(/const characterList = [^\n]+/)?.[0] ?? ""
    assert.doesNotMatch(publicationLine, /characterId|character_id/)
    assert.match(
        sellBlock,
        /Mana sale changes player\/item facts, but does not identify an affected\s*\/\/\s*character/,
        "Mana sell has no proof tying the item fact to a character ID",
    )
})

test("all nine post-commit owners use the fresh scoped wrapper after their owner write", () => {
    const expected = {
        "src/routes/api/boxGacha.ts": ["drawn-reward-characters"],
        "src/routes/api/character.ts": ["town-granted-character"],
        "src/routes/api/exchange.ts": ["exchange-reward-characters"],
        "src/routes/api/gacha.ts": ["exchanged-character", "drawn-characters"],
        "src/routes/api/item.ts": ["mana-item-fact"],
        "src/routes/api/mission.ts": ["category9-delta-missions"],
        "src/routes/api/shop.ts": ["shop-reward-characters", "shop-reward-characters"],
    }
    for (const [relativeFile, sources] of Object.entries(expected)) {
        const source = fs.readFileSync(path.join(__dirname, "..", relativeFile), "utf8")
        assert.equal((source.match(/publishAwakeCharacterListBestEffort\(/g) ?? []).length, sources.length, relativeFile)
        assert.doesNotMatch(source, /reconcileAwakeUnlockCharacterList\(/, relativeFile)
    }
})
