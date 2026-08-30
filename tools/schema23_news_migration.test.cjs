require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Sqlite = require("better-sqlite3")

const previousDataDirectory = process.env.DATA_DIR
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "server-news-schema-"))
process.env.DATA_DIR = path.join(dataDirectory, "data")

const data = require("../src/data")

test.after(() => {
    data.closeDatabase()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

function forcedNewsCount(database) {
    return database.prepare(
        "SELECT COUNT(*) AS count FROM players_options WHERE key GLOB 'server.forced_news.*'",
    ).get().count
}

test("migrates schema 22, creates an empty news table, and removes forced delivery keys", () => {
    data.initializeDatabase()
    data.closeDatabase()

    const databasePath = path.join(process.env.DATA_DIR, "wdfp_data.db")
    const schema22 = new Sqlite(databasePath)
    schema22.pragma("foreign_keys = OFF")
    schema22.prepare(
        "INSERT INTO players_options (key, value, player_id) VALUES ('server.forced_news.7', 1, 0)",
    ).run()
    schema22.prepare(
        "INSERT INTO players_options (key, value, player_id) VALUES ('server.forcedXnews.7', 1, 0)",
    ).run()
    schema22.pragma("user_version = 22")
    schema22.close()
    fs.writeFileSync(path.join(process.env.DATA_DIR, "wdfp_data.version"), "22")

    const migrated = data.initializeDatabase()
    assert.equal(migrated.pragma("user_version", { simple: true }), 23)
    assert.deepEqual(migrated.prepare("SELECT * FROM server_news").all(), [])
    assert.equal(forcedNewsCount(migrated), 0)
    assert.equal(migrated.prepare(
        "SELECT COUNT(*) AS count FROM players_options WHERE key = 'server.forcedXnews.7'",
    ).get().count, 1)

    const schema = require("../src/data/schema/server-news")
    assert.equal(typeof schema.initializeServerNewsSchemaSync, "function")
    assert.equal(typeof schema.migrateServerNewsSchema23Sync, "function")
})

test("creates a new database with an empty server-owned news table", () => {
    const freshDirectory = path.join(dataDirectory, "fresh")
    process.env.DATA_DIR = path.join(freshDirectory, "data")

    const fresh = data.initializeDatabase()
    assert.equal(fresh.pragma("user_version", { simple: true }), 23)
    assert.deepEqual(fresh.prepare("SELECT * FROM server_news").all(), [])
    assert.equal(fs.readdirSync(path.join(freshDirectory, "assets"), { withFileTypes: true })
        .some(entry => entry.isFile() && /^news\./i.test(entry.name)), false)
})

test("migration cleanup runs only for schema 22 or earlier", () => {
    const standalone = new Sqlite(":memory:")
    standalone.exec("CREATE TABLE players_options (key TEXT NOT NULL, value INTEGER NOT NULL, player_id INTEGER NOT NULL)")
    standalone.prepare(
        "INSERT INTO players_options (key, value, player_id) VALUES ('server.forced_news.8', 1, 3)",
    ).run()
    standalone.prepare(
        "INSERT INTO players_options (key, value, player_id) VALUES ('server.forcedXnews.8', 1, 3)",
    ).run()

    const { migrateServerNewsSchema23Sync } = require("../src/data/schema/server-news")
    migrateServerNewsSchema23Sync(standalone, 22)
    assert.equal(forcedNewsCount(standalone), 0)
    assert.equal(standalone.prepare(
        "SELECT COUNT(*) AS count FROM players_options WHERE key = 'server.forcedXnews.8'",
    ).get().count, 1)

    standalone.prepare(
        "INSERT INTO players_options (key, value, player_id) VALUES ('server.forced_news.9', 1, 3)",
    ).run()
    migrateServerNewsSchema23Sync(standalone, 23)
    assert.equal(forcedNewsCount(standalone), 1)
    standalone.close()
})
