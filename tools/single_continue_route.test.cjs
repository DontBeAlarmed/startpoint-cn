"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "single-continue-route-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const {
    activeQuests,
    persistActiveQuest,
    publishActiveQuest,
} = require("../src/lib/quest/active-quest-service")
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const cnLoadRoutes = require("../src/routes/cn/load").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

let app
let database
let nextViewerId = 845000000
let continueVmoneyCost = 50

async function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function createActiveQuest(playId) {
    return {
        questId: 1001001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId,
        continueCount: 0,
    }
}

function createPayload(viewerId, activeQuest, continueCount = 0) {
    return {
        viewer_id: viewerId,
        quest_id: activeQuest.questId,
        category: activeQuest.category,
        play_id: activeQuest.playId,
        payment_type: 1,
        api_count: 1,
        statistics: {
            zones: [{ floor: 0, zone: 0, continue_count: continueCount }],
        },
    }
}

function snapshotState(playerId) {
    const player = getPlayerSync(playerId)
    return {
        freeVmoney: player.freeVmoney,
        vmoney: player.vmoney,
        storedContinueCount: getPlayerActiveQuestSync(playerId)?.continueCount ?? null,
        memoryContinueCount: activeQuests[playerId]?.continueCount ?? null,
    }
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

test.before(async () => {
    database = data.initializeDatabase()
    app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app)
    await app.register(singleBattleRoutes, {
        prefix: "/single_battle_quest",
        getContinueVmoneyCost: () => continueVmoneyCost,
    })
    await app.register(cnLoadRoutes, { assetProvider: { mode: "client-owned" } })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("formal load restores persisted continue state before replay without a second write", async t => {
    const { playerId, viewerId } = await createPlayer("continue-idempotent")
    updatePlayerSync({ id: playerId, freeVmoney: 30, vmoney: 40 })
    const activeQuest = createActiveQuest("continue-idempotent-play")
    persistActiveQuest(playerId, activeQuest)
    publishActiveQuest(playerId, activeQuest)
    t.after(() => delete activeQuests[playerId])
    const payload = createPayload(viewerId, activeQuest)
    assert.equal(Object.hasOwn(payload.statistics, "continue_count"), false)

    const first = await app.inject({
        method: "POST",
        url: "/single_battle_quest/play_continue",
        payload,
    })

    assert.equal(first.statusCode, 200, first.body)
    assert.deepEqual(decode(first).data.user_info, { free_vmoney: 0, vmoney: 20 })
    assert.deepEqual(snapshotState(playerId), {
        freeVmoney: 0,
        vmoney: 20,
        storedContinueCount: 1,
        memoryContinueCount: 1,
    })

    delete activeQuests[playerId]
    assert.equal(activeQuests[playerId], undefined)
    const loaded = await app.inject({
        method: "POST",
        url: "/load",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            res_ver: "1.4.54",
        },
        payload: pack({
            viewer_id: viewerId,
            keychain: viewerId,
            device_id: 1,
            device_token: "single-continue-load",
        }).toString("base64"),
    })

    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.deepEqual(decode(loaded).data.unfinished_quest_list, [{
        play_id: activeQuest.playId,
        continue_count: 1,
    }])
    assert.equal(activeQuests[playerId].continueCount, 1)

    database.exec(`
        CREATE TRIGGER reject_continue_replay_player
        BEFORE UPDATE ON players WHEN OLD.id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'replay wrote player'); END;
        CREATE TRIGGER reject_continue_replay_active
        BEFORE UPDATE ON players_active_quests WHEN OLD.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'replay wrote active quest'); END;
    `)
    t.after(() => database.exec(`
        DROP TRIGGER IF EXISTS reject_continue_replay_player;
        DROP TRIGGER IF EXISTS reject_continue_replay_active;
    `))

    const replay = await app.inject({
        method: "POST",
        url: "/single_battle_quest/play_continue",
        payload,
    })

    assert.equal(replay.statusCode, 200, replay.body)
    assert.deepEqual(decode(replay).data.user_info, { free_vmoney: 50, vmoney: 20 })
    assert.deepEqual(snapshotState(playerId), {
        freeVmoney: 50,
        vmoney: 20,
        storedContinueCount: 1,
        memoryContinueCount: 1,
    })
})

test("play_continue rejects persisted state when memory active quest is missing", async () => {
    const { playerId, viewerId } = await createPlayer("continue-missing-memory")
    updatePlayerSync({ id: playerId, freeVmoney: 100, vmoney: 100 })
    const activeQuest = createActiveQuest("continue-missing-memory-play")
    persistActiveQuest(playerId, activeQuest)

    const response = await app.inject({
        method: "POST",
        url: "/single_battle_quest/play_continue",
        payload: createPayload(viewerId, activeQuest),
    })

    assert.equal(response.statusCode, 400, response.body)
    assert.match(response.headers["content-type"], /^application\/x-msgpack/)
    assert.deepEqual(decode(response), {
        error: "Bad Request",
        message: "No active quest to continue.",
    })
    assert.deepEqual(snapshotState(playerId), {
        freeVmoney: 100,
        vmoney: 100,
        storedContinueCount: 0,
        memoryContinueCount: null,
    })
})

test("play_continue sums every zone continue count", async t => {
    const { playerId, viewerId } = await createPlayer("continue-multi-zone")
    updatePlayerSync({ id: playerId, freeVmoney: 30, vmoney: 40 })
    const activeQuest = createActiveQuest("continue-multi-zone-play")
    activeQuest.continueCount = 2
    persistActiveQuest(playerId, activeQuest)
    publishActiveQuest(playerId, activeQuest)
    t.after(() => delete activeQuests[playerId])

    const response = await app.inject({
        method: "POST",
        url: "/single_battle_quest/play_continue",
        payload: {
            viewer_id: viewerId,
            quest_id: activeQuest.questId,
            category: activeQuest.category,
            play_id: activeQuest.playId,
            payment_type: 1,
            api_count: 1,
            statistics: {
                zones: [
                    { floor: 0, zone: 0, continue_count: 1 },
                    { floor: 0, zone: 1, continue_count: 0 },
                    { floor: 1, zone: 0, continue_count: 1 },
                ],
            },
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(decode(response).data.user_info, { free_vmoney: 0, vmoney: 20 })
    assert.deepEqual(snapshotState(playerId), {
        freeVmoney: 0,
        vmoney: 20,
        storedContinueCount: 3,
        memoryContinueCount: 3,
    })
})

test("play_continue uses the injected continue vmoney cost", async t => {
    continueVmoneyCost = 37
    t.after(() => { continueVmoneyCost = 50 })
    const { playerId, viewerId } = await createPlayer("continue-custom-cost")
    updatePlayerSync({ id: playerId, freeVmoney: 20, vmoney: 30 })
    const activeQuest = createActiveQuest("continue-custom-cost-play")
    persistActiveQuest(playerId, activeQuest)
    publishActiveQuest(playerId, activeQuest)
    t.after(() => delete activeQuests[playerId])

    const response = await app.inject({
        method: "POST",
        url: "/single_battle_quest/play_continue",
        payload: createPayload(viewerId, activeQuest),
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(decode(response).data.user_info, { free_vmoney: 0, vmoney: 13 })
    assert.deepEqual(snapshotState(playerId), {
        freeVmoney: 0,
        vmoney: 13,
        storedContinueCount: 1,
        memoryContinueCount: 1,
    })
})
