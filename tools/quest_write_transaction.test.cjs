"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quest-write-tx-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const { getPlayerQuestProgressSync } = require("../src/data/domains/quest")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const {
    activeQuests,
    persistActiveQuest,
    publishActiveQuest,
} = require("../src/lib/quest/active-quest-service")
const questUnlockRoutes = require("../src/routes/api/questUnlock").default
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

let database
let app
let nextViewerId = 840000000

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

test.before(async () => {
    database = data.initializeDatabase()
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    await app.register(questUnlockRoutes, { prefix: "/quest_unlock" })
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

test("quest unlock rolls item deductions back when progress persistence fails", async t => {
    const { playerId, viewerId } = await createPlayer("quest-unlock-rollback")
    givePlayerItemSync(playerId, 60001, 1)
    database.exec(`
        CREATE TRIGGER reject_quest_unlock_progress
        BEFORE INSERT ON players_quest_progress
        WHEN NEW.player_id = ${playerId} AND NEW.quest_id = 400001102
        BEGIN SELECT RAISE(ABORT, 'forced unlock progress failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_quest_unlock_progress"))

    const response = await app.inject({
        method: "POST",
        url: "/quest_unlock/unlock",
        payload: {
            viewer_id: viewerId,
            category: 18,
            quest_id: 400001102,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerItemSync(playerId, 60001), 1)
    assert.equal(
        Boolean(getPlayerQuestProgressSync(playerId)["18"]?.some(
            progress => progress.questId === 400001102,
        )),
        false,
    )
})

test("single battle continue commits currency and persisted count before publishing memory", async t => {
    const { playerId, viewerId } = await createPlayer("continue-rollback")
    updatePlayerSync({ id: playerId, freeVmoney: 100, vmoney: 100 })
    const activeQuest = {
        questId: 1001001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId: "continue-rollback-play",
        continueCount: 0,
    }
    persistActiveQuest(playerId, activeQuest)
    publishActiveQuest(playerId, activeQuest)
    t.after(() => delete activeQuests[playerId])
    database.exec(`
        CREATE TRIGGER reject_continue_count
        BEFORE UPDATE OF continue_count ON players_active_quests
        WHEN OLD.player_id = ${playerId}
        BEGIN SELECT RAISE(ABORT, 'forced continue count failure'); END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS reject_continue_count"))

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
        },
    })

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerSync(playerId).freeVmoney, 100)
    assert.equal(getPlayerSync(playerId).vmoney, 100)
    assert.equal(getPlayerActiveQuestSync(playerId).continueCount, 0)
    assert.equal(activeQuests[playerId].continueCount, 0)
})

test("quest unlock rejects quests without an authoritative Once item cost", async () => {
    const { playerId, viewerId } = await createPlayer("quest-unlock-no-cost")

    const response = await app.inject({
        method: "POST",
        url: "/quest_unlock/unlock",
        payload: {
            viewer_id: viewerId,
            category: 1,
            quest_id: 1001001,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 400, response.body)
    assert.equal(
        Boolean(getPlayerQuestProgressSync(playerId)["1"]?.some(
            progress => progress.questId === 1001001 && progress.unlocked,
        )),
        false,
    )
})

test("single battle continue spends free currency before paid currency", async t => {
    const { playerId, viewerId } = await createPlayer("continue-mixed-currency")
    updatePlayerSync({ id: playerId, freeVmoney: 30, vmoney: 30 })
    const activeQuest = {
        questId: 1001001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId: "continue-mixed-currency-play",
        continueCount: 0,
    }
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
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerSync(playerId).freeVmoney, 0)
    assert.equal(getPlayerSync(playerId).vmoney, 10)
    assert.equal(getPlayerActiveQuestSync(playerId).continueCount, 1)
    assert.equal(activeQuests[playerId].continueCount, 1)
})

test("single battle continue rejects a stale active quest identity", async t => {
    const { playerId, viewerId } = await createPlayer("continue-stale-identity")
    updatePlayerSync({ id: playerId, freeVmoney: 100, vmoney: 100 })
    const activeQuest = {
        questId: 1001001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId: "current-play",
        continueCount: 0,
    }
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
            play_id: "stale-play",
            payment_type: 1,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 400, response.body)
    assert.equal(getPlayerSync(playerId).freeVmoney, 100)
    assert.equal(getPlayerSync(playerId).vmoney, 100)
    assert.equal(getPlayerActiveQuestSync(playerId).continueCount, 0)
    assert.equal(activeQuests[playerId].continueCount, 0)
})

test("single battle continue rejects memory state without persisted active quest", async t => {
    const { playerId, viewerId } = await createPlayer("continue-missing-storage")
    updatePlayerSync({ id: playerId, freeVmoney: 100, vmoney: 100 })
    const activeQuest = {
        questId: 1001001,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId: "memory-only-play",
        continueCount: 0,
    }
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
        },
    })

    assert.equal(response.statusCode, 400, response.body)
    assert.equal(getPlayerSync(playerId).freeVmoney, 100)
    assert.equal(getPlayerSync(playerId).vmoney, 100)
    assert.equal(activeQuests[playerId].continueCount, 0)
})
