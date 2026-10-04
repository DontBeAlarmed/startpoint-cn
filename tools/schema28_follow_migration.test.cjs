"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => { restoreContentSnapshot() })

const { loadServerReleaseContract } = require("./server-bundle/release-contract.cjs")
const projectRoot = path.resolve(__dirname, "..")
const contract = loadServerReleaseContract(projectRoot)

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { resolveRuntimeDataPaths } = require("../src/runtime/data-paths")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { PLAYER_SAVE_EXCLUDED_TABLES } = require("../src/data/player-save/registry")

const parent = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "schema28-follows-"))
process.on("exit", () => fs.rmSync(parent, { recursive: true, force: true }))
const paths = resolveRuntimeDataPaths({ DATA_DIR: path.join(parent, "data") })

// players_follows 于 schema 28 进入契约版本;后续 29(ranking claims)继续推进
assert.equal(contract.currentDataSchema, 29, "契约版本应推进到 29(含 28 的 Follow 与 29 的 ranking claims)")

function freshPlayer(tag) {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `schema28-follows-${tag}`, status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

// ---- fresh init ----
data.initializeDatabase({ paths })
const db = getDb()
const columns = db.prepare(`
    SELECT name FROM pragma_table_info('players_follows') ORDER BY name
`).all().map(row => row.name)
assert.deepEqual(columns, ["followed_at", "followed_player_id", "follower_player_id"])

const selfCheck = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'players_follows'
`).get().sql
assert.match(selfCheck, /CHECK\s*\(\s*follower_player_id\s*<>\s*followed_player_id\s*\)/i)
assert.match(selfCheck, /FOREIGN KEY\s*\(\s*follower_player_id\s*\)\s*REFERENCES\s*players\s*\(\s*id\s*\)\s*ON DELETE CASCADE/i)
assert.match(selfCheck, /FOREIGN KEY\s*\(\s*followed_player_id\s*\)\s*REFERENCES\s*players\s*\(\s*id\s*\)\s*ON DELETE CASCADE/i)
assert.equal(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_players_follows_followed'`).get()?.name,
    "idx_players_follows_followed",
    "反向（被关注）查询需要索引",
)

// self 边被 CHECK 拒绝
const playerId = freshPlayer("self")
assert.throws(
    () => db.prepare(`
        INSERT INTO players_follows (follower_player_id, followed_player_id, followed_at)
        VALUES (?, ?, 0)
    `).run(playerId, playerId),
    /CHECK constraint failed/i,
)

// 外键级联：删玩家清理双向边
const follower = freshPlayer("follower")
const followee = freshPlayer("followee")
db.prepare(`INSERT INTO players_follows VALUES (?, ?, 11)`).run(follower, followee)
db.prepare(`INSERT INTO players_follows VALUES (?, ?, 22)`).run(followee, follower)
db.prepare(`DELETE FROM players WHERE id = ?`).run(followee)
assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM players_follows`).get().n,
    0,
    "玩家删除必须级联清理 Follow 边",
)

// player-save 排除
assert.deepEqual(
    PLAYER_SAVE_EXCLUDED_TABLES.find(table => table.name === "players_follows"),
    { name: "players_follows", reason: "serverOperation" },
)
data.closeDatabase()

// ---- upgrade from 27 ----
const Sqlite = require("better-sqlite3")
const legacy = new Sqlite(paths.databaseFile)
legacy.exec(`DROP TABLE players_follows`)
legacy.pragma("user_version = 27")
legacy.close()

data.initializeDatabase({ paths })
const migrated = getDb()
assert.equal(migrated.pragma("user_version", { simple: true }), 29)
assert.equal(
    migrated.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'players_follows'`).get().n,
    1,
    "27 → 28 升级必须补建 players_follows",
)
data.closeDatabase()

console.log("schema28 follow migration tests passed")
