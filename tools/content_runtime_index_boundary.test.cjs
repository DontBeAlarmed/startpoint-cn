"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")

// Every production raw read is a reviewed infrastructure seam or finite adapter builder.
// Values are exact first-argument expressions; duplicates intentionally lock call count.
const reviewedRawTableCalls = new Map([
    ["src/content/runtime/table-access.ts", ["tableName"]], // strict infrastructure accessor
    ["src/lib/additional-reward.ts", ["additional_reward_rules.json"]], // Additional Reward catalog
    ["src/lib/bond-token-exchange/catalog.ts", ["bond_token_exchange.json"]], // Bond exchange catalog
    ["src/lib/box-gacha-content.ts", ["box_gacha.json", "box_reward.json", "box_gacha_box_settings.json"]], // Box catalog
    ["src/lib/carnival-rewards.ts", ["carnival_event_total_score_reward.json"]], // Carnival reward adapter
    ["src/lib/character-content.ts", ["character.json", "cdndata/character.json", "cdndata/character_text.json", "character.json", "cdndata/character.json", "cdndata/character_text.json"]], // Character catalogs
    ["src/lib/character-election.ts", ["character_election.json"]], // Election catalog
    ["src/lib/character-growth-content.ts", ["tableName"]], // finite Growth table registry
    ["src/lib/config-content.ts", ["config.json"]], // Config catalog
    ["src/lib/encyclopedia-content.ts", ["encyclopedia.json"]], // Encyclopedia projection
    ["src/lib/equipment-content.ts", ["equipment_craft.json", "equipment_dissolve.json", "equipment_ids.json", "equipment_lookup.json"]], // Equipment catalog
    ["src/lib/ex-boost-content.ts", ["ex_boost.json", "ex_status.json", "ex_ability.json"]], // EX catalog
    ["src/lib/gacha-catalog/catalog.ts", ["character.json", "equipment_lookup.json", "item_lookup.json", "equipment_gacha_movie_probability.json", "gacha_pool.json", "gacha.json", "gacha_campaign_definitions.json", "stars_gacha_campaign.json", "gacha_exchange_rate.json"]], // Gacha catalog
    ["src/lib/item-content.ts", ["item_data.json", "item_ids.json", "item_lookup.json", "item_sale.json"]], // Item catalog
    ["src/lib/login-bonus.ts", ["login_bonus.json"]], // Login Bonus catalog
    ["src/lib/mission/active-mission-fact-content.ts", ["main_quest.json", "ex_quest.json", "treasure_shop.json", "boss_coin_shop_item_category_map.json", "boss_coin_shop.json"]], // Active Mission fact adapter
    ["src/lib/mission/active-mission-specific-battle-facts.ts", ["cdndata/active_mission_skill_effects.json"]], // finite active-skill facts
    ["src/lib/mission/active-plan.ts", ["mission_active.json", "mission_active_event.json", "mission_active_reward.json"]], // Active Mission catalog
    ["src/lib/mission/awake-rule-catalog.ts", ["mission_char_awake.json"]], // Awake catalog
    ["src/lib/mission/character-queries.ts", ["character_quest_lookup.json"]], // finite character query
    ["src/lib/mission/computer-event-safe.ts", ["tableName"]], // finite static-fact table registry
    ["src/lib/mission/mission-catalog-source.ts", ["source.definitionTable", "source.rewardTable"]], // finite Mission source descriptors
    ["src/lib/mission/mission-catalog.ts", ["tableName"]], // finite Mission catalog table registry
    ["src/lib/mission/regular-state-facts.ts", ["mana_board.json"]], // Mana Board fact adapter
    ["src/lib/pass-card.ts", ["pass_card_event.json", "pass_card_event.json", "pass_card_reward.json"]], // Pass Card adapter
    ["src/lib/player-history-catalog.ts", ["player_history.json", "player_history_card_background.json", "player_history_topic.json"]], // Player History catalog
    ["src/lib/player-rank-content.ts", ["cdndata/player_rank_full.json", "cdndata/player_rank.json"]], // Rank catalogs
    ["src/lib/quest/daily-challenge.ts", ["daily_challenge_point_lookup.json", "event_challenge_point_map.json"]], // Daily Challenge catalog
    ["src/lib/quest/finish/raid-overall-rewards.ts", ["raid_event_overall_reward.json", "raid_event.json"]], // Raid reward catalog
    ["src/lib/quest/periodic-reward-content.ts", ["hard_multi_event.json", "periodic_reward_point.json", "periodic_reward.json", "hard_multi_event_quest.json"]], // Periodic reward catalog
    ["src/lib/quest/score-reward-selection.ts", ["reward_element_map.json"]], // Score reward adapter
    ["src/lib/quest-content.ts", ["tableName", "quest_lookup.json", "clear_reward.json", "rare_score_reward.json", "score_reward.json"]], // finite Quest/reward queries
    ["src/lib/quest-entry-content.ts", ["quest_entry_costs.json", "quest_unlock_costs.json", "quest_prerequisites.json"]], // Entry catalog
    ["src/lib/rescue-fragment-content.ts", ["tableName"]], // finite Rescue table registry
    ["src/lib/reward-campaign.ts", ["reward_campaign.json"]], // Reward Campaign catalog
    ["src/lib/rush-event-content.ts", ["rush_event_quest_folder.json", "score_attack_border_reward.json", "rush_event_ranking_reward.json"]], // Rush response adapters
    ["src/lib/shop/catalog.ts", ["shop_item_campaign.json", "shop_select_item_campaign.json", "cdn_general_shop_whitelist.json", "shop_cost_item_schedule.json", "tableName", "event_item_shop.json", "boss_coin_shop.json"]], // Shop catalog
    ["src/lib/stamina-campaign.ts", ["stamina_campaign.json"]], // Stamina campaign adapter
    ["src/lib/star-crumb-exchange/catalog.ts", ["star_crumb_exchange.json", "star_crumb_exchange_cost.json"]], // Star exchange catalog
    ["src/lib/story-join-character.ts", ["story_join_character.json"]], // Story join adapter
])

function sourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filePath = path.join(directory, entry.name)
        return entry.isDirectory() ? sourceFiles(filePath) : [filePath]
    }).filter(filePath => filePath.endsWith(".ts"))
}

function collectRawTableCalls(filePath, sourceText) {
    const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    const calls = []
    function visit(node) {
        if (ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === "table") {
            const argument = node.arguments[0]
            calls.push(ts.isStringLiteralLike(argument) ? argument.text : argument.getText(source))
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return calls
}

function collectNamedCalls(filePath, sourceText, functionName) {
    const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    const calls = []
    function visit(node) {
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === functionName) {
            const argument = node.arguments[0]
            calls.push(ts.isStringLiteralLike(argument) ? argument.text : argument?.getText(source))
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return calls
}

test("all production repository.table raw readers are finite reviewed adapters", () => {
    const actual = new Map(sourceFiles(sourceRoot).flatMap(filePath => {
        const relative = path.relative(projectRoot, filePath).split(path.sep).join("/")
        const calls = collectRawTableCalls(filePath, fs.readFileSync(filePath, "utf8"))
        return calls.length === 0 ? [] : [[relative, calls]]
    }))
    assert.deepEqual(actual, reviewedRawTableCalls)
})

test("strict table facade consumers remain in their finite reviewed adapter", () => {
    const actual = new Map(sourceFiles(sourceRoot).flatMap(filePath => {
        const relative = path.relative(projectRoot, filePath).split(path.sep).join("/")
        const calls = collectNamedCalls(
            filePath,
            fs.readFileSync(filePath, "utf8"),
            "getStrictRuntimeContentTableSync",
        )
        return calls.length === 0 ? [] : [[relative, calls]]
    }))
    assert.deepEqual(actual, new Map([
        ["src/lib/inventory/item-inventory-policy.ts", ["item_inventory_policy.json"]],
    ]))
})

test("raw reader scanner detects a route-level repository.table bypass", () => {
    assert.deepEqual(
        collectRawTableCalls("fixture-route.ts", `
            function route(repository) {
                return repository.table<Record<string, unknown>>("bypass.json")
            }
        `),
        ["bypass.json"],
    )
})

test("production source cannot import the test-only snapshot fixture", () => {
    const violations = sourceFiles(sourceRoot).filter(filePath => (
        fs.readFileSync(filePath, "utf8").includes("content-snapshot-fixture")
    )).map(filePath => path.relative(projectRoot, filePath).split(path.sep).join("/"))
    assert.deepEqual(violations, [])
})

test("raw Config access stays inside the typed Config adapter", () => {
    const readers = sourceFiles(sourceRoot).flatMap(filePath => {
        const source = fs.readFileSync(filePath, "utf8")
        const readsConfig = /repository\.table(?:<[^>]+>)?\(\s*["']config\.json["']/.test(source)
            || /getRuntimeContentTableSync(?:<[^>]+>)?\(\s*["']config\.json["']/.test(source)
        return readsConfig
            ? [path.relative(projectRoot, filePath).split(path.sep).join("/")]
            : []
    }).sort()
    assert.deepEqual(readers, ["src/lib/config-content.ts"])

    const legacyUsers = sourceFiles(sourceRoot).flatMap(filePath => {
        const relative = path.relative(projectRoot, filePath).split(path.sep).join("/")
        return fs.readFileSync(filePath, "utf8").includes("getConfigSync") ? [relative] : []
    })
    assert.deepEqual(legacyUsers, [])
})

test("Shop business consumers use the typed Shop catalog", () => {
    const targetedConsumers = [
        "src/lib/event-currency.ts",
        "src/lib/how-to-get.ts",
        "src/routes/api/shop.ts",
    ]
    for (const relative of targetedConsumers) {
        const source = fs.readFileSync(path.join(projectRoot, relative), "utf8")
        assert.doesNotMatch(source, /getShopSelectItemCampaignsSync|getShopContentTable/, relative)
        assert.doesNotMatch(source, /shop_select_item_campaign\.json/, relative)
        if (relative === "src/lib/event-currency.ts") {
            assert.doesNotMatch(source, /getContentSnapshot|event_item_shop\.json/, relative)
        }
    }

    const rawReferences = sourceFiles(sourceRoot).flatMap(filePath => {
        const source = fs.readFileSync(filePath, "utf8")
        return /(?:event_item_shop|shop_select_item_campaign)\.json/.test(source)
            ? [path.relative(projectRoot, filePath).split(path.sep).join("/")]
            : []
    }).sort()
    assert.deepEqual(rawReferences, [
        "src/content/converters/shop.ts",
        "src/content/sync/table-registry.ts",
        "src/lib/shop/catalog.ts",
    ])

    const catalogSource = fs.readFileSync(
        path.join(projectRoot, "src/lib/shop/catalog.ts"),
        "utf8",
    )
    assert.doesNotMatch(
        catalogSource,
        /event_item_shop_id_map\.json|boss_coin_shop_item_category_map\.json/,
    )
})

test("Gacha and Box Gacha raw tables stay inside their independent typed builders", () => {
    const ordinaryPattern = /(?:^|[^A-Za-z0-9_])(?:gacha|gacha_pool|gacha_campaign_definitions|stars_gacha_campaign|gacha_exchange_rate|equipment_gacha_movie_probability)\.json/
    const ordinaryReferences = sourceFiles(sourceRoot).flatMap(filePath => {
        const source = fs.readFileSync(filePath, "utf8")
        return ordinaryPattern.test(source)
            ? [path.relative(projectRoot, filePath).split(path.sep).join("/")]
            : []
    }).sort()
    assert.deepEqual(ordinaryReferences, [
        "src/content/converters/gacha.ts",
        "src/content/converters/gameplay.ts",
        "src/content/sync/table-registry.ts",
        "src/lib/gacha-catalog/catalog.ts",
        "src/lib/types/gacha.ts",
    ])

    const boxPattern = /(?:box_gacha|box_reward|box_gacha_box_settings)\.json/
    const boxReferences = sourceFiles(sourceRoot).flatMap(filePath => {
        const source = fs.readFileSync(filePath, "utf8")
        return boxPattern.test(source)
            ? [path.relative(projectRoot, filePath).split(path.sep).join("/")]
            : []
    }).sort()
    assert.deepEqual(boxReferences, [
        "src/content/converters/box-gacha.ts",
        "src/content/sync/table-registry.ts",
        "src/lib/box-gacha-content.ts",
    ])

    const targetedConsumers = [
        "src/lib/gacha-equipment-movie.ts",
        "src/lib/gacha-legacy-content.ts",
        "src/lib/gacha-owner/save-validation.ts",
        "src/lib/how-to-get.ts",
        "src/routes/api/boxGacha.ts",
        "src/routes/api/tutorial.ts",
    ]
    for (const relative of targetedConsumers) {
        const source = fs.readFileSync(path.join(projectRoot, relative), "utf8")
        assert.doesNotMatch(
            source,
            /getGachaSync|getBoxGachaSync|getRuntimeContentTableSync\(\s*["'](?:gacha|gacha_pool|stars_gacha_campaign|equipment_gacha_movie_probability|box_gacha|box_reward|box_gacha_box_settings)\.json/,
            relative,
        )
    }
    const ordinaryCatalog = fs.readFileSync(
        path.join(projectRoot, "src/lib/gacha-catalog/catalog.ts"),
        "utf8",
    )
    assert.doesNotMatch(ordinaryCatalog, boxPattern)
    const boxCatalog = fs.readFileSync(
        path.join(projectRoot, "src/lib/box-gacha-content.ts"),
        "utf8",
    )
    assert.doesNotMatch(boxCatalog, ordinaryPattern)
})

test("Exchange, EX Boost and Character Election keep finite independent Content roots", () => {
    const expectedByPattern = [
        [/(?:star_crumb_exchange|star_crumb_exchange_cost)\.json/, [
            "src/content/sync/table-registry.ts",
            "src/lib/star-crumb-exchange/catalog.ts",
        ]],
        [/bond_token_exchange\.json/, [
            "src/content/sync/table-registry.ts",
            "src/lib/bond-token-exchange/catalog.ts",
        ]],
        [/(?:ex_ability|ex_boost|ex_status)\.json/, [
            "src/content/converters/gameplay.ts",
            "src/content/sync/table-registry.ts",
            "src/lib/ex-boost-content.ts",
        ]],
        [/character_election\.json/, [
            "src/content/converters/character-election.ts",
            "src/content/sync/table-registry.ts",
            "src/lib/character-election.ts",
        ]],
    ]
    for (const [pattern, expected] of expectedByPattern) {
        const actual = sourceFiles(sourceRoot).flatMap(filePath => (
            pattern.test(fs.readFileSync(filePath, "utf8"))
                ? [path.relative(projectRoot, filePath).split(path.sep).join("/")]
                : []
        )).sort()
        assert.deepEqual(actual, expected)
    }
    const exRoute = fs.readFileSync(path.join(projectRoot, "src/routes/api/exBoost.ts"), "utf8")
    assert.doesNotMatch(exRoute, /getRuntimeContentTableSync|ex_(?:ability|boost|status)\.json/)
    const electionRoute = fs.readFileSync(
        path.join(projectRoot, "src/routes/api/characterElection.ts"),
        "utf8",
    )
    assert.doesNotMatch(
        electionRoute,
        /getContentSnapshot|ReadonlyCharacterElectionTable|character_election\.json|getTable/,
    )
})
