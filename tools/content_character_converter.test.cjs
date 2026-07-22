"use strict"

const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

let convertCharacters
try {
    ({ convertCharacters } = require("../src/content/converters/character"))
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

let officialSkillCountGolden
try {
    officialSkillCountGolden = require("./fixtures/content-character/skill-count-1.4.54.json")
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

function encodeCsv(fields) {
    return fields.map((field) => (
        /[",\r\n]/.test(field)
            ? `"${field.replaceAll('"', '""')}"`
            : field
    )).join(",")
}

function characterRow({ race = "Human,Beast", rarity = "5", element = "3", skills = "6,6,6,0,0,0" } = {}) {
    const fields = Array(37).fill("")
    fields[0] = "fixture"
    fields[2] = rarity
    fields[3] = element
    fields[4] = race
    fields[36] = skills
    return fields
}

function characterTextRow() {
    const fields = Array(12).fill("")
    fields[0] = '带逗号,且称作"星之子"'
    fields[3] = "测试称号"
    return fields
}

function convertOne({ key = "10", character = characterRow(), text = characterTextRow() } = {}) {
    return convertCharacters({
        characterRows: [{ key, text: encodeCsv(character) }],
        characterTextRows: [{ key, text: encodeCsv(text) }],
    })
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("character converter preserves strict CSV fields and builds all compatibility tables", () => {
    assert.equal(typeof convertCharacters, "function", "角色转换器应导出 convertCharacters")

    const rawCharacter = characterRow()
    const rawText = characterTextRow()
    const output = convertCharacters({
        characterRows: [{ key: "10", text: encodeCsv(rawCharacter) }],
        characterTextRows: [{ key: "10", text: encodeCsv(rawText) }],
    })

    assert.deepEqual(output["character.json"], {
        "10": { name: "", rarity: 5, element: 3, skill_count: 3 },
    })
    assert.deepEqual(output["cdndata/character.json"], { "10": [rawCharacter] })
    assert.deepEqual(output["cdndata/character_text.json"], { "10": [rawText] })
})

test("skill_count 只统计 col36 中值恰好为 6 的能力槽", () => {
    const output = convertOne({
        character: characterRow({ skills: "6,5,1,0,6,7" }),
    })

    assert.equal(output["character.json"]["10"].skill_count, 2)
})

test("character converter validates canonical unique keys and exact column counts", () => {
    for (const key of ["", "0", "-1", "+1", "01", "1.0", " 1", "1 "]) {
        assert.throws(() => convertOne({ key }), /canonical positive integer/i, key)
    }

    assert.throws(() => convertCharacters({
        characterRows: [
            { key: "10", text: encodeCsv(characterRow()) },
            { key: "10", text: encodeCsv(characterRow()) },
        ],
        characterTextRows: [{ key: "10", text: encodeCsv(characterTextRow()) }],
    }), /duplicate key.*10/i)

    assert.throws(() => convertOne({ character: characterRow().slice(0, 36) }), /37 columns/i)
    assert.throws(() => convertOne({ text: characterTextRow().slice(0, 11) }), /12 columns/i)
})

test("character converter rejects malformed integers, skill lists, and CSV quoting", () => {
    for (const rarity of ["", " 5", "5 ", "+5", "05", "5.0", "9007199254740992"]) {
        assert.throws(() => convertOne({ character: characterRow({ rarity }) }), /rarity.*integer/i)
    }
    for (const element of ["", " 3", "3 ", "+3", "03", "3.0", "9007199254740992"]) {
        assert.throws(() => convertOne({ character: characterRow({ element }) }), /element.*integer/i)
    }
    for (const skills of ["", "6,,6", "6, 6", "6,-1", "6,+6", "6,06", "6,6.0"] ) {
        assert.throws(() => convertOne({ character: characterRow({ skills }) }), /skills/i)
    }

    const validCharacter = encodeCsv(characterRow())
    assert.throws(() => convertCharacters({
        characterRows: [{ key: "10", text: `${validCharacter}\n` }],
        characterTextRows: [{ key: "10", text: encodeCsv(characterTextRow()) }],
    }), /single CSV line/i)
    for (const malformedText of [
        `"${characterTextRow().join(",")}`,
        `illegal"quote,${Array(11).fill("").join(",")}`,
        `"closed"illegal,${Array(11).fill("").join(",")}`,
    ]) {
        assert.throws(() => convertCharacters({
            characterRows: [{ key: "10", text: validCharacter }],
            characterTextRows: [{ key: "10", text: malformedText }],
        }), /quote/i)
    }

    const textWithQuotedNewline = characterTextRow()
    textWithQuotedNewline[5] = "第一行\n第二行"
    assert.deepEqual(
        convertOne({ text: textWithQuotedNewline })["cdndata/character_text.json"]["10"],
        [textWithQuotedNewline],
    )
})

test("character converter deeply freezes output without mutating input and orders keys", () => {
    const characterRows = [
        { key: "100000000000000000001", text: encodeCsv(characterRow()) },
        { key: "9", text: encodeCsv(characterRow()) },
        { key: "99999999999999999999", text: encodeCsv(characterRow()) },
    ]
    const characterTextRows = characterRows.map(row => ({
        key: row.key,
        text: encodeCsv(characterTextRow()),
    }))
    const before = structuredClone({ characterRows, characterTextRows })
    const output = convertCharacters({ characterRows, characterTextRows })

    assert.deepEqual({ characterRows, characterTextRows }, before)
    assert.deepEqual(Object.keys(output["character.json"]), [
        "9",
        "99999999999999999999",
        "100000000000000000001",
    ])
    assertDeepFrozen(output)
})

const projectRoot = path.resolve(__dirname, "..")
test("官方 1.4.54 全量重建 cdndata，并记录 bundled 历史兼容基线差异", () => {
    const trackedCharacters = require("../assets/character.json")
    const trackedCdnCharacters = require("../assets/cdndata/character.json")
    const trackedCdnCharacterText = require("../assets/cdndata/character_text.json")
    const toRows = table => Object.entries(table).map(([key, rows]) => {
        assert.equal(rows.length, 1, `official ${key} must have exactly one row`)
        return { key, text: encodeCsv(rows[0]) }
    })

    const output = convertCharacters({
        characterRows: toRows(trackedCdnCharacters),
        characterTextRows: toRows(trackedCdnCharacterText),
    })

    assert.equal(Object.keys(output["character.json"]).length, 505)
    assert.deepEqual(output["cdndata/character.json"], trackedCdnCharacters)
    assert.deepEqual(output["cdndata/character_text.json"], trackedCdnCharacterText)
    assert.ok(officialSkillCountGolden, "应存在 tracked 1.4.54 skill_count golden")
    assert.equal(Object.keys(officialSkillCountGolden).length, 505)
    assert.deepEqual(
        Object.fromEntries(Object.entries(output["character.json"]).map(([id, value]) => (
            [id, value.skill_count]
        ))),
        officialSkillCountGolden,
    )

    for (const id of Object.keys(trackedCdnCharacters)) {
        const official = output["character.json"][id]
        const tracked = trackedCharacters[id]
        assert.equal(official.name, tracked.name, `${id}.name`)
        assert.equal(official.rarity, tracked.rarity, `${id}.rarity`)
        assert.equal(official.element, tracked.element, `${id}.element`)
    }

    assert.equal(output["character.json"]["111129"].skill_count, 6)
    assert.equal(output["character.json"]["111081"].skill_count, 6)

    // bundled 保留历史兼容基线；Release 则按官方 1.4.54 master 重建。
    const historicalDifferences = Object.keys(trackedCharacters).filter(id => (
        output["character.json"][id].skill_count !== trackedCharacters[id].skill_count
    ))
    assert.equal(historicalDifferences.length, 45)
    assert.ok(historicalDifferences.every(id => (
        trackedCharacters[id].skill_count === 3
        && output["character.json"][id].skill_count === 6
    )))

    const specialTwoSkillCharacters = Object.keys(trackedCharacters).filter(id => (
        trackedCharacters[id].skill_count === 2
    ))
    assert.equal(specialTwoSkillCharacters.length, 12)
    assert.ok(specialTwoSkillCharacters.every(id => (
        output["character.json"][id].skill_count === 2
    )))
})

test("quick:content includes the character converter regression suite", () => {
    const { TEST_GROUPS } = require("./test-workflow/groups.cjs")
    assert.ok(TEST_GROUPS["quick:content"].tests.includes(
        "tools/content_character_converter.test.cjs",
    ))
})
