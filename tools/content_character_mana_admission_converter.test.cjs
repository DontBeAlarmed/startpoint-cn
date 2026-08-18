"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { canonicalJsonBuffer, sha256Object } = require("../src/content/sync/canonical-json")

const {
    serializeNestedOrderedMap,
    serializeOrderedMap,
} = require("./orderedmap_serializer.cjs")
const official = require("./fixtures/content-character-mana/official-1.4.54-summary.json")

let convertCharacterManaAdmissionTables
let getCharacterLevelByExperience
let parseCharacterLevelTable
let parseLevelRequiredManaNodeTable
try {
    ;({ convertCharacterManaAdmissionTables } = require(
        "../src/content/converters/character-mana-admission"
    ))
    ;({
        getCharacterLevelByExperience,
        parseCharacterLevelTable,
        parseLevelRequiredManaNodeTable,
    } = require("../src/content/character-mana-admission"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

const LEVEL_PATH = official.sources.levelRequirements
const CHARACTER_LEVEL_PATH = official.sources.characterLevels
const BUNDLED_ARCHIVE_PATH =
    "production/android_bundle/23/a83b55daad153a95f8d5b66667b32e47f3dca2"
const BUNDLED_BLOB_SHA256 =
    "eb21a7fe67d9f58730235ce276d1421b26a14cb84e7d27fd35cb2e0cae2b3565"

function flat(entries) {
    return serializeOrderedMap(entries.map(([key, row]) => ({ key, row: row.join(",") })))
}

function nested(entries) {
    return serializeNestedOrderedMap(entries.map(([rarity, levels]) => ({
        key: rarity,
        row: flat(levels),
    })))
}

function curve(multiplier) {
    return Array.from({ length: 100 }, (_, index) => index * multiplier)
}

function curveRows(values) {
    return values.map((total, index) => [String(index + 1), [String(total)]])
}

function expandedCurve(values) {
    return Object.fromEntries(values.map((total, index) => [String(index + 1), total]))
}

function bundledSeedFixture() {
    const curves = {
        "3": curve(3),
        "4": curve(4),
        "5": curve(5),
    }
    return {
        schemaVersion: 1,
        source: {
            archiveLogicalPath: BUNDLED_ARCHIVE_PATH,
            blobSha256: BUNDLED_BLOB_SHA256,
        },
        summary: {
            rarities: [3, 4, 5],
            levelsPerRarity: 100,
            curves: Object.fromEntries(Object.entries(curves).map(([rarity, values]) => [
                rarity,
                {
                    level80: values[79],
                    level90: values[89],
                    level100: values[99],
                    digest: sha256Object(canonicalJsonBuffer(expandedCurve(values))),
                },
            ])),
        },
        curves,
    }
}

function compatibility(seed = bundledSeedFixture()) {
    return { characterLevelBundledSeed: seed }
}

function sourceFixture({
    requirements = Object.entries(official.levelRequirementRows),
    characterLevels = [
        ["1", curveRows(curve(1))],
        ["2", curveRows(curve(2))],
    ],
} = {}) {
    const sources = new Map([
        [LEVEL_PATH, flat(requirements)],
        [CHARACTER_LEVEL_PATH, nested(characterLevels)],
    ])
    const requested = []
    return {
        requested,
        async readBytes(logicalPath) {
            requested.push(logicalPath)
            const value = sources.get(logicalPath)
            if (!value) throw new Error(`unexpected source ${logicalPath}`)
            return value
        },
    }
}

test("converter parses Option levels and cumulative character experience", async () => {
    assert.equal(typeof convertCharacterManaAdmissionTables, "function")
    const reader = sourceFixture()
    const output = await convertCharacterManaAdmissionTables(reader, compatibility())

    assert.deepEqual(reader.requested, [LEVEL_PATH, CHARACTER_LEVEL_PATH])
    assert.deepEqual(output["level_required_mana_node.json"]["3"], {
        abilityLevels: [null, 10, 40, 90, 95, 100],
        skillEvolutionLevel: 25,
    })
    assert.deepEqual(Object.keys(output["character_level.json"]), ["1", "2", "3", "4", "5"])
    assert.deepEqual(output["character_level.json"]["1"], expandedCurve(curve(1)))
    assert.deepEqual(output["character_level.json"]["5"], expandedCurve(curve(5)))
    assert.equal(Object.isFrozen(output["level_required_mana_node.json"]["3"].abilityLevels), true)
})

test("level requirement converter rejects malformed Option values and unknown rarity", async () => {
    for (const value of ["", "0", "-1", "+10", "01", "10.0", " 10", "9007199254740992"]) {
        const rows = Object.entries(official.levelRequirementRows).map(([rarity, row]) => [
            rarity,
            rarity === "3" ? [row[0], value, ...row.slice(2)] : row,
        ])
        await assert.rejects(
            convertCharacterManaAdmissionTables(sourceFixture({ requirements: rows }), compatibility()),
            /ability_2.*positive safe integer/i,
            value,
        )
    }

    await assert.rejects(
        convertCharacterManaAdmissionTables(sourceFixture({
            requirements: Object.entries(official.levelRequirementRows).filter(([rarity]) => rarity !== "5"),
        }), compatibility()),
        /rarities 1 through 5/i,
    )
    await assert.rejects(
        convertCharacterManaAdmissionTables(sourceFixture({
            requirements: [...Object.entries(official.levelRequirementRows), ["6", official.levelRequirementRows["5"]]],
        }), compatibility()),
        /rarity.*1 through 5/i,
    )
})

test("character level converter rejects non-canonical keys, unsafe values, gaps, and non-monotonic curves", async () => {
    const invalidFixtures = [
        [["01", [["1", ["0"]], ["2", ["10"]]]]],
        [["1", [["01", ["0"]], ["2", ["10"]]]]],
        [["1", [["1", ["0"]], ["3", ["20"]]]]],
        [["1", [["1", ["0"]], ["2", ["0"]]]]],
        [["1", [["1", ["0"]], ["2", ["9007199254740992"]]]]],
    ]
    for (const characterLevels of invalidFixtures) {
        await assert.rejects(
            convertCharacterManaAdmissionTables(
                sourceFixture({ characterLevels }),
                compatibility(),
            ),
            /invalid character level content/i,
        )
    }
})

test("character level converter requires complete ordinary and bundled shards", async () => {
    await assert.rejects(
        convertCharacterManaAdmissionTables(sourceFixture({
            characterLevels: [["1", curveRows(curve(1))]],
        }), compatibility()),
        /ordinary shard.*rarities 1 and 2/i,
    )
    await assert.rejects(
        convertCharacterManaAdmissionTables(sourceFixture({
            characterLevels: [
                ["1", curveRows(curve(1))],
                ["2", curveRows(curve(2))],
                ["3", curveRows(curve(3))],
            ],
        }), compatibility()),
        /duplicate rarity 3/i,
    )

    const missingRarity = bundledSeedFixture()
    delete missingRarity.curves["5"]
    await assert.rejects(
        convertCharacterManaAdmissionTables(sourceFixture(), compatibility(missingRarity)),
        /bundled seed.*rarities 3 through 5/i,
    )
})

test("character level converter rejects damaged bundled seed curves and metadata", async () => {
    const damagedFixtures = [
        (() => {
            const seed = bundledSeedFixture()
            seed.curves["3"].pop()
            return seed
        })(),
        (() => {
            const seed = bundledSeedFixture()
            seed.curves["4"][40] = seed.curves["4"][39]
            return seed
        })(),
        (() => {
            const seed = bundledSeedFixture()
            seed.summary.curves["5"].digest = `sha256:${"0".repeat(64)}`
            return seed
        })(),
        (() => {
            const seed = bundledSeedFixture()
            seed.source.blobSha256 = "not-a-sha256"
            return seed
        })(),
    ]
    for (const seed of damagedFixtures) {
        await assert.rejects(
            convertCharacterManaAdmissionTables(sourceFixture(), compatibility(seed)),
            /invalid character level bundled seed/i,
        )
    }
})

test("bundled official curves derive exact levels at admission boundaries", () => {
    assert.equal(typeof parseCharacterLevelTable, "function")
    assert.equal(typeof getCharacterLevelByExperience, "function")
    const table = parseCharacterLevelTable(require("../assets/character_level.json"))
    for (const [rarityText, curveSummary] of Object.entries(
        official.characterLevelSummary.curves
    )) {
        const rarity = Number(rarityText)
        for (const [levelText, totalExperience] of Object.entries(curveSummary.boundaryRows)) {
            const level = Number(levelText)
            assert.equal(getCharacterLevelByExperience(table, rarity, totalExperience), level)
            if (level > 1) {
                assert.equal(
                    getCharacterLevelByExperience(table, rarity, totalExperience - 1),
                    level - 1,
                )
            }
        }
    }
    assert.notEqual(table["3"]["80"], table["4"]["80"])
    assert.notEqual(table["4"]["90"], table["5"]["90"])
})

test("runtime level requirement parser fails closed for unknown and damaged content", () => {
    assert.equal(typeof parseLevelRequiredManaNodeTable, "function")
    const parsed = parseLevelRequiredManaNodeTable(require("../assets/level_required_mana_node.json"))
    assert.deepEqual(parsed["5"].abilityLevels, [null, 10, 40, 90, 95, 100])
    assert.throws(
        () => parseLevelRequiredManaNodeTable({ ...parsed, "6": parsed["5"] }),
        /rarity.*1 through 5/i,
    )
    assert.throws(
        () => parseCharacterLevelTable({ "1": { "1": 0, "2": 0 } }),
        /rarity keys must be 1 through 5/i,
    )
    const full = Object.fromEntries([1, 2, 3, 4, 5].map(rarity => [
        String(rarity),
        expandedCurve(curve(rarity)),
    ]))
    delete full["5"]["100"]
    assert.throws(
        () => parseCharacterLevelTable(full),
        /exactly levels 1 through 100/i,
    )
})

test("bundled character levels cover every production character rarity", () => {
    const table = parseCharacterLevelTable(require("../assets/character_level.json"))
    const characters = Object.values(require("../assets/character.json"))
    const counts = characters.reduce((result, character) => {
        result[character.rarity] = (result[character.rarity] ?? 0) + 1
        return result
    }, {})

    assert.equal(characters.length, 505)
    assert.deepEqual(counts, { "1": 7, "2": 5, "3": 80, "4": 164, "5": 249 })
    assert.ok(characters.every(character => table[String(character.rarity)] !== undefined))
})

test("bundled Content repository exposes both admission tables", async () => {
    const { ContentRepository } = require("../src/content/runtime/content-repository")
    const { ContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
    const repository = await ContentRepository.loadFromSnapshot({
        projectRoot: require("node:path").resolve(__dirname, ".."),
    }, null)
    const provider = new ContentSnapshotProvider({
        snapshotSource: {
            async load() {
                return {
                    cdn: {},
                    archiveSources: { schemaVersion: 1, archives: [] },
                    repository,
                }
            },
        },
    })
    const runtimeSnapshot = await provider.initialize()

    assert.deepEqual(
        runtimeSnapshot.repository.table("level_required_mana_node.json"),
        require("../assets/level_required_mana_node.json"),
    )
    assert.deepEqual(
        runtimeSnapshot.repository.table("character_level.json"),
        require("../assets/character_level.json"),
    )
})

test("quick content selector includes character mana admission coverage", () => {
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.ok(TEST_GROUPS["quick:content"].tests.includes(
        "tools/content_character_mana_admission_converter.test.cjs",
    ))
})
