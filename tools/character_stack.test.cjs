require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const { validateCharacterStackConversion } = require("../src/lib/character-stack")
const bundledCharacters = require("../assets/character.json")
const { installFrozenTestContentSnapshot } = require("./helpers/content-snapshot-fixture.cjs")
const { getCharacterFacts } = require("../src/lib/character-content")

assert.equal(validateCharacterStackConversion(2, 1, false), null)
assert.equal(validateCharacterStackConversion(2, 2, false), null)
assert.equal(validateCharacterStackConversion(2, 3, false), "Not enough stack.")
assert.equal(validateCharacterStackConversion(2, 1, true), "Protected character cannot be converted.")
assert.equal(validateCharacterStackConversion(2, 0, false), "Invalid conversion count.")
assert.equal(validateCharacterStackConversion(2, -1, false), "Invalid conversion count.")
assert.equal(validateCharacterStackConversion(2, 1.5, false), "Invalid conversion count.")

test("CharacterFacts 从当前 Snapshot Repository 读取角色元数据", t => {
    // The unified fixture repository throws for any table it was not given,
    // so CharacterFacts reading anything beyond character.json fails loudly.
    const install = installFrozenTestContentSnapshot({
        targetVersion: "test-release",
        tables: {
            "character.json": {
                "111129": {
                    name: "release-character",
                    rarity: 5,
                    element: 4,
                    skill_count: 6,
                },
            },
        },
    })
    t.after(install.restore)

    assert.equal(bundledCharacters["111129"].skill_count, 3)
    assert.deepEqual(getCharacterFacts().get(111129), {
        rarity: 5,
        element: 4,
        skillCount: 6,
    })
    assert.equal(getCharacterFacts().get(99999999), null)
})
