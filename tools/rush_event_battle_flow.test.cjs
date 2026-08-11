require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, test } = require("node:test")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rush-event-flow-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

let db
let fastify
let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    deletePlayerRushEventPlayedPartyListSync,
    getDefaultPlayerRushEventSync,
    getPlayerRushEventPlayedPartiesSync,
    getPlayerRushEventSync,
    insertPlayerRushEventPlayedPartySync,
    insertPlayerRushEventSync,
    updatePlayerRushEventSync,
} = require("../src/data/domains/rushEvent")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { deletePlayerActiveQuestSync, getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const {
    activeQuests,
    clearPublishedActiveQuest,
} = require("../src/lib/quest/active-quest-service")
const { RushEventBattleType } = require("../src/data/types")
const { QuestCategory, RushEventFolder } = require("../src/lib/types")
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { getRushEventFolderMaxRoundSync } = require("../src/lib/assets")
const { canStartRushEventFolderBattle } = require("../src/lib/rush-folder-progression.ts")
const rushEventRoutes = require("../src/routes/api/rushEvent").default
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const { getTimeOffset, setServerTimeOffset } = require("../src/utils")

const previousTimeOffset = getTimeOffset()
restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

initializeDatabase()
db = getDb()
const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "test",
    idpId: `rush-event-flow-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000511
const eventId = 700007

db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
insertPlayerRushEventSync(playerId, getDefaultPlayerRushEventSync(eventId))

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("application/x-msgpack")) {
        return unpack(Buffer.from(response.body, "base64"))
    }
    return response.json()
}

async function post(url, body) {
    return fastify.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest(body),
    })
}

async function selectFolder(folderId) {
    return post("/api/index.php/event/rush/select_folder", {
        viewer_id: viewerId,
        api_count: 1,
        event_id: eventId,
        folder_id: folderId,
    })
}

async function startBattle(questId, partyId) {
    return post("/api/index.php/event/rush/battle/start", {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: questId,
        party_id: partyId,
        is_auto_start_mode: false,
        play_id: `rush-${questId}-${partyId}-${randomUUID()}`,
    })
}

async function finishBattle(questId) {
    return post("/api/index.php/single_battle_quest/finish", {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: questId,
        category: QuestCategory.RUSH_EVENT,
        score: 0,
        elapsed_time_ms: 1000,
        add_mana: 0,
        is_accomplished: true,
        is_restored: false,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 0,
            zones: [{
                damage_deal_total: 0,
                use_power_flip_count: 0,
                use_dash_count: 0,
                use_skill_count: 0,
                members: [{ origin_damage: 0 }, null, null],
            }],
            party: {
                characters: [{ id: 1 }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
    })
}

async function summary() {
    return post("/api/index.php/event/rush/summary", {
        viewer_id: viewerId,
        api_count: 1,
        event_id: eventId,
    })
}

async function resetFolder() {
    return post("/api/index.php/event/rush/reset", {
        viewer_id: viewerId,
        api_count: 1,
        quest_type: 1,
        event_id: eventId,
    })
}

function insertFolderParty(questId) {
    insertPlayerRushEventPlayedPartySync(playerId, eventId, {
        characterIds: [null, null, null],
        unisonCharacterIds: [null, null, null],
        equipmentIds: [null, null, null],
        abilitySoulIds: [null, null, null],
        evolutionImgLevels: [null, null, null],
        unisonEvolutionImgLevels: [null, null, null],
        round: questId,
        battleType: RushEventBattleType.FOLDER,
    })
}

function setActiveFolder(folderId) {
    updatePlayerRushEventSync(playerId, {
        eventId,
        activeRushBattleFolderId: folderId,
    })
}

function clearFolderState() {
    db.transaction(() => {
        deletePlayerRushEventPlayedPartyListSync(playerId, eventId, RushEventBattleType.FOLDER)
        setActiveFolder(null)
    })()
    clearActiveQuest()
}

function assertNoActiveQuest(message) {
    assert.equal(getPlayerActiveQuestSync(playerId), null, message)
    assert.equal(activeQuests[playerId], undefined, message)
}

function assertPlayedQuestIds(map, expectedQuestIds) {
    assert.deepEqual(
        Object.keys(map ?? {}).map(Number).sort((left, right) => left - right),
        [...expectedQuestIds].sort((left, right) => left - right),
    )
}

async function assertFirstRoundProgress(folderId, firstQuestId) {
    const selected = await selectFolder(folderId)
    assert.equal(selected.statusCode, 200, selected.body)

    const started = await startBattle(firstQuestId, 1)
    assert.equal(started.statusCode, 200, started.body)

    const finished = await finishBattle(firstQuestId)
    assert.equal(finished.statusCode, 200, finished.body)
    const finishData = decodeResponse(finished).data
    const finishMap = finishData.rush_event.rush_battle_played_party_list
    assertPlayedQuestIds(finishMap, [firstQuestId])
    assert.ok(Object.hasOwn(finishMap, firstQuestId), "finish 必须立即返回实际 questId 对应的队伍")

    const reloaded = await summary()
    assert.equal(reloaded.statusCode, 200, reloaded.body)
    const summaryData = decodeResponse(reloaded).data
    assert.deepEqual(summaryData.rush_battle_played_party_list, finishMap)
    assert.equal(summaryData.active_rush_battle_folder_id, folderId)
}

async function assertTwoRoundFolder(folderId, questIds) {
    await assertFirstRoundProgress(folderId, questIds[0])

    const secondStart = await startBattle(questIds[1], 2)
    assert.equal(secondStart.statusCode, 200, secondStart.body)
    const secondFinish = await finishBattle(questIds[1])
    assert.equal(secondFinish.statusCode, 200, secondFinish.body)
    const finishRush = decodeResponse(secondFinish).data.rush_event
    assertPlayedQuestIds(finishRush.rush_battle_played_party_list, [])
    assert.ok(finishRush.rush_battle_reward_list.length > 0)

    const settled = decodeResponse(await summary()).data
    assert.equal(settled.active_rush_battle_folder_id, null)
    assertPlayedQuestIds(settled.rush_battle_played_party_list, [])
    assert.ok(settled.cleared_folder_id_list.includes(folderId))
}

function invalidRushQuestTable() {
    const table = structuredClone(require("../assets/rush_event_quest.json"))
    table["700007002"].rushEventRound = "invalid"
    return table
}

function clearActiveQuest() {
    deletePlayerActiveQuestSync(playerId)
    clearPublishedActiveQuest(playerId)
}

fastify = Fastify({ logger: false })
fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
)
registerCnMsgpackOnSend(fastify, encodeCnMsgpackPayload)

test("folder 最大 round 来自 eventId + folderId 的官方内容表", () => {
    assert.equal(getRushEventFolderMaxRoundSync(700001, RushEventFolder.GODLY), 2)
    assert.equal(getRushEventFolderMaxRoundSync(700007, RushEventFolder.GODLY), 3)
    assert.throws(
        () => getRushEventFolderMaxRoundSync(700007, RushEventFolder.ENDLESS),
        /Invalid rush event quest configuration/,
    )
})

test("中级首关 finish 与 summary 立即一致，第二关可使用 party2 并完成两关结算", async () => {
    await fastify.register(rushEventRoutes, { prefix: "/api/index.php/event/rush" })
    await fastify.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await fastify.ready()
    await assertTwoRoundFolder(RushEventFolder.INTERMEDIATE, [700007001, 700007002])
})

test("高级首关 finish 与 summary 立即一致，第二关可使用 party2 并完成两关结算", async () => {
    await assertTwoRoundFolder(RushEventFolder.ADVANCED, [700007003, 700007004])
})

test("三关 folder 在第二关后保留 active folder 与两关队伍，第三关才结算", async () => {
    const questIds = [700007005, 700007006, 700007007]
    await assertFirstRoundProgress(RushEventFolder.GODLY, questIds[0])

    const secondStart = await startBattle(questIds[1], 2)
    assert.equal(secondStart.statusCode, 200, secondStart.body)
    const secondFinish = await finishBattle(questIds[1])
    assert.equal(secondFinish.statusCode, 200, secondFinish.body)
    const secondRush = decodeResponse(secondFinish).data.rush_event
    assertPlayedQuestIds(secondRush.rush_battle_played_party_list, questIds.slice(0, 2))

    const afterSecond = decodeResponse(await summary()).data
    assert.equal(afterSecond.active_rush_battle_folder_id, RushEventFolder.GODLY)
    assert.deepEqual(afterSecond.rush_battle_played_party_list, secondRush.rush_battle_played_party_list)

    const thirdStart = await startBattle(questIds[2], 3)
    assert.equal(thirdStart.statusCode, 200, thirdStart.body)
    const thirdFinish = await finishBattle(questIds[2])
    assert.equal(thirdFinish.statusCode, 200, thirdFinish.body)
    const thirdRush = decodeResponse(thirdFinish).data.rush_event
    assertPlayedQuestIds(thirdRush.rush_battle_played_party_list, [])
    assert.ok(thirdRush.rush_battle_reward_list.length > 0)

    const settled = decodeResponse(await summary()).data
    assert.equal(settled.active_rush_battle_folder_id, null)
    assertPlayedQuestIds(settled.rush_battle_played_party_list, [])
    assert.ok(settled.cleared_folder_id_list.includes(RushEventFolder.GODLY))
})

test("官方完整 reset 后切换 folder 必须从第一关重新计数", async () => {
    await assertFirstRoundProgress(RushEventFolder.ADVANCED, 700007003)

    const reset = await resetFolder()
    assert.equal(reset.statusCode, 200, reset.body)
    const afterReset = decodeResponse(await summary()).data
    assert.equal(afterReset.active_rush_battle_folder_id, null)
    assertPlayedQuestIds(afterReset.rush_battle_played_party_list, [])

    const selected = await selectFolder(RushEventFolder.INTERMEDIATE)
    assert.equal(selected.statusCode, 200, selected.body)
    const started = await startBattle(700007001, 1)
    assert.equal(started.statusCode, 200, started.body)
    const finished = await finishBattle(700007001)
    assert.equal(finished.statusCode, 200, finished.body)
    assertPlayedQuestIds(
        decodeResponse(finished).data.rush_event.rush_battle_played_party_list,
        [700007001],
    )

    const cleanup = await resetFolder()
    assert.equal(cleanup.statusCode, 200, cleanup.body)
})

test("select_folder 原子清除 active=null 时的历史 FOLDER 残留", async () => {
    insertFolderParty(700007003)
    try {
        db.exec(`
            CREATE TRIGGER fail_stale_rush_folder_cleanup
            BEFORE DELETE ON players_rush_events_played_parties
            WHEN OLD.battle_type = 0
            BEGIN
                SELECT RAISE(ABORT, 'injected stale folder cleanup rollback');
            END;
        `)
        try {
            const failed = await selectFolder(RushEventFolder.INTERMEDIATE)
            assert.equal(failed.statusCode, 500, failed.body)
            assert.equal(getPlayerRushEventSync(playerId, eventId).activeRushBattleFolderId, null)
            assertPlayedQuestIds(
                Object.fromEntries(getPlayerRushEventPlayedPartiesSync(playerId, eventId)
                    .filter(party => party.battleType === RushEventBattleType.FOLDER)
                    .map(party => [party.round, party])),
                [700007003],
            )
        } finally {
            db.exec("DROP TRIGGER fail_stale_rush_folder_cleanup")
        }

        const selected = await selectFolder(RushEventFolder.INTERMEDIATE)
        assert.equal(selected.statusCode, 200, selected.body)
        const reloaded = decodeResponse(await summary()).data
        assert.equal(reloaded.active_rush_battle_folder_id, RushEventFolder.INTERMEDIATE)
        assertPlayedQuestIds(reloaded.rush_battle_played_party_list, [])
    } finally {
        clearFolderState()
    }
})

test("battle/start 对 folder 事件、active folder、历史列表与下一 round fail closed", async () => {
    const rejectWithoutActiveQuest = async (questId, label) => {
        const response = await startBattle(questId, 1)
        try {
            assert.equal(response.statusCode, 400, `${label}: ${response.body}`)
            assertNoActiveQuest(label)
        } finally {
            clearActiveQuest()
        }
    }

    await rejectWithoutActiveQuest(700017001, "玩家没有请求 quest 所属的 Rush event")

    setActiveFolder(RushEventFolder.ADVANCED)
    await rejectWithoutActiveQuest(700007001, "quest folder 必须匹配 active folder")

    setActiveFolder(RushEventFolder.INTERMEDIATE)
    insertFolderParty(999999999)
    await rejectWithoutActiveQuest(700007002, "历史 FOLDER party 必须可解析")

    deletePlayerRushEventPlayedPartyListSync(playerId, eventId, RushEventBattleType.FOLDER)
    insertFolderParty(700007003)
    await rejectWithoutActiveQuest(700007002, "历史 FOLDER party 必须属于 active folder")

    deletePlayerRushEventPlayedPartyListSync(playerId, eventId, RushEventBattleType.FOLDER)
    await rejectWithoutActiveQuest(700007002, "folder quest round 必须等于已完成数加一")

    clearFolderState()
})

test("folder progression rejects a non-contiguous historical round", () => {
    const quest = {
        rushEventId: 700007,
        rushEventFolderId: RushEventFolder.GODLY,
        rushEventRound: 2,
    }
    const historicalRoundTwo = {
        round: 700007006,
        battleType: RushEventBattleType.FOLDER,
    }
    assert.equal(canStartRushEventFolderBattle({
        quest,
        rushEvent: {
            eventId: 700007,
            activeRushBattleFolderId: RushEventFolder.GODLY,
        },
        playedParties: [historicalRoundTwo],
        getQuest: questId => questId === historicalRoundTwo.round ? quest : null,
    }), false)
})

test("endless round=0 不受 folder progression 校验影响", async () => {
    setActiveFolder(RushEventFolder.INTERMEDIATE)
    insertFolderParty(999999999)
    const started = await startBattle(700007008, 1)
    assert.equal(started.statusCode, 200, started.body)
    assert.equal(getPlayerActiveQuestSync(playerId).questId, 700007008)
    clearFolderState()
})

test("battle/start 在 folder round 内容非法时拒绝创建 active quest", async () => {
    const restoreInvalidSnapshot = installBundledGameplaySnapshot({
        tableOverrides: { "rush_event_quest.json": invalidRushQuestTable() },
    })
    try {
        const response = await startBattle(700007001, 1)
        assert.equal(response.statusCode, 500, response.body)
        assertNoActiveQuest("非法 folder 主数据不得创建 active quest")
    } finally {
        restoreInvalidSnapshot()
        clearActiveQuest()
    }
})

test("single battle finish 在 folder round 内容非法时拒绝结算", async () => {
    const selected = await selectFolder(RushEventFolder.INTERMEDIATE)
    assert.equal(selected.statusCode, 200, selected.body)
    const started = await startBattle(700007001, 1)
    assert.equal(started.statusCode, 200, started.body)
    const restoreInvalidSnapshot = installBundledGameplaySnapshot({
        tableOverrides: { "rush_event_quest.json": invalidRushQuestTable() },
    })
    try {
        const response = await finishBattle(700007001)
        assert.equal(response.statusCode, 500, response.body)
    } finally {
        restoreInvalidSnapshot()
        clearFolderState()
    }
})

after(async () => {
    if (fastify) await fastify.close()
    if (db?.open) db.close()
    restoreContentSnapshot()
    restoreTimeOffset()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
