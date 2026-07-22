require("ts-node/register/transpile-only")

const assert = require("assert")
const bundledCharacters = require("../assets/character.json")
const bundledCharacterText = require("../assets/cdndata/character_text.json")
const bundledGachas = require("../assets/gacha.json")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const { getCharacterDataSync } = require("../src/lib/assets")

const {
    buildShortUpCharacterGachaTimeline,
} = require("../src/lib/admin-clairvoyance")

function repository(characterMeta, characterText) {
    return Object.freeze({
        info: () => Object.freeze({
            source: "release",
            assetVersion: "test-release",
            generatorVersion: 1,
            releaseDigest: null,
        }),
        table: (tableName) => {
            if (tableName === "character.json") return characterMeta
            if (tableName === "cdndata/character_text.json") return characterText
            throw new Error(`unexpected content table: ${tableName}`)
        },
    })
}

const previousSnapshot = productionContentSnapshotProvider.snapshot
const targetGachaItems = Object.values(bundledGachas["900002"].pool)
    .flat()
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

    const injectedCharacter = Object.freeze({
        name: "",
        rarity: 9,
        element: 8,
        skill_count: 6,
    })
    const injectedTextRow = Array(12).fill("")
    injectedTextRow[0] = "Release角色名"
    injectedTextRow[3] = "Release角色称号"
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: Object.freeze({ targetVersion: "test-release" }),
        repository: repository(
            Object.freeze({ "121069": injectedCharacter }),
            Object.freeze({ "121069": Object.freeze([Object.freeze(injectedTextRow)]) }),
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

    for (const { item } of originalRarities) delete item.rarity
    const releaseTimeline = buildShortUpCharacterGachaTimeline(
        new Date("2021-10-18T14:00:00.000Z"),
    )
    const releaseCharacter = releaseTimeline.timeline
        .find(gacha => gacha.id === 900002)
        .rateUpCharacters
        .find(character => character.id === 121069)
    assert(releaseCharacter, "注入 Release 后仍应找到角色 #121069")
    assert.strictEqual(releaseCharacter.name, "Release角色名")
    assert.strictEqual(releaseCharacter.title, "Release角色称号")
    assert.strictEqual(releaseCharacter.rarity, injectedCharacter.rarity)
    assert.strictEqual(releaseCharacter.element, injectedCharacter.element)
    assert.strictEqual(getCharacterDataSync(121069), injectedCharacter)
} finally {
    for (const { item, hasRarity, rarity } of originalRarities) {
        if (hasRarity) item.rarity = rarity
        else delete item.rarity
    }
    productionContentSnapshotProvider.snapshot = previousSnapshot
}

console.log("admin-clairvoyance tests passed")
