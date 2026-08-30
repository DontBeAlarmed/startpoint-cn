require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Sqlite = require("better-sqlite3")

const previousDataDirectory = process.env.DATA_DIR
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "server-gift-schema-"))
process.env.DATA_DIR = path.join(dataDirectory, "data")

const data = require("../src/data")
const { resolveRuntimeDataPaths } = require("../src/runtime/data-paths")

test.after(() => {
    data.closeDatabase()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

function giftTables(database) {
    return database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('server_gift_codes', 'server_gift_rewards', 'players_gift_redemptions')
        ORDER BY name
    `).all().map(row => row.name)
}

test("migrates literal schema 23 to 24 and creates the public gift tables", () => {
    data.initializeDatabase()
    data.closeDatabase()

    const databasePath = path.join(process.env.DATA_DIR, "wdfp_data.db")
    const schema23 = new Sqlite(databasePath)
    schema23.exec(`
        DROP TABLE IF EXISTS players_gift_redemptions;
        DROP TABLE IF EXISTS server_gift_rewards;
        DROP TABLE IF EXISTS server_gift_codes;
    `)
    schema23.pragma("user_version = 23")
    schema23.close()
    fs.writeFileSync(path.join(process.env.DATA_DIR, "wdfp_data.version"), "23")

    const from23 = data.initializeDatabase()
    assert.equal(from23.pragma("user_version", { simple: true }), 24)
    assert.deepEqual(giftTables(from23), [
        "players_gift_redemptions",
        "server_gift_codes",
        "server_gift_rewards",
    ])
    assert.deepEqual(
        from23.prepare("SELECT COUNT(*) AS count FROM server_gift_codes").get(),
        { count: 0 },
    )
    assert.equal(
        from23.pragma("foreign_key_list(players_gift_redemptions)")
            .filter(key => key.table === "players")
            .every(key => key.on_delete === "CASCADE" || key.on_delete === "SET NULL"),
        true,
    )
})

test("gift rewards reject unsupported protocol types", () => {
    const database = data.initializeDatabase()
    const giftId = database.prepare(`
        INSERT INTO server_gift_codes (code, created_at, updated_at)
        VALUES ('schema24', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
    `).run().lastInsertRowid
    assert.throws(
        () => database.prepare(`
            INSERT INTO server_gift_rewards (gift_id, position, type, type_id, number)
            VALUES (?, 0, 2, NULL, 1)
        `).run(giftId),
        /CHECK constraint failed/,
    )
})

test("rejects literal schema 25 as newer than this server supports", () => {
    data.closeDatabase()
    const paths = resolveRuntimeDataPaths({
        DATA_DIR: path.join(dataDirectory, "schema25", "data"),
    })
    fs.mkdirSync(paths.dataDir, { recursive: true })
    const schema25 = new Sqlite(paths.databaseFile)
    schema25.exec("CREATE TABLE migration_marker (value TEXT NOT NULL)")
    schema25.pragma("user_version = 25")
    schema25.close()
    fs.writeFileSync(paths.databaseVersionFile, "25")

    const initializeFromVersion = version => {
        try {
            return data.initializeDatabase({
                paths,
                migrations: { latestVersion: 24 },
            })
        } catch (error) {
            throw error.cause ?? new Error(`unexpected schema ${version} failure`)
        }
    }
    assert.throws(() => initializeFromVersion(25), /newer than this server supports/i)
})
