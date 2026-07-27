const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const PROJECT_ROOT = path.resolve(__dirname, "..")
const DEFAULT_ASSET_DIRECTORY = path.join(PROJECT_ROOT, "assets")
const DEFAULT_OUTPUT_PATH = path.join(DEFAULT_ASSET_DIRECTORY, "mission_event_battle_rules.json")
const TYPE16_EMPTY_SELECTOR_COMPATIBILITY = "type16-empty-selector-wildcard"

const QUEST_SOURCES = Object.freeze({
    "2": {
        categories: [2],
        fileName: "boss_battle_quest.json",
        range: "BossBattle",
        valuesForQuestId: questId => [
            Math.trunc(questId / 1_000_000),
            Math.trunc(questId / 1_000) % 1_000,
            questId % 1_000,
        ],
        selectorForRow: row => [
            decodeQuestSelector(row[8]),
            decodeQuestSelector(row[9]),
            decodeQuestSelector(row[10]),
        ],
    },
    "5": {
        categories: [7],
        fileName: "advent_event_quest.json",
        range: "AdventEvent",
        valuesForQuestId: questId => [Math.trunc(questId / 1_000), questId % 1_000],
        selectorForRow: row => [singleIdSelector(row[8]), decodeQuestSelector(row[10])],
    },
    "10": {
        categories: [19],
        fileName: "world_story_event_boss_battle_quest.json",
        range: "WorldStoryEventBossBattle",
        valuesForQuestId: questId => [Math.trunc(questId / 1_000), questId % 1_000],
        selectorForRow: row => [singleIdSelector(row[8]), decodeQuestSelector(row[10])],
    },
})

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function readPlainObject(assetDirectory, fileName) {
    const value = readJson(path.join(assetDirectory, fileName))
    if (!isPlainObject(value)) throw new TypeError(`${fileName} must be a plain object`)
    return value
}

function isCanonicalPositiveInteger(value) {
    const numericValue = Number(value)
    return /^[1-9]\d*$/.test(value)
        && Number.isSafeInteger(numericValue)
        && String(numericValue) === value
}

function validateMissionTable(table, fileName) {
    for (const [missionId, rows] of Object.entries(table)) {
        if (!isCanonicalPositiveInteger(missionId)) {
            throw new TypeError(`${fileName} mission ID must be a canonical positive integer: ${missionId}`)
        }
        if (!Array.isArray(rows)) {
            throw new TypeError(`${fileName} mission ${missionId} rows must be an array`)
        }
        if (!Array.isArray(rows[0])) {
            throw new TypeError(`${fileName} mission ${missionId} first row must be an array`)
        }
    }
    return table
}

function validateQuestTable(table, fileName) {
    for (const [questId, entry] of Object.entries(table)) {
        if (!isCanonicalPositiveInteger(questId)) {
            throw new TypeError(`${fileName} quest ID must be a canonical positive integer: ${questId}`)
        }
        if (!isPlainObject(entry)) {
            throw new TypeError(`${fileName} entry ${questId} must be a plain object`)
        }
    }
    return table
}

function parseInteger(value, label) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) throw new TypeError(`${label} must be a safe integer`)
    return parsed
}

function parseCanonicalPositiveInteger(value, label) {
    const text = String(value)
    if (!isCanonicalPositiveInteger(text)) {
        throw new TypeError(`${label} must be a canonical positive integer: ${text}`)
    }
    return Number(text)
}

function assertStrictlyIncreasing(values, label) {
    for (let index = 1; index < values.length; index++) {
        if (values[index] <= values[index - 1]) {
            throw new TypeError(`${label} values must be strictly increasing without duplicates`)
        }
    }
}

function decodeQuestSelector(value) {
    if (value === "(None)") return { kind: "All" }
    if (value === "") return { kind: "Within", values: [] }
    const values = String(value).split(",")
        .map(entry => parseCanonicalPositiveInteger(entry, "quest selector"))
    assertStrictlyIncreasing(values, "quest selector")
    return { kind: "Within", values }
}

function singleIdSelector(value) {
    if (value === "(None)" || value === "") return decodeQuestSelector(value)
    return {
        kind: "Within",
        values: [parseCanonicalPositiveInteger(value, "single quest selector")],
    }
}

function getRole(patternType) {
    if (patternType === 16) return "any"
    if (patternType === 17) return "host"
    if (patternType === 18) return "guest"
    return null
}

function queryMatches(query, value) {
    return query.kind === "All" || query.values.includes(value)
}

function type16EmptySelectorForRow(row) {
    const questKind = String(row[7])
    if (questKind === "2") {
        if (row[8] === "" && row[9] === "" && row[10] === "") {
            return [{ kind: "All" }, { kind: "All" }, { kind: "All" }]
        }
        if (row[8] !== "" && row[8] !== "(None)"
            && row[9] !== "" && row[9] !== "(None)"
            && row[10] === "") {
            return [decodeQuestSelector(row[8]), decodeQuestSelector(row[9]), { kind: "All" }]
        }
        return null
    }
    if ((questKind === "5" || questKind === "10")
        && row[8] !== "" && row[8] !== "(None)"
        && row[10] === "") {
        return [singleIdSelector(row[8]), { kind: "All" }]
    }
    return null
}

function questIdsForRange(row, questTables, patternType) {
    const questKind = String(row[7])
    if (questKind === "(None)") {
        return {
            categories: "all",
            selector: { range: "All", keys: [] },
            questIds: "all",
            compatibility: null,
        }
    }

    const source = QUEST_SOURCES[questKind]
    if (!source) return null

    let keys = source.selectorForRow(row)
    let compatibility = null
    if (keys.some(query => query.kind === "Within" && query.values.length === 0)) {
        if (patternType !== 16) return null
        const compatibleKeys = type16EmptySelectorForRow(row)
        if (compatibleKeys === null) return null
        keys = compatibleKeys
        compatibility = TYPE16_EMPTY_SELECTOR_COMPATIBILITY
    }
    const questIds = Object.keys(questTables[source.fileName])
        .map(questId => parseInteger(questId, "quest ID"))
        .filter(questId => source.valuesForQuestId(questId)
            .every((value, index) => queryMatches(keys[index], value)))
        .sort((left, right) => left - right)

    if (questIds.length === 0) return null
    const usesCategoryWideBossWildcard = compatibility === TYPE16_EMPTY_SELECTOR_COMPATIBILITY
        && source.range === "BossBattle"
        && keys.every(query => query.kind === "All")
    return {
        categories: source.categories,
        selector: { range: source.range, keys },
        questIds: usesCategoryWideBossWildcard ? "all" : questIds,
        compatibility,
    }
}

function assertGeneratedRules(rules) {
    assert.equal(rules.length, 1753, "exact event battle rule count")
    assert.deepEqual(
        rules.reduce((counts, rule) => {
            counts[rule.role]++
            return counts
        }, { any: 0, host: 0, guest: 0 }),
        { any: 1740, host: 12, guest: 1 },
        "exact event battle role partition",
    )
    assert.equal(
        rules.filter(rule => rule.patternType === 16 && rule.selector.range === "All").length,
        100,
        "type 16 all-range rule count",
    )
    assert.equal(
        rules.filter(rule => rule.patternType === 16 && rule.selector.range !== "All").length,
        1640,
        "type 16 scoped rule count",
    )
    assert.equal(
        rules.filter(rule => rule.compatibility === TYPE16_EMPTY_SELECTOR_COMPATIBILITY).length,
        948,
        "audited type 16 empty-selector compatibility count",
    )
    assert.equal(rules.some(rule => rule.patternType === 20), false, "Attention rules stay disabled")
    assert.equal(rules.some(rule => rule.missionId === 1400), true, "boss wildcard compatibility 1400")
    assert.equal(rules.some(rule => rule.missionId === 1811), true, "advent wildcard compatibility 1811")
    assert.equal(rules.some(rule => (
        Array.isArray(rule.categories) && rule.categories.includes(8)
    )), false, "Advent only uses category 7")
    assert.deepEqual(
        rules.map(rule => rule.missionId),
        rules.map(rule => rule.missionId).toSorted((left, right) => left - right),
        "rules must be sorted by numeric mission ID",
    )
}

function buildMissionEventBattleRules(assetDirectory = DEFAULT_ASSET_DIRECTORY) {
    const missions = validateMissionTable(
        readPlainObject(assetDirectory, "mission_event.json"),
        "mission_event.json",
    )
    const questTables = Object.fromEntries(
        Object.values(QUEST_SOURCES).map(source => [
            source.fileName,
            validateQuestTable(
                readPlainObject(assetDirectory, source.fileName),
                source.fileName,
            ),
        ]),
    )
    const rules = []

    for (const missionIdText of Object.keys(missions).sort((left, right) => Number(left) - Number(right))) {
        const missionId = parseInteger(missionIdText, "mission ID")
        const row = missions[missionIdText]?.[0]
        if (!Array.isArray(row)) continue

        const patternType = parseInteger(row[2], "pattern type")
        const role = getRole(patternType)
        if (role === null || row[11] !== "(None)") continue

        const questRange = questIdsForRange(row, questTables, patternType)
        if (questRange === null) continue

        rules.push({
            missionId,
            patternType,
            role,
            categories: questRange.categories,
            selector: questRange.selector,
            questIds: questRange.questIds,
            rank: null,
            compatibility: questRange.compatibility,
        })
    }

    assertGeneratedRules(rules)
    return { schemaVersion: 1, rules }
}

function writeMissionEventBattleRules(outputPath = DEFAULT_OUTPUT_PATH) {
    const output = `${JSON.stringify(buildMissionEventBattleRules(), null, 2)}\n`
    fs.writeFileSync(outputPath, output)
}

if (require.main === module) {
    writeMissionEventBattleRules()
    console.log(`Generated ${DEFAULT_OUTPUT_PATH}`)
}

module.exports = {
    buildMissionEventBattleRules,
    decodeQuestSelector,
    singleIdSelector,
    writeMissionEventBattleRules,
}
