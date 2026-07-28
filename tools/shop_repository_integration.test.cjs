"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { ContentRepository } = require("../src/content/runtime/content-repository")
const {
    ContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")

const SHOP_TABLES = Object.freeze([
    "general_shop.json",
    "event_item_shop.json",
    "event_item_shop_id_map.json",
    "boss_coin_shop.json",
    "boss_coin_shop_item_category_map.json",
    "shop_item_campaign.json",
    "shop_select_item_campaign.json",
    "star_grain_shop.json",
    "treasure_shop.json",
    "equipment_enhancement_shop.json",
])

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("ContentSnapshotProvider initializes and freezes all ten real bundled shop tables", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shop-snapshot-provider-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const projectRoot = path.resolve(__dirname, "..")
    const provider = new ContentSnapshotProvider({
        catalogSource: {
            load: async () => Object.freeze({ targetVersion: "1.4.54" }),
        },
        repositorySource: {
            load: () => ContentRepository.load({
                projectRoot,
                env: {
                    CDN_DIR: path.join(root, "cdn"),
                    CONTENT_DIR: path.join(root, "content"),
                    CONTENT_RUNTIME_DIR: path.join(projectRoot, "assets"),
                },
            }),
        },
    })

    const snapshot = await provider.initialize()

    assert.strictEqual(provider.get(), snapshot)
    assert.equal(snapshot.repository.info().source, "bundled")
    assertDeepFrozen(snapshot)
    for (const tableName of SHOP_TABLES) {
        const expected = JSON.parse(fs.readFileSync(
            path.join(projectRoot, "assets", tableName),
            "utf8",
        ))
        const table = snapshot.repository.table(tableName)
        assert.deepEqual(table, expected, tableName)
        assertDeepFrozen(table)
    }
})

test("integration:content includes the real bundled shop snapshot test", () => {
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.ok(TEST_GROUPS["integration:content"].tests.includes(
        "tools/shop_repository_integration.test.cjs",
    ))
})
