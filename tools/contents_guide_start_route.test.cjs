require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contents-guide-start-route-db-"))
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

function missionRow(
    eventId,
    stringId = "contents_guide_start",
    windowEnd = "2024-08-14 20:30:00",
) {
    const row = []
    row[0] = String(eventId)
    row[1] = "1"
    row[3] = stringId
    row[29] = "0"
    row[56] = "(None)"
    row[58] = "(None)"
    row[60] = "2020-01-01 00:00:00"
    row[61] = windowEnd
    return row
}

function unsupportedRow(eventId) {
    const row = missionRow(eventId)
    row[29] = "999"
    return row
}

function dependencyMissionRow(eventId, missionIds) {
    const row = missionRow(eventId, `guide_dep_${eventId}`)
    row[29] = "13"
    row[55] = missionIds
    return row
}

function eventRow(kind, prerequisiteQuestId = 1008004) {
    const row = []
    row[0] = "guide_event"
    row[2] = String(kind)
    row[3] = "1"
    row[14] = "2020-01-01 00:00:00"
    row[15] = "2024-08-14 20:30:00"
    row[22] = String(prerequisiteQuestId)
    return row
}

function rewardRow() {
    const row = []
    row[3] = "1"
    row[4] = "(None)"
    row[7] = "0"
    row[8] = "5"
    return row
}

const {
    QUEST_TABLE_NAMES,
    getBundledStandardMissionTables,
} = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const bundledQuestTables = Object.fromEntries(QUEST_TABLE_NAMES.map(tableName => [
    tableName,
    require(`../assets/${tableName}`),
]))
const tables = {
    "cdndata/player_rank_full.json": require("../assets/cdndata/player_rank_full.json"),
    ...getBundledStandardMissionTables(),
    ...bundledQuestTables,
    "mission_regular.json": require("../assets/mission_regular.json"),
    "mission_daily.json": require("../assets/mission_daily.json"),
    "mission_event.json": require("../assets/mission_event.json"),
    "mission_collect_item.json": require("../assets/mission_collect_item.json"),
    "mission_degree.json": require("../assets/mission_degree.json"),
    "mission_char_awake.json": require("../assets/mission_char_awake.json"),
    "mission_char_awake_reward.json": require("../assets/mission_char_awake_reward.json"),
    "character.json": require("../assets/character.json"),
    "config.json": require("../assets/config.json"),
    "item_inventory_policy.json": require("../assets/item_inventory_policy.json"),
    "item_max_count.json": require("../assets/item_max_count.json"),
    "mana_node.json": require("../assets/mana_node.json"),
    "mana_board.json": require("../assets/mana_board.json"),
    "mana_node_awake.json": require("../assets/mana_node_awake.json"),
    "character_level.json": require("../assets/character_level.json"),
    "level_required_mana_node.json": require("../assets/level_required_mana_node.json"),
    "mana_board2_open_condition.json": {},
    "daily_challenge_point_lookup.json": require("../assets/daily_challenge_point_lookup.json"),
    "event_challenge_point_map.json": require("../assets/event_challenge_point_map.json"),
    "hard_multi_event.json": require("../assets/hard_multi_event.json"),
    "hard_multi_event_quest.json": require("../assets/hard_multi_event_quest.json"),
    "periodic_reward.json": require("../assets/periodic_reward.json"),
    "periodic_reward_point.json": require("../assets/periodic_reward_point.json"),
    "mission_pass_week.json": require("../assets/mission_pass_week.json"),
    "mission_pass_daily.json": require("../assets/mission_pass_daily.json"),
    "mission_pass_event.json": require("../assets/mission_pass_event.json"),
    "mission_active.json": {
        77123: [missionRow(77)],
        88123: [unsupportedRow(88)],
        89123: [unsupportedRow(89)],
        89124: [unsupportedRow(89)],
        90123: [unsupportedRow(90)],
        91123: [missionRow(91)],
        91124: [dependencyMissionRow(91, "91123")],
    },
    "mission_active_event.json": {
        77: [eventRow(2)],
        88: [eventRow(1)],
        89: [eventRow(2)],
        90: [eventRow(2)],
        91: [eventRow(2, 1008005)],
    },
    "mission_active_reward.json": {
        77123: { 1: [rewardRow()] },
        88123: { 1: [rewardRow()] },
        89123: { 1: [rewardRow()] },
        89124: { 1: [rewardRow()] },
        90123: { 1: [rewardRow()] },
        91123: { 1: [rewardRow()] },
        91124: { 1: [rewardRow()] },
    },
}

const {
    installFrozenTestContentSnapshot,
} = require("./helpers/content-snapshot-fixture.cjs")
restoreSnapshot = installFrozenTestContentSnapshot({
    targetVersion: "contents-guide-test",
    tables,
}).restore

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerActiveMissionsSync,
    updatePlayerActiveMissionStageSync,
} = require("../src/data/domains/mission")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const contentsGuideRoutes = require("../src/routes/api/contentsGuide").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTime = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `contents-guide-start-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000223
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
const noPlayerAccount = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `contents-guide-no-player-${randomUUID()}`,
    status: "normal",
})
const noPlayerViewerId = viewerId + 1
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(noPlayerViewerId), noPlayerAccount.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function main() {
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
    await fastify.register(contentsGuideRoutes, { prefix: "/api/index.php/contents_guide" })
    await fastify.ready()

    const rawRequest = body => fastify.inject({
        method: "POST",
        url: "/api/index.php/contents_guide/start",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest(body),
    })
    const request = eventId => rawRequest({
            viewer_id: viewerId,
            api_count: 1,
            event_id: eventId,
    })

    try {
        const invalidBody = await fastify.inject({
            method: "POST",
            url: "/api/index.php/contents_guide/start",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest(null),
        })
        assert.equal(invalidBody.statusCode, 400, invalidBody.body)
        assert.equal((await request(0)).statusCode, 400)
        assert.equal((await rawRequest({
            viewer_id: viewerId + 999,
            api_count: 1,
            event_id: 77,
        })).statusCode, 400)
        assert.equal((await rawRequest({
            viewer_id: noPlayerViewerId,
            api_count: 1,
            event_id: 77,
        })).statusCode, 400)

        const prerequisiteLocked = await request(77)
        assert.equal(prerequisiteLocked.statusCode, 400, prerequisiteLocked.body)
        assert.deepEqual(getPlayerActiveMissionsSync(playerId), {})

        insertPlayerQuestProgressSync(playerId, 1, {
            questId: 1008004,
            finished: true,
            unlocked: true,
        })

        const vmoneyBefore = getPlayerSync(playerId).freeVmoney
        const started = await request(77)
        assert.equal(started.statusCode, 200, started.body)
        assert.deepEqual(decodeResponse(started).data.active_mission_list, [{
            mission_id: 77123,
            progress_value: 1,
            stages: [{ stage: 1, received: false }],
        }])
        assert.deepEqual(getPlayerActiveMissionsSync(playerId)[77123], {
            progress: 1,
            stages: { 1: false },
        })
        assert.equal(getPlayerSync(playerId).freeVmoney, vmoneyBefore, "start 只推进任务，不得提前发奖")

        const repeated = await request(77)
        assert.equal(repeated.statusCode, 200, repeated.body)
        assert.deepEqual(decodeResponse(repeated).data.active_mission_list, [])

        updatePlayerActiveMissionStageSync(playerId, 1, 77123, true)
        const alreadyReceived = await request(77)
        assert.equal(alreadyReceived.statusCode, 200, alreadyReceived.body)
        assert.deepEqual(decodeResponse(alreadyReceived).data.active_mission_list, [])
        assert.equal(getPlayerActiveMissionsSync(playerId)[77123].stages[1], true)

        const unknownEvent = await request(999)
        assert.equal(unknownEvent.statusCode, 400, unknownEvent.body)
        const wrongKind = await request(88)
        assert.equal(wrongKind.statusCode, 400, wrongKind.body)
        const duplicateMission = await request(89)
        assert.equal(duplicateMission.statusCode, 400, duplicateMission.body)
        assert.equal(getPlayerActiveMissionsSync(playerId)[88123], undefined)
        assert.equal(getPlayerActiveMissionsSync(playerId)[89123], undefined)

        db.exec(`
            CREATE TRIGGER fail_contents_guide_stage_insert
            BEFORE INSERT ON players_active_missions_stages
            WHEN NEW.mission_id = 90123
            BEGIN
                SELECT RAISE(FAIL, 'forced stage persistence failure');
            END
        `)
        const failedWrite = await request(90)
        assert.equal(failedWrite.statusCode, 500, failedWrite.body)
        assert.equal(getPlayerActiveMissionsSync(playerId)[90123], undefined)
        db.exec("DROP TRIGGER fail_contents_guide_stage_insert")

        insertPlayerQuestProgressSync(playerId, 1, {
            questId: 1008005,
            finished: true,
            unlocked: true,
        })
        const withDependency = await request(91)
        assert.equal(withDependency.statusCode, 200, withDependency.body)
        assert.deepEqual(decodeResponse(withDependency).data.active_mission_list, [
            { mission_id: 91123, progress_value: 1, stages: [{ stage: 1, received: false }] },
            { mission_id: 91124, progress_value: 1, stages: [{ stage: 1, received: false }] },
        ], "start 必须在同一请求内运行依赖固定点并返回全部变化项")
        assert.deepEqual(getPlayerActiveMissionsSync(playerId)[91124], {
            progress: 1,
            stages: { 1: false },
        })
        const repeatedWithDependency = await request(91)
        assert.deepEqual(
            decodeResponse(repeatedWithDependency).data.active_mission_list,
            [],
            "重复 start 不得重复累计或重复返回依赖变化",
        )

        db.exec(`
            CREATE TRIGGER fail_contents_guide_dependency_insert
            BEFORE INSERT ON players_active_missions
            WHEN NEW.mission_id = 91124
            BEGIN SELECT RAISE(FAIL, 'forced dependency publication failure'); END;
        `)
        const noPlayerForDependency = insertAccountSync({
            appId: "wf_cn",
            idpAlias: "",
            idpCode: "test",
            idpId: `contents-guide-dep-${randomUUID()}`,
            status: "normal",
        })
        const dependencyPlayerId = insertDefaultPlayerSync(noPlayerForDependency.id).id
        insertPlayerQuestProgressSync(dependencyPlayerId, 1, {
            questId: 1008004,
            finished: true,
            unlocked: true,
        })
        insertPlayerQuestProgressSync(dependencyPlayerId, 1, {
            questId: 1008005,
            finished: true,
            unlocked: true,
        })
        const dependencyViewerId = viewerId + 2
        db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
            .run(String(dependencyViewerId), noPlayerForDependency.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
        const dependencyFailed = await rawRequest({
            viewer_id: dependencyViewerId,
            api_count: 1,
            event_id: 91,
        })
        assert.equal(dependencyFailed.statusCode, 500, dependencyFailed.body)
        assert.equal(
            getPlayerActiveMissionsSync(dependencyPlayerId)[91123], undefined,
            "依赖固定点写失败必须回滚起始任务写入",
        )
        db.exec("DROP TRIGGER fail_contents_guide_dependency_insert")
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("contents guide start route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
