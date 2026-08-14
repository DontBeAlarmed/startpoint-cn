"use strict"

const { randomUUID } = require("node:crypto")

const { getDb } = require("../../src/data/db")
const { insertAccountSync } = require("../../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../../src/data/domains/player")

const FIXTURE_TIME = "2024-08-14T12:00:00.000Z"

function createPlayer(name) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "mission-perf",
        idpId: `${name}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function seedQuestProgress(playerId, count, completionRatio) {
    const insert = getDb().prepare(`
        INSERT INTO players_quest_progress (
            section, quest_id, finished, unlocked, high_score, clear_rank,
            best_elapsed_time_ms, leader_character_id, host_finished, player_id
        ) VALUES (?, ?, ?, 1, ?, ?, ?, 1, 0, ?)
    `)
    for (let index = 0; index < count; index++) {
        const section = index % 8 + 1
        const finished = index / count < completionRatio ? 1 : 0
        insert.run(
            section,
            100_000 + index,
            finished,
            finished ? index * 100 : null,
            finished ? index % 5 + 1 : null,
            finished ? 60_000 + index : null,
            playerId,
        )
    }
}

function seedInventory(playerId, itemCount, equipmentCount, characterCount) {
    const db = getDb()
    const insertItem = db.prepare("INSERT INTO players_items (id, amount, player_id) VALUES (?, ?, ?)")
    for (let index = 0; index < itemCount; index++) {
        insertItem.run(900_000 + index, index + 1, playerId)
    }

    const insertEquipment = db.prepare(`
        INSERT INTO players_equipment (
            id, level, enhancement_level, protection, stack, player_id
        ) VALUES (?, ?, ?, 0, ?, ?)
    `)
    for (let index = 0; index < equipmentCount; index++) {
        insertEquipment.run(800_000 + index, index % 5 + 1, index % 6, index % 3, playerId)
    }

    const insertCharacter = db.prepare(`
        INSERT INTO players_characters (
            id, entry_count, evolution_level, over_limit_step, protection,
            join_time, update_time, exp, stack, mana_board_index, player_id,
            ex_boost_status_id, ex_boost_ability_id_list, illustration_settings
        ) VALUES (?, 1, ?, ?, 0, ?, ?, ?, 0, 1, ?, NULL, NULL, NULL)
    `)
    for (let index = 0; index < characterCount; index++) {
        insertCharacter.run(
            700_000 + index,
            index % 2,
            index % 6,
            FIXTURE_TIME,
            FIXTURE_TIME,
            index * 10_000,
            playerId,
        )
    }
}

function seedProgress(playerId, scale) {
    const db = getDb()
    db.prepare(`
        UPDATE players
        SET rank_point = ?, total_stamina_used = ?, total_powerflips = ?,
            total_dashes = ?, total_mana_obtained = ?, max_combo_achieved = ?,
            total_login_days = ?
        WHERE id = ?
    `).run(
        scale * 500,
        scale * 100,
        scale * 20,
        scale * 30,
        scale * 1000,
        scale * 10,
        scale * 7,
        playerId,
    )
    seedQuestProgress(playerId, scale * 12, scale >= 10 ? 0.95 : 0.6)
    seedInventory(playerId, scale * 8, scale * 5, scale * 4)
}

const SCENARIOS = Object.freeze([
    {
        name: "new-account",
        create() {
            return createPlayer("new-account")
        },
    },
    {
        name: "normal-progress",
        create() {
            const playerId = createPlayer("normal-progress")
            seedProgress(playerId, 3)
            return playerId
        },
    },
    {
        name: "high-completion-volume",
        create() {
            const playerId = createPlayer("high-completion-volume")
            seedProgress(playerId, 20)
            return playerId
        },
    },
])

module.exports = { SCENARIOS }
