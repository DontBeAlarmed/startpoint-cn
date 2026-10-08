"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    DegreeComputer,
    allFacts,
    buildDegreeRuleCatalog,
    createSession,
    getMissionCatalog,
    installGlobalRepository,
    repositoryWith,
} = require("./helpers/mission-degree-session-fixture.cjs")

test("all 1288 Degree rules build and compute without post-context external access", () => {
    let tableCalls = 0
    const repository = repositoryWith({}, "all-degree-characterization")
    const countedRepository = {
        ...repository,
        table(tableName) {
            tableCalls++
            return repository.table(tableName)
        },
    }
    const catalog = getMissionCatalog(countedRepository)
    const missionIds = catalog.getMissionIds(5)
    const rules = buildDegreeRuleCatalog(catalog).rules
    assert.equal(rules.size, 1288)
    assert.equal([...rules.values()].filter(rule => rule.kind === "persisted").length, 100)
    // The semantic rule engine now recognizes every bundled Degree row, so
    // nothing falls through to "unsupported" anymore (was 6 before the
    // rescue/newbie/MVP semantic families landed).
    assert.equal([...rules.values()].filter(rule => rule.kind === "unsupported").length, 0)
    assert.equal([...rules.values()].filter(rule => !["persisted", "unsupported"].includes(rule.kind)).length, 1188)

    const loaderCalls = []
    const session = createSession(catalog, missionIds, allFacts(), loaderCalls)
    const context = DegreeComputer.buildContextFromSession(session, 5, missionIds)
    const tableCallsAfterContext = tableCalls
    const loaderCallsAfterContext = loaderCalls.length
    installGlobalRepository(repositoryWith({}, "global-after-context"))
    const sessionPrototype = Object.getPrototypeOf(session)
    const catalogPrototype = Object.getPrototypeOf(catalog)
    const sessionGetFact = sessionPrototype.getFact
    const sessionGetFactFromPlan = sessionPrototype.getFactFromPlan
    const catalogGetDefinition = catalogPrototype.getDefinition
    sessionPrototype.getFact = () => { throw new Error("Session getter used during compute") }
    sessionPrototype.getFactFromPlan = () => { throw new Error("Session getter used during compute") }
    catalogPrototype.getDefinition = () => { throw new Error("Catalog getter used during compute") }
    try {
        for (const missionId of missionIds) {
            assert.doesNotThrow(() => DegreeComputer.compute(missionId, context, 0))
            assert.doesNotThrow(() => DegreeComputer.compute(missionId, context, 7))
        }
    } finally {
        sessionPrototype.getFact = sessionGetFact
        sessionPrototype.getFactFromPlan = sessionGetFactFromPlan
        catalogPrototype.getDefinition = catalogGetDefinition
    }
    assert.equal(tableCalls, tableCallsAfterContext)
    assert.equal(loaderCalls.length, loaderCallsAfterContext)
})
