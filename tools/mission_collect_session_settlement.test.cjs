"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-collect-session-settlement-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const catalogModule = require("../src/lib/mission/mission-catalog")
const { MissionEvaluationSession } = require("../src/lib/mission/evaluation-session")
const { CollectComputer } = require("../src/lib/mission/collect-progress")
const { settleMissionCategories } = require("../src/lib/mission/settlement")

initializeDatabase()
const db = getDb()

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("Category 4 settlement uses Session then computes and writes without more fact loads", () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `collect-session-settlement-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    givePlayerItemSync(playerId, 80001, 50)

    const originalLegacy = CollectComputer.buildContext
    const originalSession = CollectComputer.buildContextFromSession
    const originalCompute = CollectComputer.compute
    const originalGetFact = MissionEvaluationSession.prototype.getFact
    const originalGetFactFromPlan = MissionEvaluationSession.prototype.getFactFromPlan
    let sessionContexts = 0
    let computeStarted = false
    let readsAfterCompute = 0
    const loads = []
    CollectComputer.buildContext = () => { throw new Error("Category 4 settlement used legacy context") }
    CollectComputer.buildContextFromSession = (...args) => {
        sessionContexts++
        return originalSession.call(CollectComputer, ...args)
    }
    CollectComputer.compute = (...args) => {
        computeStarted = true
        return originalCompute.call(CollectComputer, ...args)
    }
    MissionEvaluationSession.prototype.getFact = function trackedGetFact(...args) {
        if (computeStarted) readsAfterCompute++
        return originalGetFact.apply(this, args)
    }
    MissionEvaluationSession.prototype.getFactFromPlan = function trackedGetFactFromPlan(...args) {
        if (computeStarted) readsAfterCompute++
        return originalGetFactFromPlan.apply(this, args)
    }
    let settlement
    try {
        settlement = settleMissionCategories(
            playerId,
            [{ category: 4, eventId: 1, missionIds: [1500] }],
            new Date("2020-02-21T04:00:00.000Z"),
            { onMissionFactLoaderCall(key) { loads.push(key) } },
        )
    } finally {
        CollectComputer.buildContext = originalLegacy
        CollectComputer.buildContextFromSession = originalSession
        CollectComputer.compute = originalCompute
        MissionEvaluationSession.prototype.getFact = originalGetFact
        MissionEvaluationSession.prototype.getFactFromPlan = originalGetFactFromPlan
    }

    assert.equal(sessionContexts, 1)
    assert.equal(readsAfterCompute, 0)
    assert.deepEqual(loads.filter(key => key.kind === "player"), [{ kind: "player" }])
    assert.deepEqual(loads.filter(key => key.kind === "collectedItems"), [
        { kind: "collectedItems", itemIds: [80001] },
    ])
    assert.deepEqual(settlement.missionInfo, [
        { mission_category_id: 4, mission_id: 1500, mission_reward_id: 1500001 },
    ])
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 4)[1500], {
        progress: 50,
        stages: { 1: true },
    })
})

test("malformed Catalog selector cannot load collected facts, write progress, or grant rewards", () => {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `collect-malformed-settlement-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    givePlayerItemSync(playerId, 1, 100)
    const baseCatalog = catalogModule.getMissionCatalog()
    const baseDefinition = baseCatalog.getDefinition(4, 1500)
    const malformedDefinition = Object.freeze({
        ...baseDefinition,
        row: Object.freeze(baseDefinition.row.map((value, index) => index === 14 ? true : value)),
    })
    const customCatalog = new Proxy(baseCatalog, {
        get(target, property) {
            if (property === "getDefinitions") {
                return category => category === 4
                    ? target.getDefinitions(4).map(definition =>
                        definition.missionId === 1500 ? malformedDefinition : definition)
                    : target.getDefinitions(category)
            }
            if (property === "getDefinition") {
                return (category, missionId) => category === 4 && missionId === 1500
                    ? malformedDefinition
                    : target.getDefinition(category, missionId)
            }
            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
        },
    })
    const originalGetMissionCatalog = catalogModule.getMissionCatalog
    const loads = []
    let settlement
    catalogModule.getMissionCatalog = () => customCatalog
    try {
        settlement = settleMissionCategories(
            playerId,
            [{ category: 4, eventId: 1, missionIds: [1500] }],
            new Date("2020-02-21T04:00:00.000Z"),
            { onMissionFactLoaderCall(key) { loads.push(key) } },
        )
    } finally {
        catalogModule.getMissionCatalog = originalGetMissionCatalog
    }

    assert.equal(loads.some(key => key.kind === "collectedItems"), false)
    assert.deepEqual(settlement.missionInfo, [])
    assert.deepEqual(settlement.itemList, {})
    assert.equal(getPlayerCategoryMissionsSync(playerId, 4)[1500], undefined)
})
