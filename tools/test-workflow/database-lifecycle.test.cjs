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

test("database initializer repairs legacy negative experience pools", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths })
    const { insertAccountSync } = require("../../src/data/domains/account")
    const { insertDefaultPlayerSync, updatePlayerSync } = require("../../src/data/domains/player")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "negative-exp-pool-repair",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    getDb().prepare("UPDATE players SET exp_pool = ? WHERE id = ?").run(-500000, playerId)
    data.closeDatabase()

    data.initializeDatabase({ paths })
    assert.equal(getDb().prepare("SELECT exp_pool FROM players WHERE id = ?").get(playerId).exp_pool, 0)
    assert.throws(
        () => updatePlayerSync({ id: playerId, expPool: -1 }),
        /invalid exp_pool/i,
        "后续领域写入也必须拒绝负经验池",
    )
})

test("default schema migration preserves v6 players and creates cascading Pass tables", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths })
    const { insertAccountSync } = require("../../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "schema-v6-pass-migration",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    getDb().prepare("UPDATE players SET name = ? WHERE id = ?").run("schema-v6-player", playerId)
    data.closeDatabase()

    const schemaV6 = new Sqlite(paths.databaseFile)
    schemaV6.exec("DROP TABLE players_pass_card_rewards; DROP TABLE players_pass_cards")
    schemaV6.pragma("user_version = 6")
    assert.equal(schemaV6.pragma("user_version", { simple: true }), 6)
    assert.equal(schemaV6.prepare("SELECT name FROM players WHERE id = ?").get(playerId).name, "schema-v6-player")
    assert.deepEqual(
        schemaV6.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'players_pass_card%'").all(),
        [],
    )
    schemaV6.close()
    fs.writeFileSync(paths.databaseVersionFile, "6")

    data.initializeDatabase({ paths })
    const migrated = getDb()
    assert.equal(migrated.pragma("user_version", { simple: true }), 22)
    assert.deepEqual(
        migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'players_character_election_votes'").get(),
        { name: "players_character_election_votes" },
    )
    assert.equal(migrated.prepare("SELECT name FROM players WHERE id = ?").get(playerId).name, "schema-v6-player")
    assert.deepEqual(
        migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'players_login_bonus_progress'").get(),
        { name: "players_login_bonus_progress" },
    )
    assert.deepEqual(
        migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'players_pass_card%'")
            .all().map(row => row.name).sort(),
        ["players_pass_card_rewards", "players_pass_cards"],
    )
    assert.equal(
        migrated.pragma("foreign_key_list(players_pass_cards)")
            .some(foreignKey => foreignKey.table === "players" && foreignKey.on_delete === "CASCADE"),
        true,
    )
    assert.equal(
        migrated.pragma("foreign_key_list(players_pass_card_rewards)")
            .filter(foreignKey => foreignKey.table === "players_pass_cards" && foreignKey.on_delete === "CASCADE")
            .length,
        2,
    )
    assert.equal(
        migrated.pragma("foreign_key_list(players_player_history_settings)")
            .some(foreignKey => foreignKey.table === "players" && foreignKey.on_delete === "CASCADE"),
        true,
    )

    const insertPassRows = () => {
        migrated.prepare("INSERT INTO players_pass_cards (player_id, event_id) VALUES (?, 3)").run(playerId)
        migrated.prepare(`
            INSERT INTO players_pass_card_rewards (player_id, event_id, reward_id)
            VALUES (?, 3, 121)
        `).run(playerId)
    }
    insertPassRows()
    migrated.prepare("DELETE FROM players_pass_cards WHERE player_id = ? AND event_id = 3").run(playerId)
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_pass_card_rewards").get().count, 0)

    insertPassRows()
    migrated.prepare("DELETE FROM players WHERE id = ?").run(playerId)
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_pass_cards").get().count, 0)
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM players_pass_card_rewards").get().count, 0)
})

test("default schema migrates schema 14 active quests to battle session and coordinator identity", t => {
    const paths = temporaryPaths(t)
    fs.mkdirSync(paths.dataDir, { recursive: true })
    const schema14 = new Sqlite(paths.databaseFile)
    schema14.exec(`
        CREATE TABLE players_active_quests (
            player_id INTEGER PRIMARY KEY,
            play_id TEXT NOT NULL,
            quest_id INTEGER NOT NULL,
            category INTEGER NOT NULL,
            use_boss_boost_point INTEGER NOT NULL DEFAULT 0,
            use_boost_point INTEGER NOT NULL DEFAULT 0,
            is_auto_start_mode INTEGER NOT NULL DEFAULT 0,
            is_multi INTEGER NOT NULL DEFAULT 0,
            room_number TEXT,
            entry_item_id INTEGER,
            entry_item_count INTEGER,
            event_id INTEGER,
            continue_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO players_active_quests (
            player_id, play_id, quest_id, category, is_multi, room_number
        ) VALUES (77, 'legacy-play', 501, 2, 1, '123456');
    `)
    schema14.pragma("user_version = 14")
    schema14.close()
    fs.writeFileSync(paths.databaseVersionFile, "14")

    data.initializeDatabase({ paths })

    assert.equal(getDb().pragma("user_version", { simple: true }), 22)
    assert.equal(
        getDb().pragma("table_info(players_active_quests)")
            .some(column => column.name === "rescue_fragment_eligible"),
        true,
    )
    assert.equal(
        getDb().pragma("table_info(players_active_quests)")
            .some(column => column.name === "battle_session_id" && column.notnull === 0),
        true,
    )
    assert.equal(
        getDb().pragma("table_info(players_active_quests)")
            .some(column => column.name === "coordinator_origin" && column.notnull === 0),
        true,
    )
    assert.deepEqual(
        getDb().prepare(`
            SELECT play_id, battle_session_id, coordinator_origin, rescue_fragment_eligible
            FROM players_active_quests
            WHERE player_id = 77
        `).get(),
        {
            play_id: "legacy-play",
            battle_session_id: null,
            coordinator_origin: null,
            rescue_fragment_eligible: 0,
        },
    )
})

test("migrates schema 21 active quests to frozen rescue eligibility storage", t => {
    const paths = temporaryPaths(t)
    fs.mkdirSync(paths.dataDir, { recursive: true })
    data.initializeDatabase({ paths })
    const account = require("../../src/data/domains/account").insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "schema21-rescue-active-quest",
        status: "normal",
    })
    const playerId = require("../../src/data/domains/player").insertDefaultPlayerSync(account.id).id
    data.closeDatabase()
    const schema21 = new Sqlite(paths.databaseFile)
    schema21.exec(`
        DROP TABLE players_active_quests;
        CREATE TABLE players_active_quests (
            player_id INTEGER PRIMARY KEY,
            play_id TEXT NOT NULL,
            quest_id INTEGER NOT NULL,
            category INTEGER NOT NULL,
            use_boss_boost_point INTEGER NOT NULL DEFAULT 0,
            use_boost_point INTEGER NOT NULL DEFAULT 0,
            is_auto_start_mode INTEGER NOT NULL DEFAULT 0,
            is_multi INTEGER NOT NULL DEFAULT 0,
            coordinator_origin TEXT CHECK (
                coordinator_origin IS NULL OR coordinator_origin IN ('remote', 'local')
            ),
            room_number TEXT,
            battle_session_id TEXT,
            entry_item_id INTEGER,
            entry_item_count INTEGER,
            stamina_cost INTEGER,
            daily_challenge_point_id INTEGER,
            event_id INTEGER,
            continue_count INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
        );
        INSERT INTO players_active_quests (
            player_id, play_id, quest_id, category, is_multi
        ) VALUES (${playerId}, 'legacy-play', 1001, 2, 1);
    `)
    schema21.pragma("user_version = 21")
    schema21.close()
    fs.writeFileSync(paths.databaseVersionFile, "21")

    data.initializeDatabase({ paths })

    const questDomain = require("../../src/data/domains/quest_active")
    assert.equal(getDb().pragma("user_version", { simple: true }), 22)
    assert.equal(questDomain.getPlayerActiveQuestSync(playerId)?.rescueFragmentEligible, false)
    assert.equal(getDb().prepare(
        "SELECT rescue_fragment_eligible FROM players_active_quests WHERE player_id = ?",
    ).get(playerId).rescue_fragment_eligible, 0)

    questDomain.deletePlayerActiveQuestSync(playerId)
    questDomain.insertPlayerActiveQuestSync(playerId, {
        playId: "true-play",
        questId: 1001,
        category: 2,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: true,
        coordinatorOrigin: "local",
        rescueFragmentEligible: true,
        continueCount: 0,
    })
    assert.equal(questDomain.getPlayerActiveQuestSync(playerId)?.rescueFragmentEligible, true)
    assert.equal(getDb().prepare(
        "SELECT rescue_fragment_eligible FROM players_active_quests WHERE player_id = ?",
    ).get(playerId).rescue_fragment_eligible, 1)

    questDomain.deletePlayerActiveQuestSync(playerId)
    questDomain.insertPlayerActiveQuestSync(playerId, {
        playId: "false-play",
        questId: 1001,
        category: 2,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: true,
        coordinatorOrigin: "local",
        rescueFragmentEligible: false,
        continueCount: 0,
    })
    assert.equal(getDb().prepare(
        "SELECT rescue_fragment_eligible FROM players_active_quests WHERE player_id = ?",
    ).get(playerId).rescue_fragment_eligible, 0)
    questDomain.deletePlayerActiveQuestSync(playerId)
    const { persistActiveQuest } = require("../../src/lib/quest/active-quest-service")
    persistActiveQuest(playerId, {
        playId: "single-play",
        questId: 1001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        coordinatorOrigin: "local",
        rescueFragmentEligible: true,
        continueCount: 0,
    })
    assert.equal(questDomain.getPlayerActiveQuestSync(playerId)?.rescueFragmentEligible, false)
    assert.throws(() => getDb().prepare(
        "UPDATE players_active_quests SET rescue_fragment_eligible = 2 WHERE player_id = ?",
    ).run(playerId))
})

test("default schema migrates schema 15 databases to player history storage", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths })
    const { insertAccountSync } = require("../../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "schema-v15-player-history-migration",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    getDb().prepare("UPDATE players SET name = ? WHERE id = ?").run("schema-v15-player", playerId)
    data.closeDatabase()

    const schema15 = new Sqlite(paths.databaseFile)
    schema15.exec("DROP TABLE players_player_history_settings")
    schema15.pragma("user_version = 15")
    schema15.close()
    fs.writeFileSync(paths.databaseVersionFile, "15")

    data.initializeDatabase({ paths })
    assert.equal(getDb().pragma("user_version", { simple: true }), 22)
    assert.deepEqual(
        getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'players_player_history_settings'").get(),
        { name: "players_player_history_settings" },
    )
    assert.equal(getDb().prepare("SELECT name FROM players WHERE id = ?").get(playerId).name, "schema-v15-player")
})

test("default schema migrates schema 18 login bonus progress to per-group rows", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths })
    const { insertAccountSync } = require("../../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "schema-v18-login-bonus-migration",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    data.closeDatabase()

    const schema18 = new Sqlite(paths.databaseFile)
    schema18.exec(`
        DROP TABLE players_login_bonus_progress;
        CREATE TABLE players_login_bonus_progress (
            player_id INTEGER PRIMARY KEY,
            group_id TEXT NOT NULL,
            last_granted_index INTEGER NOT NULL CHECK (last_granted_index > 0),
            last_granted_business_day TEXT NOT NULL,
            received_at INTEGER NOT NULL CHECK (received_at >= 0),
            shown_at INTEGER DEFAULT NULL CHECK (shown_at IS NULL OR shown_at >= 0),
            FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
        );
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (
            ${playerId}, 'normal_2022', 3, '2024-08-14', 1723636800, 1723636801
        );
    `)
    schema18.pragma("user_version = 18")
    schema18.close()
    fs.writeFileSync(paths.databaseVersionFile, "18")

    data.initializeDatabase({ paths })
    const migrated = getDb()
    assert.equal(migrated.pragma("user_version", { simple: true }), 22)
    assert.deepEqual(
        migrated.pragma("table_info(players_login_bonus_progress)")
            .filter(column => column.pk > 0)
            .map(column => [column.name, column.pk]),
        [["player_id", 1], ["group_id", 2]],
    )
    assert.equal(
        migrated.pragma("table_info(players_login_bonus_progress)")
            .some(column => column.name === "last_granted_real_business_day"),
        true,
    )
    assert.deepEqual(
        migrated.prepare(`
            SELECT group_id, last_granted_index, last_granted_business_day,
                   last_granted_real_business_day, received_at, shown_at
            FROM players_login_bonus_progress
            WHERE player_id = ?
        `).get(playerId),
        {
            group_id: "normal_2022",
            last_granted_index: 3,
            last_granted_business_day: "2024-08-14",
            last_granted_real_business_day: null,
            received_at: 1723636800,
            shown_at: 1723636801,
        },
    )
    assert.doesNotThrow(() => migrated.prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, 'limited_a', 1, '2024-08-14', 1723636800, NULL)
    `).run(playerId))
})

test("default schema migrates schema 19 databases to player history milestones", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths })
    const { insertAccountSync } = require("../../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "schema-v19-player-history-milestones",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    data.closeDatabase()

    const schema19 = new Sqlite(paths.databaseFile)
    schema19.exec("DROP TABLE players_player_history_milestones")
    schema19.pragma("user_version = 19")
    schema19.close()
    fs.writeFileSync(paths.databaseVersionFile, "19")

    data.initializeDatabase({ paths })
    assert.equal(getDb().pragma("user_version", { simple: true }), 22)
    assert.deepEqual(
        getDb().prepare(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'players_player_history_milestones'
        `).get(),
        { name: "players_player_history_milestones" },
    )
    assert.equal(getDb().prepare("SELECT id FROM players WHERE id = ?").get(playerId).id, playerId)
})

test("active quest domain roundtrips nullable battle session identity", t => {
    const paths = temporaryPaths(t)
    data.initializeDatabase({ paths })
    const columns = getDb().pragma("table_info(players_active_quests)")
    if (!columns.some(column => column.name === "battle_session_id")) {
        getDb().exec("ALTER TABLE players_active_quests ADD COLUMN battle_session_id TEXT")
    }
    const {
        deletePlayerActiveQuestSync,
        getPlayerActiveQuestSync,
        insertPlayerActiveQuestSync,
    } = require("../../src/data/domains/quest_active")
    const { insertAccountSync } = require("../../src/data/domains/account")
    const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "active-quest-battle-session-roundtrip",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const activeQuest = {
        playerId,
        playId: "remote-play",
        questId: 501,
        category: 2,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: true,
        coordinatorOrigin: "remote",
        roomNumber: "654321",
        battleSessionId: "battle-session-1",
        entryItemId: null,
        entryItemCount: null,
        eventId: null,
        continueCount: 0,
    }

    insertPlayerActiveQuestSync(playerId, activeQuest)
    assert.equal(getPlayerActiveQuestSync(playerId).battleSessionId, "battle-session-1")
    assert.equal(getPlayerActiveQuestSync(playerId).coordinatorOrigin, "remote")

    deletePlayerActiveQuestSync(playerId)
    insertPlayerActiveQuestSync(playerId, {
        ...activeQuest,
        battleSessionId: null,
    })
    assert.equal(getPlayerActiveQuestSync(playerId).battleSessionId, null)
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

test("CN coordinator initializes database and time before content and HTTP", () => {
    const entry = fs.readFileSync(path.join(projectRoot, "src/cn-server.ts"), "utf8")
    const lifecycle = fs.readFileSync(path.join(projectRoot, "src/runtime/lifecycle.ts"), "utf8")
    const databaseIndex = lifecycle.indexOf("this.dependencies.initializeDatabase()")
    const restoreIndex = lifecycle.indexOf("this.dependencies.restoreServerTime()")
    const contentIndex = lifecycle.indexOf("await this.dependencies.initializeContent(")
    const configureIndex = lifecycle.indexOf("this.dependencies.configureHttp(")
    const listenIndex = lifecycle.indexOf("await this.dependencies.listenHttp(")

    assert.match(entry, /initializeDatabase,/)
    assert.match(entry, /restoreServerTime:\s*\(\)\s*=>\s*\{\s*serverTimeService\.restore\(\)\s*;\s*\}/)
    assert.ok(databaseIndex >= 0)
    assert.ok(databaseIndex < restoreIndex)
    assert.ok(restoreIndex < contentIndex)
    assert.ok(contentIndex < configureIndex)
    assert.ok(configureIndex < listenIndex)
})

test("global bootstrap keeps explicit database initialization before content and listen", () => {
    const source = fs.readFileSync(path.join(projectRoot, "src/server.ts"), "utf8")
    assert.match(source, /import\s+\{\s*initializeDatabase\s*\}\s+from\s+["']\.\/data["']/)
    const bootstrapStart = source.indexOf("async function bootstrap")
    const beforeBootstrap = source.slice(0, bootstrapStart)
    const bootstrap = source.slice(bootstrapStart)
    const databaseIndex = bootstrap.indexOf("initializeDatabase(")
    const contentIndex = bootstrap.indexOf("initializeContentSnapshot(")
    const listenIndex = bootstrap.indexOf("fastify.listen(")
    assert.ok(databaseIndex >= 0)
    assert.ok(databaseIndex < contentIndex)
    assert.ok(contentIndex < listenIndex)
    assert.equal(beforeBootstrap.includes("initializeDatabase("), false)
})
