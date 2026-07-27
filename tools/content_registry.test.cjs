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
const {
    CONTENT_RUNTIME_SCHEMA_VERSION,
    CONTENT_SCHEMA_VERSION,
    createReleaseManifest,
    parseReleaseManifest,
} = require("../src/content/sync/schema")
const { importBundledTable } = require("../src/content/sync/bundled-importer")

const TEST_DIGEST = `sha256:${"a".repeat(64)}`
const EXPECTED_GACHA_ODDS_DYNAMIC_SOURCE = Object.freeze({
    kind: "gacha-odds-references",
    sourceOrderedMap: "master/gacha/gacha.orderedmap",
    logicalPathTemplate: "master/gacha_odds/{oddsId}.orderedmap",
    rarityOddsColumn: 11,
    prizeKindColumn: 13,
    poolOddsColumns: Object.freeze([
        Object.freeze({ prizeKind: "0", columns: Object.freeze([14, 15, 16]) }),
        Object.freeze({ prizeKind: "1", columns: Object.freeze([22, 23, 24]) }),
    ]),
    referenceNormalization: "trim",
    skipReferences: Object.freeze(["", "(None)"]),
    order: "lexicographic",
    missingReference: "error",
})

const EXPECTED_CDN_TABLES = Object.freeze({
    "character.json": ["character", [
        "master/character/character.orderedmap",
    ]],
    "character_election.json": ["character-election", [
        "master/character_election/character_election.orderedmap",
        "master/character_election/character_election_exclude.orderedmap",
        "master/character/character.orderedmap",
        "master/encyclopedia/encyclopedia.orderedmap",
    ]],
    "cdndata/character.json": ["character", [
        "master/character/character.orderedmap",
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
    "cdndata/active_mission_skill_effects.json": ["skill-effects", [
        "master/character/character.orderedmap",
        "master/skill/action_skill.orderedmap",
        "master/skill/switched_action_skill.orderedmap",
    ]],
    "general_shop.json": ["shop", ["master/shop/general_shop.orderedmap"]],
    "event_item_shop.json": ["shop", ["master/shop/event_item_shop.orderedmap"]],
    "event_item_shop_id_map.json": ["shop", ["master/shop/event_item_shop.orderedmap"]],
    "boss_coin_shop.json": ["shop", [
        "master/shop/boss_coin_shop.orderedmap",
        "master/shop/boss_coin_shop_category.orderedmap",
    ]],
    "boss_coin_shop_item_category_map.json": ["shop", [
        "master/shop/boss_coin_shop.orderedmap",
        "master/shop/boss_coin_shop_category.orderedmap",
    ]],
    "star_grain_shop.json": ["shop", ["master/shop/star_grain_shop.orderedmap"]],
    "treasure_shop.json": ["shop", ["master/shop/treasure_shop.orderedmap"]],
    "equipment_enhancement_shop.json": ["shop", [
        "master/equipment_enhancement/equipment_enhancement_shop.orderedmap",
        "master/equipment_enhancement/equipment_enhancement_shop_category.orderedmap",
    ]],
})

const EXPECTED_DIRECT_CDN_TABLES = Object.freeze({
    "cdndata/player_rank.json": [1, "master/player/player_rank.orderedmap"],
    "character_quest_lookup.json": [1, "master/quest/character_quest.orderedmap"],
    "ex_ability.json": [1, "master/ex_boost/ex_ability.orderedmap"],
    "mana_board.json": [3, "master/generated/mana_board.orderedmap"],
    "mana_node_awake.json": [3, "master/mana_board/mana_node_awake.orderedmap"],
    "mission_active.json": [1, "master/active_mission/active_mission.orderedmap"],
    "mission_active_event.json": [1, "master/active_mission/active_mission_event.orderedmap"],
    "mission_active_reward.json": [2, "master/active_mission/active_mission_reward.orderedmap"],
    "mission_char_awake.json": [1, "master/mission/character_awake_mission.orderedmap"],
    "mission_char_awake_reward.json": [2, "master/mission/character_awake_mission_reward.orderedmap"],
    "mission_collect_item.json": [1, "master/mission/collect_item_event_mission.orderedmap"],
    "mission_collect_item_reward.json": [2, "master/mission/collect_item_event_mission_reward.orderedmap"],
    "mission_daily.json": [1, "master/mission/daily_mission.orderedmap"],
    "mission_daily_reward.json": [2, "master/mission/daily_mission_reward.orderedmap"],
    "mission_degree.json": [1, "master/mission/degree_mission.orderedmap"],
    "mission_degree_reward.json": [2, "master/mission/degree_mission_reward.orderedmap"],
    "mission_event.json": [1, "master/mission/event_mission.orderedmap"],
    "mission_event_reward.json": [2, "master/mission/event_mission_reward.orderedmap"],
    "mission_pass_daily.json": [1, "master/pass_card/pass_card_daily_mission.orderedmap"],
    "mission_pass_daily_reward.json": [2, "master/pass_card/pass_card_daily_mission_reward.orderedmap"],
    "mission_pass_event.json": [1, "master/pass_card/pass_card_event_mission.orderedmap"],
    "mission_pass_event_reward.json": [2, "master/pass_card/pass_card_event_mission_reward.orderedmap"],
    "mission_pass_week.json": [1, "master/pass_card/pass_card_week_mission.orderedmap"],
    "mission_pass_week_reward.json": [2, "master/pass_card/pass_card_week_mission_reward.orderedmap"],
    "mission_regular.json": [1, "master/mission/regular_mission.orderedmap"],
    "mission_regular_reward.json": [2, "master/mission/regular_mission_reward.orderedmap"],
    "mission_weekly_def.json": [1, "master/mission/weekly_mission.orderedmap"],
    "mission_weekly_reward.json": [2, "master/mission/weekly_mission_reward.orderedmap"],
    "pass_card_event.json": [1, "master/pass_card/pass_card_event.orderedmap"],
    "pass_card_reward.json": [1, "master/pass_card/pass_card_reward.orderedmap"],
    "raid_event_overall_reward.json": [1, "master/quest/event/raid_event_overall_reward.orderedmap"],
    "reward_element_map.json": [3, "master/reward/reward_element_map.orderedmap"],
    "stamina_campaign.json": [1, "master/campaign/stamina_campaign.orderedmap"],
    "star_crumb_exchange.json": [1, "master/shop/star_crumb_exchange.orderedmap"],
    "star_crumb_exchange_cost.json": [1, "master/shop/star_crumb_exchange_cost.orderedmap"],
})

const EXPECTED_REWARD_CDN_TABLES = Object.freeze({
    "clear_reward.json": "master/reward/clear_reward.orderedmap",
    "score_reward.json": "master/reward/score_reward.orderedmap",
    "rare_score_reward.json": "master/reward/rare_score_reward.orderedmap",
    "score_attack_border_reward.json": "master/quest/event/score_attack_border_reward.orderedmap",
    "rush_event_quest_folder.json": "master/quest/event/rush_event_quest_folder.orderedmap",
    "rush_event_ranking_reward.json": "master/quest/event/rush_event_ranking_reward.orderedmap",
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
    "mission_active.json",
    "mission_active_event.json",
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
    "mission_event_battle_rules.json",
    "mission_event_quest_map.json",
    "mission_event_reward.json",
    "mission_pass_daily.json",
    "mission_pass_daily_reward.json",
    "mission_pass_event.json",
    "mission_pass_event_reward.json",
    "mission_pass_week.json",
    "mission_pass_week_reward.json",
    "mission_regular.json",
    "mission_regular_reward.json",
    "mission_weekly_def.json",
    "mission_weekly_reward.json",
    "pass_card_event.json",
    "pass_card_reward.json",
    "practice_quest.json",
    "quest_entry_costs.json",
    "quest_lookup.json",
    "quest_unlock_costs.json",
    "raid_event.json",
    "raid_event_overall_reward.json",
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

function containsSensitivePath(value, sensitivePath, seen = new Set()) {
    if (typeof value === "string") return value.includes(sensitivePath)
    if (!value || typeof value !== "object" || seen.has(value)) return false
    seen.add(value)
    return [value.message, value.path, value.cause]
        .some(nested => containsSensitivePath(nested, sensitivePath, seen))
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
        assert.equal(entry.bundledPath, `assets/${entry.tableName}`)
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

test("registry dynamically restores tables that exactly match official OrderedMap trees", () => {
    assert.equal(Object.keys(EXPECTED_DIRECT_CDN_TABLES).length, 35)
    for (const [tableName, [depth, source]] of Object.entries(EXPECTED_DIRECT_CDN_TABLES)) {
        const entry = findTableSource(tableName)
        assert.equal(entry.scope, "cdn", tableName)
        assert.equal(entry.converterId, `ordered-map-json-${depth}`, tableName)
        assert.deepEqual(entry.sourceOrderedMaps, [source], tableName)
    }
})

test("registry derives reward tables from their official OrderedMap sources", () => {
    for (const [tableName, source] of Object.entries(EXPECTED_REWARD_CDN_TABLES)) {
        const entry = findTableSource(tableName)
        assert.equal(entry.scope, "cdn", tableName)
        assert.equal(entry.converterId, "reward", tableName)
        assert.deepEqual(entry.sourceOrderedMaps, [source], tableName)
    }
})

test("registry and release manifest explicitly describe referenced gacha odds sources", () => {
    const gacha = findTableSource("gacha.json")

    assert.deepEqual(gacha.sourceOrderedMaps, ["master/gacha/gacha.orderedmap"])
    assert.deepEqual(gacha.dynamicSources, [EXPECTED_GACHA_ODDS_DYNAMIC_SOURCE])
    assert.deepEqual(gacha.manifestSources, [
        "master/gacha/gacha.orderedmap",
        EXPECTED_GACHA_ODDS_DYNAMIC_SOURCE,
    ])
    assert.ok(TABLE_SOURCES.every(entry => (
        entry.sourceOrderedMaps.every(source => !source.includes("*"))
    )))
    assert.ok(TABLE_SOURCES
        .filter(entry => entry.tableName !== "gacha.json")
        .every(entry => entry.dynamicSources.length === 0))

    const manifest = createReleaseManifest({
        schemaVersion: CONTENT_SCHEMA_VERSION,
        assetVersion: "1.4.55",
        runtimeSchemaVersion: CONTENT_RUNTIME_SCHEMA_VERSION,
        generatorVersion: 1,
        tables: {
            "gacha.json": {
                object: TEST_DIGEST,
                scope: gacha.scope,
                converterId: gacha.converterId,
                converterVersion: gacha.converterVersion,
                sources: gacha.manifestSources,
            },
        },
        catalog: { object: TEST_DIGEST },
        summary: { object: TEST_DIGEST },
    })
    const parsed = parseReleaseManifest(JSON.parse(JSON.stringify(manifest)))
    assert.deepEqual(parsed.tables["gacha.json"].sources, gacha.manifestSources)
    assertDeepFrozen(parsed.tables["gacha.json"].sources)
})

test("registry closes over current static runtime tables", () => {
    const bundled = TABLE_SOURCES.filter(entry => entry.scope === "bundled")
        .map(entry => entry.tableName)
    const server = TABLE_SOURCES.filter(entry => entry.scope === "server")
        .map(entry => entry.tableName)

    assert.deepEqual(
        bundled,
        EXPECTED_BUNDLED_TABLES
            .filter(tableName => (
                !(tableName in EXPECTED_DIRECT_CDN_TABLES)
                && !(tableName in EXPECTED_REWARD_CDN_TABLES)
            ))
            .sort(),
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

test("every registry table has an explicit existing bundled fallback", () => {
    assert.equal(TABLE_SOURCES.length, 109)
    for (const entry of TABLE_SOURCES) {
        const sourcePath = path.resolve(projectRoot, entry.bundledPath)
        assert.ok(fs.existsSync(sourcePath), `${entry.tableName} source must exist`)

        if (entry.scope === "cdn") {
            assert.doesNotMatch(entry.bundledPath, /\.orderedmap$/)
            assert.notEqual(entry.bundledPath, entry.sourceOrderedMaps[0])
        } else {
            assert.deepEqual(entry.sourceOrderedMaps, [`assets/${entry.tableName}`], entry.tableName)
        }
    }
})

test("bundled importer samples CDN, bundled, and server registry scopes", async () => {
    const samples = [
        ["gacha_campaign.json", "cdn"],
        ["equipment_ids.json", "bundled"],
        ["news.json", "server"],
    ]

    for (const [tableName, scope] of samples) {
        assert.equal(findTableSource(tableName).scope, scope)
        assertDeepFrozen(await importBundledTable(path.join(projectRoot, "assets"), tableName))
    }
})

test("runtime state and non-table assets are excluded", () => {
    const names = new Set(TABLE_SOURCES.map(entry => entry.tableName))
    for (const tableName of EXCLUDED_TABLES) assert.equal(names.has(tableName), false, tableName)
    assert.equal(names.has("confirmed_seeds.json"), false)
})

test("registry lookup and bundled imports reject unsupported tables", async () => {
    assert.throws(() => findTableSource("not_registered.json"), /not registered/i)
    await assert.rejects(
        importBundledTable(path.join(projectRoot, "assets"), "not_registered.json"),
        /not registered/i,
    )
})

test("bundled importer reads and freezes a valid temporary JSON table", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-"))
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(temporaryRoot, "assets"))
    fs.writeFileSync(path.join(temporaryRoot, "assets", "news.json"), '{"nested":{"value":1}}')

    const value = await importBundledTable(path.join(temporaryRoot, "assets"), "news.json")
    assert.deepEqual(value, { nested: { value: 1 } })
    assertDeepFrozen(value)
})

test("bundled importer maps registry assets paths below a configured runtime root", async t => {
    const temporaryProject = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-project-"))
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-runtime-"))
    t.after(() => fs.rmSync(temporaryProject, { recursive: true, force: true }))
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }))
    fs.writeFileSync(path.join(runtimeRoot, "news.json"), '{"source":"configured-runtime"}')

    assert.equal(fs.existsSync(path.join(temporaryProject, "assets")), false)
    assert.deepEqual(
        await importBundledTable(runtimeRoot, "news.json"),
        { source: "configured-runtime" },
    )
    assert.deepEqual(fs.readdirSync(runtimeRoot), ["news.json"])
})

test("bundled importer rejects damaged JSON and symlink escapes", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-"))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-outside-"))
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.join(temporaryRoot, "assets"))

    await assert.rejects(
        importBundledTable(path.join(temporaryRoot, "assets"), "news.json"),
        error => (
            /cannot read bundled table news\.json/i.test(error.message)
            && !containsSensitivePath(error, temporaryRoot)
            && error.cause === undefined
        ),
    )

    fs.writeFileSync(path.join(temporaryRoot, "assets", "news.json"), "{")
    await assert.rejects(
        importBundledTable(path.join(temporaryRoot, "assets"), "news.json"),
        error => (
            /invalid JSON in bundled table news\.json/i.test(error.message)
            && !containsSensitivePath(error, temporaryRoot)
            && error.cause === undefined
        ),
    )

    fs.writeFileSync(path.join(outsideRoot, "payment_products.json"), "[]")
    fs.symlinkSync(
        path.join(outsideRoot, "payment_products.json"),
        path.join(temporaryRoot, "assets", "payment_products.json"),
    )
    await assert.rejects(
        importBundledTable(path.join(temporaryRoot, "assets"), "payment_products.json"),
        /outside.*assets|symlink/i,
    )
})

test("bundled importer redacts nested absolute paths from open failures", async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "content-registry-open-"))
    const sourcePath = path.join(temporaryRoot, "assets", "news.json")
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
    fs.mkdirSync(path.dirname(sourcePath))
    fs.writeFileSync(sourcePath, "[]")
    const nestedCause = Object.assign(new Error(`nested failure ${temporaryRoot}`), {
        path: sourcePath,
    })
    t.mock.method(fs.promises, "open", async () => {
        throw Object.assign(new Error(`cannot open ${sourcePath}`), {
            path: sourcePath,
            cause: nestedCause,
        })
    })

    await assert.rejects(
        importBundledTable(path.join(temporaryRoot, "assets"), "news.json"),
        error => (
            /cannot safely open bundled table news\.json/i.test(error.message)
            && !containsSensitivePath(error, temporaryRoot)
            && error.cause === undefined
        ),
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

    await assert.rejects(
        importBundledTable(path.join(temporaryRoot, "assets"), "news.json"),
        /symlink|changed/i,
    )
})

test("registry work never modifies confirmed seed state", () => {
    const currentDigest = crypto.createHash("sha256")
        .update(fs.readFileSync(confirmedSeedsPath))
        .digest("hex")
    assert.equal(currentDigest, confirmedSeedsDigest)
})
