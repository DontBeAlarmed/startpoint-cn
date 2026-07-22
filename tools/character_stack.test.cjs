require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { validateCharacterStackConversion } = require("../src/lib/character-stack")
const bundledCharacters = require("../assets/character.json")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const { getCharacterDataSync } = require("../src/lib/assets")

assert.equal(validateCharacterStackConversion(2, 1, false), null)
assert.equal(validateCharacterStackConversion(2, 2, false), null)
assert.equal(validateCharacterStackConversion(2, 3, false), "Not enough stack.")
assert.equal(validateCharacterStackConversion(2, 1, true), "Protected character cannot be converted.")
assert.equal(validateCharacterStackConversion(2, 0, false), "Invalid conversion count.")
assert.equal(validateCharacterStackConversion(2, -1, false), "Invalid conversion count.")
assert.equal(validateCharacterStackConversion(2, 1.5, false), "Invalid conversion count.")

test("getCharacterDataSync 从当前 Snapshot Repository 读取角色元数据", t => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const releaseCharacter = Object.freeze({
        name: "release-character",
        rarity: 5,
        element: 4,
        skill_count: 6,
    })
    const requestedTables = []
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: Object.freeze({ targetVersion: "test-release" }),
        repository: Object.freeze({
            info: () => Object.freeze({
                source: "release",
                assetVersion: "test-release",
                generatorVersion: 1,
                releaseDigest: null,
            }),
            table: (tableName) => {
                requestedTables.push(tableName)
                assert.equal(tableName, "character.json")
                return Object.freeze({ "111129": releaseCharacter })
            },
        }),
    })
    t.after(() => { productionContentSnapshotProvider.snapshot = previousSnapshot })

    assert.equal(bundledCharacters["111129"].skill_count, 3)
    assert.strictEqual(getCharacterDataSync(111129), releaseCharacter)
    assert.deepEqual(requestedTables, ["character.json"])
    assert.equal(getCharacterDataSync(99999999), null)
})
