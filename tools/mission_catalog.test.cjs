"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const mission = require("../src/lib/mission")
const {
    getMissionCatalog,
} = require("../src/lib/mission/mission-catalog")
const masterData = require("../src/lib/mission/master-data")
const rewards = require("../src/lib/mission/rewards")

const CATEGORY_LAYOUTS = Object.freeze({
    1: { definition: "mission_regular.json", reward: "mission_regular_reward.json", pattern: 0, start: 25, end: 26, progress: 1, rewardStart: 5 },
    2: { definition: "mission_daily.json", reward: "mission_daily_reward.json", pattern: 0, start: 25, end: 26, progress: 1, rewardStart: 5 },
    3: { definition: "mission_event.json", reward: "mission_event_reward.json", pattern: 0, start: 25, end: 26, progress: 1, rewardStart: 5 },
    4: { definition: "mission_collect_item.json", reward: "mission_collect_item_reward.json", event: 0, pattern: 2, start: 27, end: 28, progress: 2, rewardStart: 6 },
    5: { definition: "mission_degree.json", reward: "mission_degree_reward.json", pattern: 1, start: 26, end: 27, progress: 1, rewardStart: 5 },
    6: { definition: "mission_pass_daily.json", reward: "mission_pass_daily_reward.json", event: 0, pattern: 1, patternType: 3, start: 26, end: 27, progress: 1, rewardStart: 5 },
    7: { definition: "mission_pass_week.json", reward: "mission_pass_week_reward.json", event: 0, pattern: 1, patternType: 3, start: 26, end: 27, progress: 1, rewardStart: 5 },
    8: { definition: "mission_pass_event.json", reward: "mission_pass_event_reward.json", event: 0, pattern: 1, patternType: 3, start: 26, end: 27, progress: 1, rewardStart: 5 },
    9: { definition: "mission_char_awake.json", reward: "mission_char_awake_reward.json", pattern: 2, start: 27, end: 28, progress: 5, rewardStart: 9 },
    10: { definition: "mission_weekly_def.json", reward: "mission_weekly_reward.json", pattern: 0, start: 25, end: 26, progress: 1, rewardStart: 5 },
})

function emptyTables() {
    return Object.fromEntries(Object.values(CATEGORY_LAYOUTS).flatMap(layout => [
        [layout.definition, {}],
        [layout.reward, {}],
    ]))
}

function repository(tables = emptyTables(), source = "fixture") {
    return {
        info: () => ({ source }),
        table(tableName) {
            if (!Object.hasOwn(tables, tableName)) throw new Error(`unexpected table: ${tableName}`)
            return tables[tableName]
        },
    }
}

function definitionRow(category, pattern, options = {}) {
    const layout = CATEGORY_LAYOUTS[category]
    const row = []
    row[layout.pattern] = pattern
    if (layout.event !== undefined) row[layout.event] = String(options.eventId ?? 1)
    if (layout.patternType !== undefined) row[layout.patternType] = String(options.patternType ?? 3)
    if (category === 9) row[1] = String(options.characterId ?? 101)
    row[layout.start] = options.start ?? "2026-01-01 00:00:00"
    row[layout.end] = options.end ?? "2026-12-31 23:59:59"
    return row
}

function rewardRow(category, rewardId, progress, options = {}) {
    const layout = CATEGORY_LAYOUTS[category]
    const row = []
    row[0] = String(rewardId)
    row[layout.progress] = String(progress)
    if (category === 9) {
        row[1] = options.specialKind ?? "(None)"
        row[6] = options.targetClearSeconds ?? "(None)"
        if (options.specialKind === "0") {
            row[2] = options.characterId
            row[3] = options.boardIndex
            row[4] = options.awakeLevel
        }
    }
    const rewardSpecs = options.rewardSpecs ?? [[1, 2, 301]]
    rewardSpecs.forEach(([kind, amount, id], slot) => {
        const base = layout.rewardStart + slot * 6
        row[base] = String(kind)
        row[base + 1] = String(amount)
        const idOffset = { 1: 2, 2: 4, 4: 3, 6: 5 }[kind]
        if (idOffset !== undefined) row[base + idOffset] = String(id)
    })
    return row
}

function addMission(tables, category, missionKey, stages, definitionOptions = {}) {
    const layout = CATEGORY_LAYOUTS[category]
    tables[layout.definition][missionKey] = [definitionRow(
        category,
        definitionOptions.pattern ?? `pattern-${category}-${missionKey}`,
        definitionOptions,
    )]
    tables[layout.reward][missionKey] = stages
}

function assertDeepFrozen(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen)
}

test("caches catalogs by explicit repository identity", () => {
    const tables = emptyTables()
    addMission(tables, 1, "1", { 1: [rewardRow(1, 101, 1)] })
    const firstRepository = repository(tables, "first")
    const secondRepository = repository(tables, "second")

    assert.equal(getMissionCatalog(firstRepository), getMissionCatalog(firstRepository))
    assert.notEqual(getMissionCatalog(firstRepository), getMissionCatalog(secondRepository))
    assert.equal(mission.getMissionCatalog, getMissionCatalog)
})

test("freezes the cached catalog instance against runtime method replacement", () => {
    const tables = emptyTables()
    addMission(tables, 1, "1", { 1: [rewardRow(1, 101, 1)] }, { pattern: "original" })
    const contentRepository = repository(tables)
    const catalog = getMissionCatalog(contentRepository)

    assert.equal(Object.isFrozen(catalog), true)
    assert.throws(() => {
        catalog.getDefinition = () => ({ pattern: "replaced" })
    }, TypeError)
    assert.equal(getMissionCatalog(contentRepository), catalog)
    assert.equal(getMissionCatalog(contentRepository).getDefinition(1, 1).pattern, "original")
})

test("indexes complete definitions, patterns, stages, rewards, and awake characters", () => {
    const tables = emptyTables()
    addMission(tables, 1, "2", { 1: [rewardRow(1, 201, 5)] }, { pattern: "shared" })
    addMission(tables, 1, "1", {
        2: [rewardRow(1, 102, 10)],
        1: [rewardRow(1, 101, 20, { rewardSpecs: [
            [1, 2, 301],
            [2, 3, 302],
            [4, 4, 303],
            [6, 0, 304],
        ] })],
    }, { pattern: "shared" })
    const rewardSemanticsRow = rewardRow(1, 301, 1, { rewardSpecs: [
        [6, 0, 305],
        [7, 0],
        [99, 1],
    ] })
    rewardSemanticsRow[6] = ""
    addMission(tables, 1, "3", { 1: [rewardSemanticsRow] }, { pattern: "reward-semantics" })
    addMission(tables, 4, "7", { 1: [rewardRow(4, 701, 2)] }, {
        pattern: "shared",
        eventId: 9,
    })
    addMission(tables, 9, "31", { 1: [rewardRow(9, 311, 3, {
        specialKind: "0",
        characterId: "123",
        boardIndex: "2",
        awakeLevel: "4",
        targetClearSeconds: "90",
    })] }, { pattern: "awake", characterId: 123 })
    const catalog = getMissionCatalog(repository(tables))

    assert.deepEqual(catalog.getMissionIds(1), [1, 2, 3])
    assert.deepEqual(catalog.getDefinitions(1).map(value => value.missionId), [1, 2, 3])
    assert.equal(catalog.getDefinition(1, 1).pattern, "shared")
    assert.deepEqual(
        catalog.getDefinitionsByPattern("shared").map(value => [value.category, value.missionId]),
        [[1, 1], [1, 2], [4, 7]],
    )
    assert.deepEqual(catalog.getRewardStages(1, 1).map(value => value.stage), [2, 1])
    assert.equal(catalog.getRewardStage(1, 1, 1).targetProgress, 20)
    assert.equal(catalog.getRewardStage(1, 1, 2).targetProgress, 10)
    assert.deepEqual(catalog.getRewardStage(1, 1, 1).rewards, [
        { kind: 1, amount: 2, itemId: 301 },
        { kind: 2, amount: 3, equipmentId: 302 },
        { kind: 4, amount: 4, characterId: 303 },
        { kind: 6, amount: 0, degreeId: 304 },
    ])
    assert.deepEqual(catalog.getRewardStage(1, 3, 1).rewards, [
        { kind: 6, amount: 0, degreeId: 305 },
        { kind: 99, amount: 1 },
    ])
    assert.deepEqual(catalog.getRewardStage(9, 31, 1), {
        stage: 1,
        missionRewardId: 311,
        targetProgress: 3,
        targetClearSeconds: 90,
        rewards: [{ kind: 1, amount: 2, itemId: 301 }],
        specialReward: { characterId: 123, boardIndex: 2, awakeLevel: 4 },
    })
    assert.deepEqual(catalog.getAwakeMissionIdsByCharacter(123), [31])
    assert.deepEqual(catalog.getAwakeMissionIdsByCharacter("123"), [31])
    assert.deepEqual(catalog.getDefinitions(99), [])
    assert.deepEqual(catalog.getMissionIds(99), [])
})

test("uses CN master time boundaries and event scope with invalid dates closed", () => {
    const tables = emptyTables()
    addMission(tables, 4, "1", { 1: [rewardRow(4, 101, 1)] }, {
        eventId: 7,
        start: "2026-01-01 12:00:00",
        end: "2026-01-02 11:59:59",
    })
    const catalog = getMissionCatalog(repository(tables))
    assert.equal(catalog.isEnabledAt(4, 1, new Date("2026-01-01T04:00:00.000Z"), 7), true)
    assert.equal(catalog.isEnabledAt(4, 1, new Date("2026-01-02T03:59:59.000Z"), 7), true)
    assert.equal(catalog.isEnabledAt(4, 1, new Date("2026-01-02T03:59:59.001Z"), 7), false)
    assert.equal(catalog.isEnabledAt(4, 1, new Date("2026-01-01T04:00:00.000Z"), 8), false)
    assert.equal(catalog.isEnabledAt(4, 1, new Date("invalid"), 7), false)
    assert.equal(catalog.isEnabledAt(4, 999, new Date("2026-01-01T04:00:00.000Z"), 7), false)
})

test("keeps the historical cumulative login mission open after its official start", () => {
    const tables = emptyTables()
    addMission(tables, 1, "108", { 1: [rewardRow(1, 108001, 2)] }, {
        pattern: "special_total_login_2anv",
        start: "2023-08-31 12:00:00",
    })
    addMission(tables, 1, "109", { 1: [rewardRow(1, 109001, 2)] }, {
        pattern: "special_total_login_2anv",
        start: "2023-08-31 12:00:00",
        end: "2023-08-31 12:00:00",
    })
    const catalog = getMissionCatalog(repository(tables))
    assert.equal(catalog.isEnabledAt(1, 108, new Date("2026-08-27T00:00:00.000Z")), true)
    assert.equal(catalog.isEnabledAt(1, 108, new Date("2022-01-01T00:00:00.000Z")), false)
    assert.equal(catalog.isEnabledAt(1, 108, new Date("invalid")), false)
    assert.equal(catalog.isEnabledAt(1, 109, new Date("2026-08-27T00:00:00.000Z")), false)
})

test("parses CN master dates strictly with leap-day validation", () => {
    const tables = emptyTables()
    const invalidDates = [
        "2024-2-29 00:00:00",
        "2024-02-30 00:00:00",
        "2023-02-29 00:00:00",
        "2024-13-01 00:00:00",
        "2024-00-01 00:00:00",
        "2024-01-00 00:00:00",
        "2024-01-01 24:00:00",
        "2024-01-01 23:60:00",
        "2024-01-01 23:59:60",
    ]
    invalidDates.forEach((start, index) => {
        const missionId = index + 1
        addMission(tables, 1, String(missionId), {
            1: [rewardRow(1, missionId * 100 + 1, 1)],
        }, { start, end: "(None)", pattern: `invalid-date-${missionId}` })
    })
    addMission(tables, 1, "90", { 1: [rewardRow(1, 9001, 1)] }, {
        start: "2024-02-29 12:34:56",
        end: "2024-02-29 12:34:56",
        pattern: "valid-leap-day",
    })
    addMission(tables, 1, "91", { 1: [rewardRow(1, 9101, 1)] }, {
        start: "(None)",
        end: "(None)",
        pattern: "unbounded-date",
    })

    const catalog = getMissionCatalog(repository(tables))
    for (let missionId = 1; missionId <= invalidDates.length; missionId++) {
        assert.equal(
            catalog.isEnabledAt(1, missionId, new Date("2025-01-01T00:00:00.000Z")),
            false,
            invalidDates[missionId - 1],
        )
    }
    const leapInstant = new Date("2024-02-29T04:34:56.000Z")
    assert.equal(catalog.isEnabledAt(1, 90, leapInstant), true)
    assert.equal(catalog.isEnabledAt(1, 90, new Date(leapInstant.getTime() - 1)), false)
    assert.equal(catalog.isEnabledAt(1, 90, new Date(leapInstant.getTime() + 1)), false)
    assert.equal(catalog.isEnabledAt(1, 91, new Date("2025-01-01T00:00:00.000Z")), true)
})

test("requires authoritative positive safe event ids for categories 4, 6, 7, and 8", () => {
    const invalidEventIds = [
        undefined,
        "(None)",
        "0",
        "-1",
        "1.5",
        String(Number.MAX_SAFE_INTEGER + 1),
    ]
    const tables = emptyTables()
    for (const category of [4, 6, 7, 8]) {
        const layout = CATEGORY_LAYOUTS[category]
        invalidEventIds.forEach((eventId, index) => {
            const missionId = index + 1
            addMission(tables, category, String(missionId), {
                1: [rewardRow(category, category * 1000 + missionId, 1)],
            }, { eventId: 1, pattern: `bad-event-${category}-${missionId}` })
            tables[layout.definition][String(missionId)][0][layout.event] = eventId
        })
        addMission(tables, category, "99", {
            1: [rewardRow(category, category * 1000 + 99, 1)],
        }, {
            eventId: 7,
            pattern: `valid-event-${category}`,
            patternType: category === 8 ? 0 : 3,
        })
    }
    addMission(tables, 6, "100", { 1: [rewardRow(6, 6100, 1)] }, {
        eventId: 7,
        pattern: "bad-pattern-type",
        patternType: "16junk",
    })

    const catalog = getMissionCatalog(repository(tables))
    for (const category of [4, 6, 7, 8]) {
        assert.deepEqual(catalog.getMissionIds(category), [99], `category ${category}`)
        assert.equal(catalog.getDefinition(category, 99).eventId, 7)
    }
    assert.equal(catalog.getDefinition(8, 99).patternType, 0)
    const enabledAt = new Date("2026-06-01T00:00:00.000Z")
    for (const eventId of invalidEventIds) {
        assert.equal(catalog.isEnabledAt(4, 99, enabledAt, eventId), false)
    }
    assert.equal(catalog.isEnabledAt(4, 99, enabledAt, 7), true)
})

test("isolates invalid, duplicate, incomplete, and malformed missions from valid candidates", () => {
    const tables = emptyTables()
    const definitions = tables["mission_regular.json"]
    const rewardTable = tables["mission_regular_reward.json"]
    definitions["1"] = [definitionRow(1, "duplicate")]
    definitions["01"] = [definitionRow(1, "duplicate")]
    rewardTable["1"] = { 1: [rewardRow(1, 101, 1)] }
    rewardTable["01"] = { 1: [rewardRow(1, 102, 1)] }
    definitions["001"] = [definitionRow(1, "duplicate")]
    rewardTable["001"] = { 1: [rewardRow(1, 103, 1)] }
    definitions["0"] = [definitionRow(1, "invalid")]
    rewardTable["0"] = { 1: [rewardRow(1, 1, 1)] }
    definitions["20"] = [definitionRow(1, "definition-only")]
    rewardTable["30"] = { 1: [rewardRow(1, 301, 1)] }
    definitions["40"] = [definitionRow(1, "bad-stage")]
    rewardTable["40"] = {
        1: [rewardRow(1, 401, 1)],
        2: [rewardRow(1, 402, 2), rewardRow(1, 403, 3)],
    }
    definitions["50"] = [definitionRow(1, "duplicate-stage")]
    rewardTable["50"] = {
        1: [rewardRow(1, 501, 1)],
        "01": [rewardRow(1, 502, 2)],
    }
    definitions["60"] = [definitionRow(1, "bad-reward")]
    rewardTable["60"] = { 1: [rewardRow(1, "bad", "bad")] }
    definitions["70"] = [definitionRow(1, "duplicate-reward-mission")]
    rewardTable["70"] = { 1: [rewardRow(1, 701, 1)] }
    rewardTable["070"] = { 1: [rewardRow(1, 702, 1)] }
    addMission(tables, 1, "80", {
        1: [rewardRow(1, 801, 8)],
    }, { pattern: "valid-neighbor" })

    const catalog = getMissionCatalog(repository(tables))
    assert.deepEqual(catalog.getMissionIds(1), [80])
    assert.equal(catalog.getDefinition(1, 80).pattern, "valid-neighbor")
    assert.deepEqual(catalog.getDefinitionsByPattern("valid-neighbor").map(value => value.missionId), [80])
    assert.deepEqual(catalog.getRewardStages(1, 80).map(value => value.stage), [1])
    assert.equal(catalog.getRewardStage(1, 80, 1).missionRewardId, 801)
    for (const pattern of [
        "duplicate", "invalid", "definition-only", "bad-stage", "duplicate-stage", "bad-reward",
        "duplicate-reward-mission",
    ]) assert.deepEqual(catalog.getDefinitionsByPattern(pattern), [])
})

test("rejects malformed standard definitions and reward fields while preserving a healthy neighbor", () => {
    const tables = emptyTables()
    const invalidRows = [
        [11, row => { row[0] = "101junk" }],
        [12, row => { row[0] = String(Number.MAX_SAFE_INTEGER + 1) }],
        [13, row => { row[1] = "-1" }],
        [14, row => { row[1] = "1junk" }],
        [15, row => { row[5] = "-1" }],
        [16, row => { row[6] = "-1" }],
        [17, row => { row[6] = "-1junk" }],
        [18, row => {
            row[5] = "0"
            row[6] = "1"
            row[7] = "101junk"
            row[8] = "-1junk"
            row[9] = String(Number.MAX_SAFE_INTEGER + 1)
            row[10] = "NaN"
        }],
        [19, row => { row[7] = "0" }],
        [20, row => {
            row[5] = "2"
            row[9] = "0"
        }],
        [21, row => {
            row[5] = "4"
            row[8] = "0"
        }],
        [22, row => {
            row[5] = "6"
            row[6] = "0"
            row[10] = "0"
        }],
        [24, row => { row[1] = "Infinity" }],
        [25, row => { row[5] = "NaN" }],
        [26, row => {
            row[5] = "(None)"
            row[6] = "-1junk"
            row[7] = "101junk"
        }],
        [27, row => { row[0] = "0" }],
        [28, row => { row[6] = "Infinity" }],
        [29, row => { row[1] = String(Number.MAX_SAFE_INTEGER + 1) }],
    ]
    for (const [missionId, mutate] of invalidRows) {
        const row = rewardRow(1, missionId * 100 + 1, 1)
        mutate(row)
        addMission(tables, 1, String(missionId), { 1: [row] }, {
            pattern: `malformed-standard-${missionId}`,
        })
    }
    addMission(tables, 1, "23", { 1: [rewardRow(1, 2301, 1)] }, { pattern: "   " })
    addMission(tables, 1, "99", { 1: [rewardRow(1, 9901, 9)] }, {
        pattern: "  healthy-standard  ",
    })

    const catalog = getMissionCatalog(repository(tables))
    assert.deepEqual(catalog.getMissionIds(1), [99])
    assert.equal(catalog.getDefinition(1, 99).pattern, "  healthy-standard  ")
    assert.deepEqual(catalog.getRewardStage(1, 99, 1), {
        stage: 1,
        missionRewardId: 9901,
        targetProgress: 9,
        rewards: [{ kind: 1, amount: 2, itemId: 301 }],
    })
})

test("fails a whole awake mission when its authoritative character or special reward is malformed", () => {
    const tables = emptyTables()
    addMission(tables, 9, "11", { 1: [rewardRow(9, 111, 1)] }, {
        characterId: 0,
        pattern: "bad-character",
    })
    addMission(tables, 9, "12", { 1: [rewardRow(9, 121, 1, {
        specialKind: "0",
        characterId: "123",
        boardIndex: undefined,
        awakeLevel: "2",
    })] }, { characterId: 123, pattern: "bad-special" })

    const catalog = getMissionCatalog(repository(tables))
    assert.deepEqual(catalog.getMissionIds(9), [])
    assert.deepEqual(catalog.getAwakeMissionIdsByCharacter(123), [])
})

test("rejects malformed awake special fields while preserving audited positive boundaries", () => {
    const tables = emptyTables()
    const invalidRows = [
        [21, row => { row[1] = "0junk" }],
        [22, row => { row[1] = "-1" }],
        [23, row => { row[2] = "101junk" }],
        [24, row => { row[2] = String(Number.MAX_SAFE_INTEGER + 1) }],
        [25, row => { row[3] = "0" }],
        [26, row => { row[4] = "0" }],
        [27, row => { row[6] = "-1" }],
        [28, row => { row[6] = "90junk" }],
        [29, row => { row[6] = String(Number.MAX_SAFE_INTEGER + 1) }],
    ]
    for (const [missionId, mutate] of invalidRows) {
        const row = rewardRow(9, missionId * 10 + 1, 1, {
            specialKind: "0",
            characterId: "123",
            boardIndex: "1",
            awakeLevel: "1",
            targetClearSeconds: "90",
        })
        mutate(row)
        addMission(tables, 9, String(missionId), { 1: [row] }, {
            characterId: 123,
            pattern: `malformed-awake-${missionId}`,
        })
    }
    addMission(tables, 9, "99", { 1: [rewardRow(9, 991, 1, {
        specialKind: "0",
        characterId: "123",
        boardIndex: "1",
        awakeLevel: "1",
        targetClearSeconds: "0",
    })] }, { characterId: 123, pattern: "healthy-awake" })

    const catalog = getMissionCatalog(repository(tables))
    assert.deepEqual(catalog.getMissionIds(9), [99])
    assert.deepEqual(catalog.getRewardStage(9, 99, 1).specialReward, {
        characterId: 123,
        boardIndex: 1,
        awakeLevel: 1,
    })
    assert.equal(catalog.getRewardStage(9, 99, 1).targetClearSeconds, 0)
})

test("deep-freezes every public cached value", () => {
    const tables = emptyTables()
    addMission(tables, 9, "11", { 1: [rewardRow(9, 111, 1, {
        specialKind: "0",
        characterId: "123",
        boardIndex: "1",
        awakeLevel: "2",
    })] }, { characterId: 123 })
    const catalog = getMissionCatalog(repository(tables))

    for (const value of [
        catalog.getDefinitions(9),
        catalog.getDefinition(9, 11),
        catalog.getDefinitionsByPattern("pattern-9-11"),
        catalog.getMissionIds(9),
        catalog.getRewardStages(9, 11),
        catalog.getRewardStage(9, 11, 1),
        catalog.getAwakeMissionIdsByCharacter(123),
    ]) assertDeepFrozen(value)
    assert.throws(() => catalog.getMissionIds(9).push(12), TypeError)
    assert.throws(() => { catalog.getDefinition(9, 11).row[1] = "999" }, TypeError)
    assert.equal(catalog.getDefinition(9, 11).row[1], "123")
})

test("switches from the bundled pre-init catalog to runtime repository identity", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    try {
        productionContentSnapshotProvider.snapshot = null
        const bundledCatalog = getMissionCatalog()
        const tables = emptyTables()
        addMission(tables, 1, "999", { 1: [rewardRow(1, 999001, 1)] })
        const runtimeRepository = repository(tables, "runtime")
        productionContentSnapshotProvider.snapshot = {
            cdn: {},
            archiveSources: { schemaVersion: 1, archives: [] },
            repository: runtimeRepository,
        }

        const runtimeCatalog = getMissionCatalog()
        assert.notEqual(runtimeCatalog, bundledCatalog)
        assert.equal(runtimeCatalog, getMissionCatalog(runtimeRepository))
        assert.deepEqual(runtimeCatalog.getMissionIds(1), [999])
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("bundled catalog covers categories 1-10 with authoritative counts and samples", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    try {
        productionContentSnapshotProvider.snapshot = null
        const catalog = getMissionCatalog()
        const expectedCounts = [120, 656, 2512, 997, 1288, 76, 76, 115, 144, 2]
        assert.deepEqual(
            expectedCounts.map((_, index) => catalog.getMissionIds(index + 1).length),
            expectedCounts,
        )
        assert.equal(catalog.getDefinition(1, 107).pattern, masterData.getMissionMasterDefinition(1, 107).pattern)
        assert.equal(catalog.getDefinition(9, 11).row[1], masterData.getMissionMasterDefinition(9, 11).row[1])
        assert.deepEqual(
            catalog.getRewardStage(1, 107, 1).rewards,
            rewards.getRegularMissionRewards(107, 1),
        )
        assert.deepEqual(
            catalog.getRewardStage(9, 11, 1).rewards,
            rewards.getAwakeMissionRewards(11, 1),
        )
        for (let category = 1; category <= 10; category++) {
            assert.ok(catalog.getDefinitions(category).length > 0, `category ${category}`)
        }
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})
