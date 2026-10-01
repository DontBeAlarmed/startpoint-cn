"use strict"

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => { restoreContentSnapshot() })

const assert = require("node:assert/strict")
const test = require("node:test")

const { getContentSnapshot } = require("../src/content/runtime/content-snapshot")
const { getMissionCatalog } = require("../src/lib/mission/mission-catalog")
const { getMissionRequirementDraft } = require("../src/lib/mission/requirements/providers")
const {
    getMissionRoutingValidationProblems,
    MissionRoutingValidationError,
    assertMissionConditionRouting,
} = require("../src/lib/mission/requirements/routing-validation")

// Synthetic-catalog helper: clone the production repository tables and
// override individual definition rows, mirroring the forwarding catalogs of
// mission_fact_requirements.test.cjs.
function forwardingCatalog(rowOverrides, removedMissionIds = []) {
    const sourceRepository = getContentSnapshot().repository
    const tableOverrides = new Map()
    function mutableTable(tableName) {
        if (!tableOverrides.has(tableName)) {
            tableOverrides.set(tableName, structuredClone(sourceRepository.table(tableName)))
        }
        return tableOverrides.get(tableName)
    }
    for (const [category, missionId, row] of rowOverrides) {
        mutableTable(definitionTableOf(category))[String(missionId)] = [[...row]]
    }
    for (const [category, missionId] of removedMissionIds) {
        delete mutableTable(definitionTableOf(category))[String(missionId)]
    }
    return getMissionCatalog(Object.freeze({
        info: sourceRepository.info,
        table(tableName) {
            return tableOverrides.get(tableName) ?? sourceRepository.table(tableName)
        },
    }))
}

function definitionTableOf(category) {
    return {
        1: "mission_regular.json",
        2: "mission_daily.json",
        3: "mission_event.json",
        4: "mission_collect_item.json",
        5: "mission_degree.json",
        6: "mission_pass_daily.json",
        7: "mission_pass_week.json",
        8: "mission_pass_event.json",
        9: "mission_char_awake.json",
        10: "mission_weekly_def.json",
    }[category]
}

function withField(definition, index, value) {
    return definition.row.map((entry, position) => position === index ? value : entry)
}

test("bundled content passes the condition-routing cross-check with zero problems", () => {
    const problems = getMissionRoutingValidationProblems(getMissionCatalog())
    assert.deepEqual(
        problems.map(problem => `${problem.table}[${problem.id}]: ${problem.reason}`),
        [],
    )
    assert.doesNotThrow(() => assertMissionConditionRouting(getMissionCatalog()))
})

test("a Regular pattern moved off its audited condition fails the cross-check", () => {
    const catalog = getMissionCatalog()
    const source = catalog.getDefinition(1, 24) // total_login, condition 0 → player
    const drifted = forwardingCatalog([[1, 24, withField(source, 2, "48")]])
    // Condition 48 is the second-mana-board family: total_login re-routes.
    assert.equal(
        getMissionRequirementDraft(drifted.getDefinition(1, 24), drifted).mode,
        "computed",
    )
    const problems = getMissionRoutingValidationProblems(drifted)
    assert.equal(problems.length, 1)
    assert.match(problems[0].reason, /total_login/)
    assert.match(problems[0].reason, /expected computed:player/)
    assert.throws(() => assertMissionConditionRouting(drifted), MissionRoutingValidationError)
})

test("a Regular persisted pattern moved off its producer condition fails the cross-check", () => {
    const catalog = getMissionCatalog()
    const source = catalog.getDefinition(1, 29) // get_mvp, condition 19 → persisted
    const drifted = forwardingCatalog([[1, 29, withField(source, 2, "0")]])
    const problems = getMissionRoutingValidationProblems(drifted)
    assert.equal(problems.length, 1)
    assert.match(problems[0].reason, /get_mvp/)
    assert.match(problems[0].reason, /expected persisted/)
})

test("a Degree family prefix moved off its condition fails the cross-check", () => {
    const catalog = getMissionCatalog()
    const source = catalog.getDefinition(5, 13000) // degree_rank_ss_clear_single_1
    const drifted = forwardingCatalog([[5, 13000, withField(source, 3, "1")]])
    const problems = getMissionRoutingValidationProblems(drifted)
    assert.equal(problems.length, 1)
    assert.match(problems[0].reason, /degree_rank_ss_clear_single_1/)
    assert.match(problems[0].reason, /expected computed:missionBattleCounters/)
})

test("a Degree aggregate boss row with drifted shape stays fail-closed and flagged", () => {
    const catalog = getMissionCatalog()
    const source = catalog.getDefinition(5, 30000)
    const drifted = forwardingCatalog([[5, 30000, withField(source, 9, "1")]])
    const requirement = getMissionRequirementDraft(drifted.getDefinition(5, 30000), drifted)
    assert.equal(requirement.mode, "unsupported")
    const problems = getMissionRoutingValidationProblems(drifted)
    assert.equal(problems.length, 1)
    assert.match(problems[0].reason, /aggregate boss clear/)
})

test("an Event haniwa leaf reshaped off range 15 fails the cross-check", () => {
    const catalog = getMissionCatalog()
    const source = catalog.getDefinition(3, 500001) // haniwa leaf: type 23, range 15
    const drifted = forwardingCatalog([[3, 500001, withField(source, 7, "5")]])
    const problems = getMissionRoutingValidationProblems(drifted)
    assert.equal(problems.length, 1)
    assert.match(problems[0].reason, /haniwa/)
})

test("an unknown pattern on a known condition routes through the single channel", () => {
    const catalog = getMissionCatalog()
    const source = catalog.getDefinition(1, 24) // total_login row, condition 0
    const renamed = forwardingCatalog([[1, 24, withField(source, 0, "future_login_total_variant")]])
    // No legacy list entry: the condition channel is authoritative and the
    // cross-check stays silent for genuinely new content.
    assert.deepEqual(getMissionRoutingValidationProblems(renamed), [])
    const draft = getMissionRequirementDraft(renamed.getDefinition(1, 24), renamed)
    assert.equal(draft.mode, "computed")
    assert.deepEqual(draft.facts, [{ kind: "player" }])
})

test("pass coverage partition follows the requirement provider single channel", () => {
    const catalog = getMissionCatalog()
    const supported = []
    const unsupported = []
    for (const category of [6, 7, 8]) {
        for (const definition of catalog.getDefinitions(category)) {
            const bucket = getMissionRequirementDraft(definition, catalog).mode === "unsupported"
                ? unsupported
                : supported
            bucket.push(`${category}:${definition.missionId}`)
        }
    }
    // Locked by tools/mission_coverage_audit.test.cjs: 248 automated of 267.
    assert.equal(supported.length, 248)
    assert.equal(unsupported.length, 19)
    assert.deepEqual(
        catalog.getDefinitions(7)
            .filter(definition => getMissionRequirementDraft(definition, catalog).mode === "unsupported")
            .map(definition => definition.patternType),
        [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20],
    )
})
