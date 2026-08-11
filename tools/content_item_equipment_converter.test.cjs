"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

let convertItemEquipmentTables
try {
    ({ convertItemEquipmentTables } = require("../src/content/converters/item-equipment"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const SOURCES = Object.freeze({
    equipment: "master/item/equipment.orderedmap",
    craft: "master/item/equipment_craft_point_exchange.orderedmap",
    dissolveRate: "master/item/equipment_dissolve_rate.orderedmap",
    item: "master/item/item.orderedmap",
    itemBonusSelect: "master/item/item_bonus_select.orderedmap",
})

function row(key, fields) {
    return { key, text: fields.join(",") }
}

function equipmentFields(overrides = {}) {
    const fields = [
        "fixture_sword", "测试剑", "0", "", "", "", "pixel", "description",
        "5", "true", "5010001", "5", "100", "true", "1.5", "0",
    ]
    for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value
    return fields
}

function itemFields(overrides = {}) {
    const fields = [
        "fixture_item", "1", "测试道具", "thumb", "(None)", "description",
        "2", "25", "true", "", "", "", "", "", "9", "(None)",
        "100", "3", "9999", "2015-12-31 23:59:59", "(None)", "true", "",
    ]
    for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value
    return fields
}

function itemBonusSelectFields(overrides = {}) {
    const fields = [
        "测试资源箱",
        "1", "300", "2",
        "1", "300", "6",
        "1", "300", "10",
        "1", "300", "14",
        "1", "300", "43",
        "1", "300", "47",
        "999999",
    ]
    for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value
    return fields
}

function fixture(overrides = {}) {
    const tables = new Map([
        [SOURCES.equipment, [
            row("5010001", equipmentFields()),
            row("5029999", equipmentFields({
                0: "new_equipment",
                1: "新增装备",
                9: "false",
                10: "5029999",
                11: "4",
            })),
        ]],
        [SOURCES.craft, [
            row("1", ["1", "5"]),
            row("2", ["2", "10"]),
            row("3", ["3", "15"]),
            row("4", ["4", "20"]),
            row("5", ["5", "25"]),
        ]],
        [SOURCES.dissolveRate, [
            row("1", ["0"]),
            row("2", ["0"]),
            row("3", ["1"]),
            row("4", ["5"]),
            row("5", ["15"]),
        ]],
        [SOURCES.item, [
            row("100", itemFields()),
            row("101", itemFields({ 2: "普通素材", 6: "0", 7: "", 16: "5" })),
            row("102", itemFields({ 2: "比例体力药", 6: "3", 7: "50" })),
            row("103", itemFields({
                2: "测试资源箱",
                6: "22",
                7: "",
                21: "false",
                22: "900",
            })),
        ]],
        [SOURCES.itemBonusSelect, [
            row("900", itemBonusSelectFields()),
        ]],
    ])
    for (const [logicalPath, rows] of Object.entries(overrides)) tables.set(logicalPath, rows)
    const requested = []
    return {
        requested,
        reader: {
            async read(logicalPath) {
                requested.push(logicalPath)
                const rows = tables.get(logicalPath)
                if (!rows) throw new Error(`missing fixture: ${logicalPath}`)
                return rows
            },
        },
    }
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("item and equipment converter derives the eight authoritative runtime tables", async () => {
    assert.equal(typeof convertItemEquipmentTables, "function", "应导出 convertItemEquipmentTables")
    const source = fixture()
    const output = await convertItemEquipmentTables(source.reader, {
        equipmentLookup: {
            "5010001": { name: "旧名称", rarity: "0", category: "剑" },
        },
    })

    assert.deepEqual(source.requested.sort(), Object.values(SOURCES).sort())
    assert.deepEqual(output, {
        "equipment_craft.json": {
            "1": { dissolve_craft: 1, awakening_craft: 5, dissolve_star: 0 },
            "2": { dissolve_craft: 2, awakening_craft: 10, dissolve_star: 0 },
            "3": { dissolve_craft: 3, awakening_craft: 15, dissolve_star: 1 },
            "4": { dissolve_craft: 4, awakening_craft: 20, dissolve_star: 5 },
            "5": { dissolve_craft: 5, awakening_craft: 25, dissolve_star: 15 },
        },
        "equipment_dissolve.json": {
            "5010001": {
                ability_soul_id: 5010001,
                obtain_source: 0,
                generate_ability_soul: true,
                max_level: 5,
            },
            "5029999": {
                ability_soul_id: 5029999,
                obtain_source: 0,
                generate_ability_soul: false,
                max_level: 5,
            },
        },
        "equipment_ids.json": [5010001, 5029999],
        "equipment_lookup.json": {
            "5010001": { name: "测试剑", rarity: "5", category: "剑" },
            "5029999": { name: "新增装备", rarity: "4", category: "未分类" },
        },
        "item_data.json": {
            "100": { effectKind: 2, effectValue: 25 },
            "102": { effectKind: 3, effectValue: 50 },
            "103": {
                effectKind: 22,
                effectValue: 0,
                selectRewards: [
                    { itemId: 2, amount: 300 },
                    { itemId: 6, amount: 300 },
                    { itemId: 10, amount: 300 },
                    { itemId: 14, amount: 300 },
                    { itemId: 43, amount: 300 },
                    { itemId: 47, amount: 300 },
                ],
            },
        },
        "item_ids.json": [100, 101, 102, 103],
        "item_lookup.json": {
            "100": "测试道具",
            "101": "普通素材",
            "102": "比例体力药",
            "103": "测试资源箱",
        },
        "item_sale.json": {
            "100": { category: 9, sale_price: 100, sellable: true },
            "101": { category: 9, sale_price: 5, sellable: true },
            "102": { category: 9, sale_price: 100, sellable: true },
            "103": { category: 9, sale_price: 100, sellable: false },
        },
    })
    assertDeepFrozen(output)
})

test("item and equipment converter rejects malformed authoritative rows", async () => {
    assert.equal(typeof convertItemEquipmentTables, "function", "应导出 convertItemEquipmentTables")
    const source = fixture({
        [SOURCES.item]: [row("100", itemFields({ 21: "maybe" }))],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item\[100\]\.sellable must be a boolean/i,
    )
})

test("item and equipment converter requires matching craft and dissolve rarity keys", async () => {
    assert.equal(typeof convertItemEquipmentTables, "function", "应导出 convertItemEquipmentTables")
    const source = fixture({
        [SOURCES.dissolveRate]: [
            row("1", ["0"]),
            row("2", ["0"]),
            row("3", ["1"]),
            row("4", ["5"]),
        ],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /equipment craft rarity keys do not match dissolve rates/i,
    )
})

test("cultivate pack conversion requires the referenced bonus row", async () => {
    const source = fixture({
        [SOURCES.itemBonusSelect]: [],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item\[103\]\.selectBonusId references missing item_bonus_select: 900/i,
    )
})

test("cultivate pack conversion rejects a missing Item candidate", async () => {
    const source = fixture({
        [SOURCES.itemBonusSelect]: [row("900", itemBonusSelectFields({ 6: "" }))],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item_bonus_select\[900\] candidate 2 itemId must be present/i,
    )
})

test("cultivate pack conversion rejects duplicate Item candidates", async () => {
    const source = fixture({
        [SOURCES.itemBonusSelect]: [row("900", itemBonusSelectFields({ 6: "2" }))],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item_bonus_select\[900\] has duplicate Item candidate: 2/i,
    )
})

test("cultivate pack conversion rejects non-Item candidates", async () => {
    const source = fixture({
        [SOURCES.itemBonusSelect]: [row("900", itemBonusSelectFields({ 4: "2" }))],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item_bonus_select\[900\] candidate 2 kind must be Item \(1\): 2/i,
    )
})

for (const { name, overrides, expected } of [
    {
        name: "zero candidate amount",
        overrides: { 2: "0" },
        expected: /item_bonus_select\[900\] candidate 1 amount must be a positive integer: 0/i,
    },
    {
        name: "non-numeric candidate itemId",
        overrides: { 3: "invalid" },
        expected: /item_bonus_select\[900\] candidate 1 itemId must be a positive integer: invalid/i,
    },
    {
        name: "zero candidate itemId",
        overrides: { 3: "0" },
        expected: /item_bonus_select\[900\] candidate 1 itemId must be a positive integer: 0/i,
    },
    {
        name: "unsafe candidate itemId",
        overrides: { 3: "9007199254740992" },
        expected: /item_bonus_select\[900\] candidate 1 itemId must be a safe integer: 9007199254740992/i,
    },
]) {
    test(`cultivate pack conversion rejects ${name}`, async () => {
        const source = fixture({
            [SOURCES.itemBonusSelect]: [row("900", itemBonusSelectFields(overrides))],
        })
        await assert.rejects(convertItemEquipmentTables(source.reader), expected)
    })
}

test("cultivate pack conversion rejects bonus rows with the wrong column count", async () => {
    const source = fixture({
        [SOURCES.itemBonusSelect]: [row("900", itemBonusSelectFields().slice(0, -1))],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item_bonus_select\[900\] must have 20 columns, got 19/i,
    )
})

test("cultivate pack conversion validates unreferenced bonus rows", async () => {
    const source = fixture({
        [SOURCES.itemBonusSelect]: [
            row("900", itemBonusSelectFields()),
            row("901", itemBonusSelectFields({ 2: "0" })),
        ],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item_bonus_select\[901\] candidate 1 amount must be a positive integer: 0/i,
    )
})
