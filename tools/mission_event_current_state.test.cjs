require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-current-state-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const characterDomain = require("../src/data/domains/character")
const {
    insertPlayerCharacterManaNodesSync,
    insertPlayerCharacterSync,
} = characterDomain
const { insertPlayerEquipmentSync } = require("../src/data/domains/equipment")
const equipmentDomain = require("../src/data/domains/equipment")
const { setPlayerItemSync } = require("../src/data/domains/item")
const itemDomain = require("../src/data/domains/item")
const partyDomain = require("../src/data/domains/party")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const { characterExpCaps } = require("../src/lib/character")
const { getCharacterStoryQuestIds } = require("../src/lib/mission/character-queries")
const { EventSafeComputer } = require("../src/lib/mission/computer-event-safe")
const {
    MissionEvaluationSession,
    createProductionMissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const {
    getBundledStandardMissionTables,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const characters = require("../assets/character.json")
const characterQuests = require("../assets/character_quest_lookup.json")
const equipmentDissolve = require("../assets/equipment_dissolve.json")
const itemSale = require("../assets/item_sale.json")
const mainQuests = require("../assets/main_quest.json")
const manaBoard = require("../assets/mana_board.json")

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `mission-event-current-state-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const characterId = 1
const secondCharacterId = Number(Object.keys(characters).find(id => id !== String(characterId)))
const rarity = characters[String(characterId)].rarity
const maxOverLimitStep = characterExpCaps[rarity].length - 1
const validManaNodeIds = Object.values(manaBoard[String(characterId)])
    .flatMap(board => Object.values(board))
    .map(rows => Number(rows[0][0]))
    .slice(0, 3)
const chapterOneQuestIds = Object.keys(mainQuests)
    .map(Number)
    .filter(questId => Math.floor(questId / 1_000_000) === 1)
const characterStoryQuestId = getCharacterStoryQuestIds(characterId)[0]
const [equipmentId, equipmentDefinition] = Object.entries(equipmentDissolve)
    .find(([, definition]) => Number.isSafeInteger(definition.max_level) && definition.max_level >= 4)
const [secondEquipmentId] = Object.entries(equipmentDissolve)
    .find(([candidateId, definition]) => (
        candidateId !== equipmentId
        && Number.isSafeInteger(definition.max_level)
        && definition.max_level >= 2
    ))
const abilitySoulIds = Object.entries(itemSale)
    .filter(([, definition]) => definition.category === 5)
    .map(([itemId]) => Number(itemId))
const validAbilitySoulId = abilitySoulIds[0]
const unownedAbilitySoulId = abilitySoulIds[1]
const nonAbilitySoulItemId = Number(Object.entries(itemSale)
    .find(([, definition]) => definition.category !== 5)[0])

assert.equal(validManaNodeIds.length, 3)
assert.equal(chapterOneQuestIds.length > 0, true)
assert.equal(Number.isSafeInteger(characterStoryQuestId), true)
assert.equal(Number.isSafeInteger(validAbilitySoulId), true)

function insertCharacter(id, overLimitStep = 0, exp = 0) {
    const now = new Date("2024-01-01T00:00:00.000Z")
    insertPlayerCharacterSync(playerId, id, {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep,
        protection: false,
        joinTime: now,
        updateTime: now,
        exp,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [],
    })
}

insertCharacter(secondCharacterId, 2, 0)

function insertFinishedQuest(section, questId) {
    insertPlayerQuestProgressSync(playerId, section, {
        questId,
        finished: true,
        unlocked: true,
        clearRank: 1,
    })
}

function clearEquippedAbilitySouls() {
    db.prepare(`
        UPDATE players_parties
        SET ability_soul_1 = NULL, ability_soul_2 = NULL, ability_soul_3 = NULL
        WHERE player_id = ?
    `).run(playerId)
}

function setPartyAbilitySouls(slot, abilitySoulIds) {
    db.prepare(`
        UPDATE players_parties
        SET ability_soul_1 = ?, ability_soul_2 = ?, ability_soul_3 = ?
        WHERE player_id = ? AND category = 1 AND group_id = 1 AND slot = ?
    `).run(
        abilitySoulIds[0] ?? null,
        abilitySoulIds[1] ?? null,
        abilitySoulIds[2] ?? null,
        playerId,
        slot,
    )
}

function setEquippedAbilitySoul(abilitySoulId) {
    clearEquippedAbilitySouls()
    if (abilitySoulId !== null) setPartyAbilitySouls(1, [abilitySoulId, null, null])
}

function resetValidState() {
    db.prepare("DELETE FROM players_characters_mana_nodes WHERE player_id = ?").run(playerId)
    insertPlayerCharacterManaNodesSync(playerId, characterId, validManaNodeIds)
    db.prepare(`
        UPDATE players_characters
        SET exp = ?, over_limit_step = 1
        WHERE player_id = ? AND id = ?
    `).run(characterExpCaps[rarity][0], playerId, characterId)
    db.prepare(`
        UPDATE players_characters
        SET exp = 0, over_limit_step = 2
        WHERE player_id = ? AND id = ?
    `).run(playerId, secondCharacterId)
    db.prepare("DELETE FROM players_characters WHERE player_id = ? AND id NOT IN (?, ?)")
        .run(playerId, characterId, secondCharacterId)

    db.prepare("DELETE FROM players_equipment WHERE player_id = ?").run(playerId)
    insertPlayerEquipmentSync(playerId, equipmentId, {
        level: 4,
        enhancementLevel: 99,
        protection: false,
        stack: 50,
    })
    insertPlayerEquipmentSync(playerId, secondEquipmentId, {
        level: 2,
        enhancementLevel: 0,
        protection: false,
        stack: 0,
    })

    db.prepare("DELETE FROM players_quest_progress WHERE player_id = ? AND section IN (1, 3)")
        .run(playerId)
    for (const questId of chapterOneQuestIds) insertFinishedQuest(1, questId)
    insertFinishedQuest(3, characterStoryQuestId)

    db.prepare("DELETE FROM players_items WHERE player_id = ?").run(playerId)
    setPlayerItemSync(playerId, validAbilitySoulId, 1)
    setEquippedAbilitySoul(validAbilitySoulId)
}

function buildContext() {
    return EventSafeComputer.buildContext(playerId, 3, new Date("2019-12-03T12:00:00.000Z"))
}

test("Event current-state buildContext proves all 15 missions from real DB and assets", () => {
    resetValidState()
    const context = buildContext()
    const expectedProgress = new Map([
        [1201, 1], [1202, 0], [1203, 0], [1204, 1],
        [1205, 3], [1206, 3], [1207, 3], [1212, 4],
        [1217, 3], [1218, 3], [1219, 3], [1220, 1],
        [1305, 70], [1306, 3], [1307, 4],
    ])
    for (const [missionId, expected] of expectedProgress) {
        assert.equal(EventSafeComputer.compute(missionId, context, 0), expected, String(missionId))
        assert.equal(
            EventSafeComputer.compute(missionId, context, expected + 50),
            expected + 50,
            `mission ${missionId} must preserve higher dbProgress`,
        )
    }
})

test("Event Session context preserves all 15 real current-state results", () => {
    resetValidState()
    const missionIds = [
        1201, 1202, 1203, 1204, 1205, 1206, 1207, 1212,
        1217, 1218, 1219, 1220, 1305, 1306, 1307,
    ]
    const expectedProgress = new Map([
        [1201, 1], [1202, 0], [1203, 0], [1204, 1],
        [1205, 3], [1206, 3], [1207, 3], [1212, 4],
        [1217, 3], [1218, 3], [1219, 3], [1220, 1],
        [1305, 70], [1306, 3], [1307, 4],
    ])
    const catalog = getMissionCatalog()
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime: new Date("2019-12-03T12:00:00.000Z"),
        catalog,
        requirementRegistry: getMissionFactRequirementRegistry(catalog),
        candidates: missionIds.map(missionId => ({ category: 3, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
    const context = EventSafeComputer.buildContextFromSession(session, 3, missionIds)

    for (const [missionId, expected] of expectedProgress) {
        assert.equal(EventSafeComputer.compute(missionId, context, 0), expected, String(missionId))
    }
})

test("Event mana-node facts reject a node outside the character official board", () => {
    resetValidState()
    insertPlayerCharacterManaNodesSync(playerId, characterId, [999999])
    const context = buildContext()
    for (const missionId of [1205, 1206, 1207, 1217, 1218, 1219]) {
        assert.equal(EventSafeComputer.compute(missionId, context, 0), 3)
    }
})

test("Event over-limit facts reject a step above the rarity official maximum", () => {
    resetValidState()
    db.prepare("UPDATE players_characters SET over_limit_step = ? WHERE player_id = ? AND id = ?")
        .run(maxOverLimitStep + 1, playerId, characterId)
    assert.equal(EventSafeComputer.compute(1306, buildContext(), 0), 2)
})

test("Event equipment facts reject a level above official max_level", () => {
    resetValidState()
    db.prepare("UPDATE players_equipment SET level = ? WHERE player_id = ? AND id = ?")
        .run(equipmentDefinition.max_level + 1, playerId, Number(equipmentId))
    const context = buildContext()
    assert.equal(EventSafeComputer.compute(1212, context, 0), 1)
    assert.equal(EventSafeComputer.compute(1307, context, 0), 1)
})

test("Event ability-soul facts validate each party preset independently", () => {
    resetValidState()
    setPartyAbilitySouls(2, [validAbilitySoulId, null, null])
    assert.equal(EventSafeComputer.compute(1220, buildContext(), 0), 1)

    resetValidState()
    clearEquippedAbilitySouls()
    setPartyAbilitySouls(1, [validAbilitySoulId, validAbilitySoulId, null])
    assert.equal(EventSafeComputer.compute(1220, buildContext(), 0), 0)

    resetValidState()
    setPartyAbilitySouls(1, [999999999, null, null])
    setPartyAbilitySouls(2, [validAbilitySoulId, null, null])
    assert.equal(EventSafeComputer.compute(1220, buildContext(), 0), 1)

    resetValidState()
    setEquippedAbilitySoul(unownedAbilitySoulId)
    assert.equal(EventSafeComputer.compute(1220, buildContext(), 0), 0)

    resetValidState()
    setPlayerItemSync(playerId, nonAbilitySoulItemId, 1)
    setEquippedAbilitySoul(nonAbilitySoulItemId)
    assert.equal(EventSafeComputer.compute(1220, buildContext(), 0), 0)

    resetValidState()
    setPartyAbilitySouls(2, [validAbilitySoulId, null, null])
    assert.equal(EventSafeComputer.compute(1220, buildContext(), 0), 1)
})

test("Event character stories use exact official row ownership", () => {
    assert.equal(getCharacterStoryQuestIds(141003).includes(1410031), false)
    assert.equal(getCharacterStoryQuestIds(141004).includes(1410031), true)
    resetValidState()
    insertCharacter(141003)
    db.prepare("DELETE FROM players_quest_progress WHERE player_id = ? AND section = 3").run(playerId)
    insertFinishedQuest(3, 1410031)
    assert.equal(EventSafeComputer.compute(1204, buildContext(), 0), 0)

    insertCharacter(141004)
    assert.equal(EventSafeComputer.compute(1204, buildContext(), 0), 1)
})

test("Event chapter facts require every official quest in the selected chapter", () => {
    resetValidState()
    db.prepare(`
        DELETE FROM players_quest_progress
        WHERE player_id = ? AND section = 1 AND quest_id = ?
    `).run(playerId, chapterOneQuestIds[0])
    const context = buildContext()
    assert.equal(EventSafeComputer.compute(1201, context, 0), 0)
    assert.equal(EventSafeComputer.compute(1201, context, 9), 9)
})

function withContentTables(overrides, callback) {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const tables = {
        ...getBundledStandardMissionTables(),
        "character.json": characters,
        "character_quest_lookup.json": characterQuests,
        "equipment_dissolve.json": equipmentDissolve,
        "item_sale.json": itemSale,
        "main_quest.json": mainQuests,
        "mana_board.json": manaBoard,
        "mission_event.json": require("../assets/mission_event.json"),
        "challenge_dungeon_event_quest.json": require("../assets/challenge_dungeon_event_quest.json"),
        ...overrides,
    }
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "test" },
        repository: {
            info: () => ({ source: "test" }),
            table(tableName) {
                if (Object.prototype.hasOwnProperty.call(tables, tableName)) return tables[tableName]
                throw new Error(`unexpected table ${tableName}`)
            },
        },
    }
    try {
        return callback()
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
}

test("Event malformed static indexes fail closed for their whole fact family", () => {
    resetValidState()
    const cases = [
        ["mana_board.json", { ...manaBoard, 999999: null }, 1205, 1],
        ["character.json", { ...characters, 999999: { rarity: "4" } }, 1306, 1],
        ["equipment_dissolve.json", { ...equipmentDissolve, bad: { max_level: 5 } }, 1307, 1],
        ["item_sale.json", { ...itemSale, 999999: { category: "5" } }, 1220, 0],
        ["main_quest.json", { ...mainQuests, bad: {} }, 1201, 0],
        ["character_quest_lookup.json", { ...characterQuests, bad: [["bad"]] }, 1204, 0],
    ]
    for (const [tableName, table, missionId, dbProgress] of cases) {
        withContentTables({ [tableName]: table }, () => {
            assert.equal(EventSafeComputer.compute(missionId, buildContext(), dbProgress), dbProgress)
        })
    }
})

test("Event buildContext skips current-state queries and indexes outside all 15 release windows", () => {
    resetValidState()
    const spies = [
        [characterDomain, "getPlayerCharactersSync"],
        [characterDomain, "getPlayerCharactersManaNodesSync"],
        [equipmentDomain, "getPlayerEquipmentListSync"],
        [itemDomain, "getPlayerItemsSync"],
        [partyDomain, "getPlayerPartyGroupListSync"],
    ]
    const originals = spies.map(([module, name]) => module[name])
    let playerStateQueries = 0
    for (const [module, name] of spies) {
        const original = module[name]
        module[name] = (...args) => {
            playerStateQueries++
            return original(...args)
        }
    }
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    let tableReads = 0
    const standardMissionTables = getBundledStandardMissionTables()
    const eventRuleTables = Object.fromEntries([
        "challenge_dungeon_event_quest.json",
        "ranking_event_single_quest.json",
        "rush_event_quest.json",
        "carnival_event_quest.json",
    ].map(tableName => [tableName, require(`../assets/${tableName}`)]))
    productionContentSnapshotProvider.snapshot = {
        cdn: { targetVersion: "test" },
        repository: {
            info: () => ({ source: "test" }),
            table(tableName) {
                if (Object.prototype.hasOwnProperty.call(standardMissionTables, tableName)) {
                    return standardMissionTables[tableName]
                }
                if (Object.prototype.hasOwnProperty.call(eventRuleTables, tableName)) {
                    return eventRuleTables[tableName]
                }
                tableReads++
                throw new Error("unexpected current-state table read")
            },
        },
    }
    try {
        const context = EventSafeComputer.buildContext(
            playerId,
            3,
            new Date("2024-08-14T12:00:00.000Z"),
        )
        assert.equal(context.eventCurrentState, undefined)
        assert.equal(playerStateQueries, 0)
        assert.equal(tableReads, 0)
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
        spies.forEach(([module, name], index) => { module[name] = originals[index] })
    }
})
