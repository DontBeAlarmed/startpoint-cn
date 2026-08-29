"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const Sqlite = require("better-sqlite3")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "player-save-v2-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    PLAYER_SAVE_EXCLUDED_TABLES,
    PLAYER_SAVE_TABLES,
    applyPlayerSaveTemplateSync,
    clonePlayerSaveV2Sync,
    discoverPlayerOwnedTablesSync,
    exportPlayerSaveV2Sync,
    parsePlayerSaveSnapshot,
    restorePlayerSaveSnapshotSync,
    restorePlayerSaveV2Sync,
    validatePlayerSaveSnapshotSync,
    validatePlayerSaveTemplateSync,
} = require("../src/data/player-save")
const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
const {
    clearDefaultSaveTemplate,
    getDefaultSaveMeta,
    loadDefaultSaveTemplate,
    saveDefaultSaveTemplate,
} = require("../src/data/defaultSave")
const playerRoutes = require("../src/routes/web_api/player").default
const serverRoutes = require("../src/routes/web_api/server").default
const { activeQuests } = require("../src/lib/quest/active-quest-service")
const { ADMIN_UPLOAD_FILE_SIZE_LIMIT } = require("../src/routes/web_api")
const {
    PlayerSaveDownloadTooLargeError,
    serializePlayerSaveDownload,
} = require("../src/routes/web_api/player-save-download")

let db
const sqlStatements = []

function createAccount(label) {
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
}

function allSnapshotTables(snapshot) {
    return Object.values(snapshot.domains).reduce((tables, domain) => ({
        ...tables,
        ...domain.tables,
    }), {})
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value))
}

function quoteIdentifier(name) {
    assert.match(name, /^[a-z0-9_]+$/)
    return `"${name}"`
}

function playerTableInsertionOrder(database) {
    const definitions = PLAYER_SAVE_TABLES.filter(definition => definition.name !== "players")
    const pending = new Map(definitions.map(definition => [definition.name, definition]))
    const inserted = new Set(["players"])
    const result = []
    while (pending.size > 0) {
        let progressed = false
        for (const [name, definition] of pending) {
            const dependencies = database.pragma(`foreign_key_list(${name})`)
                .map(foreignKey => foreignKey.table)
                .filter(parent => pending.has(parent) || inserted.has(parent))
            if (!dependencies.every(parent => inserted.has(parent))) continue
            result.push(definition)
            inserted.add(name)
            pending.delete(name)
            progressed = true
        }
        assert.equal(progressed, true, `unresolved fixture dependency: ${[...pending.keys()].join(", ")}`)
    }
    return result
}

function seedEveryRegisteredPlayerTable(database, playerId) {
    let fixtureNumber = 900000
    for (const definition of playerTableInsertionOrder(database)) {
        const table = quoteIdentifier(definition.name)
        const existing = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE player_id = ?`).get(playerId).count
        if (existing > 0) continue

        const columns = database.pragma(`table_info(${definition.name})`)
        const row = {}
        for (const column of columns) {
            if (column.name === "player_id") {
                row[column.name] = playerId
                continue
            }
            if (column.notnull !== 1 && column.pk === 0) continue
            if (column.name === "response_data") row[column.name] = "{}"
            else if (/TEXT|CHAR|CLOB/i.test(column.type)) row[column.name] = `fixture-${fixtureNumber}`
            else row[column.name] = fixtureNumber
        }

        const foreignKeys = database.pragma(`foreign_key_list(${definition.name})`)
        const groups = new Map()
        for (const foreignKey of foreignKeys) {
            const group = groups.get(foreignKey.id) ?? []
            group.push(foreignKey)
            groups.set(foreignKey.id, group)
        }
        for (const group of groups.values()) {
            const parentName = group[0].table
            const predicate = parentName === "players" ? "id = ?" : "player_id = ?"
            const parent = database.prepare(
                `SELECT * FROM ${quoteIdentifier(parentName)} WHERE ${predicate} LIMIT 1`,
            ).get(playerId)
            assert.ok(parent, `${definition.name} requires parent ${parentName}`)
            for (const foreignKey of group) row[foreignKey.from] = parent[foreignKey.to]
        }

        const rowColumns = Object.keys(row)
        database.prepare(`
            INSERT INTO ${table} (${rowColumns.map(quoteIdentifier).join(", ")})
            VALUES (${rowColumns.map(() => "?").join(", ")})
        `).run(...rowColumns.map(column => row[column]))
        fixtureNumber += 1
    }
}

function normalizeSnapshotRows(definition, rows) {
    return rows.map(source => {
        const row = { ...source }
        if (definition.name === "players") {
            delete row.id
            delete row.account_id
        } else {
            delete row.player_id
        }
        for (const column of definition.regenerateColumns ?? []) delete row[column]
        return row
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

test.before(() => {
    db = data.initializeDatabase({
        databaseFactory: databasePath => new Sqlite(databasePath, {
            verbose: sql => sqlStatements.push(sql),
        }),
    })
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("player save registry covers every current player-owned table", () => {
    const discovered = discoverPlayerOwnedTablesSync(db)
    const registered = PLAYER_SAVE_TABLES.map(table => table.name)
    const excluded = PLAYER_SAVE_EXCLUDED_TABLES.map(table => table.name)

    assert.deepEqual([...new Set([...registered, ...excluded])].sort(), discovered)
    assert.equal(new Set([...registered, ...excluded]).size, discovered.length)
    assert.deepEqual(excluded, [
        "players_active_quests",
        "players_scheduled_resource_state",
        "scheduled_resource_rules",
    ])
    assert.deepEqual(
        PLAYER_SAVE_TABLES.find(table => table.name === "players_login_bonus_progress"),
        {
            name: "players_login_bonus_progress",
            domain: "events",
            introducedSchema: 18,
            regenerateColumns: undefined,
            clonePolicy: undefined,
        },
    )
    assert.deepEqual(
        PLAYER_SAVE_TABLES.find(table => table.name === "players_player_history_milestones"),
        {
            name: "players_player_history_milestones",
            domain: "core",
            introducedSchema: 20,
            regenerateColumns: undefined,
            clonePolicy: undefined,
        },
    )
})

test("player table discovery follows indirect foreign-key ownership", () => {
    const fixture = new Sqlite(":memory:")
    try {
        fixture.exec(`
            CREATE TABLE players (id INTEGER PRIMARY KEY);
            CREATE TABLE player_parent (
                id INTEGER PRIMARY KEY,
                player_id INTEGER NOT NULL REFERENCES players(id)
            );
            CREATE TABLE player_nested (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER NOT NULL REFERENCES player_parent(id)
            );
            CREATE TABLE global_state (id INTEGER PRIMARY KEY);
            CREATE TABLE players_orphan (id INTEGER PRIMARY KEY);
        `)
        assert.deepEqual(discoverPlayerOwnedTablesSync(fixture), [
            "player_nested",
            "player_parent",
            "players",
            "players_orphan",
        ])
    } finally {
        fixture.close()
    }
})

test("v2 export includes all registered domains and excludes transient battle state", () => {
    const account = createAccount("export")
    const playerId = insertDefaultPlayerSync(account.id).id

    db.prepare(`
        INSERT INTO players_mails (
            player_id, reason_id, subject, description, type, type_id,
            number, receive_time, create_time, reward_period_limited, reward_limit_time
        ) VALUES (?, 0, 'backup-mail', '', 1, 30005, 2, '0000-00-00 00:00:00', ?, 0, NULL)
    `).run(playerId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_box_gacha (id, box_id, reset_times, remaining_number, is_closed, player_id)
        VALUES (28, 5, 1, 2732, 0, ?)
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_box_gacha_drawn_rewards (id, box_id, gacha_id, number, player_id)
        VALUES (1, 5, 28, 3, ?)
    `).run(playerId)
    db.prepare(`INSERT INTO players_pass_cards (player_id, event_id, point, is_buy) VALUES (?, 3, 120, 1)`).run(playerId)
    db.prepare(`
        INSERT INTO players_pass_card_rewards (player_id, event_id, reward_id, is_received_1, is_received_2)
        VALUES (?, 3, 121, 1, 0)
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_shop_campaign_lineups (
            player_id, shop_type, campaign_id, lineup_id, selected_at
        ) VALUES (?, 4, 10, 1010, ?)
    `).run(playerId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_score_attack_battle_history (
            player_id, event_id, play_id, category_id, create_time,
            elapsed_time_ms, finish_kind, quest_id, total_damage
        ) VALUES (?, 7001, 'save-v2-play', 7, ?, 1234, 1, 7001001, 999)
    `).run(playerId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_active_quests (player_id, play_id, quest_id, category)
        VALUES (?, 'transient-play', 1001, 1)
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_player_history_settings (
            player_id, player_history_id, background_card_id, degree_id,
            character_ids, unison_character_ids, topic_visibility
        ) VALUES (?, 1, 2, 1, '[1,null,null]', '[null,null,null]', '{"100":true}')
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, 'normal_2022', 3, '2026-08-24', 1787500000, NULL)
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_player_history_milestones (
            player_id, aggregation_target, slot, occurred_at, subject_id
        ) VALUES (?, 4, 0, '2026-08-24T01:02:03.000Z', 1)
    `).run(playerId)

    const snapshot = exportPlayerSaveV2Sync(playerId)
    const tables = allSnapshotTables(snapshot)

    assert.equal(snapshot.schema, "starpoint-cn-save")
    assert.equal(snapshot.formatVersion, 2)
    assert.equal(snapshot.version, 2)
    assert.equal(snapshot.mode, "backup")
    assert.equal(snapshot.producer.dbSchemaVersion, 22)
    assert.equal(snapshot.playerId, playerId)
    assert.equal(tables.players_mails[0].subject, "backup-mail")
    assert.equal(tables.players_box_gacha_drawn_rewards[0].number, 3)
    assert.equal(tables.players_pass_card_rewards[0].reward_id, 121)
    assert.equal(tables.players_shop_campaign_lineups[0].lineup_id, 1010)
    assert.equal(tables.players_score_attack_battle_history[0].play_id, "save-v2-play")
    assert.equal(tables.players_player_history_settings[0].background_card_id, 2)
    assert.deepEqual(tables.players_player_history_milestones, [{
        player_id: playerId,
        aggregation_target: 4,
        slot: 0,
        occurred_at: "2026-08-24T01:02:03.000Z",
        subject_id: 1,
    }])
    assert.deepEqual(tables.players_login_bonus_progress, [{
        player_id: playerId,
        group_id: "normal_2022",
        last_granted_index: 3,
        last_granted_business_day: "2026-08-24",
        last_granted_real_business_day: null,
        received_at: 1787500000,
        shown_at: null,
    }])
    assert.equal(Object.hasOwn(tables, "players_active_quests"), false)
    assert.deepEqual(snapshot.excludedDomains, ["account", "session", "serverConfig", "activeQuest"])
})

test("v2 export reads table column metadata once per current table", () => {
    const account = createAccount("export-metadata")
    const playerId = insertDefaultPlayerSync(account.id).id
    sqlStatements.length = 0

    exportPlayerSaveV2Sync(playerId)

    const currentTableCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).get().count
    const tableInfoReads = sqlStatements.filter(sql => /^PRAGMA table_info/i.test(sql)).length
    assert.equal(tableInfoReads, currentTableCount)
})

test("restore preserves target identity, replaces all domains, and clears active quest", () => {
    const sourceAccount = createAccount("restore-source")
    const targetAccount = createAccount("restore-target")
    const sourceId = insertDefaultPlayerSync(sourceAccount.id).id
    const targetId = insertDefaultPlayerSync(targetAccount.id).id

    db.prepare("UPDATE players SET name = 'source-save', free_mana = 7654 WHERE id = ?").run(sourceId)
    db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (30005, 9, ?)").run(sourceId)
    db.prepare(`
        INSERT INTO players_mails (
            player_id, reason_id, subject, description, type, type_id,
            number, receive_time, create_time, reward_period_limited, reward_limit_time
        ) VALUES (?, 0, 'source-mail', '', 1, 30005, 1, '0000-00-00 00:00:00', ?, 0, NULL)
    `).run(sourceId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_shop_campaign_lineups (
            player_id, shop_type, campaign_id, lineup_id, selected_at
        ) VALUES (?, 4, 10, 1020, ?)
    `).run(sourceId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_score_attack_battle_history (
            player_id, event_id, play_id, category_id, create_time,
            elapsed_time_ms, finish_kind, quest_id, total_damage
        ) VALUES (?, 7001, 'restore-history', 7, ?, 1234, 1, 7001001, 999)
    `).run(sourceId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_player_history_settings (
            player_id, player_history_id, background_card_id, degree_id,
            character_ids, unison_character_ids, topic_visibility
        ) VALUES (?, 1, 3, 1, '[1,null,null]', '[null,null,null]', '{"101":false}')
    `).run(sourceId)
    db.prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, 'normal_2022', 4, '2026-08-24', 1787500100, 1787500200)
    `).run(sourceId)

    db.prepare("UPDATE players SET name = 'target-before' WHERE id = ?").run(targetId)
    db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (99999, 2, ?)").run(targetId)
    db.prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, 'stale', 1, '2026-08-23', 1787400000, NULL)
    `).run(targetId)
    db.prepare(`
        INSERT INTO players_active_quests (player_id, play_id, quest_id, category)
        VALUES (?, 'must-clear', 1001, 1)
    `).run(targetId)
    const scheduledRuleId = Number(db.prepare(`
        INSERT INTO scheduled_resource_rules (
            scope, player_id, reward_type, reward_id, grant_amount,
            trigger_threshold, inventory_cap, enabled, created_at_real, updated_at_real
        ) VALUES ('player', ?, 'item', 30005, 1, 5, 999, 1, ?, ?)
    `).run(targetId, new Date().toISOString(), new Date().toISOString()).lastInsertRowid)
    db.prepare(`
        INSERT INTO players_scheduled_resource_state (
            player_id, rule_id, last_granted_business_day, last_granted_at_real
        ) VALUES (?, ?, '2026-08-24', ?)
    `).run(targetId, scheduledRuleId, new Date().toISOString())
    activeQuests[targetId] = {
        playId: "must-clear",
        questId: 1001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        continueCount: 0,
    }

    const sourceMailId = db.prepare("SELECT id FROM players_mails WHERE player_id = ?").get(sourceId).id
    const snapshot = exportPlayerSaveV2Sync(sourceId)
    sqlStatements.length = 0
    const result = restorePlayerSaveV2Sync(snapshot, targetId)

    const currentTableCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).get().count
    assert.equal(
        sqlStatements.filter(sql => /^PRAGMA table_info/i.test(sql)).length,
        currentTableCount,
    )
    assert.equal(
        sqlStatements.filter(sql => /^PRAGMA foreign_key_list/i.test(sql)).length,
        currentTableCount,
    )

    const restored = db.prepare("SELECT id, account_id, name, free_mana FROM players WHERE id = ?").get(targetId)

    assert.deepEqual(result, { playerId: targetId, legacyPartial: false })
    assert.deepEqual(restored, {
        id: targetId,
        account_id: targetAccount.id,
        name: "source-save",
        free_mana: 7654,
    })
    assert.deepEqual(
        db.prepare("SELECT id, amount FROM players_items WHERE player_id = ? AND id IN (30005, 99999) ORDER BY id").all(targetId),
        [{ id: 30005, amount: 9 }],
    )
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_active_quests WHERE player_id = ?").get(targetId).count, 0)
    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM scheduled_resource_rules WHERE id = ? AND player_id = ?")
            .get(scheduledRuleId, targetId).count,
        1,
    )
    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM players_scheduled_resource_state WHERE player_id = ? AND rule_id = ?")
            .get(targetId, scheduledRuleId).count,
        1,
    )
    assert.equal(activeQuests[targetId], undefined)
    assert.equal(db.prepare("SELECT lineup_id FROM players_shop_campaign_lineups WHERE player_id = ?").get(targetId).lineup_id, 1020)
    assert.equal(db.prepare("SELECT play_id FROM players_score_attack_battle_history WHERE player_id = ?").get(targetId).play_id, "restore-history")
    assert.equal(
        db.prepare("SELECT background_card_id FROM players_player_history_settings WHERE player_id = ?").get(targetId).background_card_id,
        3,
    )
    assert.deepEqual(
        db.prepare(`
            SELECT group_id, last_granted_index, last_granted_business_day, received_at, shown_at
            FROM players_login_bonus_progress
            WHERE player_id = ?
        `).get(targetId),
        {
            group_id: "normal_2022",
            last_granted_index: 4,
            last_granted_business_day: "2026-08-24",
            received_at: 1787500100,
            shown_at: 1787500200,
        },
    )
    assert.notEqual(db.prepare("SELECT id FROM players_mails WHERE player_id = ?").get(targetId).id, sourceMailId)
})

test("v2 validation rejects future schemas and missing tables that existed in the producer schema", () => {
    const account = createAccount("validation")
    const playerId = insertDefaultPlayerSync(account.id).id
    const snapshot = exportPlayerSaveV2Sync(playerId)

    const future = cloneJson(snapshot)
    future.producer.dbSchemaVersion = 23
    assert.throws(() => restorePlayerSaveV2Sync(future, playerId), /newer.*schema|future.*schema/i)

    const missingCurrent = cloneJson(snapshot)
    delete missingCurrent.domains.economy.tables.players_shop_purchases
    assert.throws(() => restorePlayerSaveV2Sync(missingCurrent, playerId), /players_shop_purchases.*missing/i)

    const missingPracticeHistory = cloneJson(snapshot)
    delete missingPracticeHistory.domains.events.tables.players_practice_battle_history
    assert.throws(
        () => restorePlayerSaveV2Sync(missingPracticeHistory, playerId),
        /players_practice_battle_history.*missing/i,
    )

    const missingPendingExBoost = cloneJson(snapshot)
    delete missingPendingExBoost.domains.core.tables.players_ex_boost_pending_draws
    assert.throws(
        () => restorePlayerSaveV2Sync(missingPendingExBoost, playerId),
        /players_ex_boost_pending_draws.*missing/i,
    )

    const older = cloneJson(snapshot)
    older.producer.dbSchemaVersion = 10
    delete older.domains.events.tables.players_score_attack_battle_history
    delete older.domains.economy.tables.players_shop_campaign_lineups
    assert.doesNotThrow(() => restorePlayerSaveV2Sync(older, playerId))

    const schema12 = cloneJson(snapshot)
    schema12.producer.dbSchemaVersion = 12
    delete schema12.domains.events.tables.players_practice_battle_history
    assert.doesNotThrow(() => restorePlayerSaveV2Sync(schema12, playerId))

    const schema13 = cloneJson(snapshot)
    schema13.producer.dbSchemaVersion = 13
    delete schema13.domains.core.tables.players_ex_boost_pending_draws
    assert.doesNotThrow(() => restorePlayerSaveV2Sync(schema13, playerId))

    const schema15 = cloneJson(snapshot)
    schema15.producer.dbSchemaVersion = 15
    delete schema15.domains.core.tables.players_player_history_settings
    assert.doesNotThrow(() => restorePlayerSaveV2Sync(schema15, playerId))

    const schema17 = cloneJson(snapshot)
    schema17.producer.dbSchemaVersion = 17
    delete schema17.domains.events.tables.players_login_bonus_progress
    assert.doesNotThrow(() => restorePlayerSaveV2Sync(schema17, playerId))

    const schema19 = cloneJson(snapshot)
    schema19.producer.dbSchemaVersion = 19
    delete schema19.domains.core.tables.players_player_history_milestones
    assert.doesNotThrow(() => restorePlayerSaveV2Sync(schema19, playerId))

    const conflictingVersion = cloneJson(snapshot)
    conflictingVersion.version = 1
    assert.throws(() => validatePlayerSaveSnapshotSync(conflictingVersion), /version.*conflict/i)

    const unknownDomain = cloneJson(snapshot)
    unknownDomain.domains.hidden = { version: 1, tables: {} }
    assert.throws(() => validatePlayerSaveSnapshotSync(unknownDomain), /unknown.*domain/i)

    const missingRequiredColumn = cloneJson(snapshot)
    missingRequiredColumn.domains.core.tables.players_items = [{ id: 30005, player_id: playerId }]
    assert.throws(() => validatePlayerSaveSnapshotSync(missingRequiredColumn), /players_items\.amount.*missing/i)

    const invalidNumber = cloneJson(snapshot)
    invalidNumber.domains.core.tables.players_items = [{ id: 30005, amount: Number.NaN, player_id: playerId }]
    assert.throws(() => validatePlayerSaveSnapshotSync(invalidNumber), /players_items\.amount.*invalid/i)
})

test("clone creates a new save under the destination account and reallocates row ids", () => {
    const sourceAccount = createAccount("clone-source")
    const destinationAccount = createAccount("clone-destination")
    const sourceId = insertDefaultPlayerSync(sourceAccount.id).id

    db.prepare("UPDATE players SET name = 'clone-source' WHERE id = ?").run(sourceId)
    db.prepare(`
        INSERT INTO players_receive_history (player_id, type, type_id, number, reason_id, create_time)
        VALUES (?, 1, 30005, 1, 0, ?)
    `).run(sourceId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, 'normal_2022', 2, '2026-08-24', 1787500300, NULL)
    `).run(sourceId)
    const sourceRowId = db.prepare("SELECT id FROM players_receive_history WHERE player_id = ?").get(sourceId).id

    const result = clonePlayerSaveV2Sync(exportPlayerSaveV2Sync(sourceId), destinationAccount.id)
    const cloned = db.prepare("SELECT id, account_id, name FROM players WHERE id = ?").get(result.playerId)
    const clonedRowId = db.prepare("SELECT id FROM players_receive_history WHERE player_id = ?").get(result.playerId).id

    assert.notEqual(result.playerId, sourceId)
    assert.deepEqual(cloned, {
        id: result.playerId,
        account_id: destinationAccount.id,
        name: "clone-source",
    })
    assert.notEqual(clonedRowId, sourceRowId)
    assert.deepEqual(
        db.prepare(`
            SELECT group_id, last_granted_index, last_granted_business_day, received_at, shown_at
            FROM players_login_bonus_progress
            WHERE player_id = ?
        `).get(result.playerId),
        {
            group_id: "normal_2022",
            last_granted_index: 2,
            last_granted_business_day: "2026-08-24",
            received_at: 1787500300,
            shown_at: null,
        },
    )
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_active_quests WHERE player_id = ?").get(result.playerId).count, 0)
})

test("failed restore rolls back database rows and keeps the published active quest", () => {
    const account = createAccount("restore-rollback")
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (30005, 7, ?)").run(playerId)
    db.prepare(`
        INSERT INTO players_active_quests (player_id, play_id, quest_id, category)
        VALUES (?, 'rollback-play', 1001, 1)
    `).run(playerId)
    activeQuests[playerId] = {
        playId: "rollback-play",
        questId: 1001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        continueCount: 0,
    }
    const invalid = exportPlayerSaveV2Sync(playerId)
    invalid.domains.core.tables.players_items.push({
        ...invalid.domains.core.tables.players_items[0],
    })

    assert.throws(() => restorePlayerSaveV2Sync(invalid, playerId), /unique constraint/i)
    assert.equal(db.prepare("SELECT amount FROM players_items WHERE player_id = ? AND id = 30005").get(playerId).amount, 7)
    assert.equal(db.prepare("SELECT play_id FROM players_active_quests WHERE player_id = ?").get(playerId).play_id, "rollback-play")
    assert.equal(activeQuests[playerId].playId, "rollback-play")
    delete activeQuests[playerId]
})

test("failed clone does not leave an empty destination player", () => {
    const sourceAccount = createAccount("clone-rollback-source")
    const destinationAccount = createAccount("clone-rollback-target")
    const sourceId = insertDefaultPlayerSync(sourceAccount.id).id
    db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (30005, 1, ?)").run(sourceId)
    const invalid = exportPlayerSaveV2Sync(sourceId)
    invalid.domains.core.tables.players_items.push({
        ...invalid.domains.core.tables.players_items[0],
    })
    const countBefore = db.prepare("SELECT COUNT(*) AS count FROM players WHERE account_id = ?").get(destinationAccount.id).count

    assert.throws(() => clonePlayerSaveV2Sync(invalid, destinationAccount.id), /unique constraint/i)
    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM players WHERE account_id = ?").get(destinationAccount.id).count,
        countBefore,
    )
})

test("clone round-trips every registered player table with non-empty source data", () => {
    const sourceAccount = createAccount("matrix-source")
    const destinationAccount = createAccount("matrix-target")
    const sourceId = insertDefaultPlayerSync(sourceAccount.id).id
    seedEveryRegisteredPlayerTable(db, sourceId)
    const source = exportPlayerSaveV2Sync(sourceId)
    const sourceTables = allSnapshotTables(source)
    for (const definition of PLAYER_SAVE_TABLES) {
        assert.ok(sourceTables[definition.name].length > 0, `${definition.name} source fixture is empty`)
    }

    const cloned = clonePlayerSaveV2Sync(source, destinationAccount.id)
    const targetTables = allSnapshotTables(exportPlayerSaveV2Sync(cloned.playerId))
    for (const definition of PLAYER_SAVE_TABLES) {
        const expected = definition.clonePolicy === "clear"
            ? []
            : normalizeSnapshotRows(definition, sourceTables[definition.name])
        assert.deepEqual(
            normalizeSnapshotRows(definition, targetTables[definition.name]),
            expected,
            definition.name,
        )
    }
})

test("v1 snapshots remain parseable but are explicitly legacy partial", () => {
    const parsed = parsePlayerSaveSnapshot({
        schema: "starpoint-cn-save",
        version: 1,
        data: { player: { id: 1 } },
    })

    assert.equal(parsed.kind, "legacy-v1")
    assert.equal(parsed.legacyPartial, true)
})

test("legacy v1 restore updates legacy fields without deleting newer domains", () => {
    const account = createAccount("legacy")
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare(`
        INSERT INTO players_mails (
            player_id, reason_id, subject, description, type, type_id,
            number, receive_time, create_time, reward_period_limited, reward_limit_time
        ) VALUES (?, 0, 'preserve-v1-mail', '', 1, 30005, 1, '0000-00-00 00:00:00', ?, 0, NULL)
    `).run(playerId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_box_gacha (id, box_id, reset_times, remaining_number, is_closed, player_id)
        VALUES (88, 5, 1, 10, 0, ?)
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_box_gacha_drawn_rewards (id, box_id, gacha_id, number, player_id)
        VALUES (1, 5, 88, 3, ?)
    `).run(playerId)
    db.prepare(`
        INSERT INTO players_shop_campaign_lineups (
            player_id, shop_type, campaign_id, lineup_id, selected_at
        ) VALUES (?, 4, 10, 1010, ?)
    `).run(playerId, new Date().toISOString())
    db.prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, 'normal_2022', 4, '2026-08-24', 1787500400, NULL)
    `).run(playerId)

    const dataV1 = cloneJson(getMergedPlayerDataSync(playerId))
    dataV1.player.name = "legacy-name-restored"
    dataV1.boxGachaList = {}
    const result = restorePlayerSaveSnapshotSync({
        schema: "starpoint-cn-save",
        version: 1,
        playerId,
        data: dataV1,
    }, playerId)

    assert.deepEqual(result, { playerId, legacyPartial: true })
    assert.equal(db.prepare("SELECT name FROM players WHERE id = ?").get(playerId).name, "legacy-name-restored")
    assert.equal(db.prepare("SELECT subject FROM players_mails WHERE player_id = ?").get(playerId).subject, "preserve-v1-mail")
    assert.equal(db.prepare("SELECT lineup_id FROM players_shop_campaign_lineups WHERE player_id = ?").get(playerId).lineup_id, 1010)
    assert.equal(
        db.prepare("SELECT number FROM players_box_gacha_drawn_rewards WHERE player_id = ? AND gacha_id = 88").get(playerId).number,
        3,
    )
    assert.deepEqual(
        db.prepare(`
            SELECT group_id, last_granted_index, last_granted_business_day, received_at, shown_at
            FROM players_login_bonus_progress
            WHERE player_id = ?
        `).get(playerId),
        {
            group_id: "normal_2022",
            last_granted_index: 4,
            last_granted_business_day: "2026-08-24",
            received_at: 1787500400,
            shown_at: null,
        },
    )
})

test("default save metadata reads player identity from v2 snapshots", () => {
    const account = createAccount("default-template")
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare("UPDATE players SET name = 'v2-template' WHERE id = ?").run(playerId)
    const snapshot = exportPlayerSaveV2Sync(playerId)

    saveDefaultSaveTemplate(snapshot)
    assert.deepEqual(getDefaultSaveMeta(), {
        exists: true,
        playerName: "v2-template",
        exportedAt: snapshot.exportedAt,
        sourcePlayerId: playerId,
        formatVersion: 2,
        legacyPartial: false,
    })
    assert.equal(loadDefaultSaveTemplate().formatVersion, 2)
    assert.equal(clearDefaultSaveTemplate(), true)
})

test("default template application uses clone isolation for tutorial receipts", () => {
    const account = createAccount("template-policy")
    const sourceId = insertDefaultPlayerSync(account.id).id
    const targetId = insertDefaultPlayerSync(account.id).id
    db.prepare(`
        INSERT INTO players_tutorial_step_receipts (player_id, completed_step, skip, response_data)
        VALUES (?, 17, 0, '{"source":true}')
    `).run(sourceId)

    applyPlayerSaveTemplateSync(exportPlayerSaveV2Sync(sourceId), targetId)

    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM players_tutorial_step_receipts WHERE player_id = ?").get(targetId).count,
        0,
    )
})

test("default template validation dry-runs all database constraints without leaving rows", () => {
    const account = createAccount("template-validation")
    const sourceId = insertDefaultPlayerSync(account.id).id
    db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (30005, 1, ?)").run(sourceId)
    const invalid = exportPlayerSaveV2Sync(sourceId)
    invalid.domains.core.tables.players_items.push({
        ...invalid.domains.core.tables.players_items[0],
    })
    const accountsBefore = db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count
    const playersBefore = db.prepare("SELECT COUNT(*) AS count FROM players").get().count

    assert.throws(() => validatePlayerSaveTemplateSync(invalid), /unique constraint/i)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, accountsBefore)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players").get().count, playersBefore)
})

test("admin upload limit can accept full v2 snapshots larger than the legacy limit", () => {
    assert.ok(ADMIN_UPLOAD_FILE_SIZE_LIMIT >= 64 * 1024 * 1024)
})

test("admin download rejects snapshots that its upload endpoint cannot accept", () => {
    assert.throws(
        () => serializePlayerSaveDownload({ payload: "0123456789" }, 10),
        PlayerSaveDownloadTooLargeError,
    )
    assert.equal(serializePlayerSaveDownload({ ok: true }, 64), '{"ok":true}')
})

test("admin export and clone routes use the complete v2 path", async t => {
    const sourceAccount = createAccount("route-source")
    const destinationAccount = createAccount("route-destination")
    const sourceId = insertDefaultPlayerSync(sourceAccount.id).id
    db.prepare("UPDATE players SET name = 'route-clone' WHERE id = ?").run(sourceId)
    db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (30005, 4, ?)").run(sourceId)

    const fastify = Fastify()
    t.after(() => fastify.close())
    fastify.register(playerRoutes, { prefix: "/api/player" })
    fastify.register(serverRoutes, { prefix: "/api/server" })
    await fastify.ready()

    const exported = await fastify.inject({
        method: "GET",
        url: `/api/player/save?id=${sourceId}`,
    })
    assert.equal(exported.statusCode, 200)
    assert.equal(exported.json().formatVersion, 2)

    const cloned = await fastify.inject({
        method: "POST",
        url: `/api/server/cloneSave?playerId=${sourceId}&accountId=${destinationAccount.id}`,
        headers: { accept: "application/json" },
    })
    assert.equal(cloned.statusCode, 200)
    const newPlayerId = cloned.json().newPlayerId
    assert.deepEqual(
        db.prepare("SELECT account_id, name FROM players WHERE id = ?").get(newPlayerId),
        { account_id: destinationAccount.id, name: "route-clone" },
    )
    assert.equal(db.prepare("SELECT amount FROM players_items WHERE player_id = ? AND id = 30005").get(newPlayerId).amount, 4)

    db.exec("CREATE TABLE players_orphan (id INTEGER PRIMARY KEY)")
    try {
        const brokenRegistry = await fastify.inject({
            method: "POST",
            url: `/api/server/cloneSave?playerId=${sourceId}&accountId=${destinationAccount.id}`,
            headers: { accept: "application/json" },
        })
        assert.equal(brokenRegistry.statusCode, 500)
        assert.match(brokenRegistry.json().error, /registry/i)
    } finally {
        db.exec("DROP TABLE players_orphan")
    }
})
