"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Sqlite = require("better-sqlite3")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gacha-schema25-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = path.join(root, "data")

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")

test.after(() => {
    data.closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("literal schema 24 migrates through 25 and 26 to 27 without rewriting existing Gacha state", () => {
    const fresh = data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "schema25-gacha",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    fresh.prepare(`INSERT INTO players_gacha_info
        (gacha_id, is_daily_first, is_account_first, gacha_exchange_point, player_id)
        VALUES (1638, 0, 1, 17, ?)`).run(playerId)
    fresh.prepare(`INSERT INTO players_gacha_campaigns
        (gacha_id, campaign_id, count, player_id)
        VALUES (1638, 77, 0, ?)`).run(playerId)
    data.closeDatabase()

    const databasePath = path.join(process.env.DATA_DIR, "wdfp_data.db")
    const schema24 = new Sqlite(databasePath)
    schema24.pragma("foreign_keys = OFF")
    schema24.exec(`
        DROP TABLE players_bond_token_exchanges;
        DROP TABLE players_gacha_conversions;
        DROP TABLE players_gacha_crazy_results;
        DROP TABLE players_stars_gacha_campaigns;
        DROP TABLE players_gacha_details;
        ALTER TABLE players_gacha_info RENAME TO players_gacha_info_schema26;
        CREATE TABLE players_gacha_info (
            gacha_id INTEGER NOT NULL,
            is_daily_first INTEGER NOT NULL,
            is_account_first INTEGER NOT NULL,
            gacha_exchange_point INTEGER,
            player_id INTEGER NOT NULL,
            PRIMARY KEY (gacha_id, player_id),
            FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
        );
        INSERT INTO players_gacha_info (
            gacha_id, is_daily_first, is_account_first, gacha_exchange_point, player_id
        ) SELECT gacha_id, is_daily_first, is_account_first, gacha_exchange_point, player_id
          FROM players_gacha_info_schema26;
        DROP TABLE players_gacha_info_schema26;
        DROP INDEX idx_players_gacha_campaigns_player_gacha_campaign;
    `)
    schema24.pragma("user_version = 24")
    schema24.close()
    fs.writeFileSync(path.join(process.env.DATA_DIR, "wdfp_data.version"), "24")

    const migrated = data.initializeDatabase()
    assert.equal(migrated.pragma("user_version", { simple: true }), 27)
    assert.equal(
        migrated.pragma("table_info(players_gacha_info)")
            .some(column => column.name === "crazy_draw_count"),
        true,
    )
    assert.deepEqual(
        migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
            AND name IN ('players_gacha_crazy_results', 'players_gacha_conversions')
            ORDER BY name`).all().map(row => row.name),
        ["players_gacha_conversions", "players_gacha_crazy_results"],
    )
    assert.deepEqual(
        migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
            AND name = 'players_bond_token_exchanges'`).get(),
        { name: "players_bond_token_exchanges" },
    )
    assert.deepEqual(migrated.prepare(`SELECT gacha_id, is_daily_first,
        is_account_first, gacha_exchange_point, player_id
        FROM players_gacha_info WHERE player_id = ?`).get(playerId), {
        gacha_id: 1638,
        is_daily_first: 0,
        is_account_first: 1,
        gacha_exchange_point: 17,
        player_id: playerId,
    })
    assert.deepEqual(migrated.prepare(`SELECT gacha_id, campaign_id, count, player_id
        FROM players_gacha_campaigns WHERE player_id = ?`).get(playerId), {
        gacha_id: 1638,
        campaign_id: 77,
        count: 0,
        player_id: playerId,
    })
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_gacha_details").get().count, 0)
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_stars_gacha_campaigns").get().count, 0)
    const indexes = migrated.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_players_gacha_%'
        ORDER BY name`).all().map(row => row.name)
    assert.deepEqual(indexes, [
        "idx_players_gacha_campaigns_player_gacha_campaign",
        "idx_players_gacha_crazy_results_player_gacha",
        "idx_players_gacha_info_player_gacha",
    ])
    for (const sql of [
        "SELECT * FROM players_gacha_info WHERE player_id = ? ORDER BY gacha_id, player_id",
        "SELECT * FROM players_gacha_campaigns WHERE player_id = ? ORDER BY gacha_id, campaign_id, player_id",
    ]) {
        const plan = migrated.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(playerId)
        assert.equal(plan.some(row => /SEARCH .*player_id=\?/i.test(row.detail)), true, plan)
        assert.equal(plan.some(row => /SCAN |TEMP B-TREE/i.test(row.detail)), false, plan)
    }

    migrated.prepare(`INSERT INTO players_gacha_details
        (player_id, gacha_id, comeback_period_start_time, comeback_period_end_time)
        VALUES (?, 1638, 1, 2)`).run(playerId)
    migrated.prepare(`INSERT INTO players_stars_gacha_campaigns
        (player_id, campaign_id, gacha_id, period_start_time, period_end_time)
        VALUES (?, 1, 1638, 1, 2)`).run(playerId)
    migrated.prepare("DELETE FROM players_gacha_info WHERE player_id = ? AND gacha_id = 1638").run(playerId)
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_gacha_details").get().count, 0)
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_stars_gacha_campaigns").get().count, 0)

    migrated.prepare(`INSERT INTO players_gacha_info (
        gacha_id, is_daily_first, is_account_first, gacha_exchange_point,
        crazy_draw_count, player_id
    ) VALUES (100, 1, 1, 0, 1, ?)`).run(playerId)
    migrated.prepare(`INSERT INTO players_gacha_crazy_results (
        player_id, gacha_id, slot_index, position, character_id,
        movie_id, seed, entry_count
    ) VALUES (?, 100, 0, 0, 101, 'normal', 10000001, 1)`).run(playerId)
    migrated.prepare(`INSERT INTO players_gacha_conversions (
        player_id, gacha_id, pending_point, converted_at, shown
    ) VALUES (?, 100, 3, 1, 0)`).run(playerId)
    migrated.prepare("DELETE FROM players_gacha_info WHERE player_id = ? AND gacha_id = 100").run(playerId)
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_gacha_crazy_results").get().count, 0)
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_gacha_conversions").get().count, 0)
    migrated.prepare(`INSERT INTO players_bond_token_exchanges (
        player_id, equipment_id, exchange_count
    ) VALUES (?, 5010005, 1)`).run(playerId)
    migrated.prepare("DELETE FROM players WHERE id = ?").run(playerId)
    assert.equal(
        migrated.prepare("SELECT COUNT(*) AS count FROM players_bond_token_exchanges").get().count,
        0,
    )
})
