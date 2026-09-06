"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")

const {
    BoxGachaContentError,
    buildBoxGachaContentCatalog,
    findAvailableBoxGachaIdsForReward,
    getBoxGachaContent,
    getBoxGachaContentCatalog,
} = require("../src/lib/box-gacha-content")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

function tables(overrides = {}) {
    return {
        "box_gacha.json": {
            10: { itemId: 70001, count: 2, availableCounts: { 1: 3, 2: 1 } },
        },
        "box_reward.json": {
            10: {
                1: {
                    100: { type: 0, id: 90001, count: 1, available: 2, tier: 0 },
                    101: { type: 3, count: 100, available: 1, tier: 1 },
                },
                2: {
                    102: { type: 0, id: 90001, count: 5, available: 1, tier: 2 },
                },
            },
        },
        "box_gacha_box_settings.json": {
            10: {
                1: {
                    requiredBoxId: null,
                    resetKind: 0,
                    resetLimit: null,
                    availableFrom: "2024-01-01 00:00:00",
                    availableUntil: "2024-01-31 23:59:59",
                    closeKind: 0,
                },
                2: {
                    requiredBoxId: 1,
                    resetKind: 2,
                    resetLimit: null,
                    availableFrom: "2024-02-01 00:00:00",
                    availableUntil: null,
                    closeKind: 1,
                },
            },
        },
        ...overrides,
    }
}

function repository(source = tables()) {
    return createFrozenTestContentRepository({ tables: source })
}

test("Box Gacha catalog validates relations, caches by repository and indexes reward sources", () => {
    const source = repository()
    const catalog = getBoxGachaContentCatalog(source)
    assert.strictEqual(getBoxGachaContentCatalog(source), catalog)
    assert.notStrictEqual(getBoxGachaContentCatalog(repository()), catalog)
    assert.equal(getBoxGachaContent(catalog, 10).redeemItemId, 70001)
    assert.equal(Object.isFrozen(catalog), true)

    const january = Date.parse("2024-01-15T00:00:00+08:00")
    const february = Date.parse("2024-02-15T00:00:00+08:00")
    assert.deepEqual(findAvailableBoxGachaIdsForReward(catalog, 0, 90001, january), [10])
    assert.deepEqual(findAvailableBoxGachaIdsForReward(catalog, 0, 90001, february), [10])
    assert.deepEqual(findAvailableBoxGachaIdsForReward(catalog, 1, 90001, february), [])
})

test("Box Gacha catalog rejects mismatched counts and missing prerequisite boxes", () => {
    const countMismatch = tables()
    countMismatch["box_gacha.json"][10].availableCounts[1] = 4
    assert.throws(
        () => buildBoxGachaContentCatalog(repository(countMismatch)),
        BoxGachaContentError,
    )

    const missingRequired = tables()
    missingRequired["box_gacha_box_settings.json"][10][2].requiredBoxId = 99
    assert.throws(
        () => buildBoxGachaContentCatalog(repository(missingRequired)),
        /required box does not exist/,
    )
})

test("Box Gacha catalog rejects non-canonical and malformed inner rows", () => {
    const scenarios = [
        source => {
            source["box_reward.json"][10][1]["01"] = source["box_reward.json"][10][1][100]
            delete source["box_reward.json"][10][1][100]
        },
        source => { source["box_gacha_box_settings.json"][10][1].resetKind = 1 },
        source => { source["box_gacha_box_settings.json"][10][1] = null },
        source => { source["box_reward.json"][10][1][100] = null },
    ]
    for (const mutate of scenarios) {
        const source = tables()
        mutate(source)
        assert.throws(
            () => buildBoxGachaContentCatalog(repository(source)),
            BoxGachaContentError,
        )
    }
})

test("bundled Box Gacha tables form one complete 48-entry Catalog", () => {
    const assetsRoot = path.resolve(__dirname, "../assets")
    const bundled = repository({
        "box_gacha.json": require(path.join(assetsRoot, "box_gacha.json")),
        "box_reward.json": require(path.join(assetsRoot, "box_reward.json")),
        "box_gacha_box_settings.json": require(path.join(
            assetsRoot,
            "box_gacha_box_settings.json",
        )),
    })
    const catalog = buildBoxGachaContentCatalog(bundled)
    assert.equal(Object.keys(catalog.entries).length, 48)
    assert.equal(Object.keys(catalog.rewardSourcesByKey).length > 0, true)
})
