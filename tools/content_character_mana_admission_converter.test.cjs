"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

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

function flat(entries) {
    return serializeOrderedMap(entries.map(([key, row]) => ({ key, row: row.join(",") })))
}

function nested(entries) {
    return serializeNestedOrderedMap(entries.map(([rarity, levels]) => ({
        key: rarity,
        row: flat(levels),
    })))
}

function sourceFixture({
    requirements = Object.entries(official.levelRequirementRows),
    characterLevels = [
        ["1", [["1", ["0"]], ["2", ["10"]], ["3", ["20"]]]],
        ["2", [["1", ["0"]], ["2", ["10"]], ["3", ["20"]]]],
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
    const output = await convertCharacterManaAdmissionTables(reader)

    assert.deepEqual(reader.requested, [LEVEL_PATH, CHARACTER_LEVEL_PATH])
    assert.deepEqual(output["level_required_mana_node.json"]["3"], {
        abilityLevels: [null, 10, 40, 90, 95, 100],
        skillEvolutionLevel: 25,
    })
    assert.deepEqual(output["character_level.json"], {
        "1": { "1": 0, "2": 10, "3": 20 },
        "2": { "1": 0, "2": 10, "3": 20 },
    })
    assert.equal(Object.isFrozen(output["level_required_mana_node.json"]["3"].abilityLevels), true)
})

test("level requirement converter rejects malformed Option values and unknown rarity", async () => {
    for (const value of ["", "0", "-1", "+10", "01", "10.0", " 10", "9007199254740992"]) {
        const rows = Object.entries(official.levelRequirementRows).map(([rarity, row]) => [
            rarity,
            rarity === "3" ? [row[0], value, ...row.slice(2)] : row,
        ])
        await assert.rejects(
            convertCharacterManaAdmissionTables(sourceFixture({ requirements: rows })),
            /ability_2.*positive safe integer/i,
            value,
        )
    }

    await assert.rejects(
        convertCharacterManaAdmissionTables(sourceFixture({
            requirements: Object.entries(official.levelRequirementRows).filter(([rarity]) => rarity !== "5"),
        })),
        /rarities 1 through 5/i,
    )
    await assert.rejects(
        convertCharacterManaAdmissionTables(sourceFixture({
            requirements: [...Object.entries(official.levelRequirementRows), ["6", official.levelRequirementRows["5"]]],
        })),
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
            convertCharacterManaAdmissionTables(sourceFixture({ characterLevels })),
            /invalid character level content/i,
        )
    }
})

test("bundled official curves derive exact levels at admission boundaries", () => {
    assert.equal(typeof parseCharacterLevelTable, "function")
    assert.equal(typeof getCharacterLevelByExperience, "function")
    const table = parseCharacterLevelTable(require("../assets/character_level.json"))
    for (const rarity of official.characterLevelSummary.rarities) {
        for (const [levelText, totalExperience] of Object.entries(
            official.characterLevelSummary.boundaryRows
        )) {
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
    assert.throws(() => getCharacterLevelByExperience(table, 3, 0), /unknown rarity 3/i)
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
        /strictly increasing/i,
    )
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
