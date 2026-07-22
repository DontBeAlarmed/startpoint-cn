const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Sqlite = require("better-sqlite3")

const importSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wdfp-database-module-"))
process.env.DATA_DIR = path.join(importSandbox, "data")
process.on("exit", () => fs.rmSync(importSandbox, { recursive: true, force: true }))
require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "../..")
const data = require("../../src/data")
const { getDb } = require("../../src/data/db")
const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")

function temporaryPaths(t) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wdfp-database-lifecycle-"))
    t.after(() => {
        data.closeDatabase()
        fs.rmSync(parent, { recursive: true, force: true })
    })
    return resolveRuntimeDataPaths({ DATA_DIR: path.join(parent, "data") })
}

function createExistingDatabase(paths, userVersion) {
    fs.mkdirSync(paths.dataDir, { recursive: true })
    const db = new Sqlite(paths.databaseFile)
    db.exec("CREATE TABLE migration_log (value TEXT NOT NULL)")
    db.pragma(`user_version = ${userVersion}`)
    db.close()
}

function migrations(overrides = {}) {
    return {
        latestVersion: 4,
        init(database) {
            database.exec("CREATE TABLE IF NOT EXISTS initialized (value INTEGER NOT NULL)")
        },
        ...overrides,
    }
}

function fileDigest(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

test("runs updateBefore, init, updateAfter, and user_version in one transaction", t => {
    const paths = temporaryPaths(t)
    createExistingDatabase(paths, 1)
    const calls = []

    data.initializeDatabase({
        paths,
        migrations: migrations({
            updateBefore(database, version) {
                calls.push(["before", version])
                database.prepare("INSERT INTO migration_log VALUES (?)").run("before")
            },
            init(database) {
                calls.push(["init"])
                database.exec("CREATE TABLE initialized (value INTEGER NOT NULL)")
            },
            updateAfter(database, version) {
                calls.push(["after", version])
                database.prepare("INSERT INTO migration_log VALUES (?)").run("after")
            },
        }),
    })

    assert.deepEqual(calls, [["before", 1], ["init"], ["after", 1]])
    assert.equal(getDb().pragma("user_version", { simple: true }), 4)
    assert.deepEqual(
        getDb().prepare("SELECT value FROM migration_log ORDER BY rowid").all(),
        [{ value: "before" }, { value: "after" }],
    )
})

test("rolls back a failed migration, closes it, leaves no cache, and can retry", t => {
    const paths = temporaryPaths(t)
    createExistingDatabase(paths, 1)
    fs.writeFileSync(paths.databaseVersionFile, "1")
    const originalError = new Error("injected migration failure")

    assert.throws(
        () => data.initializeDatabase({
            paths,
            migrations: migrations({
                updateBefore(database) {
                    database.prepare("INSERT INTO migration_log VALUES (?)").run("must roll back")
                },
                init() {
                    throw originalError
                },
            }),
        }),
        error => {
            assert.equal(error.cause, originalError)
            assert.equal(error.message.includes(paths.dataDir), false)
            return true
        },
    )

    assert.deepEqual(data.getDatabaseStatus(), { open: false, ready: false, schema: null })
    assert.throws(() => getDb(), /not initialized/i)
    assert.equal(fs.readFileSync(paths.databaseVersionFile, "utf8"), "1")
    const inspection = new Sqlite(paths.databaseFile)
    assert.equal(inspection.pragma("user_version", { simple: true }), 1)
    assert.deepEqual(inspection.prepare("SELECT value FROM migration_log").all(), [])
    inspection.close()

    data.initializeDatabase({ paths, migrations: migrations() })
    assert.deepEqual(data.getDatabaseStatus(), { open: true, ready: true, schema: 4 })
})

test("uses a valid legacy sidecar only when user_version is zero", t => {
    const paths = temporaryPaths(t)
    createExistingDatabase(paths, 0)
    fs.writeFileSync(paths.databaseVersionFile, "2")
    const versions = []

    data.initializeDatabase({
        paths,
        migrations: migrations({
            updateBefore(_database, version) { versions.push(version) },
            updateAfter(_database, version) { versions.push(version) },
        }),
    })

    assert.deepEqual(versions, [2, 2])
    assert.equal(getDb().pragma("user_version", { simple: true }), 4)
    assert.equal(fs.readFileSync(paths.databaseVersionFile, "utf8"), "4")

    data.closeDatabase()
    const db = new Sqlite(paths.databaseFile)
    db.pragma("user_version = 3")
    db.close()
    fs.writeFileSync(paths.databaseVersionFile, "1")
    versions.length = 0

    data.initializeDatabase({
        paths,
        migrations: migrations({
            updateBefore(_database, version) { versions.push(version) },
            updateAfter(_database, version) { versions.push(version) },
        }),
    })
    assert.deepEqual(versions, [3, 3])
})

test("rejects a newer legacy sidecar without changing database or sidecar", t => {
    const paths = temporaryPaths(t)
    createExistingDatabase(paths, 0)
    fs.writeFileSync(paths.databaseVersionFile, "9")
    const databaseBefore = fileDigest(paths.databaseFile)
    let migrationRuns = 0

    assert.throws(
        () => data.initializeDatabase({
            paths,
            migrations: migrations({
                updateBefore() { migrationRuns++ },
                init() { migrationRuns++ },
                updateAfter() { migrationRuns++ },
            }),
        }),
        error => error.cause?.message === "Database schema is newer than this server supports",
    )

    assert.equal(migrationRuns, 0)
    assert.equal(fileDigest(paths.databaseFile), databaseBefore)
    assert.equal(fs.readFileSync(paths.databaseVersionFile, "utf8"), "9")
    const inspection = new Sqlite(paths.databaseFile)
    assert.equal(inspection.pragma("user_version", { simple: true }), 0)
    inspection.close()
})

for (const [name, sidecar] of [
    ["negative", "-1"],
    ["non-numeric", "NaN"],
    ["unsafe integer", "9007199254740992"],
]) {
    test(`treats ${name} legacy sidecar as version zero`, t => {
        const paths = temporaryPaths(t)
        createExistingDatabase(paths, 0)
        fs.writeFileSync(paths.databaseVersionFile, sidecar)
        const versions = []

        data.initializeDatabase({
            paths,
            migrations: migrations({
                updateBefore(_database, version) { versions.push(version) },
            }),
        })

        assert.deepEqual(versions, [0])
        assert.equal(getDb().pragma("user_version", { simple: true }), 4)
        assert.equal(fs.readFileSync(paths.databaseVersionFile, "utf8"), "4")
    })
}

test("schema column helper is idempotent when the column already exists", () => {
    const { ensureSchemaColumn } = require("../../src/data/schema")
    const database = new Sqlite(":memory:")
    try {
        database.exec("CREATE TABLE players (id INTEGER, total_login_days INTEGER NOT NULL DEFAULT 0)")
        assert.equal(ensureSchemaColumn(database, "players.total_login_days"), false)
        assert.equal(ensureSchemaColumn(database, "players.total_login_days"), false)
        assert.equal(
            database.pragma("table_info(players)").filter(column => column.name === "total_login_days").length,
            1,
        )
    } finally {
        database.close()
    }
})

test("database initializer uses schema checks instead of broad ALTER catches", () => {
    const source = fs.readFileSync(
        path.join(projectRoot, "src/data/initializers/wdfpData.ts"),
        "utf8",
    )
    assert.doesNotMatch(source, /\bcatch\b/)
    assert.ok(source.split("ensureSchemaColumn(").length - 1 >= 20)
})

test("non-duplicate ALTER failure rolls back and leaves user_version unchanged", t => {
    const { ensureSchemaColumn } = require("../../src/data/schema")
    const paths = temporaryPaths(t)
    createExistingDatabase(paths, 1)
    const fixture = new Sqlite(paths.databaseFile)
    fixture.exec("CREATE VIEW players AS SELECT 1 AS id")
    fixture.close()
    fs.writeFileSync(paths.databaseVersionFile, "1")

    assert.throws(
        () => data.initializeDatabase({
            paths,
            migrations: migrations({
                init(database) {
                    database.prepare("INSERT INTO migration_log VALUES (?)").run("must roll back")
                    ensureSchemaColumn(database, "players.total_login_days")
                },
            }),
        }),
        error => /view/i.test(error.cause?.message ?? ""),
    )

    const inspection = new Sqlite(paths.databaseFile)
    assert.equal(inspection.pragma("user_version", { simple: true }), 1)
    assert.deepEqual(inspection.prepare("SELECT value FROM migration_log").all(), [])
    inspection.close()
    assert.equal(fs.readFileSync(paths.databaseVersionFile, "utf8"), "1")
})

for (const nestedPathMode of ["same", "different"]) {
    test(`rejects ${nestedPathMode}-path reentrant initialization and closes the owned handle`, t => {
        const outerPaths = temporaryPaths(t)
        const nestedPaths = nestedPathMode === "same" ? outerPaths : temporaryPaths(t)
        const handles = []
        const databaseFactory = filePath => {
            const handle = new Sqlite(filePath)
            handles.push(handle)
            return handle
        }

        assert.throws(
            () => data.initializeDatabase({
                paths: outerPaths,
                databaseFactory,
                migrations: migrations({
                    init() {
                        data.initializeDatabase({
                            paths: nestedPaths,
                            databaseFactory,
                            migrations: migrations(),
                        })
                    },
                }),
            }),
            error => {
                const messages = [error.message, error.cause?.message, error.cause?.cause?.message]
                return messages.some(message => /already in progress/i.test(message ?? ""))
            },
        )

        assert.equal(handles.length, 1)
        assert.equal(handles[0].open, false)
        assert.equal(data.closeDatabase(), false)

        data.initializeDatabase({
            paths: outerPaths,
            databaseFactory,
            migrations: migrations(),
        })
        assert.equal(handles.length, 2)
        assert.equal(handles[1].open, true)
        assert.equal(data.closeDatabase(), true)
    })
}

test("committed user_version prevents migration replay when sidecar publishing fails", t => {
    const paths = temporaryPaths(t)
    createExistingDatabase(paths, 3)
    fs.mkdirSync(paths.databaseVersionFile)
    let migrationRuns = 0
    const migrationSet = migrations({
        updateBefore(database) {
            migrationRuns++
            database.prepare("INSERT INTO migration_log VALUES (?)").run("once")
        },
    })

    assert.throws(
        () => data.initializeDatabase({ paths, migrations: migrationSet }),
        error => error.cause instanceof Error,
    )
    assert.equal(migrationRuns, 1)
    assert.deepEqual(data.getDatabaseStatus(), { open: false, ready: false, schema: null })

    const inspection = new Sqlite(paths.databaseFile)
    assert.equal(inspection.pragma("user_version", { simple: true }), 4)
    assert.deepEqual(inspection.prepare("SELECT value FROM migration_log").all(), [{ value: "once" }])
    inspection.close()

    fs.rmSync(paths.databaseVersionFile, { recursive: true })
    data.initializeDatabase({ paths, migrations: migrationSet })
    assert.equal(migrationRuns, 1)
    assert.equal(fs.readFileSync(paths.databaseVersionFile, "utf8"), "4")
})

test("reports status without paths and supports checkpoint, close, and reinitialize", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths, migrations: migrations() })

    const status = data.getDatabaseStatus()
    assert.deepEqual(status, { open: true, ready: true, schema: 4 })
    assert.equal(JSON.stringify(status).includes(paths.dataDir), false)
    const checkpoint = data.checkpointDatabase()
    assert.equal(checkpoint.mode, "TRUNCATE")
    assert.equal(typeof checkpoint.busy, "number")
    assert.equal(typeof checkpoint.log, "number")
    assert.equal(typeof checkpoint.checkpointed, "number")

    assert.equal(data.closeDatabase(), true)
    assert.equal(data.closeDatabase(), false)
    assert.throws(() => data.checkpointDatabase(), /not initialized/i)
    assert.throws(() => getDb(), /not initialized/i)

    data.initializeDatabase({ paths, migrations: migrations() })
    assert.equal(getDb().open, true)
})

test("failed close keeps the ready database reachable and can be retried", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths, migrations: migrations() })
    const database = getDb()
    const iterator = database.prepare("SELECT 1 AS value UNION ALL SELECT 2 AS value").iterate()
    assert.deepEqual(iterator.next(), { value: { value: 1 }, done: false })

    assert.throws(
        () => data.closeDatabase(),
        error => {
            assert.equal(error instanceof data.DatabaseLifecycleError, true)
            assert.match(error.message, /close/i)
            assert.match(error.cause?.message ?? "", /busy/i)
            return true
        },
    )
    assert.deepEqual(data.getDatabaseStatus(), { open: true, ready: true, schema: 4 })
    assert.strictEqual(getDb(), database)
    assert.equal(database.open, true)

    iterator.return()
    assert.equal(data.closeDatabase(), true)
    assert.deepEqual(data.getDatabaseStatus(), { open: false, ready: false, schema: null })
})

test("externally closed cached handle is cleared without closing it again", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths, migrations: migrations() })
    const database = getDb()
    const originalClose = database.close.bind(database)
    database.close()
    let closeCalls = 0
    database.close = () => {
        closeCalls++
        throw new Error("closed handle must not be closed again")
    }

    try {
        assert.equal(data.closeDatabase(), false)
        assert.equal(closeCalls, 0)
        assert.deepEqual(data.getDatabaseStatus(), { open: false, ready: false, schema: null })
        assert.throws(() => getDb(), /not initialized/i)
        assert.equal(data.closeDatabase(), false)
    } finally {
        database.close = originalClose
        data.closeDatabase()
    }
})

test("CN and global bootstraps initialize database before content and listen", () => {
    for (const [entrypoint, hasStateRestore] of [["cn-server.ts", true], ["server.ts", false]]) {
        const source = fs.readFileSync(path.join(projectRoot, "src", entrypoint), "utf8")
        assert.match(source, /import\s+\{\s*initializeDatabase\s*\}\s+from\s+["']\.\/data["']/)
        const bootstrapStart = source.indexOf("async function bootstrap")
        const beforeBootstrap = source.slice(0, bootstrapStart)
        const bootstrap = source.slice(bootstrapStart)
        const databaseIndex = bootstrap.indexOf("initializeDatabase(")
        const contentIndex = bootstrap.indexOf("initializeContentSnapshot(")
        const listenIndex = bootstrap.indexOf("fastify.listen(")
        assert.ok(databaseIndex >= 0, entrypoint)
        assert.ok(databaseIndex < contentIndex, entrypoint)
        assert.ok(contentIndex < listenIndex, entrypoint)
        assert.equal(beforeBootstrap.includes("initializeDatabase("), false, entrypoint)
        if (hasStateRestore) {
            const restoreIndex = bootstrap.indexOf("restoreTimeOffset(")
            assert.ok(databaseIndex < restoreIndex, entrypoint)
            assert.ok(restoreIndex < contentIndex, entrypoint)
            assert.equal(beforeBootstrap.includes("restoreTimeOffset("), false)
        }
    }
})
