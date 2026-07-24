const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "../..")
const defaultDatabaseDirectory = path.join(projectRoot, ".database")

function snapshotDirectory(directory) {
    if (!fs.existsSync(directory)) return null
    function visit(currentDirectory, relativeDirectory = "") {
        return fs.readdirSync(currentDirectory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))
            .flatMap(entry => {
                const relativePath = path.join(relativeDirectory, entry.name)
                const absolutePath = path.join(currentDirectory, entry.name)
                if (entry.isDirectory()) {
                    return [[`${relativePath}/`, "directory"], ...visit(absolutePath, relativePath)]
                }
                return [[
                    relativePath,
                    crypto.createHash("sha256")
                        .update(fs.readFileSync(absolutePath))
                        .digest("hex"),
                ]]
            })
    }
    return Object.fromEntries(visit(directory))
}

const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), "wdfp-database-import-"))
const dataDirectory = path.join(temporaryParent, "data")
const defaultDatabaseBefore = snapshotDirectory(defaultDatabaseDirectory)
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = dataDirectory
delete process.env.WDFP_DATABASE_DIR
require("ts-node/register/transpile-only")

try {
    const data = require("../../src/data")
    const { getDb } = require("../../src/data/db")

    assert.equal(
        fs.existsSync(dataDirectory),
        false,
        "importing data modules must not prepare the volume or open SQLite",
    )
    assert.deepEqual(data.getDatabaseStatus(), { open: false, ready: false, schema: null })
    assert.throws(() => getDb(), /not initialized/i)

    data.initializeDatabase()
    const db = getDb()
    assert.equal(db.prepare("SELECT 1 AS value").get().value, 1)
    assert.deepEqual(data.getDatabaseStatus(), { open: true, ready: true, schema: 7 })
    assert.equal(fs.existsSync(path.join(dataDirectory, "wdfp_data.db")), true)
    assert.equal(fs.readFileSync(path.join(dataDirectory, "wdfp_data.db.version"), "utf8"), "7")

    assert.equal(data.closeDatabase(), true)
    assert.equal(data.closeDatabase(), false)
    assert.deepEqual(data.getDatabaseStatus(), { open: false, ready: false, schema: null })
    assert.deepEqual(
        fs.readdirSync(dataDirectory).sort(),
        ["state", "wdfp_data.db", "wdfp_data.db.version"],
    )
    assert.deepEqual(fs.readdirSync(path.join(dataDirectory, "state")), [])
    console.log("database isolation tests passed")
} finally {
    fs.rmSync(temporaryParent, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    assert.deepEqual(snapshotDirectory(defaultDatabaseDirectory), defaultDatabaseBefore)
}
