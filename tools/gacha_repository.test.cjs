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
        type: 0,
        paymentType: 0,
        singleCost: 150,
        multiCost: 1500,
        discountCost: 50,
        startDate: "2026-01-01 00:00:00",
        endDate: "2026-01-10 00:00:00",
        pool: Object.freeze({}),
    })
    const requestedTables = []
    const tables = Object.freeze({
        "character.json": Object.freeze({ "990001": character }),
        "gacha.json": Object.freeze({ "990002": gacha }),
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
        assert.strictEqual(getGachaSync(990002), gacha)
        assert.equal(getGachaCampaignIdSync(990002), 77)
        assert.deepEqual(requestedTables, [
            "character.json",
            "gacha.json",
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

test("character and gacha API routes share the Repository-backed assets facade", () => {
    const characterRoute = fs.readFileSync(path.join(projectRoot, "src/routes/api/character.ts"), "utf8")
    const gachaRoute = fs.readFileSync(path.join(projectRoot, "src/routes/api/gacha.ts"), "utf8")

    assert.match(characterRoute, /getCharacterDataSync.*from "\.\.\/\.\.\/lib\/assets"/)
    assert.match(gachaRoute, /getGachaCampaignIdSync, getGachaSync.*from "\.\.\/\.\.\/lib\/assets"/)
    assert.doesNotMatch(characterRoute, /assets\/character\.json/)
    assert.doesNotMatch(gachaRoute, /assets\/gacha(?:_campaign)?\.json/)
})
