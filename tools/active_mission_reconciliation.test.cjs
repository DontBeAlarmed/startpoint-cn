require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const reconciliationPath = path.resolve(
    __dirname,
    "../src/lib/mission/active-reconciliation.ts",
)
assert.equal(
    fs.existsSync(reconciliationPath),
    true,
    "Active Mission 状态 reconciliation 模块必须存在",
)

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "active-mission-reconcile-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
let restoreSnapshot = () => {}
let restoreTime = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreSnapshot()
    restoreTime()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

function missionRow({
    eventId,
    phase = 1,
    pattern,
    questKind = "(None)",
    questA = "",
    questB = "",
    questC = "",
    missionIds = "",
    start = "2020-01-01 00:00:00",
    end = "(None)",
}) {
    const row = []
    row[0] = String(eventId)
    row[1] = phase === undefined ? "(None)" : String(phase)
    row[3] = `test_${eventId}_${pattern}_${phase}`
    row[29] = String(pattern)
    row[34] = String(questKind)
    row[35] = String(questA)
    row[36] = String(questB)
    row[37] = String(questC)
    row[55] = missionIds
    row[56] = "(None)"
    row[57] = ""
    row[58] = "(None)"
    row[59] = ""
    row[60] = start
    row[61] = end
    row[62] = start
    row[63] = end
    return row
}

function eventRow({
    kind = 0,
    stringId = "normal_event",
    maxPhase = 1,
    start = "2020-01-01 00:00:00",
    end = "(None)",
} = {}) {
    const row = []
    row[0] = stringId
    row[2] = String(kind)
    row[3] = String(maxPhase)
    row[14] = start
    row[15] = end
    row[22] = "(None)"
    return row
}

function rewardRow(targetProgress = 1) {
    const row = []
    row[3] = String(targetProgress)
    row[4] = "(None)"
    row[7] = "0"
    row[8] = "5"
    return row
}

const tables = {
    "mission_active.json": {
        90001: [missionRow({ eventId: 901, pattern: 57, questKind: 0, questA: 1, questB: 8, questC: 4 })],
        90002: [missionRow({ eventId: 901, pattern: 57, questKind: 1, questA: 1, questB: 8, questC: 1 })],
        90003: [missionRow({ eventId: 901, pattern: 57, questKind: 9, questA: 500005, questC: 1 })],
        90004: [missionRow({ eventId: 901, pattern: 0 })],
        90005: [missionRow({ eventId: 901, pattern: 39 })],
        90006: [missionRow({ eventId: 901, pattern: 13, missionIds: "90001,90002,90003" })],
        90007: [missionRow({
            eventId: 901,
            phase: 2,
            pattern: 13,
            missionIds: "90001,90002,90003,90004,90005,90006",
        })],
        90008: [missionRow({ eventId: 902, pattern: 13, missionIds: "90001,99999" })],
        90009: [missionRow({ eventId: 903, pattern: 57, questKind: 0, questA: 1, questB: 8, questC: 5 })],
        90010: [missionRow({
            eventId: 904,
            pattern: 0,
            start: "2024-08-15 00:00:00",
        })],
        90011: [missionRow({
            eventId: 905,
            pattern: 39,
            end: "2024-08-14 19:59:59",
        })],
        90012: [missionRow({ eventId: 906, pattern: 0 })],
        90013: [missionRow({ eventId: 907, pattern: 0 })],
    },
    "mission_active_event.json": {
        901: [eventRow({ maxPhase: 2 })],
        902: [eventRow()],
        903: [eventRow()],
        904: [eventRow({ start: "2024-08-15 00:00:00" })],
        905: [eventRow({ end: "2024-08-14 19:59:59" })],
        906: [eventRow({ kind: 1, stringId: "come_back_mission_test" })],
        907: [eventRow({ kind: 1, stringId: "normal_mission_test" })],
    },
    "mission_active_reward.json": {
        90001: { 1: [rewardRow()] },
        90002: { 1: [rewardRow()] },
        90003: { 1: [rewardRow()] },
        90004: { 1: [rewardRow(3)] },
        90005: { 1: [rewardRow(20)] },
        90006: { 1: [rewardRow()] },
        90007: { 1: [rewardRow()] },
        90008: { 1: [rewardRow()] },
        90009: { 1: [rewardRow()] },
        90010: { 1: [rewardRow()] },
        90011: { 1: [rewardRow()] },
        90012: { 1: [rewardRow()] },
        90013: { 1: [rewardRow()] },
    },
}

const repository = {
    info: () => ({
        source: "release",
        assetVersion: "active-reconcile-test",
        generatorVersion: 1,
        releaseDigest: "sha256:active-reconcile-test",
    }),
    table: tableName => {
        if (!(tableName in tables)) throw new Error(`unexpected table ${tableName}`)
        return tables[tableName]
    },
}

const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const previousSnapshot = productionContentSnapshotProvider.snapshot
productionContentSnapshotProvider.snapshot = {
    cdn: { targetVersion: "active-reconcile-test" },
    repository,
}
restoreSnapshot = () => {
    productionContentSnapshotProvider.snapshot = previousSnapshot
}

const {
    reconcileActiveMissionFacts,
    resolveActiveMissionQuestIds,
} = require(reconciliationPath)
const bundledActiveMissions = require("../assets/mission_active.json")
const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionSync,
} = require("../src/data/domains/mission")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const {
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} = require("../src/data/domains/quest")
const { getClientSerializedData } = require("../src/data/utils")
const cnLoadRoutes = require("../src/routes/cn/load").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(previousTimeOffset)
const serverNow = Date.parse("2024-08-14T12:00:00.000Z")
setServerTimeOffset(serverNow - Date.now())

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `active-reconcile-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000331
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

function addQuest(questId, finished) {
    insertPlayerQuestProgressSync(playerId, 1, {
        questId,
        finished,
        unlocked: true,
    })
}

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function main() {
    assert.deepEqual(resolveActiveMissionQuestIds(bundledActiveMissions[11050][0]), [1008004])
    assert.deepEqual(resolveActiveMissionQuestIds(bundledActiveMissions[12070][0]), [11008001])
    assert.deepEqual(resolveActiveMissionQuestIds(bundledActiveMissions[21100][0]), [500005001])
    assert.deepEqual(resolveActiveMissionQuestIds(tables["mission_active.json"][90001][0]), [1008004])
    assert.deepEqual(resolveActiveMissionQuestIds(tables["mission_active.json"][90002][0]), [11008001])
    assert.deepEqual(
        resolveActiveMissionQuestIds(tables["mission_active.json"][90003][0]),
        [500005001],
        "WorldStoryEvent 21100 同构参数 [9,500005,\"\",1] 必须映射到活动关卡 500005001",
    )

    addQuest(1008004, true)
    addQuest(11008001, true)
    addQuest(500005001, true)
    addQuest(1008005, false)
    updatePlayerSync({ id: playerId, totalLoginDays: 3, totalStaminaUsed: 20 })

    const first = reconcileActiveMissionFacts({ playerId, repository, now: serverNow })
    const firstById = Object.fromEntries(first.map(delta => [delta.mission_id, delta]))
    for (const missionId of [90001, 90002, 90003, 90004, 90005, 90006, 90007, 90013]) {
        const expectedProgress = missionId === 90004 || missionId === 90013
            ? 3
            : missionId === 90005 ? 20 : 1
        assert.equal(firstById[missionId]?.progress_value, expectedProgress)
        assert.deepEqual(firstById[missionId]?.stages, [{ stage: 1, received: false }])
    }
    assert.equal(firstById[90008], undefined, "target_mission_clear 缺一个目标时不得完成")
    assert.equal(firstById[90009], undefined, "unfinished quest 不得完成")
    assert.equal(firstById[90010], undefined, "未开放任务必须 fail closed")
    assert.equal(firstById[90011], undefined, "已过期任务必须 fail closed")
    assert.equal(
        firstById[90012],
        undefined,
        "Comeback(kind 1) 缺少玩家回归资格生产者时不得只凭时间推进",
    )
    assert.equal(firstById[90013]?.progress_value, 3, "普通 kind 1 Normal 事件不得被误判为 Comeback")
    assert.equal(
        getPlayerActiveMissionsSync(playerId)[90007].progress,
        1,
        "同一次 reconcile 必须通过固定点完成前置任务并开放 phase 2",
    )
    assert.equal(
        getPlayerActiveMissionsSync(playerId)[90001].stages[1],
        false,
        "target_mission_clear 不得要求目标奖励已经领取",
    )

    updatePlayerSync({ id: playerId, totalLoginDays: 1, totalStaminaUsed: 5 })
    assert.deepEqual(
        reconcileActiveMissionFacts({ playerId, repository, now: serverNow }),
        [],
        "绝对事实降低与重复 reconcile 都不得产生增量或回退",
    )
    assert.equal(getPlayerActiveMissionsSync(playerId)[90004].progress, 3)
    assert.equal(getPlayerActiveMissionsSync(playerId)[90005].progress, 20)

    updatePlayerSync({ id: playerId, totalLoginDays: 4, totalStaminaUsed: 25 })
    updatePlayerQuestProgressSync(playerId, 1, { questId: 1008005, finished: true })
    db.exec(`
        CREATE TRIGGER fail_active_reconcile_stage_insert
        BEFORE INSERT ON players_active_missions_stages
        WHEN NEW.mission_id = 90009
        BEGIN
            SELECT RAISE(FAIL, 'forced active reconciliation failure');
        END
    `)
    assert.throws(
        () => reconcileActiveMissionFacts({ playerId, repository, now: serverNow }),
        /forced active reconciliation failure/,
    )
    assert.equal(getPlayerActiveMissionsSync(playerId)[90004].progress, 3, "数据库异常必须回滚较早写入")
    assert.equal(getPlayerActiveMissionsSync(playerId)[90005].progress, 20)
    assert.equal(getPlayerActiveMissionsSync(playerId)[90009], undefined, "数据库异常必须回滚整批写入")
    db.exec("DROP TRIGGER fail_active_reconcile_stage_insert")

    const awakeBefore = getClientSerializedData(playerId, { viewerId }).active_mission_list
    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await fastify.register(cnLoadRoutes, { assetProvider: { mode: "client-owned" } })
    await fastify.ready()

    try {
        const loaded = await fastify.inject({
            method: "POST",
            url: "/load",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                res_ver: "1.4.54",
            },
            payload: encodeRequest({
                viewer_id: viewerId,
                keychain: viewerId,
                device_id: 1,
                device_token: "test",
            }),
        })
        assert.equal(loaded.statusCode, 200, loaded.body)
        const data = decodeResponse(loaded).data
        assert.equal(data.all_active_mission_list[90004].progress, 4)
        assert.equal(data.all_active_mission_list[90005].progress, 25)
        assert.equal(data.all_active_mission_list[90009].progress, 1)
        assert.deepEqual(
            data.active_mission_list,
            awakeBefore,
            "Active Mission reconciliation 不得污染 category 9 角色觉醒 active_mission_list",
        )
        assert.equal(
            data.active_mission_list.some(mission => mission.mission_id === 90009),
            false,
        )
    } finally {
        await fastify.close()
    }

    updatePlayerActiveMissionSync(playerId, 999001, 77)
    assert.equal(
        getClientSerializedData(playerId, { viewerId }).all_active_mission_list[999001],
        undefined,
        "自定义 Content Release 必须决定 Active Mission 白名单，不能回退 bundled 表",
    )
}

main().then(
    () => {
        console.log("active mission reconciliation tests passed")
        cleanup()
        process.removeListener("exit", cleanup)
    },
    error => {
        console.error(error)
        cleanup()
        process.removeListener("exit", cleanup)
        process.exitCode = 1
    },
)
