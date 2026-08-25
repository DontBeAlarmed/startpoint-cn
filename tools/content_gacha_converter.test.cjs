"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

let convertGachas
try {
    ({ convertGachas } = require("../src/content/converters/gacha"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const GACHA_PATH = "master/gacha/gacha.orderedmap"
const CAMPAIGN_PATH = "master/gacha/gacha_campaign.orderedmap"
const FEATURE_PATH = "master/gacha/gacha_feature_content.orderedmap"

function encodeCsv(fields) {
    return fields.map(field => (
        /[",\r\n]/.test(field)
            ? `"${field.replaceAll('"', '""')}"`
            : field
    )).join(",")
}

function gachaRow({
    stringId,
    name,
    prizeKind,
    rarityOdds = "fixture_rarity",
    rank3 = "",
    rank4 = "",
    rank5 = "",
    guaranteeRarity = "4",
    crazyTenTicketItemId = "",
} = {}) {
    const fields = Array(47).fill("")
    fields[0] = stringId
    fields[1] = name
    fields[4] = "0"
    fields[5] = prizeKind === "1" ? "75" : "150"
    fields[6] = prizeKind === "1" ? "750" : "1500"
    fields[7] = prizeKind === "1" ? "25" : "50"
    fields[10] = guaranteeRarity
    fields[11] = rarityOdds
    fields[13] = prizeKind
    if (prizeKind === "0") {
        fields[14] = rank3
        fields[15] = rank4
        fields[16] = rank5
        fields[17] = "normal"
        fields[18] = "normal_guarantee"
        fields[19] = "true"
        fields[20] = "false"
        fields[21] = "true"
    } else {
        fields[22] = rank3
        fields[23] = rank4
        fields[24] = rank5
        fields[25] = "movie_fixture"
        fields[26] = "true"
    }
    fields[27] = "20001"
    fields[28] = "20002"
    fields[29] = "2026-01-01 00:00:00"
    fields[30] = "2026-01-10 00:00:00"
    fields[45] = crazyTenTicketItemId
    return fields
}

function row(key, fields) {
    return { key, text: encodeCsv(fields) }
}

function createFixture(overrides = {}) {
    const character = gachaRow({
        stringId: "character_fixture",
        name: '角色,"精选"',
        prizeKind: "0",
        rank3: "character_3",
        rank4: "(None)",
        rank5: "character_5",
    })
    const equipment = gachaRow({
        stringId: "equipment_fixture",
        name: "装备精选",
        prizeKind: "1",
        rank3: " ",
        rank4: "equipment_4",
        rank5: "equipment_5",
        guaranteeRarity: "5",
    })
    const flat = new Map([
        [GACHA_PATH, [row("20", equipment), row("10", character)]],
        [CAMPAIGN_PATH, [row("7", [
            "campaign_fixture",
            '免费,"活动"',
            "2",
            "2026-01-01 00:00:00",
            "2026-01-10 00:00:00",
            "10,20",
            "(None)",
            "",
        ])]],
    ])
    const nested = new Map([
        [FEATURE_PATH, [
            { key: "20", rows: [row("1", ["1", '装备,"横幅"', "", "", "", "", "(None)", "", ""])] },
            { key: "10", rows: [row("2", ["2", "", "", "1", "preview", "1005", "0", "1005", ""])] },
        ]],
        ["master/gacha_odds/fixture_rarity.orderedmap", [{
            key: "fixture_rarity",
            rows: [row("3", ["3", "70"]), row("1", ["5", "5"]), row("2", ["4", "25"])],
        }]],
        ["master/gacha_odds/character_3.orderedmap", [{
            key: "character_3",
            rows: [row("1", ["1003", "3", "70", "false", "false", "false", "false"])],
        }]],
        ["master/gacha_odds/character_5.orderedmap", [{
            key: "character_5",
            rows: [
                row("1", ["1005", "5", "3", "true", "true", "true", "true"]),
                row("2", ["1006", "5", "2", "false", "false", "false", "false"]),
            ],
        }]],
        ["master/gacha_odds/equipment_4.orderedmap", [{
            key: "equipment_4",
            rows: [row("1", ["5004", "4", "25", "true", "false", "true"])],
        }]],
        ["master/gacha_odds/equipment_5.orderedmap", [{
            key: "equipment_5",
            rows: [row("1", ["5005", "5", "5", "false", "true", "false"])],
        }]],
    ])
    for (const [path, value] of Object.entries(overrides.flat ?? {})) flat.set(path, value)
    for (const [path, value] of Object.entries(overrides.nested ?? {})) nested.set(path, value)

    const reads = []
    const reader = {
        async read(logicalPath) {
            reads.push(["flat", logicalPath])
            if (!flat.has(logicalPath)) throw new Error(`fixture flat source missing: ${logicalPath}`)
            return flat.get(logicalPath)
        },
        async readNested(logicalPath) {
            reads.push(["nested", logicalPath])
            if (!nested.has(logicalPath)) throw new Error(`fixture nested source missing: ${logicalPath}`)
            return nested.get(logicalPath)
        },
    }
    return { character, equipment, flat, nested, reader, reads }
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("gacha converter builds character/equipment runtime pools and raw compatibility tables", async () => {
    assert.equal(typeof convertGachas, "function", "gacha converter should export convertGachas")
    const fixture = createFixture()
    const output = await convertGachas(fixture.reader)

    assert.deepEqual(Object.keys(output["gacha.json"]), ["10", "20"])
    assert.deepEqual(output["cdndata/gacha.json"], {
        "10": [fixture.character],
        "20": [fixture.equipment],
    })

    const character = output["gacha.json"]["10"]
    assert.equal(character.type, 0)
    assert.equal(character.name, '角色,"精选"')
    assert.deepEqual(character.rankRates, {
        normal: [50, 250, 700],
        multiGuarantee: [50, 950],
    })
    assert.deepEqual(Object.fromEntries(
        Object.entries(character.pool).map(([rank, items]) => [rank, items.length]),
    ), { "1": 2, "3": 1 })
    assert.deepEqual(character.pool["1"], [
        {
            id: 1005,
            rank: 5,
            odds: 3,
            isRateUp: true,
            isLimited: true,
            isExchangeable: true,
            trialReadingForced: true,
            rarity: 600,
        },
        {
            id: 1006,
            rank: 5,
            odds: 2,
            isRateUp: false,
            isLimited: false,
            isExchangeable: false,
            trialReadingForced: false,
            rarity: 400,
        },
    ])
    assert.deepEqual(character.pool["3"].map(item => [item.id, item.odds]), [[1003, 70]])

    const equipment = output["gacha.json"]["20"]
    assert.equal(equipment.type, 1)
    assert.equal(equipment.equipmentMovieProbabilityId, "movie_fixture")
    assert.deepEqual(equipment.rankRates, {
        normal: [50, 250, 700],
        multiGuarantee: [1000, 0],
    })
    assert.deepEqual(equipment.pool["1"].map(item => [item.id, item.odds, item.isLimited]), [
        [5005, 5, true],
    ])
    assert.deepEqual(equipment.pool["2"].map(item => [item.id, item.odds, item.isRateUp]), [
        [5004, 25, true],
    ])

    assert.deepEqual(output["gacha_campaign.json"], { "10": 7, "20": 7 })
    assert.deepEqual(output["cdndata/gacha_feature_content.json"], {
        "10": { "2": [["2", "", "", "1", "preview", "1005", "0", "1005", ""]] },
        "20": { "1": [["1", '装备,"横幅"', "", "", "", "", "(None)", "", ""]] },
    })
    assertDeepFrozen(output)

    const readPaths = fixture.reads.map(([, logicalPath]) => logicalPath)
    assert.equal(readPaths.some(path => path.endsWith("/.orderedmap")), false)
    assert.equal(readPaths.some(path => path.includes("(None)")), false)
})

test("gacha converter preserves the official crazy ten-ticket field", async () => {
    const fixture = createFixture()
    fixture.flat.set(GACHA_PATH, [
        row("10", gachaRow({
            stringId: "crazy_fixture",
            name: "疯狂十连",
            prizeKind: "0",
            rank3: "character_3",
            rank5: "character_5",
            crazyTenTicketItemId: "999012",
        })),
    ])

    const output = await convertGachas(fixture.reader)
    assert.equal(output["gacha.json"]["10"].crazyTenTicketItemId, 999012)
})

test("gacha converter fails clearly when a referenced non-empty odds source is missing", async () => {
    assert.equal(typeof convertGachas, "function", "gacha converter should export convertGachas")
    const fixture = createFixture()
    fixture.nested.delete("master/gacha_odds/character_5.orderedmap")
    const privateError = new Error("cannot read /opt/cdn/private/secret.zip")
    const readNested = fixture.reader.readNested.bind(fixture.reader)
    fixture.reader.readNested = async logicalPath => {
        if (logicalPath === "master/gacha_odds/character_5.orderedmap") {
            throw privateError
        }
        return readNested(logicalPath)
    }

    await assert.rejects(
        convertGachas(fixture.reader),
        error => {
            assert.match(
                error.message,
                /referenced character odds.*character_5.*master\/gacha_odds\/character_5\.orderedmap.*missing.*unreadable/i,
            )
            assert.doesNotMatch(error.message, /opt\/cdn\/private\/secret\.zip/)
            assert.strictEqual(error.cause, privateError)
            return true
        },
    )
})

test("gacha converter does not impose campaign ID reuse policy", async () => {
    assert.equal(typeof convertGachas, "function", "gacha converter should export convertGachas")
    const fixture = createFixture()
    const campaign = campaignId => row(campaignId, [
        `campaign_${campaignId}`,
        "fixture",
        "1",
        "2026-01-01 00:00:00",
        "2026-01-10 00:00:00",
        "10",
        "(None)",
        "",
    ])
    fixture.flat.set(CAMPAIGN_PATH, [campaign("8"), campaign("7")])

    const output = await convertGachas(fixture.reader)
    assert.equal(output["gacha_campaign.json"]["10"], 8)
})

test("gacha converter strictly validates odds integers, booleans, columns, and outer keys", async t => {
    assert.equal(typeof convertGachas, "function", "gacha converter should export convertGachas")
    const cases = [
        ["integer", ["1005x", "5", "3", "true", "true", "true", "true"], /characterId.*integer/i],
        ["boolean", ["1005", "5", "3", "yes", "true", "true", "true"], /oddsUp.*boolean/i],
        ["column count", ["1005", "5", "3", "true", "true", "true"], /7 columns/i],
    ]
    for (const [name, fields, expected] of cases) {
        await t.test(name, async () => {
            const fixture = createFixture()
            fixture.nested.set("master/gacha_odds/character_5.orderedmap", [{
                key: "character_5",
                rows: [row("1", fields)],
            }])
            await assert.rejects(convertGachas(fixture.reader), expected)
        })
    }

    const fixture = createFixture()
    fixture.nested.set("master/gacha_odds/character_5.orderedmap", [{
        key: "wrong_outer",
        rows: [row("1", ["1005", "5", "3", "true", "true", "true", "true"])],
    }])
    await assert.rejects(convertGachas(fixture.reader), /outer key.*character_5/i)
})

test("gacha converter requires official fixed table shapes", async () => {
    assert.equal(typeof convertGachas, "function", "gacha converter should export convertGachas")
    const shortGacha = createFixture()
    shortGacha.flat.set(GACHA_PATH, [row("10", shortGacha.character.slice(0, 46))])
    await assert.rejects(convertGachas(shortGacha.reader), /47 columns/i)

    const shortCampaign = createFixture()
    shortCampaign.flat.set(CAMPAIGN_PATH, [row("7", Array(7).fill(""))])
    await assert.rejects(convertGachas(shortCampaign.reader), /gacha_campaign.*8 columns/i)

    const shortFeature = createFixture()
    shortFeature.nested.set(FEATURE_PATH, [{ key: "10", rows: [row("1", Array(8).fill(""))] }])
    await assert.rejects(convertGachas(shortFeature.reader), /gacha_feature_content.*9 columns/i)
})

test("quick:content includes the gacha converter regression suite", () => {
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.ok(TEST_GROUPS["quick:content"].tests.includes(
        "tools/content_gacha_converter.test.cjs",
    ))
})
