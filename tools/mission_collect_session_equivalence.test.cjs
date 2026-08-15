"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-collect-equivalence-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getDb } = require("../src/data/db")
const {
    MissionEvaluationSession,
    createProductionMissionFactLoaderRegistry,
    getMissionCatalog,
    getMissionFactRequirementRegistry,
} = require("../src/lib/mission")
const { MissionFactLoaderRegistry } = require("../src/lib/mission/fact-loaders")
const { CollectComputer, getCollectMissionItemId } = require("../src/lib/mission/collect-progress")

initializeDatabase()
const db = getDb()
const evaluationTime = new Date("2024-08-14T12:00:00.000Z")

test.after(() => {
    if (db.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

test("legacy and Session compute every Category 4 mission equivalently", () => {
    const playerId = createPlayer("collect-equivalence")
    const totals = Object.fromEntries([
        [50200, 3], [50300, 5], [50800, 7], [51000, 11], [51001, 13],
        [51002, 17], [80001, 19], [80002, 23], [80003, 29],
    ])
    for (const [itemId, amount] of Object.entries(totals)) {
        givePlayerItemSync(playerId, Number(itemId), amount)
    }
    const catalog = getMissionCatalog()
    const missionIds = catalog.getMissionIds(4)
    const session = new MissionEvaluationSession({
        playerId,
        evaluationTime,
        catalog,
        requirementRegistry: getMissionFactRequirementRegistry(catalog),
        candidates: missionIds.map(missionId => ({ category: 4, missionId })),
        orchestratorFacts: [{ kind: "player" }],
        loaders: createProductionMissionFactLoaderRegistry(),
    })
    const legacyContext = CollectComputer.buildContext(playerId, 4, evaluationTime, missionIds)
    const sessionContext = CollectComputer.buildContextFromSession(session, 4, missionIds)

    assert.equal(missionIds.length, 997)
    for (const definition of catalog.getDefinitions(4)) {
        const missionId = definition.missionId
        const rawItemId = definition.row[14]
        const parsedItemId = typeof rawItemId === "number"
            ? (Number.isSafeInteger(rawItemId) && rawItemId > 0 ? rawItemId : undefined)
            : typeof rawItemId === "string" && /^[+-]?\d+$/.test(rawItemId)
                && Number.isSafeInteger(Number(rawItemId)) && Number(rawItemId) > 0
                ? Number(rawItemId)
                : undefined
        for (const dbProgress of [0, 2, 31]) {
            const expected = parsedItemId === undefined
                ? dbProgress
                : Math.max(dbProgress, totals[String(parsedItemId)] ?? 0)
            assert.equal(
                CollectComputer.compute(missionId, sessionContext, dbProgress),
                expected,
                `Session Category 4 mission ${missionId} dbProgress ${dbProgress}`,
            )
            assert.equal(
                CollectComputer.compute(missionId, legacyContext, dbProgress),
                expected,
                `legacy Category 4 mission ${missionId} dbProgress ${dbProgress}`,
            )
        }
    }
})

test("Session compute uses its Catalog item selector without reading global master", () => {
    const baseCatalog = getMissionCatalog()
    const baseDefinition = baseCatalog.getDefinition(4, 1500)
    const customDefinition = Object.freeze({
        ...baseDefinition,
        row: Object.freeze(baseDefinition.row.map((value, index) => index === 14 ? 777777 : value)),
    })
    const customCatalog = new Proxy(baseCatalog, {
        get(target, property) {
            if (property === "getDefinitions") {
                return category => category === 4
                    ? target.getDefinitions(4).map(definition =>
                        definition.missionId === 1500 ? customDefinition : definition)
                    : target.getDefinitions(category)
            }
            if (property === "getDefinition") {
                return (category, missionId) => category === 4 && missionId === 1500
                    ? customDefinition
                    : target.getDefinition(category, missionId)
            }
            const value = Reflect.get(target, property, target)
            return typeof value === "function" ? value.bind(target) : value
        },
    })
    const registry = getMissionFactRequirementRegistry(customCatalog)
    let collectedLoads = 0
    const loaders = new MissionFactLoaderRegistry()
        .register("player", () => ({ id: 42 }))
        .register("collectedItems", ({ key }) => {
            collectedLoads++
            assert.deepEqual(key.itemIds, [777777])
            return { "777777": 41 }
        })
    const session = new MissionEvaluationSession({
        playerId: 42,
        evaluationTime,
        catalog: customCatalog,
        requirementRegistry: registry,
        candidates: [{ category: 4, missionId: 1500 }],
        orchestratorFacts: [{ kind: "player" }],
        loaders,
    })
    const context = CollectComputer.buildContextFromSession(session, 4, [1500])

    assert.equal(getCollectMissionItemId(1500), 80001)
    assert.equal(CollectComputer.compute(1500, context, 0), 41)
    assert.equal(CollectComputer.compute(1500, context, 50), 50)
    assert.equal(collectedLoads, 1)
})

test("malformed Catalog selectors stay unsupported without loading or advancing", () => {
    const baseCatalog = getMissionCatalog()
    const baseDefinition = baseCatalog.getDefinition(4, 1500)
    const malformed = [true, "1e3", " 42 ", 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1]

    for (const rawItemId of malformed) {
        const customDefinition = Object.freeze({
            ...baseDefinition,
            row: Object.freeze(baseDefinition.row.map((value, index) =>
                index === 14 ? rawItemId : value)),
        })
        const customCatalog = new Proxy(baseCatalog, {
            get(target, property) {
                if (property === "getDefinitions") {
                    return category => category === 4
                        ? target.getDefinitions(4).map(definition =>
                            definition.missionId === 1500 ? customDefinition : definition)
                        : target.getDefinitions(category)
                }
                if (property === "getDefinition") {
                    return (category, missionId) => category === 4 && missionId === 1500
                        ? customDefinition
                        : target.getDefinition(category, missionId)
                }
                const value = Reflect.get(target, property, target)
                return typeof value === "function" ? value.bind(target) : value
            },
        })
        let collectedLoads = 0
        const loaders = new MissionFactLoaderRegistry()
            .register("player", () => ({ id: 42 }))
            .register("collectedItems", ({ key }) => {
                collectedLoads++
                return Object.fromEntries(key.itemIds.map(itemId => [String(itemId), 99]))
            })
        const session = new MissionEvaluationSession({
            playerId: 42,
            evaluationTime,
            catalog: customCatalog,
            requirementRegistry: getMissionFactRequirementRegistry(customCatalog),
            candidates: [{ category: 4, missionId: 1500 }],
            orchestratorFacts: [{ kind: "player" }],
            loaders,
        })
        const context = CollectComputer.buildContextFromSession(session, 4, [1500])

        assert.equal(CollectComputer.compute(1500, context, 0), 0, String(rawItemId))
        assert.equal(CollectComputer.compute(1500, context, 17), 17, String(rawItemId))
        assert.equal(collectedLoads, 0, String(rawItemId))
    }
})
