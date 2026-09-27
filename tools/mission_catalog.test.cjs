"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => { restoreContentSnapshot() })

const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const mission = require("../src/lib/mission")
const {
    getMissionCatalog,
    isMissionMasterDefinitionEnabledAt,
} = require("../src/lib/mission/mission-catalog")
const { createGameCalendarPolicy } = require("../src/time/game-calendar")
const {
    bundledMissionContentRepository,
} = require("./helpers/mission-catalog-bundled.cjs")
const {
    MissionCatalogDataError,
} = require("../src/lib/mission/mission-catalog-source")

function captureRowProblems(repository) {
    try {
        getMissionCatalog(repository)
    } catch (error) {
        assert.ok(error instanceof MissionCatalogDataError, "must throw MissionCatalogDataError")
        return error.problems
    }
    return assert.fail("expected the catalog to reject this content")
}

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

test("mission master start and end follow an explicit +540 calendar", () => {
    const tables = emptyTables()
    addMission(tables, 4, "1", { 1: [rewardRow(4, 101, 1)] }, {
        eventId: 7,
        start: "2026-01-01 12:00:00",
        end: "2026-01-02 11:59:59",
    })
    const definition = getMissionCatalog(repository(tables)).getDefinition(4, 1)
    const calendar540 = createGameCalendarPolicy(540)
    // +540 moves both window edges one hour earlier in absolute time.
    assert.equal(
        isMissionMasterDefinitionEnabledAt(definition, new Date("2026-01-01T03:00:00.000Z"), 7, calendar540),
        true,
        "+540 开始边界必须包含等号",
    )
    assert.equal(
        isMissionMasterDefinitionEnabledAt(definition, new Date("2026-01-01T02:59:59.999Z"), 7, calendar540),
        false,
    )
    assert.equal(
        isMissionMasterDefinitionEnabledAt(definition, new Date("2026-01-02T02:59:59.000Z"), 7, calendar540),
        true,
        "+540 结束边界必须包含等号",
    )
    assert.equal(
        isMissionMasterDefinitionEnabledAt(definition, new Date("2026-01-02T03:00:00.000Z"), 7, calendar540),
        false,
    )
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

test("rejects non-authoritative event ids and pattern types with named row errors", () => {
    const invalidEventIds = [
        undefined,
        "(None)",
        "0",
        "-1",
        "1.5",
        String(Number.MAX_SAFE_INTEGER + 1),
    ]
    for (const category of [4, 6, 7, 8]) {
        const layout = CATEGORY_LAYOUTS[category]
        invalidEventIds.forEach((eventId, index) => {
            const missionId = index + 1
            const tables = emptyTables()
            addMission(tables, category, String(missionId), {
                1: [rewardRow(category, category * 1000 + missionId, 1)],
            }, { eventId: 1, pattern: `bad-event-${category}-${missionId}` })
            tables[layout.definition][String(missionId)][0][layout.event] = eventId
            const problems = captureRowProblems(repository(tables))
            assert.deepEqual(problems, [{
                table: layout.definition,
                id: String(missionId),
                reason: "event id column is not a positive integer",
            }])
        })
    }

    const patternTypeTables = emptyTables()
    addMission(patternTypeTables, 6, "100", { 1: [rewardRow(6, 6100, 1)] }, {
        eventId: 7,
        pattern: "bad-pattern-type",
        patternType: "16junk",
    })
    assert.deepEqual(captureRowProblems(repository(patternTypeTables)), [{
        table: "mission_pass_daily.json",
        id: "100",
        reason: "pattern type column is not a non-negative integer",
    }])

    // A valid event-scoped mission still parses, and the client-mirroring
    // availability rule keeps non-positive or non-integer event scopes closed.
    const validTables = emptyTables()
    addMission(validTables, 4, "99", {
        1: [rewardRow(4, 4099, 1)],
    }, { eventId: 7, pattern: "valid-event-4" })
    const catalog = getMissionCatalog(repository(validTables))
    const enabledAt = new Date("2026-06-01T00:00:00.000Z")
    for (const eventId of invalidEventIds) {
        assert.equal(catalog.isEnabledAt(4, 99, enabledAt, eventId), false)
    }
    assert.equal(catalog.isEnabledAt(4, 99, enabledAt, 7), true)
})

test("reports duplicate, non-positive, incomplete, orphan, and malformed rows as named errors", () => {
    function isolatedProblem(missions, rewards) {
        const tables = emptyTables()
        tables["mission_regular.json"] = missions
        tables["mission_regular_reward.json"] = rewards
        return captureRowProblems(repository(tables))
    }
    const row = () => rewardRow(1, 901, 1)

    // Duplicate mission keys (raw "1"/"01"/"001" all normalize to id 1);
    // the dropped definition also orphans its reward rows.
    assert.deepEqual(isolatedProblem({
        "1": [definitionRow(1, "duplicate")],
        "01": [definitionRow(1, "duplicate")],
    }, { "1": { 1: [row()] } }), [
        {
            table: "mission_regular.json",
            id: "01",
            reason: "table key appears more than once",
        },
        {
            table: "mission_regular_reward.json",
            id: "1",
            reason: "reward stage rows exist without a mission definition",
        },
    ])
    // Non-positive table keys fail on both sides.
    assert.deepEqual(isolatedProblem({
        "0": [definitionRow(1, "invalid")],
    }, { "0": { 1: [row()] } }), [
        {
            table: "mission_regular.json",
            id: "0",
            reason: "table key is not a positive integer id",
        },
        {
            table: "mission_regular_reward.json",
            id: "0",
            reason: "table key is not a positive integer id",
        },
    ])
    // Definition without reward stage rows.
    assert.deepEqual(isolatedProblem({
        "20": [definitionRow(1, "definition-only")],
    }, {}), [{
        table: "mission_regular_reward.json",
        id: "20",
        reason: "mission has no reward stage rows",
    }])
    // Reward rows without a mission definition.
    assert.deepEqual(isolatedProblem({}, {
        "30": { 1: [row()] },
    }), [{
        table: "mission_regular_reward.json",
        id: "30",
        reason: "reward stage rows exist without a mission definition",
    }])
    // Malformed stage row bundle.
    assert.deepEqual(isolatedProblem({
        "40": [definitionRow(1, "bad-stage")],
    }, { "40": { 1: [row()], 2: [row(), row()] } }), [{
        table: "mission_regular_reward.json mission 40",
        id: "2",
        reason: "reward stage row bundle must contain exactly one row",
    }])
    // Duplicate stage table keys are named, never silently folded.
    assert.deepEqual(isolatedProblem({
        "50": [definitionRow(1, "duplicate-stage")],
    }, { "50": { 1: [row()], "01": [row()] } }), [{
        table: "mission_regular_reward.json mission 50",
        id: "01",
        reason: "table key appears more than once",
    }])
    // Malformed reward id/amount and duplicate reward mission keys.
    assert.deepEqual(isolatedProblem({
        "60": [definitionRow(1, "bad-reward")],
    }, { "60": { 1: [rewardRow(1, "bad", "bad")] } }), [{
        table: "mission_regular_reward.json mission 60",
        id: "1",
        reason: "mission reward id or target progress column is invalid",
    }])
    assert.deepEqual(isolatedProblem({
        "70": [definitionRow(1, "duplicate-reward-mission")],
    }, { "70": { 1: [row()] }, "070": { 1: [row()] } }), [
        {
            table: "mission_regular_reward.json",
            id: "070",
            reason: "table key appears more than once",
        },
        {
            table: "mission_regular_reward.json",
            id: "70",
            reason: "mission has no reward stage rows",
        },
    ])
})

test("rejects malformed standard definition and reward fields with named row errors", () => {
    const invalidRows = [
        [11, row => { row[0] = "101junk" }, "mission reward id or target progress column is invalid"],
        [12, row => { row[0] = String(Number.MAX_SAFE_INTEGER + 1) }, "mission reward id or target progress column is invalid"],
        [13, row => { row[1] = "-1" }, "mission reward id or target progress column is invalid"],
        [14, row => { row[1] = "1junk" }, "mission reward id or target progress column is invalid"],
        [15, row => { row[5] = "-1" }, "reward slot 1 kind is not a non-negative integer"],
        [16, row => { row[6] = "-1" }, "reward slot 1 amount is not a non-negative integer"],
        [17, row => { row[6] = "-1junk" }, "reward slot 1 amount is not a non-negative integer"],
        [18, row => {
            row[5] = "0"
            row[6] = "1"
            row[7] = "101junk"
            row[8] = "-1junk"
            row[9] = String(Number.MAX_SAFE_INTEGER + 1)
            row[10] = "NaN"
        }, "reward slot 1 id column 2 is not a positive integer"],
        [19, row => { row[7] = "0" }, "reward slot 1 id column 2 is not a positive integer"],
        [20, row => {
            row[5] = "2"
            row[9] = "0"
        }, "reward slot 1 id column 4 is not a positive integer"],
        [21, row => {
            row[5] = "4"
            row[8] = "0"
        }, "reward slot 1 id column 3 is not a positive integer"],
        [22, row => {
            row[5] = "6"
            row[6] = "0"
            row[10] = "0"
        }, "reward slot 1 id column 5 is not a positive integer"],
        [24, row => { row[1] = "Infinity" }, "mission reward id or target progress column is invalid"],
        [25, row => { row[5] = "NaN" }, "reward slot 1 kind is not a non-negative integer"],
        [26, row => {
            row[5] = "(None)"
            row[6] = "-1junk"
            row[7] = "101junk"
        }, "reward slot 1 amount is not a non-negative integer"],
        [27, row => { row[0] = "0" }, "mission reward id or target progress column is invalid"],
        [28, row => { row[6] = "Infinity" }, "reward slot 1 amount is not a non-negative integer"],
        [29, row => { row[1] = String(Number.MAX_SAFE_INTEGER + 1) }, "mission reward id or target progress column is invalid"],
    ]
    for (const [missionId, mutate, reason] of invalidRows) {
        const tables = emptyTables()
        const row = rewardRow(1, missionId * 100 + 1, 1)
        mutate(row)
        addMission(tables, 1, String(missionId), { 1: [row] }, {
            pattern: `malformed-standard-${missionId}`,
        })
        assert.deepEqual(captureRowProblems(repository(tables)), [{
            table: "mission_regular_reward.json mission " + missionId,
            id: "1",
            reason,
        }], `malformed standard row ${missionId}`)
    }

    // A whitespace pattern fails at the definition level.
    const blankTables = emptyTables()
    addMission(blankTables, 1, "23", { 1: [rewardRow(1, 2301, 1)] }, { pattern: "   " })
    assert.deepEqual(captureRowProblems(repository(blankTables)), [{
        table: "mission_regular.json",
        id: "23",
        reason: "pattern column is empty or (None)",
    }])

    // The healthy neighbor parses on its own with unchanged semantics.
    const healthyTables = emptyTables()
    addMission(healthyTables, 1, "99", { 1: [rewardRow(1, 9901, 9)] }, {
        pattern: "  healthy-standard  ",
    })
    const catalog = getMissionCatalog(repository(healthyTables))
    assert.equal(catalog.getDefinition(1, 99).pattern, "  healthy-standard  ")
    assert.deepEqual(catalog.getRewardStage(1, 99, 1), {
        stage: 1,
        missionRewardId: 9901,
        targetProgress: 9,
        rewards: [{ kind: 1, amount: 2, itemId: 301 }],
    })
})

test("rejects malformed awake authority and special rewards with named row errors", () => {
    const badCharacterTables = emptyTables()
    addMission(badCharacterTables, 9, "11", { 1: [rewardRow(9, 111, 1)] }, {
        characterId: 0,
        pattern: "bad-character",
    })
    assert.deepEqual(captureRowProblems(repository(badCharacterTables)), [{
        table: "mission_char_awake.json",
        id: "11",
        reason: "awake character id column is not a positive integer",
    }])

    const badSpecialTables = emptyTables()
    addMission(badSpecialTables, 9, "12", { 1: [rewardRow(9, 121, 1, {
        specialKind: "0",
        characterId: "123",
        boardIndex: undefined,
        awakeLevel: "2",
    })] }, { characterId: 123, pattern: "bad-special" })
    assert.deepEqual(captureRowProblems(repository(badSpecialTables)), [{
        table: "mission_char_awake_reward.json mission 12",
        id: "1",
        reason: "awake special reward character/board/level column is invalid",
    }])
})

test("rejects malformed awake special fields and clear seconds with named row errors", () => {
    const invalidRows = [
        [21, row => { row[1] = "0junk" }, "awake special reward kind is not a non-negative integer"],
        [22, row => { row[1] = "-1" }, "awake special reward kind is not a non-negative integer"],
        [23, row => { row[2] = "101junk" }, "awake special reward character/board/level column is invalid"],
        [24, row => { row[2] = String(Number.MAX_SAFE_INTEGER + 1) }, "awake special reward character/board/level column is invalid"],
        [25, row => { row[3] = "0" }, "awake special reward character/board/level column is invalid"],
        [26, row => { row[4] = "0" }, "awake special reward character/board/level column is invalid"],
        [27, row => { row[6] = "-1" }, "awake target clear seconds column is invalid"],
        [28, row => { row[6] = "90junk" }, "awake target clear seconds column is invalid"],
        [29, row => { row[6] = String(Number.MAX_SAFE_INTEGER + 1) }, "awake target clear seconds column is invalid"],
    ]
    for (const [missionId, mutate, reason] of invalidRows) {
        const tables = emptyTables()
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
        assert.deepEqual(captureRowProblems(repository(tables)), [{
            table: "mission_char_awake_reward.json mission " + missionId,
            id: "1",
            reason,
        }], `malformed awake row ${missionId}`)
    }

    // The audited positive boundary (targetClearSeconds 0) still parses.
    const healthyTables = emptyTables()
    addMission(healthyTables, 9, "99", { 1: [rewardRow(9, 991, 1, {
        specialKind: "0",
        characterId: "123",
        boardIndex: "1",
        awakeLevel: "1",
        targetClearSeconds: "0",
    })] }, { characterId: 123, pattern: "healthy-awake" })
    const catalog = getMissionCatalog(repository(healthyTables))
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

test("pre-init catalog access fails closed and follows the installed runtime repository", () => {
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    try {
        productionContentSnapshotProvider.snapshot = null
        assert.throws(() => getMissionCatalog(), /CONTENT_SNAPSHOT_NOT_INITIALIZED/)
        const tables = emptyTables()
        addMission(tables, 1, "999", { 1: [rewardRow(1, 999001, 1)] })
        const runtimeRepository = repository(tables, "runtime")
        productionContentSnapshotProvider.snapshot = {
            cdn: {},
            archiveSources: { schemaVersion: 1, archives: [] },
            repository: runtimeRepository,
        }

        const runtimeCatalog = getMissionCatalog()
        assert.equal(runtimeCatalog, getMissionCatalog(runtimeRepository))
        assert.deepEqual(runtimeCatalog.getMissionIds(1), [999])
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("bundled catalog covers categories 1-10 with authoritative counts and samples", () => {
    const catalog = getMissionCatalog(bundledMissionContentRepository)
    {
        const expectedCounts = [120, 656, 2512, 997, 1288, 76, 76, 115, 144, 2]
        assert.deepEqual(
            expectedCounts.map((_, index) => catalog.getMissionIds(index + 1).length),
            expectedCounts,
        )
        for (let category = 1; category <= 10; category++) {
            assert.ok(catalog.getDefinitions(category).length > 0, `category ${category}`)
        }
    }
})
