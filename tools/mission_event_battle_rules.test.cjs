const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")
const generatorPath = path.join(projectRoot, "scripts", "gen_mission_event_battle_rules.js")
const checkedInAssetPath = path.join(projectRoot, "assets", "mission_event_battle_rules.json")
const generatorSourceFiles = [
    "mission_event.json",
    "boss_battle_quest.json",
    "advent_event_quest.json",
    "world_story_event_boss_battle_quest.json",
]

assert.equal(fs.existsSync(generatorPath), true, "strict event battle rule generator must exist")

const {
    buildMissionEventBattleRules,
    decodeQuestSelector,
    singleIdSelector,
    writeMissionEventBattleRules,
} = require(generatorPath)

assert.deepEqual(decodeQuestSelector(""), { kind: "Within", values: [] })
assert.deepEqual(decodeQuestSelector("(None)"), { kind: "All" })
assert.deepEqual(decodeQuestSelector("2,4,5"), { kind: "Within", values: [2, 4, 5] })
assert.equal(typeof singleIdSelector, "function", "single ID selector helper must exist")
assert.deepEqual(singleIdSelector("3"), { kind: "Within", values: [3] })

const generated = buildMissionEventBattleRules()
assert.equal(generated.schemaVersion, 1)
assert.equal(generated.rules.length, 1753)
assert.deepEqual(
    generated.rules.reduce((counts, rule) => {
        counts[rule.role]++
        return counts
    }, { any: 0, host: 0, guest: 0 }),
    { any: 1740, host: 12, guest: 1 },
)
assert.deepEqual(
    generated.rules.map(rule => rule.missionId),
    generated.rules.map(rule => rule.missionId).toSorted((left, right) => left - right),
)
assert.equal(generated.rules.some(rule => rule.patternType === 20), false)
assert.equal(generated.rules.some(rule => (
    Array.isArray(rule.categories) && rule.categories.includes(8)
)), false)

const emptySelectorCompatibilityRules = generated.rules.filter(rule => (
    rule.compatibility === "type16-empty-selector-wildcard"
))
assert.equal(emptySelectorCompatibilityRules.length, 948)
assert.deepEqual(
    emptySelectorCompatibilityRules.reduce((counts, rule) => {
        counts[rule.selector.range] = (counts[rule.selector.range] ?? 0) + 1
        return counts
    }, {}),
    { BossBattle: 588, WorldStoryEventBossBattle: 342, AdventEvent: 18 },
)
assert.equal(
    generated.rules.filter(rule => rule.compatibility === null).length,
    805,
    "既有严格规则不得被空 selector 兼容规则改写",
)

assert.deepEqual(generated.rules.find(rule => rule.missionId === 1400), {
    missionId: 1400,
    patternType: 16,
    role: "any",
    categories: [2],
    selector: {
        range: "BossBattle",
        keys: [{ kind: "All" }, { kind: "All" }, { kind: "All" }],
    },
    questIds: "all",
    rank: null,
    compatibility: "type16-empty-selector-wildcard",
})

assert.deepEqual(generated.rules.find(rule => rule.missionId === 2491), {
    missionId: 2491,
    patternType: 16,
    role: "any",
    categories: [2],
    selector: {
        range: "BossBattle",
        keys: [
            { kind: "Within", values: [1] },
            { kind: "Within", values: [20] },
            { kind: "All" },
        ],
    },
    questIds: [1020001, 1020002, 1020003],
    rank: null,
    compatibility: "type16-empty-selector-wildcard",
})

assert.deepEqual(generated.rules.find(rule => rule.missionId === 1811), {
    missionId: 1811,
    patternType: 16,
    role: "any",
    categories: [7],
    selector: {
        range: "AdventEvent",
        keys: [
            { kind: "Within", values: [100002] },
            { kind: "All" },
        ],
    },
    questIds: [100002001, 100002002, 100002003, 100002004, 100002005, 100002006, 100002007],
    rank: null,
    compatibility: "type16-empty-selector-wildcard",
})

const allRange = generated.rules.find(rule => rule.missionId === 1224)
assert.deepEqual(allRange, {
    missionId: 1224,
    patternType: 16,
    role: "any",
    categories: "all",
    selector: { range: "All", keys: [] },
    questIds: "all",
    rank: null,
    compatibility: null,
})

const finiteAny = generated.rules.find(rule => rule.missionId === 1625)
assert.deepEqual(finiteAny, {
    missionId: 1625,
    patternType: 16,
    role: "any",
    categories: [7],
    selector: {
        range: "AdventEvent",
        keys: [
            { kind: "Within", values: [6] },
            { kind: "Within", values: [2] },
        ],
    },
    questIds: [6002],
    rank: null,
    compatibility: null,
})

const bossAny = generated.rules.find(rule => rule.missionId === 1416)
assert.deepEqual(bossAny, {
    missionId: 1416,
    patternType: 16,
    role: "any",
    categories: [2],
    selector: {
        range: "BossBattle",
        keys: [
            { kind: "Within", values: [1] },
            { kind: "Within", values: [14] },
            { kind: "All" },
        ],
    },
    questIds: [1014001, 1014002, 1014003, 1014004],
    rank: null,
    compatibility: null,
})

const hostExpectations = new Map([
    [1412, [3002]], [1413, [3002]], [1414, [3004, 3005]], [1415, [3004, 3005]],
    [1526, [4002]], [1527, [4002]], [1528, [4004, 4005]], [1529, [4004, 4005]],
    [1565, [5002]], [1566, [5002]], [1567, [5003, 5004]], [1568, [5003, 5004]],
])
for (const [missionId, questIds] of hostExpectations) {
    const rule = generated.rules.find(candidate => candidate.missionId === missionId)
    assert.equal(rule.role, "host", String(missionId))
    assert.deepEqual(rule.categories, [7], String(missionId))
    assert.deepEqual(rule.questIds, questIds, String(missionId))
}
assert.deepEqual(generated.rules.find(rule => rule.missionId === 1412).selector, {
    range: "AdventEvent",
    keys: [
        { kind: "Within", values: [3] },
        { kind: "Within", values: [2] },
    ],
})

const guest = generated.rules.find(rule => rule.missionId === 800000)
assert.equal(guest.role, "guest")
assert.deepEqual(guest.categories, [7])
assert.deepEqual(guest.questIds, [14001, 14002, 14003, 14004])

function assertDamagedFixture(fileName, mutate, expectedError) {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-rules-fixture-"))
    try {
        for (const sourceFile of generatorSourceFiles) {
            fs.copyFileSync(
                path.join(projectRoot, "assets", sourceFile),
                path.join(fixtureDirectory, sourceFile),
            )
        }
        const fixturePath = path.join(fixtureDirectory, fileName)
        const source = JSON.parse(fs.readFileSync(fixturePath, "utf8"))
        fs.writeFileSync(fixturePath, JSON.stringify(mutate(source)))
        assert.throws(
            () => buildMissionEventBattleRules(fixtureDirectory),
            expectedError,
            fileName,
        )
    } finally {
        fs.rmSync(fixtureDirectory, { recursive: true, force: true })
    }
}

assertDamagedFixture("mission_event.json", () => [], /mission_event\.json.*plain object/)
assertDamagedFixture("mission_event.json", source => {
    source["01224"] = source["1224"]
    return source
}, /mission_event\.json.*mission ID.*canonical positive integer/)
assertDamagedFixture("mission_event.json", source => {
    source["999999998"] = {}
    return source
}, /mission_event\.json.*999999998.*rows.*array/)
assertDamagedFixture("mission_event.json", source => {
    source["999999999"] = [{}]
    return source
}, /mission_event\.json.*999999999.*first row.*array/)
assertDamagedFixture("mission_event.json", source => {
    source["1414"][0][10] = "5,4"
    return source
}, /quest selector.*strictly increasing.*without duplicates/)
assertDamagedFixture("mission_event.json", source => {
    source["1414"][0][10] = "4,4"
    return source
}, /quest selector.*strictly increasing.*without duplicates/)
assertDamagedFixture("mission_event.json", source => {
    source["1625"][0][8] = "0"
    return source
}, /single quest selector.*canonical positive integer/)
assertDamagedFixture("boss_battle_quest.json", () => [], /boss_battle_quest\.json.*plain object/)
assertDamagedFixture("boss_battle_quest.json", source => {
    source["01"] = source[Object.keys(source)[0]]
    return source
}, /boss_battle_quest\.json.*canonical positive integer/)
assertDamagedFixture("boss_battle_quest.json", source => {
    source[Object.keys(source)[0]] = []
    return source
}, /boss_battle_quest\.json.*entry.*plain object/)

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-event-rules-"))
try {
    const generatedPath = path.join(temporaryDirectory, "mission_event_battle_rules.json")
    writeMissionEventBattleRules(generatedPath)
    assert.deepEqual(
        fs.readFileSync(generatedPath),
        fs.readFileSync(checkedInAssetPath),
        "checked-in strict rules must be byte-for-byte reproducible",
    )
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}

console.log("mission event battle rule generator tests passed")
