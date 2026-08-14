require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-scope-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db

function cleanup() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const missionDomain = require("../src/data/domains/mission")
const playerDomain = require("../src/data/domains/player")
const dbDomain = require("../src/data/db")
const registry = require("../src/lib/mission/registry")
const calls = {
    buildContext: [],
    compute: [],
    getDb: [],
    getComputer: [],
    getPlayerSync: [],
    persisted: [],
    transaction: [],
}
const realGetPlayerCategoryMissionsSync = missionDomain.getPlayerCategoryMissionsSync
const realGetPlayerSync = playerDomain.getPlayerSync
const realGetDb = dbDomain.getDb
const realGetComputer = registry.getComputer

missionDomain.getPlayerCategoryMissionsSync = function instrumentedPersistedRead(playerId, category) {
    calls.persisted.push({ playerId, category })
    return realGetPlayerCategoryMissionsSync(playerId, category)
}
registry.getComputer = function instrumentedGetComputer(category) {
    calls.getComputer.push(category)
    const computer = realGetComputer(category)
    return {
        name: computer.name,
        buildContext(...args) {
            calls.buildContext.push({
                playerId: args[0],
                category: args[1],
                missionIds: args[3] === undefined ? undefined : [...args[3]],
            })
            return computer.buildContext(...args)
        },
        compute(missionId, context, dbProgress) {
            calls.compute.push({
                playerId: context.playerId,
                category: context.category,
                missionId,
            })
            return computer.compute(missionId, context, dbProgress)
        },
    }
}

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { recordMissionBattleResultSync } = require("../src/data/domains/mission_battle_facts")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { isMissionEnabledAt } = require("../src/lib/mission/patterns")
const { getMissionIdsByCategory } = require("../src/lib/mission/stages")

initializeDatabase()
db = realGetDb()

let settlementInProgress = false
const instrumentedDb = new Proxy(db, {
    get(target, property) {
        if (property === "transaction") {
            return function instrumentedTransactionFactory(...args) {
                const transaction = target.transaction(...args)
                return function instrumentedTransaction(...transactionArgs) {
                    if (settlementInProgress) calls.transaction.push(true)
                    return transaction(...transactionArgs)
                }
            }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
    },
})
dbDomain.getDb = function instrumentedGetDb() {
    if (!settlementInProgress) return realGetDb()
    calls.getDb.push(true)
    return instrumentedDb
}
playerDomain.getPlayerSync = function instrumentedGetPlayerSync(playerId) {
    if (settlementInProgress) calls.getPlayerSync.push(playerId)
    return realGetPlayerSync(playerId)
}

const { settleMissionCategories } = require("../src/lib/mission/settlement")

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

function resetCalls() {
    for (const entries of Object.values(calls)) entries.length = 0
}

function settleWithCandidates(playerId, scopes, evaluationTime) {
    const candidates = []
    settlementInProgress = true
    try {
        const result = settleMissionCategories(playerId, scopes, evaluationTime, {
            onCategoryCandidates(category, count) {
                candidates.push({ category, count })
            },
        })
        return { candidates, result }
    } finally {
        settlementInProgress = false
    }
}

const evaluationTime = new Date("2025-01-01T12:00:00.000Z")
const categoryOneMissionIdSet = new Set(getMissionIdsByCategory(1))
const foreignCategoryMissionId = getMissionIdsByCategory(2)
    .find(missionId => !categoryOneMissionIdSet.has(missionId))
assert.notEqual(
    foreignCategoryMissionId,
    undefined,
    "Category 2 must contain a mission that does not belong to Category 1",
)

resetCalls()
const targetedPlayerId = createPlayer("mission-scope-targeted")
const targeted = settleWithCandidates(
    targetedPlayerId,
    [{ category: 1, missionIds: [1, 2, 16, 999_999_999] }],
    evaluationTime,
)
assert.deepEqual(targeted.candidates, [{ category: 1, count: 3 }])
assert.ok(calls.getDb.length > 0, "targeted scope must exercise the real database monitor")
assert.deepEqual(calls.transaction, [true])
assert.ok(
    calls.getPlayerSync.includes(targetedPlayerId),
    "targeted scope must exercise the real player-read monitor",
)
assert.deepEqual(calls.getComputer, [1])
assert.deepEqual(calls.buildContext, [{
    playerId: targetedPlayerId,
    category: 1,
    missionIds: [1, 2],
}])
assert.deepEqual(calls.persisted, [{ playerId: targetedPlayerId, category: 1 }])
assert.deepEqual(calls.compute.map(call => call.missionId), [1, 2])

for (const [label, missionIds, expectedCandidateCount] of [
    ["empty", [], 0],
    ["disabled", [16, 17], 2],
    ["invalid", [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1], 0],
    ["foreign", [foreignCategoryMissionId], 0],
]) {
    resetCalls()
    const playerId = createPlayer(`mission-scope-${label}`)
    const settlement = settleWithCandidates(
        playerId,
        [{ category: 1, missionIds }],
        evaluationTime,
    )
    assert.deepEqual(settlement.candidates, [{ category: 1, count: expectedCandidateCount }])
    assert.deepEqual(settlement.result, {
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        passCardPoints: {},
    })
    assert.deepEqual({
        getDb: calls.getDb,
        getPlayerSync: calls.getPlayerSync,
        transaction: calls.transaction,
    }, {
        getDb: [],
        getPlayerSync: [],
        transaction: [],
    }, `${label} scope must not touch the database`)
    assert.deepEqual(calls.getComputer, [], `${label} scope must not resolve a computer`)
    assert.deepEqual(calls.buildContext, [], `${label} scope must not build context`)
    assert.deepEqual(calls.persisted, [], `${label} scope must not read persisted missions`)
    assert.deepEqual(calls.compute, [], `${label} scope must not compute missions`)
}

resetCalls()
const unionPlayerId = createPlayer("mission-scope-union")
const union = settleWithCandidates(
    unionPlayerId,
    [
        { category: 1, missionIds: [1, 1, 0, -1, 1.5, NaN, Infinity, 16] },
        { category: 1, missionIds: [2, 2, 16, Number.MAX_SAFE_INTEGER + 1] },
    ],
    evaluationTime,
)
assert.deepEqual(union.candidates, [{ category: 1, count: 3 }])
assert.deepEqual(calls.buildContext[0].missionIds, [1, 2])
assert.deepEqual(calls.compute.map(call => call.missionId), [1, 2])

const fullMissionIds = getMissionIdsByCategory(1)
const enabledFullMissionIds = fullMissionIds.filter(missionId =>
    isMissionEnabledAt(1, missionId, evaluationTime),
)
let fullSettlementResult
for (const [label, scopes] of [
    ["full-only", [1]],
    ["full-then-targeted", [1, { category: 1, missionIds: [1] }]],
    ["targeted-then-full", [{ category: 1, missionIds: [1] }, 1]],
]) {
    resetCalls()
    const playerId = createPlayer(`mission-scope-${label}`)
    const settlement = settleWithCandidates(playerId, scopes, evaluationTime)
    assert.deepEqual(settlement.candidates, [{ category: 1, count: fullMissionIds.length }])
    assert.deepEqual(calls.buildContext[0].missionIds, enabledFullMissionIds)
    assert.deepEqual(calls.compute.map(call => call.missionId), enabledFullMissionIds)
    if (fullSettlementResult === undefined) fullSettlementResult = settlement.result
    else assert.deepEqual(settlement.result, fullSettlementResult)
}

resetCalls()
const dailyPlayerId = createPlayer("mission-scope-daily-dependencies")
updatePlayerSync({
    id: dailyPlayerId,
    totalDashes: 10,
    totalStaminaUsed: 50,
})
for (let index = 0; index < 3; index++) {
    recordMissionBattleResultSync(dailyPlayerId, { isMulti: false, accomplished: true })
}
recordMissionBattleResultSync(dailyPlayerId, { isMulti: true, accomplished: true })
const dailyMissionIds = getMissionIdsByCategory(2)
const enabledDailyMissionIds = dailyMissionIds.filter(missionId =>
    isMissionEnabledAt(2, missionId, evaluationTime),
)
const daily = settleWithCandidates(
    dailyPlayerId,
    [{ category: 2, missionIds: [17] }],
    evaluationTime,
)
assert.deepEqual(daily.candidates, [{ category: 2, count: dailyMissionIds.length }])
assert.deepEqual(calls.buildContext[0].missionIds, enabledDailyMissionIds)
assert.deepEqual(calls.compute.map(call => call.missionId), enabledDailyMissionIds)
assert.equal(realGetPlayerCategoryMissionsSync(dailyPlayerId, 2)[17].progress, 4)

resetCalls()
const eventPlayerId = createPlayer("mission-scope-independent-events")
settleWithCandidates(
    eventPlayerId,
    [
        { category: 1, eventId: 1, missionIds: [1] },
        { category: 1, eventId: 2, missionIds: [1] },
    ],
    evaluationTime,
)
assert.deepEqual(calls.buildContext.map(call => call.missionIds), [[1], [1]])
assert.deepEqual(calls.compute.map(call => call.missionId), [1])

console.log("scoped mission settlement tests passed")
cleanup()
process.removeListener("exit", cleanup)
