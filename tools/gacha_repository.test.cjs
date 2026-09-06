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
} = require("../src/lib/assets")
const { getGachaCatalog } = require("../src/lib/gacha-catalog")
const { getLegacyGachas } = require("../src/lib/gacha-legacy-content")

const projectRoot = path.resolve(__dirname, "..")

test("character facade and Gacha typed catalog read one initialized ContentRepository", () => {
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
        fixture_5: Object.freeze([{ id: 990001, rank: 5, odds: 1, isExchangeable: false }]),
        fixture_4: Object.freeze([{ id: 990003, rank: 4, odds: 1, isExchangeable: false }]),
        fixture_3: Object.freeze([{ id: 990004, rank: 3, odds: 1, isExchangeable: false }]),
    })
    const requestedTables = []
    const tables = Object.freeze({
        "character.json": Object.freeze({
            "990001": character,
            "990003": Object.freeze({ ...character, rarity: 4 }),
            "990004": Object.freeze({ ...character, rarity: 3 }),
        }),
        "gacha.json": Object.freeze({ "990002": gacha }),
        "gacha_pool.json": pools,
        "gacha_campaign_definitions.json": Object.freeze({}),
        "stars_gacha_campaign.json": Object.freeze({}),
        "gacha_exchange_rate.json": Object.freeze({
            character: Object.freeze({ 3: 250, 4: 250, 5: 250 }),
            equipment: Object.freeze({ 3: 250, 4: 250, 5: 250 }),
        }),
        "equipment_lookup.json": Object.freeze({}),
        "item_lookup.json": Object.freeze({}),
        "equipment_gacha_movie_probability.json": Object.freeze({}),
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
        const catalog = getGachaCatalog(productionContentSnapshotProvider.snapshot.repository)
        const projectedGacha = getLegacyGachas(
            productionContentSnapshotProvider.snapshot.repository,
        )["990002"]
        assert.equal(projectedGacha.type, 0)
        assert.equal(projectedGacha.singleCost, 150)
        assert.strictEqual(projectedGacha.pool["1"], catalog.pools.fixture_5.items)
        assert.deepEqual(requestedTables, [
            "character.json",
            "character.json",
            "equipment_lookup.json",
            "item_lookup.json",
            "equipment_gacha_movie_probability.json",
            "gacha_pool.json",
            "gacha.json",
            "gacha_campaign_definitions.json",
            "stars_gacha_campaign.json",
            "gacha_exchange_rate.json",
        ])
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("bundled ContentRepository keeps tracked gacha fallback behavior", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gacha-repository-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const trackedGachas = require("../assets/gacha.json")
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
            return placeholder
        },
    })

    assert.equal(repository.info().source, "bundled")
    assert.equal(Object.keys(trackedGachas).length, 584)
    assert.deepEqual(repository.table("gacha.json"), trackedGachas)
})

test("Gacha HTTP routes delegate Content ownership to the Gacha catalog", () => {
    const characterRoute = fs.readFileSync(path.join(projectRoot, "src/routes/api/character.ts"), "utf8")
    const characterOwner = fs.readFileSync(path.join(projectRoot, "src/lib/character.ts"), "utf8")
    const gachaRoute = fs.readFileSync(path.join(projectRoot, "src/routes/api/gacha.ts"), "utf8")
    const gachaOwner = fs.readFileSync(path.join(projectRoot, "src/lib/gacha-owner/execute.ts"), "utf8")
    const exchangeOwner = fs.readFileSync(path.join(projectRoot, "src/lib/gacha-owner/exchange.ts"), "utf8")

    assert.match(characterRoute, /givePlayerCharacterSync.*from "\.\.\/\.\.\/lib\/character"/)
    assert.match(characterOwner, /getCharacterDataSync.*from "\.\/assets"/)
    assert.match(gachaRoute, /executeGachaDrawSync[\s\S]*from "\.\.\/\.\.\/lib\/gacha-owner"/)
    assert.match(gachaOwner, /getGachaCatalog/)
    assert.doesNotMatch(gachaOwner, /getGachaCampaignIdSync|getGachaSync/)
    assert.match(gachaRoute, /registerGachaExchangeRoutes/)
    assert.match(exchangeOwner, /getGachaCatalog/)
    assert.doesNotMatch(exchangeOwner, /getGachaSync|exchangeRequiredPoints|\b250\b/)
    assert.doesNotMatch(characterRoute, /assets\/character\.json/)
    assert.doesNotMatch(characterOwner, /assets\/character\.json/)
    assert.doesNotMatch(gachaRoute, /assets\/gacha(?:_campaign)?\.json/)
})

test("Gacha route registration exposes exactly the CN client endpoints", async () => {
    const Fastify = require("fastify")
    const gachaRoutes = require("../src/routes/api/gacha").default
    const app = Fastify({ logger: false })
    const registered = []
    app.addHook("onRoute", route => {
        registered.push(`${route.method} ${route.url}`)
    })
    await app.register(gachaRoutes, { prefix: "/gacha" })
    await app.ready()
    assert.deepEqual(registered.sort(), [
        "POST /gacha/crazy_gacha_save",
        "POST /gacha/crazy_gacha_select",
        "POST /gacha/exchange_character",
        "POST /gacha/exchange_equipment",
        "POST /gacha/exec",
        "POST /gacha/shown_converted",
    ])
    assert.equal(registered.some(entry => (
        entry === "POST /gacha/index"
        || entry === "POST /gacha/payment"
        || entry === "POST /gacha/history"
        || entry === "POST /gacha/point"
    )), false)
    await app.close()
})
