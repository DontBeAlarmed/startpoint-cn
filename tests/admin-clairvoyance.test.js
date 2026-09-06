require("ts-node/register/transpile-only")

const assert = require("assert")
const bundledCharacters = require("../assets/character.json")
const bundledCharacterText = require("../assets/cdndata/character_text.json")
const bundledGachas = require("../assets/gacha.json")
const bundledGachaPools = require("../assets/gacha_pool.json")
const bundledCampaigns = require("../assets/gacha_campaign_definitions.json")
const bundledStarsCampaigns = require("../assets/stars_gacha_campaign.json")
const bundledEquipmentLookup = require("../assets/equipment_lookup.json")
const bundledItemLookup = require("../assets/item_lookup.json")
const bundledMovieProbability = require("../assets/equipment_gacha_movie_probability.json")
const bundledExchangeRates = require("../assets/gacha_exchange_rate.json")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")

const {
    buildShortUpCharacterGachaTimeline,
} = require("../src/lib/admin-clairvoyance")

function repository(
    characterMeta,
    characterText,
    gachas = bundledGachas,
    gachaPools = bundledGachaPools,
    // Partial-injection repositories only carry gacha 900002, so the bundled
    // campaign/stars definitions would dangle; they must be empty there. The
    // gacha catalog validates every remaining auxiliary table strictly.
    { campaignTables = true } = {},
) {
    return Object.freeze({
        info: () => Object.freeze({
            source: "release",
            assetVersion: "test-release",
            generatorVersion: 1,
            releaseDigest: null,
        }),
        table: (tableName) => {
            if (tableName === "gacha.json") return gachas
            if (tableName === "gacha_pool.json") return gachaPools
            if (tableName === "character.json") return characterMeta
            if (tableName === "cdndata/character_text.json") return characterText
            if (tableName === "gacha_campaign_definitions.json") {
                return campaignTables ? bundledCampaigns : {}
            }
            if (tableName === "stars_gacha_campaign.json") {
                return campaignTables ? bundledStarsCampaigns : {}
            }
            if (tableName === "gacha_exchange_rate.json") return bundledExchangeRates
            if (tableName === "equipment_lookup.json") return bundledEquipmentLookup
            if (tableName === "item_lookup.json") return bundledItemLookup
            if (tableName === "equipment_gacha_movie_probability.json") return bundledMovieProbability
            throw new Error(`unexpected content table: ${tableName}`)
        },
    })
}

const previousSnapshot = productionContentSnapshotProvider.snapshot
const targetGachaItems = Object.values(bundledGachas["900002"].poolOddsIds)
    .flatMap(oddsId => bundledGachaPools[oddsId])
    .filter(item => item.id === 121069)
const originalRarities = targetGachaItems.map(item => ({
    item,
    hasRarity: Object.hasOwn(item, "rarity"),
    rarity: item.rarity,
}))
productionContentSnapshotProvider.snapshot = Object.freeze({
    cdn: Object.freeze({ targetVersion: "1.4.54" }),
    repository: repository(bundledCharacters, bundledCharacterText),
})

try {
    const timeline = buildShortUpCharacterGachaTimeline(new Date("2021-10-18T14:00:00.000Z"))

    assert.strictEqual(timeline.scope, "short-up-character-gacha")
    assert(timeline.timeline.length > 300, "应解析固定 CDN 基线内的短期 UP 角色池")
    assert(timeline.current.length >= 2, "2021-10-18 22:00 中国时间应能命中同时生效的短期 UP 角色池")
    assert(timeline.current.some((gacha) => gacha.id === 96), "应包含复刻角色特选扭蛋 #96")
    assert(timeline.current.some((gacha) => gacha.id === 900002), "应包含当晚临时新角色特选扭蛋 #900002")
    assert(timeline.timeline.every((gacha) => gacha.type === "character"), "时间线不应包含装备池")
    assert(timeline.timeline.every((gacha) => gacha.pageKind === 0), "第一阶段不应包含福袋、票池、星之英雄等特殊 pageKind")
    assert(timeline.timeline.every((gacha) => gacha.rateUpCharacters.length > 0), "第一阶段只展示含 UP 角色的卡池")
    assert(timeline.timeline.every((gacha) => gacha.durationDays > 0 && gacha.durationDays <= 60), "第一阶段只展示短期池")

    const beastFighter = timeline.searchIndex.find((row) => row.characterId === 121069)
    assert(beastFighter, "搜索索引应包含 UP 角色 #121069")
    assert.strictEqual(beastFighter.name, "谢胧")
    assert(beastFighter.gachas.some((gacha) => gacha.id === 900002), "角色搜索应能反查到对应卡池")

    // Catalog validation pins character.json rarity to the pool rank (5), so
    // the injected table overrides rarity-compatible fields only; element 8
    // stays distinct from the bundled value and proves the override flows.
    const injectedCharacter = Object.freeze({
        name: "",
        rarity: 5,
        element: 8,
        skill_count: 6,
    })
    const injectedTextRow = Array(12).fill("")
    injectedTextRow[0] = "Release角色名"
    injectedTextRow[3] = "Release角色称号"
    // The injected pools still reference other characters for rarity checks.
    const injectedCharacters = Object.freeze({
        ...bundledCharacters,
        "121069": injectedCharacter,
    })
    const injectedText = Object.freeze({
        ...bundledCharacterText,
        "121069": Object.freeze([Object.freeze(injectedTextRow)]),
    })
    const injectedGacha = structuredClone(bundledGachas["900002"])
    injectedGacha.name = "Release卡池名"
    const injectedGachaPools = Object.fromEntries(
        Object.values(injectedGacha.poolOddsIds).map(oddsId => [
            oddsId,
            structuredClone(bundledGachaPools[oddsId]),
        ]),
    )
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: Object.freeze({ targetVersion: "test-release" }),
        repository: repository(
            injectedCharacters,
            injectedText,
            Object.freeze({ "900002": Object.freeze(injectedGacha) }),
            Object.freeze(injectedGachaPools),
            { campaignTables: false },
        ),
    })

    const releaseTimelineWithGachaRarity = buildShortUpCharacterGachaTimeline(
        new Date("2021-10-18T14:00:00.000Z"),
    )
    const releaseCharacterWithGachaRarity = releaseTimelineWithGachaRarity.timeline
        .find(gacha => gacha.id === 900002)
        .rateUpCharacters
        .find(character => character.id === 121069)
    assert.strictEqual(
        releaseCharacterWithGachaRarity.rarity,
        originalRarities[0].rarity,
        "gacha 行提供 rarity 时应保持原有优先级",
    )

    // The first timeline build deep-freezes the shared pool items through the
    // gacha catalog, so deleting `rarity` in place is a silent no-op now. The
    // no-gacha-rarity case instead installs fresh clones with the field
    // stripped; catalog validation only pins `rank`, never `item.rarity`.
    const injectedGachaPoolsWithoutRarity = Object.fromEntries(
        Object.entries(injectedGachaPools).map(([oddsId, items]) => [
            oddsId,
            items.map(item => item.id === 121069
                ? Object.fromEntries(Object.entries(item).filter(([field]) => field !== "rarity"))
                : item),
        ]),
    )
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: Object.freeze({ targetVersion: "test-release-without-gacha-rarity" }),
        repository: repository(
            injectedCharacters,
            injectedText,
            Object.freeze({ "900002": Object.freeze(injectedGacha) }),
            Object.freeze(injectedGachaPoolsWithoutRarity),
            { campaignTables: false },
        ),
    })
    const releaseTimeline = buildShortUpCharacterGachaTimeline(
        new Date("2021-10-18T14:00:00.000Z"),
    )
    const releaseCharacter = releaseTimeline.timeline
        .find(gacha => gacha.id === 900002)
        .rateUpCharacters
        .find(character => character.id === 121069)
    assert(releaseCharacter, "注入 Release 后仍应找到角色 #121069")
    assert.strictEqual(
        releaseTimeline.timeline.find(gacha => gacha.id === 900002).name,
        "Release卡池名",
        "admin 卡池定义必须与角色和文本来自同一 Repository",
    )
    assert.strictEqual(releaseCharacter.name, "Release角色名")
    assert.strictEqual(releaseCharacter.title, "Release角色称号")
    assert.strictEqual(releaseCharacter.rarity, injectedCharacter.rarity)
    assert.strictEqual(releaseCharacter.element, injectedCharacter.element)

    let tableReads = 0
    const cachedRepository = Object.freeze({
        info: () => Object.freeze({
            source: "release",
            assetVersion: "cache-test",
            generatorVersion: 1,
            releaseDigest: null,
        }),
        table: (tableName) => {
            tableReads++
            if (tableName === "gacha.json") return Object.freeze({ "900002": Object.freeze(injectedGacha) })
            if (tableName === "gacha_pool.json") return Object.freeze(injectedGachaPools)
            if (tableName === "character.json") return injectedCharacters
            if (tableName === "cdndata/character_text.json") return injectedText
            if (tableName === "gacha_campaign_definitions.json") return {}
            if (tableName === "stars_gacha_campaign.json") return {}
            if (tableName === "gacha_exchange_rate.json") return bundledExchangeRates
            if (tableName === "equipment_lookup.json") return bundledEquipmentLookup
            if (tableName === "item_lookup.json") return bundledItemLookup
            if (tableName === "equipment_gacha_movie_probability.json") return bundledMovieProbability
            throw new Error(`unexpected content table: ${tableName}`)
        },
    })
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: Object.freeze({ targetVersion: "cache-test" }),
        repository: cachedRepository,
    })

    const cachedFirst = buildShortUpCharacterGachaTimeline(new Date("2021-10-18T14:00:00.000Z"))
    const cachedSecond = buildShortUpCharacterGachaTimeline(new Date("2021-10-18T15:00:00.000Z"))
    // One build per fixed repository: 9 gacha catalog tables + character.json
    // (facts) + character_text.json (display text) = 11 reads, then cached.
    assert.strictEqual(tableReads, 11, "同一个固定 Repository 只应构建一次静态千里眼数据")
    assert.notStrictEqual(cachedFirst.currentTime, cachedSecond.currentTime)
} finally {
    for (const { item, hasRarity, rarity } of originalRarities) {
        if (hasRarity) item.rarity = rarity
        else delete item.rarity
    }
    productionContentSnapshotProvider.snapshot = previousSnapshot
}

console.log("admin-clairvoyance tests passed")
