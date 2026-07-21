"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const confirmedSeedsPath = path.join(projectRoot, "assets", "confirmed_seeds.json")
const confirmedSeedsDigest = crypto.createHash("sha256")
    .update(fs.readFileSync(confirmedSeedsPath))
    .digest("hex")

const {
    TABLE_SOURCES,
    findTableSource,
} = require("../src/content/sync/table-registry")
const { importBundledTable } = require("../src/content/sync/bundled-importer")

const EXPECTED_CDN_TABLES = Object.freeze({
    "character.json": ["character", [
        "master/character/character.orderedmap",
        "master/character/character_status.orderedmap",
    ]],
    "cdndata/character.json": ["character", [
        "master/character/character.orderedmap",
        "master/character/character_status.orderedmap",
    ]],
    "cdndata/character_text.json": ["character", [
        "master/character/character_text.orderedmap",
    ]],
    "gacha.json": ["gacha", ["master/gacha/gacha.orderedmap"]],
    "gacha_campaign.json": ["gacha", ["master/gacha/gacha_campaign.orderedmap"]],
    "cdndata/gacha.json": ["gacha", ["master/gacha/gacha.orderedmap"]],
    "cdndata/gacha_feature_content.json": ["gacha", [
        "master/gacha/gacha_feature_content.orderedmap",
    ]],
    "general_shop.json": ["shop", ["master/shop/general_shop.orderedmap"]],
    "event_item_shop.json": ["shop", ["master/shop/event_item_shop.orderedmap"]],
    "event_item_shop_id_map.json": ["shop", ["master/shop/event_item_shop.orderedmap"]],
    "boss_coin_shop.json": ["shop", ["master/shop/boss_coin_shop.orderedmap"]],
    "boss_coin_shop_item_category_map.json": ["shop", [
        "master/shop/boss_coin_shop.orderedmap",
    ]],
    "star_grain_shop.json": ["shop", ["master/shop/star_grain_shop.orderedmap"]],
    "treasure_shop.json": ["shop", ["master/shop/treasure_shop.orderedmap"]],
    "equipment_enhancement_shop.json": ["shop", [
        "master/equipment_enhancement/equipment_enhancement_shop.orderedmap",
    ]],
})

const EXPECTED_BUNDLED_TABLES = Object.freeze([
    "advent_event_quest.json",
    "boss_battle_quest.json",
    "box_gacha.json",
    "box_gacha_box_settings.json",
    "box_reward.json",
    "carnival_event_quest.json",
    "carnival_event_total_score_reward.json",
    "cdndata/player_rank.json",
    "cdndata/player_rank_full.json",
    "challenge_dungeon_event_quest.json",
    "character_quest.json",
    "character_quest_lookup.json",
    "clear_reward.json",
    "daily_challenge_point_lookup.json",
    "daily_exp_mana_event_quest.json",
    "daily_week_event_quest.json",
    "encyclopedia.json",
    "equipment_craft.json",
    "equipment_dissolve.json",
    "equipment_gacha_movie_probability.json",
    "equipment_ids.json",
    "equipment_lookup.json",
    "event_challenge_point_map.json",
    "ex_ability.json",
    "ex_boost.json",
    "ex_quest.json",
    "ex_status.json",
    "expert_single_event_quest.json",
    "hard_multi_event_quest.json",
    "item_data.json",
    "item_ids.json",
    "item_lookup.json",
    "item_sale.json",
    "main_quest.json",
    "mana_board.json",
    "mana_node.json",
    "mana_node_awake.json",
    "mission_active_reward.json",
    "mission_char_awake.json",
    "mission_char_awake_reward.json",
    "mission_collect_item.json",
    "mission_collect_item_reward.json",
    "mission_daily.json",
    "mission_daily_reward.json",
    "mission_degree.json",
    "mission_degree_reward.json",
    "mission_event.json",
    "mission_event_quest_map.json",
    "mission_event_reward.json",
    "mission_regular.json",
    "mission_regular_reward.json",
    "mission_weekly_def.json",
    "mission_weekly_reward.json",
    "practice_quest.json",
    "quest_entry_costs.json",
    "quest_lookup.json",
    "quest_unlock_costs.json",
    "raid_event_quest.json",
    "ranking_event_single_quest.json",
    "rare_score_reward.json",
    "reward_element_map.json",
    "rush_event_quest.json",
    "rush_event_quest_folder.json",
    "rush_event_ranking_reward.json",
    "score_attack_border_reward.json",
    "score_attack_event_quest.json",
    "score_reward.json",
    "solo_time_attack_event_quest.json",
    "stamina_campaign.json",
    "star_crumb_exchange.json",
    "star_crumb_exchange_cost.json",
    "story_event_single_quest.json",
    "tower_dungeon_event_quest.json",
    "world_story_event_boss_battle_quest.json",
    "world_story_event_quest.json",
])

const EXPECTED_SERVER_TABLES = Object.freeze([
    "cdn_general_shop_whitelist.json",
    "config.json",
    "news.json",
    "payment_products.json",
])

const EXCLUDED_TABLES = Object.freeze([
    "confirmed_seeds.json",
    "pending_seeds.json",
    "blocked_seeds.json",
    "device_seeds.json",
    "purified_seeds.json",
    "test_seeds.json",
    "verified_seeds.json",
    "gacha_movie_seeds.json",
    "gacha_movie_seeds_fes.json",
    "gacha_movie_seeds_fes_guarantee.json",
    "gacha_movie_seeds_normal.json",
    "gacha_movie_seeds_normal_guarantee.json",
    "gacha_rate_up_movie_seeds.json",
    "gacha_rate_up_movie_seeds_fes.json",
    "gacha_rate_up_movie_seeds_fes_guarantee.json",
    "gacha_rate_up_movie_seeds_normal.json",
    "gacha_rate_up_movie_seeds_normal_guarantee.json",
    "pool_config.json",
    "save_data.json",
    "rare_score_reward_synthetic_new.json",
    "rare_score_reward_synthetic_review.json",
    "asset-patch/manifest.json",
    "cdn/catalog-cn-1.4.54.json",
    "asset_lists/en-android-full.json",
    "asset_lists/en-android-short.json",
    "asset_lists/en-ios-full.json",
    "asset_lists/ko-android-full.json",
    "asset_lists/ko-android-short.json",
    "asset_lists/ko-ios-full.json",
    "asset_lists/th-android-full.json",
    "asset_lists/th-android-short.json",
    "asset_lists/th-ios-full.json",
])

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.ok(Object.isFrozen(value), "registry values must be deeply frozen")
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

function collectStaticAssetJsonReferences(directory) {
    const references = new Set()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            for (const reference of collectStaticAssetJsonReferences(entryPath)) {
                references.add(reference)
            }
            continue
        }
        if (!entry.name.endsWith(".ts")) continue
        const source = fs.readFileSync(entryPath, "utf8")
        for (const match of source.matchAll(/["']([^"']*assets\/([^"']+\.json))["']/g)) {
            references.add(match[2])
        }
    }
    return references
}

test("registry is sorted, unique, deeply frozen, and versioned", () => {
    const names = TABLE_SOURCES.map(entry => entry.tableName)
    assert.deepEqual(names, [...names].sort())
    assert.equal(new Set(names).size, names.length)
    assertDeepFrozen(TABLE_SOURCES)

    for (const entry of TABLE_SOURCES) {
        assert.ok(Number.isSafeInteger(entry.converterVersion) && entry.converterVersion > 0)
        assert.ok(Number.isSafeInteger(entry.outputShapeVersion) && entry.outputShapeVersion > 0)
        assert.ok(entry.sourceOrderedMaps.length > 0)
    }
})

test("registry covers the first CDN converter tables with verified logical paths", () => {
    for (const [tableName, [converterId, sources]] of Object.entries(EXPECTED_CDN_TABLES)) {
        const entry = findTableSource(tableName)
        assert.equal(entry.scope, "cdn", tableName)
        assert.equal(entry.converterId, converterId, tableName)
        assert.deepEqual(entry.sourceOrderedMaps, sources, tableName)
    }
})

test("registry closes over current static runtime tables", () => {
    const bundled = TABLE_SOURCES.filter(entry => entry.scope === "bundled")
        .map(entry => entry.tableName)
    const server = TABLE_SOURCES.filter(entry => entry.scope === "server")
        .map(entry => entry.tableName)

    assert.deepEqual(
        bundled,
        [...EXPECTED_BUNDLED_TABLES].sort(),
    )
    assert.deepEqual(
        server,
        [...EXPECTED_SERVER_TABLES].sort(),
    )
})

test("registry independently covers static CN runtime JSON references", () => {
    const registered = new Set(TABLE_SOURCES.map(entry => entry.tableName))
    const intentionallyExternal = new Set([
        "cdn/catalog-cn-1.4.54.json",
        "asset_lists/en-android-full.json",
        "asset_lists/en-android-short.json",
        "asset_lists/en-ios-full.json",
        "asset_lists/ko-android-full.json",
        "asset_lists/ko-android-short.json",
        "asset_lists/ko-ios-full.json",
        "asset_lists/th-android-full.json",
        "asset_lists/th-android-short.json",
        "asset_lists/th-ios-full.json",
    ])
    const references = collectStaticAssetJsonReferences(path.join(projectRoot, "src"))

    const uncovered = [...references]
        .filter(reference => !registered.has(reference) && !intentionallyExternal.has(reference))
        .sort()
    const dynamicallyReadRuntimeTables = new Set(["news.json"])
    const unreferenced = TABLE_SOURCES
        .filter(entry => entry.scope !== "cdn")
        .map(entry => entry.tableName)
        .filter(tableName => (
            !references.has(tableName) && !dynamicallyReadRuntimeTables.has(tableName)
        ))
        .sort()
    assert.deepEqual(uncovered, [])
    assert.deepEqual(unreferenced, [])
})

test("every non-CDN registry source exists and imports from the repository", async () => {
    for (const entry of TABLE_SOURCES.filter(source => source.scope !== "cdn")) {
        assert.deepEqual(entry.sourceOrderedMaps, [`assets/${entry.tableName}`], entry.tableName)
        const sourcePath = path.resolve(projectRoot, entry.sourceOrderedMaps[0])
        assert.ok(fs.existsSync(sourcePath), `${entry.tableName} source must exist`)
        const imported = await importBundledTable(projectRoot, entry.tableName)
        assertDeepFrozen(imported)
    }
})

test("runtime state and non-table assets are excluded", () => {
    const names = new Set(TABLE_SOURCES.map(entry => entry.tableName))
    for (const tableName of EXCLUDED_TABLES) assert.equal(names.has(tableName), false, tableName)
    assert.equal(names.has("confirmed_seeds.json"), false)
})

test("registry lookup and CDN imports reject unsupported tables", async () => {
    assert.throws(() => findTableSource("not_registered.json"), /not registered/i)
    await assert.rejects(
        importBundledTable(projectRoot, "not_registered.json"),
        /not registered/i,
    )
    await assert.rejects(importBundledTable(projectRoot, "character.json"), /cdn/i)
})

test("bundled importer reads and freezes a valid temporary JSON table", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-"))
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(temporaryRoot, "assets"))
    fs.writeFileSync(path.join(temporaryRoot, "assets", "news.json"), '{"nested":{"value":1}}')

    const value = await importBundledTable(temporaryRoot, "news.json")
    assert.deepEqual(value, { nested: { value: 1 } })
    assertDeepFrozen(value)
})

test("bundled importer rejects damaged JSON and symlink escapes", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-"))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-outside-"))
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(temporaryRoot, "assets"))
    fs.writeFileSync(path.join(temporaryRoot, "assets", "news.json"), "{")
    await assert.rejects(importBundledTable(temporaryRoot, "news.json"), /invalid JSON/i)

    fs.writeFileSync(path.join(outsideRoot, "payment_products.json"), "[]")
    fs.symlinkSync(
        path.join(outsideRoot, "payment_products.json"),
        path.join(temporaryRoot, "assets", "payment_products.json"),
    )
    await assert.rejects(
        importBundledTable(temporaryRoot, "payment_products.json"),
        /outside.*assets|symlink/i,
    )
})

test("bundled importer rejects a symlink swapped in after realpath validation", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-race-"))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-race-outside-"))
    const sourcePath = path.join(temporaryRoot, "assets", "news.json")
    const outsidePath = path.join(outsideRoot, "news.json")
    const originalRealpath = fs.promises.realpath
    let swapped = false
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }))
    t.after(() => { fs.promises.realpath = originalRealpath })
    fs.mkdirSync(path.dirname(sourcePath))
    fs.writeFileSync(sourcePath, '{"source":"inside"}')
    fs.writeFileSync(outsidePath, '{"source":"outside"}')

    fs.promises.realpath = async value => {
        const resolved = await originalRealpath.call(fs.promises, value)
        if (!swapped && path.resolve(value) === sourcePath) {
            swapped = true
            queueMicrotask(() => {
                fs.unlinkSync(sourcePath)
                fs.symlinkSync(outsidePath, sourcePath)
            })
        }
        return resolved
    }

    await assert.rejects(importBundledTable(temporaryRoot, "news.json"), /symlink|changed/i)
})

test("registry work never modifies confirmed seed state", () => {
    const currentDigest = crypto.createHash("sha256")
        .update(fs.readFileSync(confirmedSeedsPath))
        .digest("hex")
    assert.equal(currentDigest, confirmedSeedsDigest)
})
