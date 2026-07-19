const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "../..")
const dataSourcePath = path.join(projectRoot, "src/data/index.ts")
const dataSource = fs.readFileSync(dataSourcePath, "utf8")
const defaultDatabaseDirectory = path.join(projectRoot, ".database")

function snapshotDirectory(directory) {
    if (!fs.existsSync(directory)) return null
    return Object.fromEntries(fs.readdirSync(directory).sort().map(file => [
        file,
        crypto.createHash("sha256")
            .update(fs.readFileSync(path.join(directory, file)))
            .digest("hex"),
    ]))
}

assert.match(
    dataSource,
    /process\.env\.WDFP_DATABASE_DIR/,
    "data layer must honor WDFP_DATABASE_DIR before any database import",
)

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wdfp-database-"))
const defaultDatabaseBefore = snapshotDirectory(defaultDatabaseDirectory)
process.env.WDFP_DATABASE_DIR = temporaryDirectory
require("ts-node/register/transpile-only")

let db
try {
    const { getDb } = require("../../src/data/db")
    db = getDb()
    assert.equal(db.prepare("SELECT 1 AS value").get().value, 1)

    assert.equal(fs.existsSync(path.join(temporaryDirectory, "wdfp_data.db")), true)
    assert.equal(fs.existsSync(path.join(temporaryDirectory, "wdfp_data.db.version")), true)
    db.close()
    db = null
    assert.deepEqual(
        fs.readdirSync(temporaryDirectory).sort(),
        ["wdfp_data.db", "wdfp_data.db.version"],
    )
    console.log("database isolation tests passed")
} finally {
    if (db?.open) db.close()
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    delete process.env.WDFP_DATABASE_DIR
    assert.deepEqual(snapshotDirectory(defaultDatabaseDirectory), defaultDatabaseBefore)
}
