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

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "single-continue-errors-"))
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
let nextViewerId = 846000000

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

function createActiveQuest(playId, continueCount = 0) {
    return {
        questId: 1001001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId,
        continueCount,
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

function assertMsgpackError(response, message) {
    assert.equal(response.statusCode, 400, response.body)
    assert.match(response.headers["content-type"], /^application\/x-msgpack/)
    assert.deepEqual(unpack(Buffer.from(response.body, "base64")), {
        error: "Bad Request",
        message,
    })
}

test.before(async () => {
    data.initializeDatabase()
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

test("play_continue rejects empty, null, and array root bodies as MsgPack", async t => {
    for (const scenario of [
        { name: "empty body" },
        { name: "null body", payload: null },
        { name: "array body", payload: [] },
    ]) {
        await t.test(scenario.name, async () => {
            const response = await app.inject({
                method: "POST",
                url: "/single_battle_quest/play_continue",
                ...(Object.hasOwn(scenario, "payload") ? { payload: scenario.payload } : {}),
            })
            assertMsgpackError(response, "Invalid request body.")
        })
    }
})

test("play_continue rejects missing and invalid statistics counts as MsgPack before writes", async t => {
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
            assertMsgpackError(response, "Invalid request body.")
            assert.deepEqual(snapshotState(playerId), before)
        })
    }
})

test("play_continue encodes invalid viewer failures as MsgPack", async () => {
    const activeQuest = createActiveQuest("continue-invalid-viewer")
    const response = await app.inject({
        method: "POST",
        url: "/single_battle_quest/play_continue",
        payload: createPayload(999999999, activeQuest),
    })

    assertMsgpackError(response, "Invalid viewer id.")
})

test("play_continue encodes lifecycle failures as MsgPack without writes", async t => {
    const scenarios = [
        {
            name: "stale count",
            storedCount: 2,
            requestCount: 0,
            player: { freeVmoney: 100, vmoney: 100 },
            message: "Continue count does not match persisted active quest.",
        },
        {
            name: "future count",
            storedCount: 0,
            requestCount: 1,
            player: { freeVmoney: 100, vmoney: 100 },
            message: "Continue count does not match persisted active quest.",
        },
        {
            name: "insufficient balance",
            storedCount: 0,
            requestCount: 0,
            player: { freeVmoney: 0, vmoney: 49 },
            message: "Not enough vmoney to continue",
        },
    ]

    for (const scenario of scenarios) {
        await t.test(scenario.name, async t => {
            const { playerId, viewerId } = await createPlayer(`continue-${scenario.name}`)
            updatePlayerSync({ id: playerId, ...scenario.player })
            const activeQuest = createActiveQuest(
                `continue-${scenario.name}-play`,
                scenario.storedCount,
            )
            persistActiveQuest(playerId, activeQuest)
            publishActiveQuest(playerId, activeQuest)
            t.after(() => delete activeQuests[playerId])
            const before = snapshotState(playerId)

            const response = await app.inject({
                method: "POST",
                url: "/single_battle_quest/play_continue",
                payload: createPayload(viewerId, activeQuest, scenario.requestCount),
            })

            assertMsgpackError(response, scenario.message)
            assert.deepEqual(snapshotState(playerId), before)
        })
    }
})
