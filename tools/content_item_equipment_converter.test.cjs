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

const { createGameCalendarPolicy } = require("../src/time/game-calendar")

const SOURCES = Object.freeze({
    equipment: "master/item/equipment.orderedmap",
    craft: "master/item/equipment_craft_point_exchange.orderedmap",
    dissolveRate: "master/item/equipment_dissolve_rate.orderedmap",
    item: "master/item/item.orderedmap",
    itemBonusSelect: "master/item/item_bonus_select.orderedmap",
})

const SELECT_REWARD_ITEM_IDS = Object.freeze([100, 101, 102, 104, 105, 106])

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
        "1", "300", String(SELECT_REWARD_ITEM_IDS[0]),
        "1", "300", String(SELECT_REWARD_ITEM_IDS[1]),
        "1", "300", String(SELECT_REWARD_ITEM_IDS[2]),
        "1", "300", String(SELECT_REWARD_ITEM_IDS[3]),
        "1", "300", String(SELECT_REWARD_ITEM_IDS[4]),
        "1", "300", String(SELECT_REWARD_ITEM_IDS[5]),
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
            11: "5",
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
            row("101", itemFields({
                2: "活动素材",
                6: "9",
                7: "",
                14: "3",
                16: "5",
                20: "2020-07-01 04:59:59",
                21: "false",
            })),
            row("102", itemFields({ 2: "比例体力药", 6: "3", 7: "50" })),
            row("103", itemFields({
                2: "测试资源箱",
                6: "22",
                7: "",
                21: "false",
                22: "900",
            })),
            row("104", itemFields({ 2: "选择素材104", 6: "0", 7: "" })),
            row("105", itemFields({ 2: "选择素材105", 6: "0", 7: "" })),
            row("106", itemFields({ 2: "选择素材106", 6: "0", 7: "" })),
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

test("item and equipment converter derives the ten authoritative runtime tables", async () => {
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
            "5029999": { name: "新增装备", rarity: "5", category: "未分类" },
        },
        "item_data.json": {
            "100": { effectKind: 2, effectValue: 25 },
            "102": { effectKind: 3, effectValue: 50 },
            "103": {
                effectKind: 22,
                effectValue: 0,
                selectRewards: [
                    { itemId: 100, amount: 300 },
                    { itemId: 101, amount: 300 },
                    { itemId: 102, amount: 300 },
                    { itemId: 104, amount: 300 },
                    { itemId: 105, amount: 300 },
                    { itemId: 106, amount: 300 },
                ],
            },
        },
        "item_ids.json": [100, 101, 102, 103, 104, 105, 106],
        "item_inventory_policy.json": {
            byItemId: {
                "100": {
                    effectKind: 2,
                    category: 9,
                    salePrice: 100,
                    maxCount: 9999,
                    sellable: true,
                    startTimeMs: Date.UTC(2015, 11, 31, 15, 59, 59),
                    endTimeMs: null,
                },
                "101": {
                    effectKind: 9,
                    category: 3,
                    salePrice: 5,
                    maxCount: 9999,
                    sellable: false,
                    startTimeMs: Date.UTC(2015, 11, 31, 15, 59, 59),
                    endTimeMs: Date.UTC(2020, 5, 30, 20, 59, 59),
                },
                "102": {
                    effectKind: 3,
                    category: 9,
                    salePrice: 100,
                    maxCount: 9999,
                    sellable: true,
                    startTimeMs: Date.UTC(2015, 11, 31, 15, 59, 59),
                    endTimeMs: null,
                },
                "103": {
                    effectKind: 22,
                    category: 9,
                    salePrice: 100,
                    maxCount: 9999,
                    sellable: false,
                    startTimeMs: Date.UTC(2015, 11, 31, 15, 59, 59),
                    endTimeMs: null,
                },
                "104": {
                    effectKind: 0,
                    category: 9,
                    salePrice: 100,
                    maxCount: 9999,
                    sellable: true,
                    startTimeMs: Date.UTC(2015, 11, 31, 15, 59, 59),
                    endTimeMs: null,
                },
                "105": {
                    effectKind: 0,
                    category: 9,
                    salePrice: 100,
                    maxCount: 9999,
                    sellable: true,
                    startTimeMs: Date.UTC(2015, 11, 31, 15, 59, 59),
                    endTimeMs: null,
                },
                "106": {
                    effectKind: 0,
                    category: 9,
                    salePrice: 100,
                    maxCount: 9999,
                    sellable: true,
                    startTimeMs: Date.UTC(2015, 11, 31, 15, 59, 59),
                    endTimeMs: null,
                },
            },
            eventTradeItemIds: [101],
        },
        "item_lookup.json": {
            "100": "测试道具",
            "101": "活动素材",
            "102": "比例体力药",
            "103": "测试资源箱",
            "104": "选择素材104",
            "105": "选择素材105",
            "106": "选择素材106",
        },
        "item_max_count.json": {
            "100": 9999,
            "101": 9999,
            "102": 9999,
            "103": 9999,
            "104": 9999,
            "105": 9999,
            "106": 9999,
        },
        "item_sale.json": {
            "100": { category: 9, sale_price: 100, sellable: true },
            "101": { category: 3, sale_price: 5, sellable: false },
            "102": { category: 9, sale_price: 100, sellable: true },
            "103": { category: 9, sale_price: 100, sellable: false },
            "104": { category: 9, sale_price: 100, sellable: true },
            "105": { category: 9, sale_price: 100, sellable: true },
            "106": { category: 9, sale_price: 100, sellable: true },
        },
    })
    assertDeepFrozen(output)
})

test("item inventory policy accepts the closed effect kinds 14 and 17", async () => {
    const source = fixture({
        [SOURCES.item]: [
            row("100", itemFields({ 6: "14", 7: "" })),
            row("101", itemFields({ 6: "17", 7: "" })),
        ],
    })
    const output = await convertItemEquipmentTables(source.reader)
    assert.equal(output["item_inventory_policy.json"].byItemId[100].effectKind, 14)
    assert.equal(output["item_inventory_policy.json"].byItemId[101].effectKind, 17)
    assert.deepEqual(output["item_inventory_policy.json"].eventTradeItemIds, [])
})

for (const { name, overrides, expected } of [
    {
        name: "negative effect kind",
        overrides: { 6: "-1" },
        expected: /effectKind must be a non-negative integer/i,
    },
    {
        name: "effect kind above the closed range",
        overrides: { 6: "23" },
        expected: /effectKind must be an integer from 0 through 22/i,
    },
    {
        name: "non-integer effect kind",
        overrides: { 6: "9.5" },
        expected: /effectKind must be a non-negative integer/i,
    },
    {
        name: "invalid UTC+8 date",
        overrides: { 19: "2020-02-30 00:00:00" },
        expected: /startTime must be a valid UTC\+8 second-precision time/i,
    },
    {
        name: "1969 time with a negative epoch",
        overrides: { 19: "1969-12-31 23:59:59" },
        expected: /startTime must convert to a non-negative safe epoch millisecond/i,
    },
    {
        name: "time without second precision",
        overrides: { 19: "2020-01-01 00:00" },
        expected: /startTime must be a valid UTC\+8 second-precision time/i,
    },
    {
        name: "inverted availability window",
        overrides: { 19: "2020-01-02 00:00:00", 20: "2020-01-01 23:59:59" },
        expected: /endTime must not precede startTime/i,
    },
    {
        name: "EventTrade without a positive sale price",
        overrides: { 6: "9", 16: "0" },
        expected: /salePrice must be positive for EventTrade/i,
    },
]) {
    test(`item inventory policy rejects ${name}`, async () => {
        const source = fixture({
            [SOURCES.item]: [row("100", itemFields(overrides))],
        })
        await assert.rejects(convertItemEquipmentTables(source.reader), expected)
    })
}

test("item inventory policy epochs follow the injected game calendar offset", async () => {
    const base = await convertItemEquipmentTables(
        fixture().reader,
        { equipmentLookup: {} },
        { gameCalendar: createGameCalendarPolicy(480) },
    )
    const shifted = await convertItemEquipmentTables(
        fixture().reader,
        { equipmentLookup: {} },
        { gameCalendar: createGameCalendarPolicy(540) },
    )

    const baseStart = base["item_inventory_policy.json"].byItemId["100"].startTimeMs
    const shiftedStart = shifted["item_inventory_policy.json"].byItemId["100"].startTimeMs
    assert.equal(shiftedStart - baseStart, -3_600_000)
})

test("item inventory policy requires all 23 Item columns", async () => {
    const source = fixture({
        [SOURCES.item]: [row("100", itemFields().slice(0, -1))],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item\[100\] must have 23 columns, got 22/i,
    )
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
        [SOURCES.itemBonusSelect]: [row("900", itemBonusSelectFields({ 6: "100" }))],
    })
    await assert.rejects(
        convertItemEquipmentTables(source.reader),
        /item_bonus_select\[900\] has duplicate Item candidate: 100/i,
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
