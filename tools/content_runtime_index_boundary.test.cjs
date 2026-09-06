"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const sourceRoot = path.join(projectRoot, "src")

// D27 C2-C5 may add only reviewed raw-to-typed adapter builders here.
const strictAccessorImporters = new Set([
    "src/lib/inventory/item-inventory-policy.ts",
])

function sourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filePath = path.join(directory, entry.name)
        return entry.isDirectory() ? sourceFiles(filePath) : [filePath]
    }).filter(filePath => filePath.endsWith(".ts"))
}

test("strict raw table access is limited to reviewed typed adapter builders", () => {
    const actual = sourceFiles(sourceRoot).flatMap(filePath => {
        const relative = path.relative(projectRoot, filePath).split(path.sep).join("/")
        if (relative === "src/content/runtime/table-access.ts") return []
        const source = fs.readFileSync(filePath, "utf8")
        return source.includes("getStrictRuntimeContentTableSync") ? [relative] : []
    }).sort()
    assert.deepEqual(actual, [...strictAccessorImporters].sort())
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
        "src/lib/assets.ts",
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
        "src/lib/assets.ts",
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
    const assets = fs.readFileSync(path.join(projectRoot, "src/lib/assets.ts"), "utf8")
    assert.doesNotMatch(assets, /getExAbilityPoolsSync|getExStatusPoolSync|getExBoostItemSync/)
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
