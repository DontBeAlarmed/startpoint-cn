require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { closeDatabase, initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { resolveRuntimeDataPaths } = require("../src/runtime/data-paths")

const INDEX_CASES = [
    {
        name: "idx_players_items_player_id",
        table: "players_items",
        columns: [["player_id", 0], ["id", 0]],
        query: `
            SELECT id, amount
            FROM players_items
            WHERE player_id = ?
        `,
        parameters: fixture => [fixture.playerId],
    },
    {
        name: "idx_players_characters_player_id",
        table: "players_characters",
        columns: [["player_id", 0], ["id", 0]],
        query: `
            SELECT id, entry_count, evolution_level
            FROM players_characters
            WHERE player_id = ?
        `,
        parameters: fixture => [fixture.playerId],
    },
    {
        name: "idx_player_bond_tokens_player_character",
        table: "players_characters_bond_tokens",
        columns: [["player_id", 0], ["character_id", 0], ["mana_board_index", 0]],
        query: `
            SELECT mana_board_index, status
            FROM players_characters_bond_tokens
            WHERE player_id = ? AND character_id = ?
        `,
        parameters: fixture => [fixture.playerId, fixture.characterId],
    },
    {
        name: "idx_player_mana_nodes_player_character",
        table: "players_characters_mana_nodes",
        columns: [["player_id", 0], ["character_id", 0], ["value", 0]],
        query: `
            SELECT value, awake_level
            FROM players_characters_mana_nodes
            WHERE player_id = ? AND character_id = ?
        `,
        parameters: fixture => [fixture.playerId, fixture.characterId],
    },
    {
        name: "idx_players_equipment_player_id",
        table: "players_equipment",
        columns: [["player_id", 0], ["id", 0]],
        query: `
            SELECT id, level, enhancement_level
            FROM players_equipment
            WHERE player_id = ?
        `,
        parameters: fixture => [fixture.playerId],
    },
    {
        name: "idx_category_missions_player_category",
        table: "players_category_missions",
        columns: [["player_id", 0], ["category", 0], ["id", 0]],
        query: `
            SELECT id, progress
            FROM players_category_missions
            WHERE player_id = ? AND category = ?
        `,
        parameters: fixture => [fixture.playerId, fixture.category],
    },
    {
        name: "idx_players_mails_player_id",
        table: "players_mails",
        columns: [["player_id", 0], ["id", 1]],
        query: `
            SELECT id, subject, receive_time, create_time
            FROM players_mails
            WHERE player_id = ?
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `,
        parameters: fixture => [fixture.playerId, 10, 5],
    },
    {
        name: "idx_players_mails_player_unreceived",
        table: "players_mails",
        columns: [["player_id", 0], ["receive_time", 0], ["id", 1]],
        query: `
            SELECT id, subject, receive_time, create_time
            FROM players_mails
            WHERE player_id = ? AND receive_time = ?
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `,
        parameters: fixture => [fixture.playerId, "0000-00-00 00:00:00", 10, 5],
    },
    {
        name: "idx_receive_history_player_created",
        table: "players_receive_history",
        columns: [["player_id", 0], ["create_time", 1], ["id", 1]],
        query: `
            SELECT *
            FROM players_receive_history
            WHERE player_id = ? AND create_time >= ?
            ORDER BY create_time DESC, id DESC
            LIMIT ? OFFSET ?
        `,
            parameters: fixture => [fixture.playerId, "2024-08-01 00:00:00", 10, 5],
    },
    {
        name: "idx_receive_history_created",
        table: "players_receive_history",
        columns: [["create_time", 0], ["id", 0]],
        query: `
            SELECT id
            FROM players_receive_history
            WHERE create_time < ?
            ORDER BY create_time, id
            LIMIT ?
        `,
        parameters: () => ["2024-08-01 00:00:00", 100],
    },
]

function clonePlayers(database, sourcePlayerId, count) {
    const columns = database.pragma("table_info(players)")
        .map(column => column.name)
        .filter(column => column !== "id")
    const columnList = columns.map(column => `"${column}"`).join(", ")
    const clone = database.prepare(`
        INSERT INTO players (${columnList})
        SELECT ${columnList}
        FROM players
        WHERE id = ?
    `)
    const playerIds = [sourcePlayerId]
    for (let index = 1; index < count; index += 1) {
        playerIds.push(Number(clone.run(sourcePlayerId).lastInsertRowid))
    }
    return playerIds
}

function seedHotPathTables(database, playerIds) {
    database.exec(`
        DELETE FROM players_characters_bond_tokens;
        DELETE FROM players_characters_mana_nodes;
        DELETE FROM players_characters;
        DELETE FROM players_items;
        DELETE FROM players_equipment;
        DELETE FROM players_category_missions;
        DELETE FROM players_mails;
        DELETE FROM players_receive_history;
    `)

    const insertItem = database.prepare(`
        INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)
    `)
    const insertCharacter = database.prepare(`
        INSERT INTO players_characters (
            id, entry_count, evolution_level, over_limit_step, protection,
            join_time, update_time, exp, stack, mana_board_index, player_id
        ) VALUES (?, 1, 0, 0, 0, ?, ?, 0, 0, 1, ?)
    `)
    const insertBondToken = database.prepare(`
        INSERT INTO players_characters_bond_tokens (
            mana_board_index, status, player_id, character_id
        ) VALUES (?, 0, ?, ?)
    `)
    const insertManaNode = database.prepare(`
        INSERT INTO players_characters_mana_nodes (
            value, awake_level, character_id, player_id
        ) VALUES (?, 0, ?, ?)
    `)
    const insertEquipment = database.prepare(`
        INSERT INTO players_equipment (
            id, level, enhancement_level, protection, stack, player_id
        ) VALUES (?, 1, 0, 0, 1, ?)
    `)
    const insertCategoryMission = database.prepare(`
        INSERT INTO players_category_missions (category, id, progress, player_id)
        VALUES (?, ?, ?, ?)
    `)
    const insertMail = database.prepare(`
        INSERT INTO players_mails (
            player_id, reason_id, subject, description, type, type_id, number,
            receive_time, create_time, reward_period_limited, reward_limit_time
        ) VALUES (?, 0, ?, ?, 1, ?, 1, ?, ?, 0, NULL)
    `)
    const insertReceiveHistory = database.prepare(`
        INSERT INTO players_receive_history (
            player_id, type, type_id, number, reason_id, create_time
        ) VALUES (?, 1, ?, 1, 0, ?)
    `)

    database.transaction(() => {
        for (const playerId of playerIds) {
            for (let entry = 1; entry <= 24; entry += 1) {
                const timestamp = `2024-08-${String((entry % 28) + 1).padStart(2, "0")} 12:00:00`
                insertItem.run(entry, entry * 10, playerId)
                insertCharacter.run(entry, timestamp, timestamp, playerId)
                insertEquipment.run(entry, playerId)
                insertCategoryMission.run((entry % 4) + 1, entry, entry * 2, playerId)
                for (let boardIndex = 1; boardIndex <= 3; boardIndex += 1) {
                    insertBondToken.run(boardIndex, playerId, entry)
                }
                for (let value = 1; value <= 6; value += 1) {
                    insertManaNode.run(value, entry, playerId)
                }
            }
            for (let entry = 1; entry <= 32; entry += 1) {
                const timestamp = `2024-08-${String((entry % 28) + 1).padStart(2, "0")} 12:00:00`
                const receiveTime = entry % 2 === 0 ? "0000-00-00 00:00:00" : timestamp
                insertMail.run(
                    playerId,
                    `mail-${entry}`,
                    `description-${entry}`,
                    entry,
                    receiveTime,
                    timestamp,
                )
                insertReceiveHistory.run(playerId, entry, timestamp)
            }
        }
    })()
    database.exec("ANALYZE")
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

test("initializes exact player hot-path indexes and uses them for player reads", t => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wdfp-hot-path-indexes-"))
    t.after(() => {
        closeDatabase()
        fs.rmSync(parent, { recursive: true, force: true })
    })

    const database = initializeDatabase({
        paths: resolveRuntimeDataPaths({ DATA_DIR: path.join(parent, "data") }),
    })
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "database-hot-path-indexes",
        status: "normal",
    })
    const sourcePlayerId = insertDefaultPlayerSync(account.id).id
    const playerIds = clonePlayers(database, sourcePlayerId, 40)
    seedHotPathTables(database, playerIds)

    const fixture = {
        playerId: playerIds[Math.floor(playerIds.length / 2)],
        characterId: 12,
        category: 3,
    }
    for (const indexCase of INDEX_CASES) {
        const index = database.prepare(`PRAGMA index_list('${indexCase.table}')`)
            .all()
            .find(candidate => candidate.name === indexCase.name)
        assert.deepEqual(
            index && {
                name: index.name,
                unique: index.unique,
                origin: index.origin,
                partial: index.partial,
            },
            { name: indexCase.name, unique: 0, origin: "c", partial: 0 },
            `${indexCase.name} is missing or is not an ordinary non-unique index`,
        )

        const columns = database.prepare(`PRAGMA index_xinfo('${indexCase.name}')`)
            .all()
            .filter(column => column.key === 1)
            .map(column => [column.name, column.desc])
        assert.deepEqual(columns, indexCase.columns, `${indexCase.name} has the wrong columns`)

        const queryPlan = database.prepare(`EXPLAIN QUERY PLAN ${indexCase.query}`)
            .all(...indexCase.parameters(fixture))
        const details = queryPlan.map(row => String(row.detail)).join("\n")
        assert.match(
            details,
            new RegExp(`(?:^|\\n)SEARCH ${escapeRegex(indexCase.table)} .*${escapeRegex(indexCase.name)}`),
            `${indexCase.name} query did not use an indexed SEARCH:\n${details}`,
        )
        assert.doesNotMatch(
            details,
            new RegExp(`(?:^|\\n)SCAN ${escapeRegex(indexCase.table)}(?:\\s|$)`),
            `${indexCase.name} query performed a table SCAN:\n${details}`,
        )
    }
})
