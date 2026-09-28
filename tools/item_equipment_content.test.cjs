"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getEquipmentContentCatalog,
    getEquipmentCraftSync,
    getEquipmentRaritySync,
} = require("../src/lib/equipment-content")
const {
    getItemContentCatalog,
} = require("../src/lib/item-content")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

function repository(marker, tableOverrides = {}) {
    return createFrozenTestContentRepository({
        assetVersion: "same-version",
        tables: {
            "item_data.json": { "1": { effectKind: 2, effectValue: marker } },
            "item_ids.json": [1],
            "item_lookup.json": { "1": `item-${marker}` },
            "item_sale.json": { "1": { category: 1, sale_price: marker, sellable: true } },
            "equipment_craft.json": {
                "1": { dissolve_craft: marker, awakening_craft: marker, dissolve_star: marker },
            },
            "equipment_dissolve.json": {
                "1000001": {
                    ability_soul_id: 1,
                    obtain_source: 0,
                    generate_ability_soul: true,
                    max_level: marker,
                },
            },
            "equipment_ids.json": [1000001],
            "equipment_lookup.json": {
                "1000001": { name: `equipment-${marker}`, rarity: "1", category: "test" },
            },
            ...tableOverrides,
        },
    })
}

test("Item and Equipment catalogs cache once per repository identity", () => {
    const firstRepository = repository(1)
    const secondRepository = repository(2)

    const firstItem = getItemContentCatalog(firstRepository)
    assert.strictEqual(getItemContentCatalog(firstRepository), firstItem)
    assert.notStrictEqual(getItemContentCatalog(secondRepository), firstItem)
    assert.equal(firstItem.lookup["1"], "item-1")
    assert.equal(getItemContentCatalog(secondRepository).lookup["1"], "item-2")

    const firstEquipment = getEquipmentContentCatalog(firstRepository)
    assert.strictEqual(getEquipmentContentCatalog(firstRepository), firstEquipment)
    assert.notStrictEqual(getEquipmentContentCatalog(secondRepository), firstEquipment)
    assert.equal(firstEquipment.lookup["1000001"].name, "equipment-1")
    assert.equal(getEquipmentContentCatalog(secondRepository).lookup["1000001"].name, "equipment-2")

    assert.equal(Object.isFrozen(firstItem), true)
    assert.equal(Object.isFrozen(firstEquipment), true)
})

test("typed catalog construction fails closed when a required table is missing", () => {
    const missing = createFrozenTestContentRepository({ tables: { "item_data.json": {} } })
    assert.throws(() => getItemContentCatalog(missing), /missing test content table/)
    assert.throws(() => getEquipmentContentCatalog(missing), /missing test content table/)
})

test("Item catalog rejects malformed roots, negative economics and relationship drift", () => {
    assert.throws(
        () => getItemContentCatalog(repository(1, { "item_sale.json": [] })),
        /invalid item catalog content.*item_sale.*object/i,
    )
    assert.throws(
        () => getItemContentCatalog(repository(1, {
            "item_sale.json": { "1": { category: 1, sale_price: -100, sellable: true } },
        })),
        /sale_price.*non-negative/i,
    )
    assert.throws(
        () => getItemContentCatalog(repository(1, { "item_lookup.json": {} })),
        /item_lookup ids must exactly match/i,
    )
})

test("Equipment catalog rejects malformed levels and missing craft relationships", () => {
    assert.throws(
        () => getEquipmentContentCatalog(repository(1, {
            "equipment_dissolve.json": {
                "1000001": {
                    ability_soul_id: 1,
                    obtain_source: 0,
                    generate_ability_soul: true,
                    max_level: "bad",
                },
            },
        })),
        /max_level.*positive safe integer/i,
    )
    assert.throws(
        () => getEquipmentContentCatalog(repository(1, { "equipment_craft.json": {} })),
        /equipment_craft must not be empty|missing craft rarity/i,
    )
    assert.throws(
        () => getEquipmentContentCatalog(repository(1, { "equipment_dissolve.json": {} })),
        /equipment_dissolve ids must exactly match/i,
    )
})

test("Equipment rarity follows the ID prefix only for equipment namespaces", () => {
    const specialNamespace = repository(1, {
        "equipment_craft.json": {
            "5": { dissolve_craft: 1, awakening_craft: 1, dissolve_star: 1 },
        },
        "equipment_ids.json": [100001],
        "equipment_dissolve.json": {
            "100001": {
                ability_soul_id: 1,
                obtain_source: 0,
                generate_ability_soul: false,
                max_level: 1,
            },
        },
        "equipment_lookup.json": {
            "100001": { name: "主线宝珠", rarity: "5", category: "主线宝珠" },
        },
    })
    assert.doesNotThrow(() => getEquipmentContentCatalog(specialNamespace))

    assert.throws(
        () => getEquipmentContentCatalog(repository(1, {
            "equipment_craft.json": {
                "5": { dissolve_craft: 1, awakening_craft: 1, dissolve_star: 1 },
            },
            "equipment_lookup.json": {
                "1000001": { name: "装备", rarity: "5", category: "剑" },
            },
            "equipment_ids.json": [1000001],
            "equipment_dissolve.json": {
                "1000001": {
                    ability_soul_id: 1,
                    obtain_source: 0,
                    generate_ability_soul: false,
                    max_level: 1,
                },
            },
        })),
        /rarity must match its id prefix/i,
    )
})

test("Equipment rarity policy resolves both equipment and sub-million namespaces", () => {
    const specialNamespace = repository(1, {
        "equipment_craft.json": {
            "5": { dissolve_craft: 1, awakening_craft: 1, dissolve_star: 1 },
        },
        "equipment_ids.json": [100001],
        "equipment_dissolve.json": {
            "100001": {
                ability_soul_id: 1,
                obtain_source: 0,
                generate_ability_soul: false,
                max_level: 1,
            },
        },
        "equipment_lookup.json": {
            "100001": { name: "主线宝珠", rarity: "5", category: "主线宝珠" },
        },
    })
    assert.equal(getEquipmentRaritySync(100001, specialNamespace), 5)
})

test("Equipment rarity rejects unsupported domains and craft lookup fails closed", () => {
    const unsupportedRarity = repository(1, {
        "equipment_craft.json": {
            "1": { dissolve_craft: 1, awakening_craft: 1, dissolve_star: 1 },
            "5": { dissolve_craft: 5, awakening_craft: 5, dissolve_star: 5 },
            "6": { dissolve_craft: 6, awakening_craft: 6, dissolve_star: 6 },
        },
        "equipment_ids.json": [6000001],
        "equipment_dissolve.json": {
            "6000001": {
                ability_soul_id: 1,
                obtain_source: 0,
                generate_ability_soul: false,
                max_level: 1,
            },
        },
        "equipment_lookup.json": {
            "6000001": { name: "越界装备", rarity: "6", category: "测试" },
        },
    })

    assert.throws(
        () => getEquipmentContentCatalog(unsupportedRarity),
        /rarity must be from 1 through 5/i,
    )
    assert.equal(getEquipmentCraftSync(6), null)
})
