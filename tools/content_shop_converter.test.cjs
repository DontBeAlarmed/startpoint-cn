"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

let convertShops
try {
    ({ convertShops } = require("../src/content/converters/shop"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const PATHS = Object.freeze({
    general: "master/shop/general_shop.orderedmap",
    event: "master/shop/event_item_shop.orderedmap",
    eventCampaign: "master/quest/event/event_shop_select_item_campaign.orderedmap",
    eventLineup: "master/quest/event/event_shop_select_item_campaign_lineup.orderedmap",
    boss: "master/shop/boss_coin_shop.orderedmap",
    bossCategory: "master/shop/boss_coin_shop_category.orderedmap",
    bossCampaign: "master/shop/boss_coin_shop_select_item_campaign.orderedmap",
    bossLineup: "master/shop/boss_coin_shop_select_item_campaign_lineup.orderedmap",
    starGrain: "master/shop/star_grain_shop.orderedmap",
    treasure: "master/shop/treasure_shop.orderedmap",
    equipment: "master/equipment_enhancement/equipment_enhancement_shop.orderedmap",
    equipmentCategory:
        "master/equipment_enhancement/equipment_enhancement_shop_category.orderedmap",
    specialPack: "master/shop/special_pack_shop.orderedmap",
})

function encodeCsv(fields) {
    return fields.map(field => (
        /[",\r\n]/.test(field)
            ? `"${field.replaceAll('"', '""')}"`
            : field
    )).join(",")
}

function row(key, fields) {
    return { key, text: encodeCsv(fields) }
}

function fields(length, values) {
    const result = Array(length).fill("")
    for (const [index, value] of Object.entries(values)) result[Number(index)] = String(value)
    return result
}

function createFixture() {
    const requested = []
    const sources = new Map([
        [PATHS.general, [row("20", fields(47, {
            9: 2,
            10: 7,
            12: 900,
            13: 3,
            14: 901,
            15: 4,
            20: "2024-01-01 00:00:00",
            21: "(None)",
            23: 9,
            24: 2,
            25: 1,
            26: "1,4,7,10",
            27: 5,
            29: 0,
            30: 100,
            31: 2,
            32: 1,
            33: "",
            34: 50,
        }))]],
        [PATHS.event, [row("30", fields(51, {
            0: 6,
            1: 700001,
            2: 11,
            4: 10,
            5: 1010,
            18: 70010,
            19: 5,
            26: "2024-02-01 12:00:00",
            27: "2024-02-29 11:59:59",
            29: 10,
            30: 3,
            31: 2,
            32: 2,
            33: "",
            34: 1000,
            50: false,
        }))]],
        [PATHS.eventCampaign, [row("10", fields(13, {
            0: "challenge_dungeon_campaign_01",
            1: 4,
            2: 1,
            6: "2022-12-22 12:00:00",
            7: "2022-12-29 11:59:59",
            8: "2023-01-06 11:59:59",
        }))]],
        [PATHS.eventLineup, [row("1010", fields(3, {
            0: 10,
            1: 1,
            2: 5020025,
        }))]],
        [PATHS.boss, [row("40", fields(50, {
            0: 5,
            3: 20,
            4: 2010,
            17: 40000,
            18: 10,
            25: "2024-03-01 12:00:00",
            26: "(None)",
            28: 4,
            29: 7,
            30: 1,
            31: 2,
            32: 4,
            33: 5010001,
            34: 1,
        }))]],
        [PATHS.bossCategory, [
            row("8", fields(13, { 0: "empty", 1: 8, 12: false })),
            row("5", fields(13, { 0: "fixture", 1: 5, 12: false })),
        ]],
        [PATHS.bossCampaign, [row("20", fields(13, {
            0: "boss_campaign_01",
            1: 999,
            2: 5,
            6: "2024-03-01 12:00:00",
            7: "2024-03-08 11:59:59",
            8: "2024-03-15 11:59:59",
        }))]],
        [PATHS.bossLineup, [row("2010", fields(6, {
            0: 20,
            1: "(None)",
            2: 1,
            3: 5010001,
            4: "Boss 装备",
            5: "装备",
        }))]],
        [PATHS.starGrain, [row("50", fields(43, {
            10: 990008,
            11: 30,
            18: "2024-04-01 12:00:00",
            19: "(None)",
            21: 3,
            22: 1,
            23: 2,
            24: 4,
            25: 0,
            26: 10001,
            27: 1,
            28: 0,
            29: 1,
            30: 175,
        }))]],
        [PATHS.treasure, [row("60", fields(44, {
            7: 1,
            8: 300,
            18: "2024-05-01 12:00:00",
            19: "(None)",
            21: 99,
            22: 10,
            23: 6,
            24: 0,
            25: 1,
            26: 2,
            42: 10,
            43: 0.5,
        }))]],
        [PATHS.equipment, [row("70", fields(50, {
            0: 3,
            2: 21,
            3: 2,
            4: 1,
            14: 40401,
            15: 10,
            16: 40407,
            17: 1,
            22: "2024-06-01 12:00:00",
            23: "(None)",
            25: "",
            29: 5020042,
            30: 70,
            31: 5,
        }))]],
        [PATHS.equipmentCategory, [row("3", fields(10, {
            0: "steam_robot_weapon",
            1: 3,
            3: "机兵装备强化",
            8: "2024-06-01 12:00:00",
            9: "(None)",
        }))]],
        [PATHS.specialPack, [row("220040", fields(46, {
            9: 0,
            10: 50,
            20: "2024-06-01 05:00:00",
            21: "(None)",
            23: 99,
            24: "(None)",
            25: "(None)",
            26: "(None)",
            27: 6,
            29: 100,
        }))]],
    ])
    return {
        requested,
        sources,
        reader: {
            async read(logicalPath) {
                requested.push(logicalPath)
                if (!sources.has(logicalPath)) throw new Error(`missing fixture ${logicalPath}`)
                return sources.get(logicalPath)
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

test("shop converter reads all verified sources and emits runtime-compatible tables", async () => {
    assert.equal(typeof convertShops, "function", "商店转换器应导出 convertShops")
    const fixture = createFixture()
    const output = await convertShops(fixture.reader)

    assert.deepEqual(fixture.requested, Object.values(PATHS))
    assert.deepEqual(output["general_shop.json"], {
        "20": {
            costs: [{ id: 900, amount: 3 }, { id: 901, amount: 4 }],
            rewards: [{ type: 0, id: 100, count: 2 }, { type: 1, count: 50 }],
            availableFrom: "2024-01-01 00:00:00",
            availableUntil: null,
            stock: 9,
            userCost: { type: 2, amount: 7 },
            maxFrequency: 2,
            dailyStock: 1,
            specifiedMonths: [1, 4, 7, 10],
            monthlyStock: 5,
        },
    })
    assert.deepEqual(output["event_item_shop.json"], {
        "11": {
            "700001": {
                "30": {
                    costs: [{ id: 70010, amount: 5 }],
                    rewards: [{ type: 2, count: 1000 }],
                    availableFrom: "2024-02-01 12:00:00",
                    availableUntil: "2024-02-29 11:59:59",
                    stock: 10,
                    maxFrequency: 3,
                    dailyStock: 2,
                    campaignId: 10,
                    lineupId: 1010,
                },
            },
        },
    })
    assert.deepEqual(output["event_item_shop_id_map.json"], {
        "30": { eventType: 11, eventId: 700001 },
    })
    assert.deepEqual(output["boss_coin_shop.json"], {
        "5": {
            "40": {
                costs: [{ id: 40000, amount: 10 }],
                rewards: [{ type: 4, id: 5010001, count: 1 }],
                availableFrom: "2024-03-01 12:00:00",
                availableUntil: null,
                stock: 4,
                maxFrequency: 7,
                dailyStock: 1,
                monthlyStock: 2,
                campaignId: 20,
                lineupId: 2010,
            },
        },
        "8": {},
    })
    assert.deepEqual(output["boss_coin_shop_item_category_map.json"], { "40": 5 })
    assert.deepEqual(output["shop_select_item_campaign.json"], {
        "4": {
            "10": {
                availableFrom: "2022-12-22 12:00:00",
                availableUntil: "2023-01-06 11:59:59",
                lineupIds: [1010],
            },
        },
        "7": {
            "20": {
                availableFrom: "2024-03-01 12:00:00",
                availableUntil: "2024-03-15 11:59:59",
                lineupIds: [2010],
            },
        },
    })
    assert.deepEqual(output["shop_item_campaign.json"], {
        "4": { "30": { campaignId: 10, lineupId: 1010 } },
        "7": { "40": { campaignId: 20, lineupId: 2010 } },
    })
    assert.deepEqual(output["star_grain_shop.json"]["50"].rewards, [
        { type: 0, id: 10001, count: 1 },
        { type: 0, id: 1, count: 175 },
    ])
    assert.deepEqual(output["treasure_shop.json"], {
        "60": {
            costs: [],
            rewards: [{ type: 0, id: 1, count: 2 }],
            availableFrom: "2024-05-01 12:00:00",
            availableUntil: null,
            stock: 99,
            userCost: { type: 1, amount: 300 },
            maxFrequency: 10,
            dailyStock: 6,
        },
    })
    assert.deepEqual(output["equipment_enhancement_shop.json"], {
        "70": {
            costs: [{ id: 40401, amount: 10 }, { id: 40407, amount: 1 }],
            rewards: [],
            availableFrom: "2024-06-01 12:00:00",
            availableUntil: null,
            stock: -1,
            shopCategoryId: 3,
            groupId: 21,
            stage: 2,
            equipmentId: 5020042,
            enhancementMaxLevel: 70,
            requireAwakeningLevel: 5,
        },
    })
    assert.deepEqual(output["special_pack_shop.json"], {
        "220040": {
            costs: [],
            rewards: [],
            availableFrom: "2024-06-01 05:00:00",
            availableUntil: null,
            stock: 99,
            userCost: { type: 3, amount: 50 },
            passCardPoints: 100,
        },
    })
    assert.equal(output["event_item_shop.json"]["11"]["700011"], undefined)
    assertDeepFrozen(output)
})

test("shop converter preserves empty official shops without synthesizing rows", async () => {
    const fixture = createFixture()
    for (const source of fixture.sources.keys()) fixture.sources.set(source, [])

    const output = await convertShops(fixture.reader)

    assert.deepEqual(output, {
        "general_shop.json": {},
        "event_item_shop.json": {},
        "event_item_shop_id_map.json": {},
        "boss_coin_shop.json": {},
        "boss_coin_shop_item_category_map.json": {},
        "shop_select_item_campaign.json": { "4": {}, "7": {} },
        "shop_item_campaign.json": { "4": {}, "7": {} },
        "star_grain_shop.json": {},
        "treasure_shop.json": {},
        "equipment_enhancement_shop.json": {},
        "special_pack_shop.json": {},
    })
})

test("shop converter validates CN calendar values without local timezone normalization", async t => {
    const generalRowWithDate = value => row("20", fields(47, {
        20: value,
        21: "(None)",
        23: 1,
    }))

    for (const value of ["2025-02-31 12:00:00", "2025-01-01 24:00:00"]) {
        await t.test(`rejects ${value}`, async () => {
            const fixture = createFixture()
            fixture.sources.set(PATHS.general, [generalRowWithDate(value)])
            await assert.rejects(
                convertShops(fixture.reader),
                /general_shop.*availableFrom.*CN date-time/i,
            )
        })
    }

    const leapDay = createFixture()
    leapDay.sources.set(PATHS.general, [generalRowWithDate("2024-02-29 23:59:59")])
    const output = await convertShops(leapDay.reader)
    assert.equal(output["general_shop.json"]["20"].availableFrom, "2024-02-29 23:59:59")
})

test("shop converter rejects duplicate keys, malformed shapes, and unknown categories", async t => {
    assert.equal(typeof convertShops, "function", "商店转换器应导出 convertShops")
    await t.test("duplicate product", async () => {
        const fixture = createFixture()
        fixture.sources.set(PATHS.general, [
            ...fixture.sources.get(PATHS.general),
            ...fixture.sources.get(PATHS.general),
        ])
        await assert.rejects(convertShops(fixture.reader), /general_shop.*duplicate key.*20/i)
    })
    await t.test("fixed column count", async () => {
        const fixture = createFixture()
        fixture.sources.set(PATHS.treasure, [row("60", Array(43).fill(""))])
        await assert.rejects(convertShops(fixture.reader), /treasure_shop.*44 columns/i)
    })
    await t.test("ordinary shop stock remains required", async () => {
        const fixture = createFixture()
        const generalFields = fields(47, {
            20: "2024-01-01 00:00:00",
            21: "(None)",
            23: "",
        })
        fixture.sources.set(PATHS.general, [row("20", generalFields)])
        await assert.rejects(convertShops(fixture.reader), /general_shop.*stock.*integer/i)
    })
    await t.test("boss category is official", async () => {
        const fixture = createFixture()
        fixture.sources.set(PATHS.bossCategory, [row("8", fields(13, {}))])
        await assert.rejects(convertShops(fixture.reader), /boss_coin_shop.*category.*5/i)
    })
    await t.test("equipment category is official", async () => {
        const fixture = createFixture()
        fixture.sources.set(PATHS.equipmentCategory, [])
        await assert.rejects(convertShops(fixture.reader), /equipment_enhancement_shop.*category.*3/i)
    })
})

test("bundled 1.4.54 fallback preserves authoritative total and periodic limits", () => {
    const general = require("../assets/general_shop.json")
    const event = require("../assets/event_item_shop.json")
    const boss = require("../assets/boss_coin_shop.json")
    const starGrain = require("../assets/star_grain_shop.json")
    const treasure = require("../assets/treasure_shop.json")
    const itemCampaigns = require("../assets/shop_item_campaign.json")
    const selectCampaigns = require("../assets/shop_select_item_campaign.json")

    assert.equal(general[100001].maxFrequency, 1)
    assert.equal(event[2][100006][310194].maxFrequency, 10)
    assert.equal(boss[1][200101].monthlyStock, 1)
    assert.equal(starGrain[100000].maxFrequency, 7)
    assert.equal(treasure[200001].dailyStock, 10)
    assert.equal(Object.keys(itemCampaigns[4]).length, 246)
    assert.equal(Object.values(itemCampaigns[4]).filter(item => item.lineupId === undefined).length, 111)
    assert.equal(Object.values(itemCampaigns[4]).filter(item => item.lineupId !== undefined).length, 135)
    assert.deepEqual(itemCampaigns[7], {})
    assert.equal(Object.keys(selectCampaigns[4]).length, 6)
    assert.equal(Object.values(selectCampaigns[4]).flatMap(campaign => campaign.lineupIds).length, 27)
    assert.deepEqual(selectCampaigns[7], {})
})

test("quick:content includes the shop converter regression suite", () => {
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.ok(TEST_GROUPS["quick:content"].tests.includes(
        "tools/content_shop_converter.test.cjs",
    ))
})
