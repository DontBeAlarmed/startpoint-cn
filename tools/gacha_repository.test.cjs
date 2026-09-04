"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { ContentRepository } = require("../src/content/runtime/content-repository")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const {
    getCharacterDataSync,
    getGachaCampaignIdSync,
    getGachaSync,
} = require("../src/lib/assets")

const projectRoot = path.resolve(__dirname, "..")

test("character and gacha API asset facades read one initialized ContentRepository", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const character = Object.freeze({ name: "", rarity: 5, element: 1, skill_count: 6 })
    const gacha = Object.freeze({
        kind: "character",
        name: "fixture",
        page: Object.freeze({ kind: 0, singleCost: 150, multiCost: 1500, dailyPaidCost: 50 }),
        wildcardTicketAvailable: false,
        rarityOddsId: "fixture_rarity",
        guaranteeRarity: 4,
        guaranteeNumber: 1,
        rankRates: Object.freeze({ normal: [50, 250, 700], multiGuarantee: [50, 950] }),
        startDate: "2026-01-01 00:00:00",
        endDate: "2026-01-10 00:00:00",
        showPeriod: true,
        isComeback: false,
        isStarsGacha: false,
        freemiumGuaranteeAvailable: false,
        poolOddsIds: Object.freeze({ "1": "fixture_5", "2": "fixture_4", "3": "fixture_3" }),
        movieName: "normal",
        guaranteeMovieName: "normal_guarantee",
        toUseOddsUpAsTrialReading: false,
        canBeStartDashExchange: false,
    })
    const pools = Object.freeze({
        fixture_5: Object.freeze([]),
        fixture_4: Object.freeze([]),
        fixture_3: Object.freeze([]),
    })
    const requestedTables = []
    const tables = Object.freeze({
        "character.json": Object.freeze({ "990001": character }),
        "gacha.json": Object.freeze({ "990002": gacha }),
        "gacha_pool.json": pools,
        "gacha_campaign.json": Object.freeze({ "990002": 77 }),
    })
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: Object.freeze({ targetVersion: "test-release" }),
        repository: Object.freeze({
            info: () => Object.freeze({
                source: "release",
                assetVersion: "test-release",
                generatorVersion: 1,
                releaseDigest: null,
            }),
            table: tableName => {
                requestedTables.push(tableName)
                if (!(tableName in tables)) throw new Error(`unexpected table ${tableName}`)
                return tables[tableName]
            },
        }),
    })

    try {
        assert.strictEqual(getCharacterDataSync(990001), character)
        const projectedGacha = getGachaSync(990002)
        assert.equal(projectedGacha.type, 0)
        assert.equal(projectedGacha.singleCost, 150)
        assert.strictEqual(projectedGacha.pool["1"], pools.fixture_5)
        assert.equal(getGachaCampaignIdSync(990002), 77)
        assert.deepEqual(requestedTables, [
            "character.json",
            "gacha.json",
            "gacha_pool.json",
            "gacha_campaign.json",
        ])
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("bundled ContentRepository keeps tracked gacha fallback behavior", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gacha-repository-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const trackedGachas = require("../assets/gacha.json")
    const trackedCampaigns = require("../assets/gacha_campaign.json")
    const placeholder = Object.freeze({ placeholder: true })
    const repository = await ContentRepository.load({
        projectRoot,
        env: {
            CDN_DIR: path.join(root, "cdn"),
            CONTENT_DIR: path.join(root, "content"),
            CONTENT_RUNTIME_DIR: path.join(root, "runtime"),
        },
    }, {
        importBundledTable: async (_root, tableName) => {
            if (tableName === "gacha.json") return trackedGachas
            if (tableName === "gacha_campaign.json") return trackedCampaigns
            return placeholder
        },
    })

    assert.equal(repository.info().source, "bundled")
    assert.equal(Object.keys(trackedGachas).length, 584)
    assert.equal(Object.keys(trackedCampaigns).length, 145)
    assert.deepEqual(repository.table("gacha.json"), trackedGachas)
    assert.deepEqual(repository.table("gacha_campaign.json"), trackedCampaigns)
})

test("character grant owner and gacha API route share the Repository-backed assets facade", () => {
    const characterRoute = fs.readFileSync(path.join(projectRoot, "src/routes/api/character.ts"), "utf8")
    const characterOwner = fs.readFileSync(path.join(projectRoot, "src/lib/character.ts"), "utf8")
    const gachaRoute = fs.readFileSync(path.join(projectRoot, "src/routes/api/gacha.ts"), "utf8")

    assert.match(characterRoute, /givePlayerCharacterSync.*from "\.\.\/\.\.\/lib\/character"/)
    assert.match(characterOwner, /getCharacterDataSync.*from "\.\/assets"/)
    assert.match(gachaRoute, /getGachaCampaignIdSync, getGachaSync.*from "\.\.\/\.\.\/lib\/assets"/)
    assert.doesNotMatch(characterRoute, /assets\/character\.json/)
    assert.doesNotMatch(characterOwner, /assets\/character\.json/)
    assert.doesNotMatch(gachaRoute, /assets\/gacha(?:_campaign)?\.json/)
})
