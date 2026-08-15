"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    getMissionCatalog,
    getMissionCatalogContentTable,
} = require("../src/lib/mission/mission-catalog")
const {
    bundledMissionContentRepository,
} = require("../src/lib/mission/mission-catalog-source")
const {
    deriveRegularStateFacts,
} = require("../src/lib/mission/regular-state-facts")
const {
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission/requirements/registry")
const { getFactKeyId } = require("../src/lib/mission/facts/fact-key")

function repositoryWithTables(tables) {
    return Object.freeze({
        info: () => bundledMissionContentRepository.info(),
        table(tableName) {
            if (Object.prototype.hasOwnProperty.call(tables, tableName)) return tables[tableName]
            return bundledMissionContentRepository.table(tableName)
        },
    })
}

function character(overrides = {}) {
    return {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 2,
        protection: false,
        joinTime: new Date(0),
        updateTime: new Date(0),
        exp: Number.MAX_SAFE_INTEGER,
        stack: 0,
        manaBoardIndex: 2,
        bondTokenList: [{ manaBoardIndex: 1, status: 1 }],
        ...overrides,
    }
}

test("Mission Catalog keeps its private readonly Content table source", () => {
    const characterTable = Object.freeze({ 100001: Object.freeze({ rarity: 5 }) })
    const manaBoardTable = Object.freeze({})
    const catalog = getMissionCatalog(repositoryWithTables({
        "character.json": characterTable,
        "mana_board.json": manaBoardTable,
    }))

    assert.equal(typeof getMissionCatalogContentTable, "function")
    assert.strictEqual(getMissionCatalogContentTable(catalog, "character.json"), characterTable)
    assert.strictEqual(getMissionCatalogContentTable(catalog, "mana_board.json"), manaBoardTable)
    assert.throws(
        () => getMissionCatalogContentTable(Object.freeze({}), "character.json"),
        /source.*not found/i,
    )
})

test("Regular craft-point requirement selects its Catalog config item with the legacy default", () => {
    for (const [config, expectedItemId] of [
        [{ craft_point_item_id: 777777 }, 777777],
        [{}, 100000],
        [{ craft_point_item_id: "invalid" }, 100000],
    ]) {
        const catalog = getMissionCatalog(repositoryWithTables({ "config.json": config }))
        const requirement = getMissionFactRequirementRegistry(catalog).getRequirement(1, 66)
        assert.deepEqual(requirement.facts.map(getFactKeyId), [
            `collectedItems:${expectedItemId}`,
        ])
    }
})

test("pure Regular state derivation preserves character, board, equipment and collected rules", () => {
    assert.equal(typeof deriveRegularStateFacts, "function")
    const facts = deriveRegularStateFacts({
        characters: {
            100001: character(),
            100002: character({
                exp: 0,
                manaBoardIndex: 1,
                overLimitStep: 1,
                bondTokenList: [{ manaBoardIndex: 1, status: 0 }],
            }),
        },
        characterManaNodes: { 100001: [501, 502], 100002: [601] },
        equipment: {
            200001: { level: 3, enhancementLevel: 0, protection: false, stack: 0 },
            200002: { level: 5, enhancementLevel: 0, protection: false, stack: 0 },
        },
        collectedItemTotals: { 700001: 77 },
        characterTable: {
            100001: { rarity: 5 },
            100002: { rarity: 5 },
        },
        manaBoardTable: {
            100001: { 2: { 1: [[501]], 2: [[502]] } },
            100002: { 2: { 1: [[601]], 2: [[602]] } },
        },
        craftPointItemId: 700001,
    })

    assert.deepEqual(facts, {
        characterCount: 2,
        level80CharacterCount: 1,
        manaBoardNodeCount: 3,
        overLimitCount: 3,
        bondTokenCount: 1,
        equipmentKindCount: 2,
        equipmentAwakeningCount: 6,
        maxLevelEquipmentCount: 1,
        secondManaBoardOpenCount: 1,
        secondManaBoardCompleteCount: 1,
        craftPointObtainedCount: 77,
    })
})

test("pure Regular state derivation uses safe zeroes for unloaded facts", () => {
    assert.deepEqual(deriveRegularStateFacts({ craftPointItemId: 700001 }), {
        characterCount: 0,
        level80CharacterCount: 0,
        manaBoardNodeCount: 0,
        overLimitCount: 0,
        bondTokenCount: 0,
        equipmentKindCount: 0,
        equipmentAwakeningCount: 0,
        maxLevelEquipmentCount: 0,
        secondManaBoardOpenCount: 0,
        secondManaBoardCompleteCount: 0,
        craftPointObtainedCount: 0,
    })
})
