"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    getEquipmentContentCatalog,
} = require("../src/lib/equipment-content")
const {
    getItemContentCatalog,
} = require("../src/lib/item-content")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

function repository(marker) {
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
