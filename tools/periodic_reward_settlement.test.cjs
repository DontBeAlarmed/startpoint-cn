require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "periodic-reward-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const { installBundledGameplaySnapshot } = require(
    "./helpers/install-bundled-gameplay-snapshot.cjs"
)
const restoreSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: [
        "hard_multi_event.json",
        "periodic_reward.json",
        "periodic_reward_point.json",
    ],
})

let db
function cleanup() {
    restoreSnapshot()
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    consumePeriodicRewardPointSync,
    ensureActivityPeriodicRewardPointsSync,
    getPlayerPeriodicRewardPointsSync,
} = require("../src/data/domains/campaign")
const {
    dailyResetPlayerDataSync,
    getPlayerSync,
    insertDefaultPlayerSync,
} = require("../src/data/domains/player")
const { getPlayerItemSync } = require("../src/data/domains/item")
const {
    settleActivityPeriodicRewardsSync,
} = require("../src/lib/quest/finish/periodic-reward-handler")

initializeDatabase()
db = getDb()

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

function points(playerId) {
    return Object.fromEntries(getPlayerPeriodicRewardPointsSync(playerId)
        .map(entry => [String(entry.id), entry.point]))
}

const playerId = createPlayer("periodic-reward")
assert.deepEqual(points(playerId), {
    1: 2,
    2: 2,
    3: 2,
    10000000: 2,
    10000001: 2,
    10000002: 2,
})

db.prepare(`UPDATE players_periodic_reward_points SET point = 7 WHERE player_id = ? AND id = 1`)
    .run(playerId)
db.prepare(`DELETE FROM players_periodic_reward_points WHERE player_id = ? AND id = 3`)
    .run(playerId)
ensureActivityPeriodicRewardPointsSync(playerId)
assert.equal(points(playerId)[1], 7, "同日补齐不得覆盖已有次数")
assert.equal(points(playerId)[3], 2, "旧存档缺失点数应在首次读取时补齐")

db.prepare(`UPDATE players_periodic_reward_points SET point = 98 WHERE player_id = ? AND id = 1`)
    .run(playerId)
db.prepare(`UPDATE players_periodic_reward_points SET point = 1 WHERE player_id = ? AND id = 2`)
    .run(playerId)
db.prepare(`DELETE FROM players_periodic_reward_points WHERE player_id = ? AND id = 3`)
    .run(playerId)
const previousLogin = new Date("2025-06-19T00:00:00.000Z")
db.prepare(`UPDATE players SET last_login_time = ? WHERE id = ?`)
    .run(previousLogin.toISOString(), playerId)

const resetTime = new Date("2025-06-20T00:00:00.000Z")
assert.equal(dailyResetPlayerDataSync(getPlayerSync(playerId), resetTime), true)
assert.equal(points(playerId)[1], 99, "恢复后不得超过 CDN 上限")
assert.equal(points(playerId)[2], 3, "每日恢复应增加 CDN recoveryPoint")
assert.equal(points(playerId)[3], 2, "跨日首次补齐不得额外叠加恢复")
assert.equal(
    dailyResetPlayerDataSync(getPlayerSync(playerId), new Date("2025-06-20T01:00:00.000Z")),
    false,
)
assert.equal(points(playerId)[2], 3, "同一服务器日不得重复恢复")

db.prepare(`UPDATE players_periodic_reward_points SET point = 1 WHERE player_id = ? AND id = 10000002`)
    .run(playerId)
assert.equal(consumePeriodicRewardPointSync(playerId, 10000002), 0)
assert.equal(consumePeriodicRewardPointSync(playerId, 10000002), null)

db.prepare(`UPDATE players_periodic_reward_points SET point = 1 WHERE player_id = ? AND id = 10000002`)
    .run(playerId)
assert.throws(() => db.transaction(() => {
    assert.equal(consumePeriodicRewardPointSync(playerId, 10000002), 0)
    throw new Error("rollback periodic reward point")
})(), /rollback periodic reward point/)
assert.equal(points(playerId)[10000002], 1)

function settlePeriodic(player, overrides = {}) {
    return db.transaction(() => settleActivityPeriodicRewardsSync({
        playerId: player,
        questCategory: 26,
        questId: 100002001,
        questAccomplished: true,
        isMulti: true,
        random: () => 0.5,
        ...overrides,
    }))()
}

const normalPlayerId = createPlayer("periodic-normal")
const normalBefore = getPlayerItemSync(normalPlayerId, 40405) ?? 0
const normal = settlePeriodic(normalPlayerId)
assert.deepEqual(normal, {
    dropPeriodicRewardIds: [{ group_id: 10000002, index: 1, number: 9 }],
    periodicRewardPointList: [{ id: 10000002, point: 1 }],
    items: { 40405: normalBefore + 9 },
})
assert.equal(getPlayerItemSync(normalPlayerId, 40405), normalBefore + 9)

const finalPlayerId = createPlayer("periodic-final")
const finalBefore = getPlayerItemSync(finalPlayerId, 40405) ?? 0
const final = settlePeriodic(finalPlayerId, { questId: 1006001 })
assert.deepEqual(final, {
    dropPeriodicRewardIds: [{ group_id: 10000002, index: 1, number: 9 }],
    periodicRewardPointList: [{ id: 10000002, point: 1 }],
    items: { 40405: finalBefore + 9 },
})

const exhaustedPlayerId = createPlayer("periodic-exhausted")
db.prepare(`UPDATE players_periodic_reward_points SET point = 0 WHERE player_id = ? AND id = 10000002`)
    .run(exhaustedPlayerId)
let exhaustedRandomCalls = 0
assert.deepEqual(settlePeriodic(exhaustedPlayerId, { random: () => {
    exhaustedRandomCalls++
    return 0.5
} }), {
    dropPeriodicRewardIds: [], periodicRewardPointList: [], items: {},
})
assert.equal(exhaustedRandomCalls, 0, "次数耗尽时不得进入周期奖励抽选")
assert.equal(getPlayerItemSync(exhaustedPlayerId, 40405), null)

for (const [label, overrides] of [
    ["failed", { questAccomplished: false }],
    ["single", { isMulti: false }],
    ["boss", { questCategory: 2, questId: 1066001 }],
]) {
    const boundaryPlayerId = createPlayer(`periodic-${label}`)
    assert.deepEqual(settlePeriodic(boundaryPlayerId, overrides), {
        dropPeriodicRewardIds: [], periodicRewardPointList: [], items: {},
    })
    assert.equal(points(boundaryPlayerId)[10000002], 2)
    assert.equal(getPlayerItemSync(boundaryPlayerId, 40405), null)
}

const settlementRollbackPlayerId = createPlayer("periodic-settlement-rollback")
assert.throws(() => db.transaction(() => {
    settleActivityPeriodicRewardsSync({
        playerId: settlementRollbackPlayerId,
        questCategory: 26,
        questId: 100002001,
        questAccomplished: true,
        isMulti: true,
        random: () => 0.5,
    })
    throw new Error("rollback periodic settlement")
})(), /rollback periodic settlement/)
assert.equal(points(settlementRollbackPlayerId)[10000002], 2)
assert.equal(getPlayerItemSync(settlementRollbackPlayerId, 40405), null)

console.log("periodic reward settlement tests passed")
