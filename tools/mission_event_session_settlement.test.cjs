"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-session-settlement-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getDb } = require("../src/data/db")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")

initializeDatabase()
const db = getDb()
const originalPrepare = db.prepare.bind(db)
let tracking = false
let sqlReads

function emptySqlReads() {
    return {
        player: 0,
        quest: 0,
        characters: 0,
        manaNodes: 0,
        equipment: 0,
        items: 0,
        partyGroups: 0,
        parties: 0,
        categoryMissions: 0,
        categoryStages: 0,
    }
}

db.prepare = statement => {
    if (tracking) {
        const sql = String(statement)
        if (/\bFROM\s+players\s+WHERE\b/i.test(sql)) sqlReads.player++
        if (/\bFROM\s+players_quest_progress\b/i.test(sql)) sqlReads.quest++
        if (/\bFROM\s+players_characters\s+WHERE\b/i.test(sql)) sqlReads.characters++
        if (/\bFROM\s+players_characters_mana_nodes\b/i.test(sql)) sqlReads.manaNodes++
        if (/\bFROM\s+players_equipment\b/i.test(sql)) sqlReads.equipment++
        if (/\bFROM\s+players_items\b/i.test(sql)) sqlReads.items++
        if (/\bFROM\s+players_party_groups\b/i.test(sql)) sqlReads.partyGroups++
        if (/\bFROM\s+players_parties\b/i.test(sql)) sqlReads.parties++
        if (/\bFROM\s+players_category_missions\b/i.test(sql)) sqlReads.categoryMissions++
        if (/\bFROM\s+players_category_mission_stages\b/i.test(sql)) sqlReads.categoryStages++
    }
    return originalPrepare(statement)
}

const { EventSafeComputer } = require("../src/lib/mission/computer-event-safe")
const { getComputer } = require("../src/lib/mission/registry")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `event-session-settlement-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

test.after(() => {
    tracking = false
    db.prepare = originalPrepare
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("Category 3 settlement routes through Session and loads only mission 1201 facts", () => {
    const playerId = createPlayer()
    const originalLegacy = EventSafeComputer.buildContext
    const originalSession = EventSafeComputer.buildContextFromSession
    let legacyContexts = 0
    let sessionContexts = 0
    EventSafeComputer.buildContext = (...args) => {
        legacyContexts++
        return originalLegacy.call(EventSafeComputer, ...args)
    }
    EventSafeComputer.buildContextFromSession = (...args) => {
        sessionContexts++
        if (originalSession === undefined) {
            throw new Error("Event Session context builder is missing")
        }
        return originalSession.call(EventSafeComputer, ...args)
    }

    sqlReads = emptySqlReads()
    tracking = true
    try {
        settleMissionCategories(
            playerId,
            [{ category: 3, missionIds: [1201] }],
            new Date("2019-11-28T04:00:00.000Z"),
        )
    } finally {
        tracking = false
        EventSafeComputer.buildContext = originalLegacy
        EventSafeComputer.buildContextFromSession = originalSession
    }

    assert.deepEqual({ sessionContexts, legacyContexts, sqlReads }, {
        sessionContexts: 1,
        legacyContexts: 0,
        sqlReads: {
            player: 1,
            quest: 1,
            characters: 0,
            manaNodes: 0,
            equipment: 0,
            items: 0,
            partyGroups: 0,
            parties: 0,
            categoryMissions: 1,
            categoryStages: 1,
        },
    })
})

test("Pass 7/8 and Awake 9 remain outside the Session settlement guard", () => {
    const passComputer = getComputer(7)
    assert.strictEqual(passComputer, getComputer(8))
    const originalPassLegacy = passComputer.buildContext
    const originalPassSession = passComputer.buildContextFromSession
    let passLegacyContexts = 0
    let passSessionContexts = 0
    passComputer.buildContext = (...args) => {
        passLegacyContexts++
        return originalPassLegacy.call(passComputer, ...args)
    }
    passComputer.buildContextFromSession = (...args) => {
        passSessionContexts++
        return originalPassSession.call(passComputer, ...args)
    }

    const awakeComputer = getComputer(9)
    const originalAwakeLegacy = awakeComputer.buildContext
    let awakeLegacyContexts = 0
    awakeComputer.buildContext = (...args) => {
        awakeLegacyContexts++
        return originalAwakeLegacy.call(awakeComputer, ...args)
    }
    try {
        settleMissionCategories(
            createPlayer(),
            [{ category: 7, missionIds: [1] }, { category: 8, missionIds: [1] }],
            new Date("2024-06-02T04:00:00.000Z"),
        )
        settleMissionCategories(
            createPlayer(),
            [{ category: 9, missionIds: [11] }],
            new Date("2024-08-14T12:00:00.000Z"),
        )
    } finally {
        passComputer.buildContext = originalPassLegacy
        passComputer.buildContextFromSession = originalPassSession
        awakeComputer.buildContext = originalAwakeLegacy
    }

    assert.equal(passLegacyContexts, 2)
    assert.equal(passSessionContexts, 0)
    assert.equal(awakeLegacyContexts, 1)
    assert.equal(awakeComputer.buildContextFromSession, undefined)
})
