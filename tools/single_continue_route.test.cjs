"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const { unpack } = require("msgpackr")

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
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

let app
let database
let nextViewerId = 845000000

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
        statistics: { continue_count: continueCount },
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
    registerCnMsgpackOnSend(app)
    await app.register(singleBattleRoutes, { prefix: "/single_battle_quest" })
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

test("identical play_continue payload replays after restart without a second write", async t => {
    const { playerId, viewerId } = await createPlayer("continue-idempotent")
    updatePlayerSync({ id: playerId, freeVmoney: 30, vmoney: 40 })
    const activeQuest = createActiveQuest("continue-idempotent-play")
    persistActiveQuest(playerId, activeQuest)
    publishActiveQuest(playerId, activeQuest)
    t.after(() => delete activeQuests[playerId])
    const payload = createPayload(viewerId, activeQuest)

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

    publishActiveQuest(playerId, { ...activeQuest, continueCount: 0 })
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
    assert.deepEqual(decode(replay).data.user_info, { free_vmoney: 0, vmoney: 20 })
    assert.deepEqual(snapshotState(playerId), {
        freeVmoney: 0,
        vmoney: 20,
        storedContinueCount: 1,
        memoryContinueCount: 1,
    })
})

test("play_continue rejects missing and invalid statistics counts before writes", async t => {
    const { playerId, viewerId } = await createPlayer("continue-invalid-count")
    updatePlayerSync({ id: playerId, freeVmoney: 100, vmoney: 100 })
    const activeQuest = createActiveQuest("continue-invalid-count-play")
    persistActiveQuest(playerId, activeQuest)
    publishActiveQuest(playerId, activeQuest)
    t.after(() => delete activeQuests[playerId])
    const validPayload = createPayload(viewerId, activeQuest)
    const before = snapshotState(playerId)
    const scenarios = [
        { name: "missing statistics", payload: { ...validPayload, statistics: undefined } },
        { name: "null statistics", payload: { ...validPayload, statistics: null } },
        { name: "missing continue_count", payload: { ...validPayload, statistics: {} } },
        { name: "negative", payload: createPayload(viewerId, activeQuest, -1) },
        { name: "fraction", payload: createPayload(viewerId, activeQuest, 0.5) },
        { name: "string", payload: createPayload(viewerId, activeQuest, "0") },
        {
            name: "unsafe",
            payload: createPayload(viewerId, activeQuest, Number.MAX_SAFE_INTEGER + 1),
        },
    ]

    for (const scenario of scenarios) {
        await t.test(scenario.name, async () => {
            const response = await app.inject({
                method: "POST",
                url: "/single_battle_quest/play_continue",
                payload: scenario.payload,
            })

            assert.equal(response.statusCode, 400, response.body)
            assert.deepEqual(snapshotState(playerId), before)
        })
    }
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
    assert.deepEqual(snapshotState(playerId), {
        freeVmoney: 100,
        vmoney: 100,
        storedContinueCount: 0,
        memoryContinueCount: null,
    })
})
