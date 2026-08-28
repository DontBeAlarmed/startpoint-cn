"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
const test = require("node:test")

const {
    DEFAULT_RECEIVE_HISTORY_MAX_AGE_DAYS,
    DEFAULT_RECEIVE_HISTORY_MAX_ROWS,
    ReceiveHistoryRetentionService,
    resolveReceiveHistoryRetentionConfig,
    runReceiveHistoryRetentionPass,
} = require("../src/lib/receive-history-retention")

function createDatabase() {
    const database = new Database(":memory:")
    database.exec(`
        CREATE TABLE players_receive_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            type INTEGER NOT NULL DEFAULT 1,
            type_id INTEGER,
            number INTEGER NOT NULL DEFAULT 1,
            reason_id INTEGER NOT NULL DEFAULT 0,
            create_time TEXT NOT NULL
        );
        CREATE INDEX idx_receive_history_created
            ON players_receive_history (create_time, id);
        CREATE INDEX idx_receive_history_player_created
            ON players_receive_history (player_id, create_time DESC, id DESC);
    `)
    return database
}

function insert(database, playerId, createTime, count) {
    const statement = database.prepare(`
        INSERT INTO players_receive_history (player_id, create_time)
        VALUES (?, ?)
    `)
    for (let index = 0; index < count; index++) statement.run(playerId, createTime)
}

function countingDatabase(database) {
    const statements = []
    return {
        statements,
        prepare(sql) {
            const statement = database.prepare(sql)
            return {
                run(...parameters) {
                    const result = statement.run(...parameters)
                    statements.push({ sql, changes: result.changes })
                    return result
                },
                all(...parameters) {
                    const rows = statement.all(...parameters)
                    statements.push({ sql, rows })
                    return rows
                },
            }
        },
        transaction(callback) {
            return database.transaction(callback)
        },
    }
}

test("retention configuration defaults safely and rejects malformed overrides", () => {
    assert.deepEqual(resolveReceiveHistoryRetentionConfig({}), {
        enabled: true,
        maxAgeDays: DEFAULT_RECEIVE_HISTORY_MAX_AGE_DAYS,
        maxRowsPerPlayer: DEFAULT_RECEIVE_HISTORY_MAX_ROWS,
    })
    assert.deepEqual(resolveReceiveHistoryRetentionConfig({
        RECEIVE_HISTORY_RETENTION_ENABLED: "false",
        RECEIVE_HISTORY_RETENTION_MAX_AGE_DAYS: "45",
        RECEIVE_HISTORY_RETENTION_MAX_ROWS: "750",
    }), { enabled: false, maxAgeDays: 45, maxRowsPerPlayer: 750 })
    assert.deepEqual(resolveReceiveHistoryRetentionConfig({
        RECEIVE_HISTORY_RETENTION_MAX_AGE_DAYS: "0",
        RECEIVE_HISTORY_RETENTION_MAX_ROWS: "1.5",
    }), {
        enabled: true,
        maxAgeDays: DEFAULT_RECEIVE_HISTORY_MAX_AGE_DAYS,
        maxRowsPerPlayer: DEFAULT_RECEIVE_HISTORY_MAX_ROWS,
    })
})

test("one expired-age batch deletes expired rows without crossing its write bound", async () => {
    const database = createDatabase()
    insert(database, 1, "2026-06-01 00:00:00", 5)
    insert(database, 1, "2026-08-27 00:00:00", 3)

    const counted = countingDatabase(database)
    let shouldStop = false
    const first = runReceiveHistoryRetentionPass(counted, new Date("2026-08-28T00:00:00Z"), {
        maxAgeDays: 31,
        maxRowsPerPlayer: 500,
        batchSize: 2,
    }, async () => { shouldStop = true }, () => shouldStop)
    const result = await first
    assert.deepEqual(result, {
        batches: 1,
        deletedExpired: 2,
        deletedOverflow: 0,
        deletedRows: 2,
    })
    const deletedChanges = counted.statements
        .filter(entry => entry.sql.toUpperCase().includes("DELETE"))
        .map(entry => entry.changes)
    assert.deepEqual(deletedChanges, [2])
    assert.equal(counted.statements.some(entry => entry.sql.toUpperCase().includes("ROW_NUMBER()")), false)
    assert.equal(counted.statements.some(entry => entry.sql.includes("HAVING COUNT(*) > ?")), false)
    assert.equal(database.prepare("SELECT COUNT(*) count FROM players_receive_history").get().count, 6)

    database.close()
})

test("retention keeps the newest rows per player with stable same-second ordering", async () => {
    const database = createDatabase()
    insert(database, 1, "2026-08-27 00:00:00", 7)
    insert(database, 2, "2026-08-27 00:00:00", 3)
    const newestPlayerOneIds = database.prepare(`
        SELECT id FROM players_receive_history
        WHERE player_id = 1 ORDER BY id DESC LIMIT 5
    `).all().map(row => row.id).sort((left, right) => left - right)

    const result = await runReceiveHistoryRetentionPass(database, new Date("2026-08-28T00:00:00Z"), {
        maxAgeDays: 31,
        maxRowsPerPlayer: 5,
        batchSize: 10,
    })
    assert.equal(result.deletedExpired, 0)
    assert.equal(result.deletedOverflow, 2)
    assert.equal(result.batches, 2)
    assert.deepEqual(database.prepare(`
        SELECT id FROM players_receive_history
        WHERE player_id = 1 ORDER BY id
    `).all().map(row => row.id), newestPlayerOneIds)
    assert.equal(database.prepare(`
        SELECT COUNT(*) count FROM players_receive_history WHERE player_id = 2
    `).get().count, 3)

    database.close()
})

test("a pass queries overflow candidates once and deletes each player in bounded batches", async () => {
    const database = createDatabase()
    insert(database, 3, "2026-08-27 00:00:00", 12)
    insert(database, 1, "2026-08-27 00:00:00", 8)
    insert(database, 2, "2026-08-27 00:00:00", 7)
    const counted = countingDatabase(database)

    const result = await runReceiveHistoryRetentionPass(
        counted,
        new Date("2026-08-28T00:00:00Z"),
        { maxAgeDays: 31, maxRowsPerPlayer: 5, batchSize: 3 },
        async () => {},
    )
    const candidateQueries = counted.statements.filter(entry =>
        entry.sql.includes("HAVING COUNT(*) > ?")
    )
    assert.equal(candidateQueries.length, 1)
    assert.deepEqual(candidateQueries[0].rows.map(row => row.player_id), [1, 2, 3])
    assert.deepEqual(result, {
        batches: 6,
        deletedExpired: 0,
        deletedOverflow: 12,
        deletedRows: 12,
    })

    const overflowDeletes = counted.statements.filter(entry =>
        entry.sql.trimStart().toUpperCase().startsWith("DELETE")
        && entry.sql.includes("ORDER BY create_time DESC, id DESC")
    )
    assert.deepEqual(overflowDeletes.map(entry => entry.changes), [3, 2, 3, 3, 1])
    assert.equal(overflowDeletes.every(entry => entry.sql.includes("WHERE player_id = ?")), true)
    assert.equal(database.prepare("SELECT COUNT(*) count FROM players_receive_history").get().count, 15)
    database.close()
})

test("a retention pass drains multiple bounded batches and yields between them", async () => {
    const database = createDatabase()
    insert(database, 1, "2026-06-01 00:00:00", 5)
    insert(database, 1, "2026-08-27 00:00:00", 7)
    let yieldCount = 0
    const result = await runReceiveHistoryRetentionPass(
        database,
        new Date("2026-08-28T00:00:00Z"),
        { maxAgeDays: 31, maxRowsPerPlayer: 5, batchSize: 2 },
        async () => { yieldCount++ },
    )
    assert.deepEqual(result, {
        batches: 4,
        deletedExpired: 5,
        deletedOverflow: 2,
        deletedRows: 7,
    })
    assert.equal(yieldCount, 3)
    assert.equal(database.prepare("SELECT COUNT(*) count FROM players_receive_history").get().count, 5)
    database.close()
})

test("a stop set at a yield prevents the next bounded batch", async () => {
    const database = createDatabase()
    insert(database, 1, "2026-06-01 00:00:00", 5)
    let shouldStop = false

    const result = await runReceiveHistoryRetentionPass(
        database,
        new Date("2026-08-28T00:00:00Z"),
        { maxAgeDays: 31, maxRowsPerPlayer: 500, batchSize: 2 },
        async () => { shouldStop = true },
        () => shouldStop,
    )
    assert.deepEqual(result, {
        batches: 1,
        deletedExpired: 2,
        deletedOverflow: 0,
        deletedRows: 2,
    })
    assert.equal(database.prepare("SELECT COUNT(*) count FROM players_receive_history").get().count, 3)
    database.close()
})

test("retention service schedules once and a completed pass schedules the next daily run", async () => {
    const database = createDatabase()
    insert(database, 1, "2026-06-01 00:00:00", 3)
    const scheduled = []
    const cleared = []
    const logs = []
    const service = new ReceiveHistoryRetentionService(() => database, {
        enabled: true,
        maxAgeDays: 31,
        maxRowsPerPlayer: 500,
        batchSize: 2,
        initialDelayMs: 60_000,
        intervalMs: 86_400_000,
    }, {
        getNow: () => new Date("2026-08-28T00:00:00Z"),
        createTimeout(callback, delayMs) {
            const timer = { callback, delayMs, unrefCalled: false, unref() { this.unrefCalled = true } }
            scheduled.push(timer)
            return timer
        },
        clearTimeout: timer => { cleared.push(timer) },
        yieldBetweenBatches: async () => {},
        logger: { log: message => logs.push(message), warn: message => logs.push(message) },
    })

    service.start()
    service.start()
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].delayMs, 60_000)
    assert.equal(scheduled[0].unrefCalled, true)
    scheduled[0].callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(database.prepare("SELECT COUNT(*) count FROM players_receive_history").get().count, 0)
    assert.equal(scheduled.length, 2, "completed pass schedules the next daily run")
    assert.equal(scheduled[1].delayMs, 86_400_000)
    await service.stop()
    assert.deepEqual(cleared, [scheduled[1]])
    assert.equal(logs.some(message => message.includes("deletedRows=3")), true)
    database.close()
})

test("retention service stop at a controlled yield finishes only the active batch", async () => {
    const database = createDatabase()
    insert(database, 1, "2026-06-01 00:00:00", 3)
    const scheduled = []
    const cleared = []
    const logs = []
    const service = new ReceiveHistoryRetentionService(() => database, {
        enabled: true,
        maxAgeDays: 31,
        maxRowsPerPlayer: 500,
        batchSize: 2,
        initialDelayMs: 60_000,
        intervalMs: 86_400_000,
    }, {
        getNow: () => new Date("2026-08-28T00:00:00Z"),
        createTimeout(callback, delayMs) {
            const timer = { callback, delayMs, unref() {} }
            scheduled.push(timer)
            return timer
        },
        clearTimeout: timer => { cleared.push(timer) },
        yieldBetweenBatches: async () => { void service.stop() },
        logger: { log: message => logs.push(message), warn: message => logs.push(message) },
    })

    service.start()
    scheduled[0].callback()
    await service.stop()
    assert.equal(database.prepare("SELECT COUNT(*) count FROM players_receive_history").get().count, 1)
    assert.equal(logs.some(message => message.includes("deletedExpired=2")), true)
    assert.equal(scheduled.length, 1, "stop during an active pass must not schedule another run")
    assert.deepEqual(cleared, [])
    assert.equal(logs.some(message => message.includes("deletedRows=2")), true)
    database.close()
})
