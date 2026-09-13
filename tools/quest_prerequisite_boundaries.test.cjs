"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, before, test } = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quest-prerequisite-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

let restoreContentSnapshot

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase, closeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default

initializeDatabase()

let app
let nextViewerId = 950000000

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
    updatePlayerSync({ id: playerId, stamina: 100, staminaHealTime: new Date() })
    return { playerId, viewerId }
}

async function start(viewerId, questId, category = 1) {
    const response = await app.inject({
        method: "POST",
        url: "/api/index.php/single_battle_quest/start",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({
            viewer_id: viewerId,
            api_count: 1,
            quest_id: questId,
            category,
            party_id: 1,
            play_id: `prereq-${questId}-${randomUUID()}`,
            use_boost_point: false,
            use_boss_boost_point: false,
            is_auto_start_mode: false,
        }).toString("base64"),
    })
    const contentType = String(response.headers["content-type"] ?? "")
    const decoded = contentType.includes("application/x-msgpack")
        ? unpack(Buffer.from(response.body, "base64"))
        : { data_headers: {} }
    return { statusCode: response.statusCode, headers: decoded.data_headers }
}

function insertQuestProgress(playerId, category, questId) {
    getDb().prepare(`
        INSERT INTO players_quest_progress (section, quest_id, finished, unlocked, player_id)
        VALUES (?, ?, 1, 1, ?)
        ON CONFLICT (section, quest_id, player_id) DO UPDATE SET finished = 1
    `).run(category, questId, playerId)
}

function insertMainQuestProgress(playerId, questId) {
    insertQuestProgress(playerId, 1, questId)
}

before(async () => {
    app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app, encodeCnMsgpackPayload)
    app.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await app.ready()
})

after(async () => {
    await app.close()
    closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("first-node main quests start without any prerequisite progress", async () => {
    const { playerId, viewerId } = await createPlayer("first-node")
    const result = await start(viewerId, 1001002)
    assert.equal(result.statusCode, 200, JSON.stringify(result))
    assert.notEqual(getPlayerActiveQuestSync(playerId), null)
})

test("a chained main quest is locked until every need-node quest is cleared", async () => {
    const { playerId, viewerId } = await createPlayer("chained")
    // Quest 1002001 (chapter 1 node 2) needs 1001001/1001002/1001003 cleared.
    const before = getPlayerSync(playerId).stamina
    const locked = await start(viewerId, 1002001)
    assert.equal(locked.statusCode, 400)
    assert.equal(getPlayerActiveQuestSync(playerId), null)
    assert.equal(getPlayerSync(playerId).stamina, before, "locked start must not consume stamina")

    insertMainQuestProgress(playerId, 1001001)
    insertMainQuestProgress(playerId, 1001002)
    const stillLocked = await start(viewerId, 1002001)
    assert.equal(stillLocked.statusCode, 400, "partial node clear must stay locked")

    insertMainQuestProgress(playerId, 1001003)
    const unlocked = await start(viewerId, 1002001)
    assert.equal(unlocked.statusCode, 200, JSON.stringify(unlocked))
    assert.notEqual(getPlayerActiveQuestSync(playerId), null)
})

test("main and ex quests with the same id use category-specific prerequisites", async () => {
    const main = await createPlayer("same-id-main")
    for (const questId of [1008001, 1008002, 1008003, 1008004]) {
        insertQuestProgress(main.playerId, 1, questId)
    }
    const mainResult = await start(main.viewerId, 2001001, 1)
    assert.equal(mainResult.statusCode, 200, JSON.stringify(mainResult))

    // EX 2:1's need_main_stage_node is 2:9, which collides with EX's own 2:9
    // node number. The prerequisite must resolve against the MAIN table
    // (category 1, quests 2009001..2009007), so ex-category progress on the
    // same numeric ids must not unlock it.
    const ex = await createPlayer("same-id-ex")
    for (const questId of [2009001, 2009002, 2009003]) {
        insertQuestProgress(ex.playerId, 4, questId)
    }
    const lockedByCollision = await start(ex.viewerId, 2001001, 4)
    assert.equal(lockedByCollision.statusCode, 400)
    assert.equal(getPlayerActiveQuestSync(ex.playerId), null)

    for (const questId of [2009001, 2009002, 2009003, 2009004, 2009005, 2009006, 2009007]) {
        insertQuestProgress(ex.playerId, 1, questId)
    }
    const exResult = await start(ex.viewerId, 2001001, 4)
    assert.equal(exResult.statusCode, 200, JSON.stringify(exResult))
})

test("ex internal chains gate ex quests on their predecessor node", async () => {
    // EX 2:2 needs EX 2:1 (quests 2001001/2001002) cleared first.
    const { playerId, viewerId } = await createPlayer("ex-chain")
    const locked = await start(viewerId, 2002001, 4)
    assert.equal(locked.statusCode, 400)
    assert.equal(getPlayerActiveQuestSync(playerId), null)

    insertQuestProgress(playerId, 4, 2001001)
    const stillLocked = await start(viewerId, 2002001, 4)
    assert.equal(stillLocked.statusCode, 400, "partial node clear must stay locked")

    insertQuestProgress(playerId, 4, 2001002)
    const unlocked = await start(viewerId, 2002001, 4)
    assert.equal(unlocked.statusCode, 200, JSON.stringify(unlocked))
    assert.notEqual(getPlayerActiveQuestSync(playerId), null)
})
