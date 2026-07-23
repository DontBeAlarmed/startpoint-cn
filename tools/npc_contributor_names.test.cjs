const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

function loadValidator() {
    try {
        return require("./npc_contributor_names.cjs").validateNpcContributorNames
    } catch (error) {
        assert.fail(`NPC contributor name validator is unavailable: ${error.message}`)
    }
}

function validNames(names = ["开心超人", "名字真难取"]) {
    return {
        schemaVersion: 1,
        names,
    }
}

test("accepts a valid contributor NPC nickname asset", () => {
    const validateNpcContributorNames = loadValidator()

    assert.doesNotThrow(() => validateNpcContributorNames(validNames(), 12))
})

test("validates the repository contributor NPC nickname asset against live config", () => {
    const validateNpcContributorNames = loadValidator()
    const projectRoot = path.resolve(__dirname, "..")
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "assets", "config.json"), "utf8"))
    const names = JSON.parse(fs.readFileSync(
        path.join(projectRoot, "assets", "server", "npc_contributor_names.json"),
        "utf8",
    ))

    assert.doesNotThrow(() => {
        validateNpcContributorNames(names, config.max_player_name_length)
    })
})

test("rejects invalid root schemas", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames(null, 12))
    assert.throws(() => validateNpcContributorNames({ names: ["开心超人"] }, 12))
    assert.throws(() => validateNpcContributorNames(validNames(), 0))
    assert.throws(() => validateNpcContributorNames({ ...validNames(), schemaVersion: 2 }, 12))
})

test("rejects extra root keys", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames({ ...validNames(), playerId: 1 }, 12))
})

test("rejects an empty names array", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames(validNames([]), 12))
})

test("rejects names values that are not arrays", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames({ schemaVersion: 1, names: {} }, 12))
    assert.throws(() => validateNpcContributorNames({ schemaVersion: 1, names: "开心超人" }, 12))
})

test("rejects blank-only nicknames", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames(validNames([""]), 12))
    assert.throws(() => validateNpcContributorNames(validNames(["   "]), 12))
})

test("rejects non-string nicknames", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames(validNames([123]), 12))
})

test("rejects nicknames with leading or trailing whitespace", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames(validNames([" 开心超人"]), 12))
    assert.throws(() => validateNpcContributorNames(validNames(["开心超人 "]), 12))
})

test("rejects C0 and DEL control characters", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames(validNames(["开心\u0000超人"]), 12))
    assert.throws(() => validateNpcContributorNames(validNames(["开心\u001f超人"]), 12))
    assert.throws(() => validateNpcContributorNames(validNames(["开心\u007f超人"]), 12))
})

test("uses JavaScript UTF-16 length for emoji limits", () => {
    const validateNpcContributorNames = loadValidator()

    assert.doesNotThrow(() => validateNpcContributorNames(validNames(["😀"]), 2))
    assert.throws(() => validateNpcContributorNames(validNames(["😀"]), 1))
})

test("rejects identical duplicate nicknames", () => {
    const validateNpcContributorNames = loadValidator()

    assert.throws(() => validateNpcContributorNames(validNames(["开心超人", "开心超人"]), 12))
})
