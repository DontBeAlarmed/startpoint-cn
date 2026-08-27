"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "login-bonus-route-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: ["login_bonus.json"],
})
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerDegreeIdsSync } = require("../src/data/domains/degree")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { getPlayerPassCardStateSync } = require("../src/data/domains/pass-card")
const {
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const cnLoadRoutes = require("../src/routes/cn/load").default
const bonusRoutes = require("../src/routes/api/bonus").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const VIEWER_ID = 730000001
const targetVirtualMs = Date.parse("2024-08-14T12:00:00.000Z")
const previousOffset = getTimeOffset()
let app
let playerId

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function postLoadWith(targetApp, viewerId) {
    return targetApp.inject({
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
            device_token: "login-bonus-route-device",
        }).toString("base64"),
    })
}

async function postLoad() {
    return postLoadWith(app, VIEWER_ID)
}

async function createViewer(viewerId, label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const createdPlayerId = insertDefaultPlayerSync(account.id).id
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
    return createdPlayerId
}

async function buildLoadApp(encoder) {
    const targetApp = Fastify({ logger: false })
    targetApp.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(targetApp, encoder)
    await targetApp.register(cnLoadRoutes, {
        assetProvider: { mode: "client-owned" },
        dailyResetHour: 5,
        multiMode: "embedded",
    })
    await targetApp.ready()
    return targetApp
}

test.before(async () => {
    setServerTimeOffset(targetVirtualMs - Date.now())
    data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `login-bonus-route-${randomUUID()}`,
        status: "normal",
    })
    playerId = insertDefaultPlayerSync(account.id).id
    await insertSessionWithToken({
        token: String(VIEWER_ID),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })

    app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app)
    await app.register(cnLoadRoutes, {
        assetProvider: { mode: "client-owned" },
        dailyResetHour: 5,
        multiMode: "embedded",
    })
    await app.register(bonusRoutes, { prefix: "/bonus" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    setServerTimeOffset(previousOffset)
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("load grants and returns the current CDN Normal bonus with immediate inventory state", async () => {
    const before = getPlayerSync(playerId)
    const firstResponse = await postLoad()
    assert.equal(firstResponse.statusCode, 200, firstResponse.body)
    const first = decode(firstResponse)

    assert.deepEqual(first.data.bonus_index_list, [
        { bonus_group_id: "normal_2022", bonus_group_type: "Normal", index: 1 },
        { bonus_group_id: "newbie_present", bonus_group_type: "ActiveUser", index: 1 },
        { bonus_group_id: "anv3_present", bonus_group_type: "ActiveUser", index: 1 },
        { bonus_group_id: "xmas22", bonus_group_type: "Limited", index: 1 },
    ])
    assert.equal(typeof first.data.login_bonus_received_at, "number")
    assert.ok(Math.abs(first.data.login_bonus_received_at - targetVirtualMs / 1000) <= 2)
    assert.deepEqual(first.data.premium_bonus_index_list, [])
    assert.deepEqual(first.data.premium_bonus_mailed_item_list, [])
    assert.equal(first.data.user_info.free_vmoney, before.freeVmoney + 6100)
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney + 6100)

    const repeatedResponse = await postLoad()
    assert.equal(repeatedResponse.statusCode, 200, repeatedResponse.body)
    const repeated = decode(repeatedResponse)
    assert.deepEqual(repeated.data.bonus_index_list, first.data.bonus_index_list)
    assert.equal(repeated.data.login_bonus_received_at, first.data.login_bonus_received_at)
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney + 6100)
})

test("bonus shown acknowledges the pending batch once and later same-day loads stay empty", async () => {
    const shownResponse = await app.inject({
        method: "POST",
        url: "/bonus/shown",
        payload: { viewer_id: VIEWER_ID, api_count: 2 },
    })
    assert.equal(shownResponse.statusCode, 200, shownResponse.body)
    assert.deepEqual(decode(shownResponse).data, [])

    const repeatedShown = await app.inject({
        method: "POST",
        url: "/bonus/shown",
        payload: { viewer_id: VIEWER_ID, api_count: 3 },
    })
    assert.equal(repeatedShown.statusCode, 200, repeatedShown.body)
    assert.deepEqual(decode(repeatedShown).data, [])

    const loadResponse = await postLoad()
    assert.equal(loadResponse.statusCode, 200, loadResponse.body)
    const loaded = decode(loadResponse)
    assert.deepEqual(loaded.data.bonus_index_list, [])
    assert.equal(loaded.data.login_bonus_received_at, null)
})

test("virtual date jumps do not advance login rewards before the real 05:00 reset", async () => {
    setServerTimeOffset(targetVirtualMs + 86_400_000 - Date.now())
    try {
        const response = await postLoad()
        assert.equal(response.statusCode, 200, response.body)
        const payload = decode(response)
        assert.deepEqual(payload.data.bonus_index_list, [])
        assert.equal(payload.data.login_bonus_received_at, null)
    } finally {
        setServerTimeOffset(targetVirtualMs - Date.now())
    }
})

test("load settles cumulative login missions immediately without duplicate rewards", async t => {
    const viewerId = VIEWER_ID + 10
    const loginMissionPlayerId = await createViewer(viewerId, "cumulative-login-mission")
    updatePlayerSync({
        id: loginMissionPlayerId,
        totalLoginDays: 1,
        lastLoginTime: new Date(targetVirtualMs - 86_400_000),
    })

    const targetApp = await buildLoadApp()
    t.after(async () => targetApp.close())

    const firstResponse = await postLoadWith(targetApp, viewerId)
    assert.equal(firstResponse.statusCode, 200, firstResponse.body)
    const first = decode(firstResponse)
    assert.deepEqual(
        first.data.mission_info.filter(entry => (
            entry.mission_category_id === 1 && entry.mission_id === 24
        )),
        [{
            mission_category_id: 1,
            mission_id: 24,
            mission_reward_id: 24001,
        }],
    )
    assert.deepEqual(getPlayerCategoryMissionsSync(loginMissionPlayerId, 1)[24], {
        progress: 2,
        stages: { 1: true },
    })
    assert.equal(
        first.data.user_info.free_vmoney,
        getPlayerSync(loginMissionPlayerId).freeVmoney,
        "登录任务发奖后的首个 /load 响应必须返回最终余额",
    )

    const freeVmoneyAfterFirst = getPlayerSync(loginMissionPlayerId).freeVmoney
    const repeatedResponse = await postLoadWith(targetApp, viewerId)
    assert.equal(repeatedResponse.statusCode, 200, repeatedResponse.body)
    const repeated = decode(repeatedResponse)
    assert.deepEqual(repeated.data.mission_info, [])
    assert.equal(getPlayerSync(loginMissionPlayerId).freeVmoney, freeVmoneyAfterFirst)
})

test("load settles cumulative login degree missions at the login fact boundary", async t => {
    const viewerId = VIEWER_ID + 11
    const loginDegreePlayerId = await createViewer(viewerId, "cumulative-login-degree")
    updatePlayerSync({
        id: loginDegreePlayerId,
        totalLoginDays: 6,
        lastLoginTime: new Date(targetVirtualMs - 86_400_000),
    })

    const targetApp = await buildLoadApp()
    t.after(async () => targetApp.close())

    const response = await postLoadWith(targetApp, viewerId)
    assert.equal(response.statusCode, 200, response.body)
    const loaded = decode(response)
    assert.deepEqual(
        loaded.data.mission_info.filter(entry => (
            entry.mission_category_id === 5 && entry.mission_id === 53000
        )),
        [{
            mission_category_id: 5,
            mission_id: 53000,
            mission_reward_id: 53000001,
        }],
    )
    assert.equal(getPlayerDegreeIdsSync(loginDegreePlayerId).includes(53000), true)
})

test("load settles the active pass login mission but leaves level rewards claimable", async t => {
    const viewerId = VIEWER_ID + 12
    const passLoginPlayerId = await createViewer(viewerId, "pass-login-mission")
    updatePlayerSync({
        id: passLoginPlayerId,
        totalLoginDays: 1,
        lastLoginTime: new Date(targetVirtualMs - 86_400_000),
    })

    const targetApp = await buildLoadApp()
    t.after(async () => targetApp.close())

    const response = await postLoadWith(targetApp, viewerId)
    assert.equal(response.statusCode, 200, response.body)
    const loaded = decode(response)
    assert.deepEqual(
        loaded.data.mission_info.filter(entry => (
            entry.mission_category_id === 8 && entry.mission_id === 13
        )),
        [{
            mission_category_id: 8,
            mission_id: 13,
            mission_reward_id: 13001,
        }],
    )
    assert.equal(getPlayerPassCardStateSync(passLoginPlayerId, 3).point, 100)
})

test("bonus shown rejects an unknown viewer without changing progress", async () => {
    const response = await app.inject({
        method: "POST",
        url: "/bonus/shown",
        payload: { viewer_id: 999999999, api_count: 4 },
    })
    assert.equal(response.statusCode, 400)
})

test("load encoding failure preserves one pending batch without duplicate rewards", async t => {
    const viewerId = VIEWER_ID + 1
    const interruptedPlayerId = await createViewer(viewerId, "encoding-failure")
    const before = getPlayerSync(interruptedPlayerId)
    const failingApp = await buildLoadApp(() => {
        throw new Error("forced login bonus encoding failure")
    })
    t.after(async () => failingApp.close())

    const failed = await postLoadWith(failingApp, viewerId)
    assert.equal(failed.statusCode, 500)
    assert.equal(getPlayerSync(interruptedPlayerId).freeVmoney, before.freeVmoney + 6100)

    const retryApp = await buildLoadApp()
    t.after(async () => retryApp.close())
    const retried = await postLoadWith(retryApp, viewerId)
    assert.equal(retried.statusCode, 200, retried.body)
    const payload = decode(retried)
    assert.deepEqual(payload.data.bonus_index_list, [
        { bonus_group_id: "normal_2022", bonus_group_type: "Normal", index: 1 },
        { bonus_group_id: "newbie_present", bonus_group_type: "ActiveUser", index: 1 },
        { bonus_group_id: "anv3_present", bonus_group_type: "ActiveUser", index: 1 },
        { bonus_group_id: "xmas22", bonus_group_type: "Limited", index: 1 },
    ])
    assert.equal(getPlayerSync(interruptedPlayerId).freeVmoney, before.freeVmoney + 6100)
})

test("load encoding failure rolls back ordinary login mission settlement for retry", async t => {
    const viewerId = VIEWER_ID + 20
    const missionPlayerId = await createViewer(viewerId, "login-mission-encoding-failure")
    updatePlayerSync({
        id: missionPlayerId,
        totalLoginDays: 1,
        lastLoginTime: new Date(targetVirtualMs - 86_400_000),
    })

    const failingApp = await buildLoadApp(() => {
        throw new Error("forced ordinary login mission encoding failure")
    })
    t.after(async () => failingApp.close())

    const failed = await postLoadWith(failingApp, viewerId)
    assert.equal(failed.statusCode, 500)
    assert.equal(getPlayerCategoryMissionsSync(missionPlayerId, 1)[24], undefined)

    const retryApp = await buildLoadApp()
    t.after(async () => retryApp.close())
    const retried = await postLoadWith(retryApp, viewerId)
    assert.equal(retried.statusCode, 200, retried.body)
    const payload = decode(retried)
    assert.deepEqual(
        payload.data.mission_info.filter(entry => (
            entry.mission_category_id === 1 && entry.mission_id === 24
        )),
        [{
            mission_category_id: 1,
            mission_id: 24,
            mission_reward_id: 24001,
        }],
    )
})
