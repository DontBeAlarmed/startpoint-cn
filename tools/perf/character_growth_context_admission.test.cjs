"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const BetterSqlite3 = require("better-sqlite3")

const { closeDatabase, initializeDatabase } = require("../../src/data")
const { insertAccountSync } = require("../../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
const { createSqlCounter } = require("./mission_settlement_sql.cjs")
const { CharacterGrowthRepository } = require("../../src/lib/character-growth/repository")
const { createCharacterGrowthRequestContext } = require("../../src/lib/character-growth/request-context")
const { createCharacterGrowthBatchContext } = require("../../src/lib/character-growth/batch-context")

const TABLES = Object.freeze([
    "players_characters",
    "players_characters_bond_tokens",
    "players_characters_mana_nodes",
    "players_character_awake_unlocks",
    "players_items",
])

function createObservedDatabase(databasePath, state) {
    const database = new BetterSqlite3(databasePath, {
        verbose(sql) {
            if (state.active !== null) state.active.sql.observe(sql)
        },
    })
    return new Proxy(database, {
        get(target, property, receiver) {
            if (property === "prepare") {
                return sql => {
                    if (state.active !== null) state.active.prepareCalls++
                    const statement = target.prepare(sql)
                    return new Proxy(statement, {
                        get(statementTarget, statementProperty, statementReceiver) {
                            if (!["all", "get", "run"].includes(statementProperty)) {
                                return Reflect.get(statementTarget, statementProperty, statementReceiver)
                            }
                            return (...args) => {
                                if (state.active !== null) state.active[`${statementProperty}Calls`]++
                                return Reflect.apply(
                                    statementTarget[statementProperty],
                                    statementTarget,
                                    args,
                                )
                            }
                        },
                    })
                }
            }
            return Reflect.get(target, property, receiver)
        },
    })
}

function createMeasureState() {
    return {
        prepareCalls: 0,
        allCalls: 0,
        getCalls: 0,
        runCalls: 0,
        sql: createSqlCounter(),
    }
}

function facts() {
    return {
        boardCount: 1,
        boardNodeIds: new Map([[1, new Set([2201])]]),
        secondBoardAvailable: false,
    }
}

function setupDatabase() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-real-admission-"))
    const state = { active: null }
    let database
    try {
        database = initializeDatabase({
            paths: resolveRuntimeDataPaths({ DATA_DIR: directory }),
            databaseFactory: databasePath => createObservedDatabase(databasePath, state),
        })
        const account = insertAccountSync({
            appId: "wf_cn",
            idpAlias: "",
            idpCode: "character-growth-admission",
            idpId: `character-growth-admission-${process.pid}-${Date.now()}`,
            status: "normal",
        })
        const playerId = insertDefaultPlayerSync(account.id).id
        const insertCharacter = database.prepare(`
            INSERT INTO players_characters
                (id, entry_count, evolution_level, over_limit_step, protection,
                 join_time, update_time, exp, stack, mana_board_index, player_id,
                 ex_boost_status_id, ex_boost_ability_id_list, illustration_settings)
            VALUES (?, 1, 0, 0, 0, ?, ?, 100, 0, 1, ?, NULL, NULL, NULL)
        `)
        const insertToken = database.prepare(`
            INSERT INTO players_characters_bond_tokens
                (mana_board_index, status, player_id, character_id)
            VALUES (?, ?, ?, ?)
        `)
        const insertNode = database.prepare(`
            INSERT INTO players_characters_mana_nodes
                (value, awake_level, character_id, player_id)
            VALUES (?, 0, ?, ?)
        `)
        const insertAwakeUnlock = database.prepare(`
            INSERT INTO players_character_awake_unlocks
                (player_id, character_id, board_index, awake_level)
            VALUES (?, ?, 1, 1)
        `)
        const now = "2026-08-31T00:00:00.000Z"
        for (let characterId = 2; characterId <= 20; characterId++) {
            insertCharacter.run(characterId, now, now, playerId)
            insertToken.run(1, 0, playerId, characterId)
            insertNode.run(2201, characterId, playerId)
            insertAwakeUnlock.run(playerId, characterId)
        }
        database.prepare(
            "INSERT INTO players_items (id, amount, player_id) VALUES (1, 10, ?)",
        ).run(playerId)
        return { directory, state, playerId, database }
    } catch (error) {
        if (database?.open) database.close()
        fs.rmSync(directory, { recursive: true, force: true })
        throw error
    }
}

function measure(state, operation) {
    const measured = createMeasureState()
    state.active = measured
    try {
        operation()
    } finally {
        state.active = null
    }
    const sql = measured.sql.snapshot()
    return {
        prepareCalls: measured.prepareCalls,
        allCalls: measured.allCalls,
        getCalls: measured.getCalls,
        runCalls: measured.runCalls,
        sqlReads: sql.selectStatements,
        sqlWrites: sql.writeStatements,
        sqlByTable: sql.byTable,
    }
}

function reportScenario(measured, behavior) {
    return {
        ...measured,
        behavior,
        behaviorSha256: crypto.createHash("sha256")
            .update(JSON.stringify(behavior))
            .digest("hex"),
    }
}

function createRequestContext(repository, characterId) {
    return createCharacterGrowthRequestContext({
        playerId: repository.playerId,
        characterId,
        repository: repository.instance,
        rarityLoader: () => 5,
        contentFactsLoader: facts,
    })
}

test("admission measures real SQLite SQL for untouched and single-character contexts", t => {
    const fixture = setupDatabase()
    t.after(() => {
        closeDatabase()
        fs.rmSync(fixture.directory, { recursive: true, force: true })
    })
    const repository = { playerId: fixture.playerId, instance: new CharacterGrowthRepository() }

    const untouched = measure(fixture.state, () => {
        createRequestContext(repository, 1)
    })
    assert.equal(untouched.sqlReads, 0)
    assert.equal(untouched.prepareCalls, 0)
    assert.equal(untouched.allCalls, 0)
    assert.equal(untouched.getCalls, 0)
    assert.equal(untouched.runCalls, 0)

    const single = measure(fixture.state, () => {
        const context = createRequestContext(repository, 1)
        context.character()
        context.bondTokens()
        context.normalManaNodes()
        context.awakeUnlocks()
        context.requiredItems([1, 2])
    })
    assert.equal(single.sqlReads, 5)
    assert.equal(single.sqlWrites, 0)
    assert.equal(single.prepareCalls, 5)
    assert.equal(single.getCalls, 1)
    assert.equal(single.allCalls, 4)
    assert.equal(single.runCalls, 0)
    assert.equal(single.sqlByTable.players_equipment, undefined)
    assert.deepEqual(
        Object.fromEntries(Object.entries(single.sqlByTable).map(([table, counts]) => [
            table,
            counts.statements,
        ])),
        {
            players_character_awake_unlocks: 1,
            players_characters: 1,
            players_characters_bond_tokens: 1,
            players_characters_mana_nodes: 1,
            players_items: 1,
        },
    )
    const report = {
        version: 2,
        scenarios: {
            untouched: reportScenario(untouched, { contextCreated: true, sections: [] }),
            single: reportScenario(single, { contextCreated: true, sections: ["all"] }),
        },
    }
    assert.match(report.scenarios.single.behaviorSha256, /^[a-f0-9]{64}$/)
    console.log(JSON.stringify(report))
})

test("admission measures constant real SQLite SQL for one and twenty character batches", t => {
    const fixture = setupDatabase()
    t.after(() => {
        closeDatabase()
        fs.rmSync(fixture.directory, { recursive: true, force: true })
    })
    const repository = { playerId: fixture.playerId, instance: new CharacterGrowthRepository() }
    const runBatch = ids => {
        const context = createCharacterGrowthBatchContext({
            playerId: fixture.playerId,
            characterIds: ids,
            repository: repository.instance,
            rarityLoader: () => 5,
            contentFactsLoader: facts,
        })
        context.characters()
        for (const characterId of ids) {
            context.bondTokens(characterId)
            context.normalManaNodes(characterId)
            context.awakeUnlocks(characterId)
        }
        context.requiredItems([1, 2])
    }
    const one = measure(fixture.state, () => runBatch([1]))
    const twentyIds = Array.from({ length: 20 }, (_unused, index) => index + 1)
    const twenty = measure(fixture.state, () => runBatch(twentyIds))

    for (const measured of [one, twenty]) {
        assert.equal(measured.sqlReads, 5)
        assert.equal(measured.sqlWrites, 0)
        assert.equal(measured.prepareCalls, 5)
        assert.equal(measured.getCalls, 0)
        assert.equal(measured.allCalls, 5)
        assert.equal(measured.runCalls, 0)
        assert.equal(measured.sqlByTable.players_equipment, undefined)
    }
    assert.deepEqual(twenty.sqlByTable, one.sqlByTable)
    console.log(JSON.stringify({
        version: 2,
        scenarios: {
            batchOne: reportScenario(one, { characterCount: 1, sections: ["all"] }),
            batchTwenty: reportScenario(twenty, { characterCount: 20, sections: ["all"] }),
        },
    }))
})

test("admission report schema includes real operation counters and stable behavior hashes", () => {
    const report = reportScenario({
        prepareCalls: 0,
        allCalls: 0,
        getCalls: 0,
        runCalls: 0,
        sqlReads: 0,
        sqlWrites: 0,
        sqlByTable: Object.fromEntries(TABLES.map(table => [
            table,
            { reads: 0, writes: 0, statements: 0 },
        ])),
    }, { contextCreated: false })
    assert.equal(report.prepareCalls, 0)
    assert.equal(report.allCalls, 0)
    assert.equal(report.getCalls, 0)
    assert.equal(report.runCalls, 0)
    assert.match(report.behaviorSha256, /^[a-f0-9]{64}$/)
})

