"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "collect-entry-facts-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = dataDirectory
delete process.env.WDFP_DATABASE_DIR

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getPlayerCategoryMissionsSync } = require("../src/data/domains/mission")
const { getMissionCatalog } = require("../src/lib/mission/mission-catalog")
const { getMissionFactRequirementRegistry } = require("../src/lib/mission/requirements/registry")
const {
    recordCollectLoginMissionFactsSync,
    recordCollectProfileViewMissionFactsSync,
} = require("../src/lib/mission/collect-entry-facts")
const { setServerTime } = require("../src/utils")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const profileRoutes = require("../src/routes/api/profile")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
test.after(() => {
    restoreContentSnapshot()
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    fs.rmSync(dataDirectory, { recursive: true, force: true })
})
process.once("exit", () => {
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
    fs.rmSync(dataDirectory, { recursive: true, force: true })
})

initializeDatabase()
const db = getDb()

function newPlayerSession() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "collect-entry-facts",
        idpId: `collect-entry-${randomUUID()}`,
        status: "normal",
    })
    const player = insertDefaultPlayerSync(account.id)
    const viewerId = 770000000 + player.id
    db.prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, 2)
    `).run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString())
    return { playerId: player.id, viewerId }
}

function collectProgress(playerId, missionId) {
    return getPlayerCategoryMissionsSync(playerId, 4)[String(missionId)]?.progress
}

// Mission 2089: eventId 10016, window 2024-02-22 12:00 ~ 2024-03-07 23:59:59
// (UTC+8 master times). Mission 10166: eventId 100009, window
// 2025-06-19 12:00 ~ 2025-07-05 23:59:59.
const COLLECT_LOGIN_WINDOW = {
    insideDay1: new Date("2024-02-23T04:00:00.000Z"), // CN 02-23 12:00
    sameDayLater: new Date("2024-02-23T15:30:00.000Z"), // CN 02-23 23:30
    nextDay: new Date("2024-02-24T04:00:00.000Z"), // CN 02-24 12:00
    outside: new Date("2024-03-20T04:00:00.000Z"),
}
const PROFILE_VIEW_INSIDE = new Date("2025-06-20T04:00:00.000Z")
const PROFILE_VIEW_OUTSIDE = new Date("2025-07-20T04:00:00.000Z")

test("collect rows 2089 and 10166 route to the persisted producer channel", () => {
    const registry = getMissionFactRequirementRegistry(getMissionCatalog())
    assert.equal(registry.getRequirement(4, 2089).mode, "persisted")
    assert.equal(registry.getRequirement(4, 10166).mode, "persisted")
})

test("collect window login days dedup within a CN day and follow the mission window", () => {
    const { playerId } = newPlayerSession()

    assert.deepEqual(recordCollectLoginMissionFactsSync(playerId, COLLECT_LOGIN_WINDOW.insideDay1), [2089])
    assert.equal(collectProgress(playerId, 2089), 1)

    // Same CN calendar day: no double count.
    assert.deepEqual(recordCollectLoginMissionFactsSync(playerId, COLLECT_LOGIN_WINDOW.sameDayLater), [])
    assert.equal(collectProgress(playerId, 2089), 1)

    // Next CN calendar day inside the window counts again.
    assert.deepEqual(recordCollectLoginMissionFactsSync(playerId, COLLECT_LOGIN_WINDOW.nextDay), [2089])
    assert.equal(collectProgress(playerId, 2089), 2)

    // Outside the mission window nothing is enabled, nothing changes.
    assert.deepEqual(recordCollectLoginMissionFactsSync(playerId, COLLECT_LOGIN_WINDOW.outside), [])
    assert.equal(collectProgress(playerId, 2089), 2)
})

test("profile view fact completes once through the real get_my_profile endpoint", async () => {
    const { playerId, viewerId } = newPlayerSession()

    const app = Fastify()
    registerCnMsgpackOnSend(app)
    await app.register(profileRoutes.default, { prefix: "/api/index.php/profile" })
    await app.ready()

    // Outside the 10166 window: the endpoint answers, the fact stays absent.
    setServerTime(PROFILE_VIEW_OUTSIDE)
    const outsideResponse = await app.inject({
        method: "POST",
        url: "/api/index.php/profile/get_my_profile",
        payload: { viewer_id: viewerId },
    })
    assert.equal(outsideResponse.statusCode, 200)
    assert.equal(collectProgress(playerId, 10166), undefined)

    // Inside the window: the first own-profile fetch completes the mission.
    setServerTime(PROFILE_VIEW_INSIDE)
    const insideResponse = await app.inject({
        method: "POST",
        url: "/api/index.php/profile/get_my_profile",
        payload: { viewer_id: viewerId },
    })
    assert.equal(insideResponse.statusCode, 200)
    assert.equal(collectProgress(playerId, 10166), 1)

    // The one-shot fact never double-counts on later views.
    const againResponse = await app.inject({
        method: "POST",
        url: "/api/index.php/profile/get_my_profile",
        payload: { viewer_id: viewerId },
    })
    assert.equal(againResponse.statusCode, 200)
    assert.equal(collectProgress(playerId, 10166), 1)
    assert.deepEqual(
        recordCollectProfileViewMissionFactsSync(playerId, PROFILE_VIEW_INSIDE),
        [],
    )
})
