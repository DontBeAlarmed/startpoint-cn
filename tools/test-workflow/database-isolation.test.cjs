const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "../..")
const dataSourcePath = path.join(projectRoot, "src/data/index.ts")
const dataSource = fs.readFileSync(dataSourcePath, "utf8")
const runtimePathsSource = fs.readFileSync(
    path.join(projectRoot, "src/runtime/data-paths.ts"),
    "utf8",
)
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

assert.match(
    dataSource,
    /prepareDataVolume\(\)/,
    "data layer must prepare the centralized data volume before opening SQLite",
)
assert.match(
    runtimePathsSource,
    /environment\.WDFP_DATABASE_DIR/,
    "runtime paths must retain WDFP_DATABASE_DIR compatibility",
)

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wdfp-database-"))
const defaultDatabaseBefore = snapshotDirectory(defaultDatabaseDirectory)
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
delete process.env.DATA_DIR
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
        ["state", "wdfp_data.db", "wdfp_data.db.version"],
    )
    assert.deepEqual(fs.readdirSync(path.join(temporaryDirectory, "state")), [])
    console.log("database isolation tests passed")
} finally {
    if (db?.open) db.close()
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    assert.deepEqual(snapshotDirectory(defaultDatabaseDirectory), defaultDatabaseBefore)
}
