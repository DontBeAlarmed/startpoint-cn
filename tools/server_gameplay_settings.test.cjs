"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const importSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "server-gameplay-settings-import-"))
process.env.DATA_DIR = path.join(importSandbox, "data")
process.on("exit", () => fs.rmSync(importSandbox, { recursive: true, force: true }))
require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const Database = require("better-sqlite3")
const { resolveRuntimeDataPaths } = require("../src/runtime/data-paths")

function temporaryPaths(t) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "server-gameplay-settings-"))
    t.after(() => {
        data.closeDatabase()
        fs.rmSync(parent, { recursive: true, force: true })
    })
    return resolveRuntimeDataPaths({ DATA_DIR: path.join(parent, "data") })
}

test("initializes the singleton gameplay settings row from the legacy environment once", t => {
    const previousMultiplier = process.env.DROP_MULTIPLIER
    t.after(() => {
        if (previousMultiplier === undefined) delete process.env.DROP_MULTIPLIER
        else process.env.DROP_MULTIPLIER = previousMultiplier
    })
    process.env.DROP_MULTIPLIER = "10"
    const paths = temporaryPaths(t)

    data.initializeDatabase({ paths })

    const table = getDb().prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'server_gameplay_settings'",
    ).get()
    assert.deepEqual(table, { name: "server_gameplay_settings" })
    assert.deepEqual(
        getDb().prepare(
            "SELECT id, drop_multiplier, multi_rescue_fragment_rewards_enabled, multi_rescue_host_rewards_enabled FROM server_gameplay_settings WHERE id = 1",
        ).get(),
        {
            id: 1,
            drop_multiplier: 10,
            multi_rescue_fragment_rewards_enabled: 1,
            multi_rescue_host_rewards_enabled: 1,
        },
    )

    getDb().prepare(
        "UPDATE server_gameplay_settings SET drop_multiplier = 3 WHERE id = 1",
    ).run()
    data.closeDatabase()
    process.env.DROP_MULTIPLIER = "20"
    data.initializeDatabase({ paths })

    assert.equal(
        getDb().prepare(
            "SELECT drop_multiplier FROM server_gameplay_settings WHERE id = 1",
        ).get().drop_multiplier,
        3,
    )
})

test("gameplay settings domain and API persist only validated integer multipliers", async t => {
    const domainPath = path.join(__dirname, "../src/data/domains/server-settings.ts")
    const routePath = path.join(__dirname, "../src/routes/web_api/settings.ts")
    assert.equal(fs.existsSync(domainPath), true, "server settings domain must exist")
    assert.equal(fs.existsSync(routePath), true, "server settings API must exist")

    const paths = temporaryPaths(t)
    delete process.env.DROP_MULTIPLIER
    data.initializeDatabase({ paths })
    const {
        getServerGameplaySettingsSync,
        updateServerGameplaySettingsSync,
    } = require(domainPath)
    const settingsRoutes = require(routePath).default

    assert.equal(getServerGameplaySettingsSync().dropMultiplier, 1)
    assert.equal(getServerGameplaySettingsSync().multiRescueFragmentRewardsEnabled, true)
    assert.equal(getServerGameplaySettingsSync().multiRescueHostRewardsEnabled, true)
    const updated = updateServerGameplaySettingsSync({
        dropMultiplier: 7,
        multiRescueFragmentRewardsEnabled: false,
        multiRescueHostRewardsEnabled: false,
    })
    assert.equal(updated.dropMultiplier, 7)
    assert.equal(updated.multiRescueFragmentRewardsEnabled, false)
    assert.equal(updated.multiRescueHostRewardsEnabled, false)
    assert.match(updated.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    for (const value of [0, 11, 1.5, NaN, "10", null, undefined]) {
        assert.throws(
            () => updateServerGameplaySettingsSync({ dropMultiplier: value }),
            /drop multiplier/i,
            String(value),
        )
    }
    assert.equal(getServerGameplaySettingsSync().dropMultiplier, 7)
    assert.equal(getServerGameplaySettingsSync().multiRescueFragmentRewardsEnabled, false)
    assert.equal(getServerGameplaySettingsSync().multiRescueHostRewardsEnabled, false)

    const fastify = Fastify()
    t.after(() => fastify.close())
    await fastify.register(settingsRoutes, { prefix: "/api/server/settings" })

    const loaded = await fastify.inject({
        method: "GET",
        url: "/api/server/settings/gameplay",
    })
    assert.equal(loaded.statusCode, 200)
    assert.equal(loaded.json().dropMultiplier, 7)

    const saved = await fastify.inject({
        method: "PATCH",
        url: "/api/server/settings/gameplay",
        payload: { dropMultiplier: 8 },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().dropMultiplier, 8)
    assert.equal(saved.json().multiRescueFragmentRewardsEnabled, false)
    assert.equal(saved.json().multiRescueHostRewardsEnabled, false)

    const hostEnabled = await fastify.inject({
        method: "PATCH",
        url: "/api/server/settings/gameplay",
        payload: { multiRescueHostRewardsEnabled: true },
    })
    assert.equal(hostEnabled.statusCode, 200)
    assert.equal(hostEnabled.json().dropMultiplier, 8)
    assert.equal(hostEnabled.json().multiRescueFragmentRewardsEnabled, false)
    assert.equal(hostEnabled.json().multiRescueHostRewardsEnabled, true)

    const rescueEnabled = await fastify.inject({
        method: "PATCH",
        url: "/api/server/settings/gameplay",
        payload: { multiRescueFragmentRewardsEnabled: true },
    })
    assert.equal(rescueEnabled.statusCode, 200)
    assert.equal(rescueEnabled.json().dropMultiplier, 8)
    assert.equal(rescueEnabled.json().multiRescueFragmentRewardsEnabled, true)

    for (const payload of [
        null,
        {},
        { dropMultiplier: "10" },
        { dropMultiplier: 0 },
        { dropMultiplier: 11 },
        { multiRescueFragmentRewardsEnabled: "true" },
        { multiRescueHostRewardsEnabled: "true" },
        { dropMultiplier: 2, unexpected: true },
    ]) {
        const rejected = await fastify.inject({
            method: "PATCH",
            url: "/api/server/settings/gameplay",
            payload,
            headers: { "content-type": "application/json" },
        })
        assert.equal(rejected.statusCode, 400, JSON.stringify(payload))
    }
    assert.equal(getServerGameplaySettingsSync().dropMultiplier, 8)
    assert.equal(getServerGameplaySettingsSync().multiRescueFragmentRewardsEnabled, true)
    assert.equal(getServerGameplaySettingsSync().multiRescueHostRewardsEnabled, true)
})

test("migrates an existing gameplay settings row with host rewards enabled", t => {
    const paths = temporaryPaths(t)
    fs.mkdirSync(path.dirname(paths.databaseFile), { recursive: true })
    const legacyDatabase = new Database(paths.databaseFile)
    legacyDatabase.exec(`
        CREATE TABLE server_gameplay_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            drop_multiplier INTEGER NOT NULL CHECK (drop_multiplier BETWEEN 1 AND 10),
            updated_at TEXT NOT NULL
        )
    `)
    legacyDatabase.prepare(`
        INSERT INTO server_gameplay_settings (id, drop_multiplier, updated_at)
        VALUES (1, 6, '2024-08-14T12:00:00.000Z')
    `).run()
    legacyDatabase.pragma("user_version = 21")
    legacyDatabase.close()

    data.initializeDatabase({ paths })

    const columns = getDb().prepare(
        "PRAGMA table_info(server_gameplay_settings)",
    ).all()
    const migratedColumn = columns.find(column => (
        column.name === "multi_rescue_host_rewards_enabled"
    ))
    assert.equal(migratedColumn?.type, "INTEGER")
    assert.equal(migratedColumn?.notnull, 1)
    assert.equal(migratedColumn?.dflt_value, "1")
    assert.equal(migratedColumn?.pk, 0)
    const row = getDb().prepare(
        "SELECT multi_rescue_fragment_rewards_enabled, multi_rescue_host_rewards_enabled FROM server_gameplay_settings WHERE id = 1",
    ).get()
    assert.deepEqual(row, {
        multi_rescue_fragment_rewards_enabled: 1,
        multi_rescue_host_rewards_enabled: 1,
    })
    const { getServerGameplaySettingsSync } = require(
        path.join(__dirname, "../src/data/domains/server-settings.ts"),
    )
    assert.equal(getServerGameplaySettingsSync().multiRescueFragmentRewardsEnabled, true)
    assert.equal(getServerGameplaySettingsSync().multiRescueHostRewardsEnabled, true)
})

test("quest score rewards use the persisted multiplier instead of DROP_MULTIPLIER", t => {
    const domainPath = path.join(__dirname, "../src/data/domains/server-settings.ts")
    assert.equal(fs.existsSync(domainPath), true, "server settings domain must exist")
    const paths = temporaryPaths(t)
    process.env.DROP_MULTIPLIER = "2"
    data.initializeDatabase({ paths })

    const { insertAccountSync } = require("../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../src/data/domains/player")
    const { updateServerGameplaySettingsSync } = require(domainPath)
    const { givePlayerScoreRewardsSync } = require("../src/lib/quest")
    const { RewardType, ScoreRewardType } = require("../src/lib/types")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "drop-multiplier-test",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    updateServerGameplaySettingsSync({ dropMultiplier: 4 })
    process.env.DROP_MULTIPLIER = "99"

    const result = givePlayerScoreRewardsSync(playerId, 7001, [{
        name: "test mana",
        type: ScoreRewardType.ITEM,
        reward_type: RewardType.MANA,
        count: 3,
        field5: 0,
    }])

    assert.equal(result.drop_score_reward_ids[0].number, 12)
    assert.equal(result.user_info.free_mana, 12)
})
