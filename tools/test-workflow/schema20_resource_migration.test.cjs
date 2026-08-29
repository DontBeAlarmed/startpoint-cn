"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Sqlite = require("better-sqlite3")

require("ts-node/register/transpile-only")

const data = require("../../src/data")
const { getDb } = require("../../src/data/db")
const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")

const parent = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "schema20-resources-"))
process.on("exit", () => fs.rmSync(parent, { recursive: true, force: true }))
const paths = resolveRuntimeDataPaths({ DATA_DIR: path.join(parent, "data") })

data.initializeDatabase({ paths })
const { insertAccountSync } = require("../../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
const account = insertAccountSync({
    appId: "wf_cn", idpAlias: "", idpCode: "test",
    idpId: "schema20-resource-migration", status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
getDb().prepare(`
    UPDATE players SET stamina = 12, stamina_heal_time = 1000, total_stamina_used = 345 WHERE id = ?
`).run(playerId)
getDb().prepare(`
    INSERT INTO players_active_quests (
        player_id, play_id, quest_id, category, use_boss_boost_point,
        use_boost_point, is_auto_start_mode, is_multi, coordinator_origin,
        room_number, battle_session_id, entry_item_id, entry_item_count,
        stamina_cost, daily_challenge_point_id, event_id, continue_count
    ) VALUES (
        ?, 'legacy-resource-play', 1001, 1, 0, 0, 0, 1, 'local',
        '123456', 'battle-schema20', 500000, 2, 8, 9001, NULL, 0
    )
`).run(playerId)
data.closeDatabase()

const schema20 = new Sqlite(paths.databaseFile)
schema20.exec(`
    ALTER TABLE players_active_quests DROP COLUMN stamina_cost;
    ALTER TABLE players_active_quests DROP COLUMN daily_challenge_point_id;
`)
schema20.pragma("user_version = 20")
schema20.close()
fs.writeFileSync(paths.databaseVersionFile, "20")

data.initializeDatabase({ paths })
const migrated = getDb()
assert.equal(migrated.pragma("user_version", { simple: true }), 21)
assert.deepEqual(migrated.prepare(`
    SELECT stamina, stamina_heal_time, total_stamina_used FROM players WHERE id = ?
`).get(playerId), { stamina: 12, stamina_heal_time: 1000, total_stamina_used: 345 })
assert.deepEqual(migrated.prepare(`
    SELECT play_id, coordinator_origin, room_number, battle_session_id,
           entry_item_id, entry_item_count,
           stamina_cost, daily_challenge_point_id
    FROM players_active_quests WHERE player_id = ?
`).get(playerId), {
    play_id: "legacy-resource-play",
    coordinator_origin: "local",
    room_number: "123456",
    battle_session_id: "battle-schema20",
    entry_item_id: 500000,
    entry_item_count: 2,
    stamina_cost: null,
    daily_challenge_point_id: null,
})
assert.deepEqual(migrated.prepare(`
    PRAGMA foreign_key_list(players_active_quests)
`).all(), [{
    id: 0,
    seq: 0,
    table: "players",
    from: "player_id",
    to: "id",
    on_update: "NO ACTION",
    on_delete: "CASCADE",
    match: "NONE",
}])
const activeQuestDdl = migrated.prepare(`
    SELECT sql FROM sqlite_master WHERE name = 'players_active_quests'
`).get().sql
assert.match(activeQuestDdl, /coordinator_origin[\s\S]*CHECK\s*\([\s\S]*'remote'[\s\S]*'local'/)

console.log("schema20 resource migration tests passed")
