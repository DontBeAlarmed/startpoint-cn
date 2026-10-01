const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    parseMissionCatalogSource,
    MissionCatalogDataError,
} = require("../src/lib/mission/mission-catalog-source")

// Minimal valid category 1 fixtures. Rows are position-based; unspecified
// trailing columns read as empty master values.
function validDefinitionRow() {
    return ["ok_pattern"]
}
function validRewardRow() {
    return ["1001", "1", , , , "0", "10"]
}
function repositoryWith(overrides) {
    const tables = {
        "mission_regular.json": { "101": [validDefinitionRow()] },
        "mission_regular_reward.json": { "101": { "1": [validRewardRow()] } },
        ...overrides,
    }
    return { table: name => tables[name] }
}

function captureProblems(repository) {
    try {
        parseMissionCatalogSource(repository)
        return null
    } catch (error) {
        assert.ok(error instanceof MissionCatalogDataError, "must throw MissionCatalogDataError")
        return error.problems
    }
}

test("valid minimal mission tables parse without problems", () => {
    const entries = parseMissionCatalogSource(repositoryWith({}))
    assert.equal(entries.length, 1)
    assert.equal(entries[0].definition.missionId, 101)
    assert.equal(entries[0].definition.pattern, "ok_pattern")
    assert.equal(entries[0].stages.length, 1)
    assert.deepEqual(
        { kind: entries[0].stages[0].rewards[0].kind, amount: entries[0].stages[0].rewards[0].amount },
        { kind: 0, amount: 10 },
    )
})

test("empty or (None) pattern is a named row error", () => {
    const problems = captureProblems(repositoryWith({
        "mission_regular.json": { "101": [["(None)"]] },
    }))
    assert.deepEqual(problems, [{
        table: "mission_regular.json",
        id: "101",
        reason: "pattern column is empty or (None)",
    }])
})

test("definition without reward stage rows is a named row error", () => {
    const problems = captureProblems(repositoryWith({
        "mission_regular_reward.json": {},
    }))
    assert.deepEqual(problems, [{
        table: "mission_regular_reward.json",
        id: "101",
        reason: "mission has no reward stage rows",
    }])
})

test("reward rows without a mission definition are named row errors", () => {
    const problems = captureProblems(repositoryWith({
        "mission_regular_reward.json": {
            "101": { "1": [validRewardRow()] },
            "999": { "1": [validRewardRow()] },
        },
    }))
    assert.deepEqual(problems, [{
        table: "mission_regular_reward.json",
        id: "999",
        reason: "reward stage rows exist without a mission definition",
    }])
})

test("non-integer table key is a named row error", () => {
    const problems = captureProblems(repositoryWith({
        "mission_regular.json": { "oops": [validDefinitionRow()] },
        "mission_regular_reward.json": {},
    }))
    assert.deepEqual(problems, [{
        table: "mission_regular.json",
        id: "oops",
        reason: "table key is not a positive integer id",
    }])
})

test("invalid event id on an event-scoped category is a named row error", () => {
    const problems = captureProblems(repositoryWith({
        "mission_collect_item.json": { "55": [[ "", "", "pattern" ] ] },
        "mission_collect_item_reward.json": { "55": { "1": [[ "55001", "", "", "1", , , "0", "10" ]] } },
    }))
    assert.deepEqual(problems, [{
        table: "mission_collect_item.json",
        id: "55",
        reason: "event id column is not a positive integer",
    }])
})

test("item reward without item id is a named stage error", () => {
    const problems = captureProblems(repositoryWith({
        "mission_regular_reward.json": { "101": { "1": [[ "1001", "1", , , , "1", "10" ]] } },
    }))
    assert.deepEqual(problems, [{
        table: "mission_regular_reward.json mission 101",
        id: "1",
        reason: "reward slot 1 item kind is missing its item id",
    }])
})

test("non-numeric target progress is a named stage error", () => {
    const problems = captureProblems(repositoryWith({
        "mission_regular_reward.json": { "101": { "1": [[ "1001", "x", , , , "0", "10" ]] } },
    }))
    assert.deepEqual(problems, [{
        table: "mission_regular_reward.json mission 101",
        id: "1",
        reason: "mission reward id or target progress column is invalid",
    }])
})

test("multiple problems are all reported with table and id", () => {
    const problems = captureProblems(repositoryWith({
        "mission_regular.json": {
            "101": [["(None)"]],
            "102": [["another"], ["duplicate-row"]],
        },
        "mission_regular_reward.json": {
            "101": { "1": [validRewardRow()] },
            "102": { "1": [validRewardRow()] },
        },
    }))
    assert.equal(problems.length, 2)
    assert.deepEqual(
        problems.map(problem => `${problem.table}[${problem.id}]: ${problem.reason}`).sort(),
        [
            "mission_regular.json[101]: pattern column is empty or (None)",
            "mission_regular.json[102]: definition row bundle must contain exactly one row",
        ],
    )
})

test("duplicate stage table keys are a named row error, not a silent fold", () => {
    const problems = captureProblems(repositoryWith({
        "mission_regular_reward.json": { "101": {
            "1": [validRewardRow()],
            "01": [validRewardRow()],
        } },
    }))
    assert.deepEqual(problems, [{
        table: "mission_regular_reward.json mission 101",
        id: "01",
        reason: "table key appears more than once",
    }])
})

test("bundled gameplay snapshot parses the real tables without problems", () => {
    const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs")
        .installBundledGameplaySnapshot()
    try {
        const entries = parseMissionCatalogSource(
            require("../src/content/runtime/content-snapshot").getContentSnapshot().repository,
        )
        assert.equal(entries.length, 5986)
    } finally {
        restore()
    }
})
