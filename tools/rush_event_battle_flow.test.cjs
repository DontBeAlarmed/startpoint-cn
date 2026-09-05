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
    insertPlayerRushEventClearedFolderSync,
    getPlayerRushEventPlayedPartiesSync,
    getPlayerRushEventSync,
    insertPlayerRushEventPlayedPartySync,
    insertPlayerRushEventSync,
    updatePlayerRushEventSync,
} = require("../src/data/domains/rushEvent")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { deletePlayerActiveQuestSync, getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const {
    activeQuests,
    clearPublishedActiveQuest,
} = require("../src/lib/quest/active-quest-service")
const { RushEventBattleType } = require("../src/data/types")
const { QuestCategory, RushEventFolder } = require("../src/lib/types")
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const {
    getRushEventFolderClearRewards,
    getRushEventFolderMaxRoundSync,
} = require("../src/lib/assets")
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
const compatibilityEventId = 700011

db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
insertPlayerRushEventSync(playerId, getDefaultPlayerRushEventSync(eventId))
insertPlayerRushEventSync(playerId, getDefaultPlayerRushEventSync(compatibilityEventId))

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

async function selectFolder(folderId, targetEventId = eventId) {
    return post("/api/index.php/event/rush/select_folder", {
        viewer_id: viewerId,
        api_count: 1,
        event_id: targetEventId,
        folder_id: folderId,
    })
}

async function startBattle(
    questId,
    partyId,
    isAutoStartMode = false,
    playId = `rush-${questId}-${partyId}-${randomUUID()}`,
) {
    return post("/api/index.php/event/rush/battle/start", {
        viewer_id: viewerId,
        api_count: 1,
        quest_id: questId,
        party_id: partyId,
        is_auto_start_mode: isAutoStartMode,
        play_id: playId,
    })
}

async function finishBattle(questId) {
    const activeQuest = getPlayerActiveQuestSync(playerId)
    return post("/api/index.php/single_battle_quest/finish", {
        viewer_id: viewerId,
        api_count: 1,
        play_id: activeQuest.playId,
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

function getStoredItemAndMailTotal(itemId) {
    const inventory = getPlayerItemSync(playerId, itemId) ?? 0
    const mail = db.prepare(`
        SELECT COALESCE(SUM(number), 0) AS amount
        FROM players_mails
        WHERE player_id = ?
          AND receive_time = '0000-00-00 00:00:00'
          AND type = 1
          AND type_id = ?
    `).get(playerId, itemId).amount
    return inventory + mail
}

function clientAutoRetryTransition(rushEvent, battleStartRemainingTimes) {
    if (rushEvent.rush_battle_reward_list.length === 0) return "no-clear-dialog"
    return battleStartRemainingTimes > 0 ? "auto-retry" : "complete"
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

    const settled = decodeResponse(await summary()).data
    assert.equal(settled.active_rush_battle_folder_id, null)
    assertPlayedQuestIds(settled.rush_battle_played_party_list, [])
    assert.ok(settled.cleared_folder_id_list.includes(folderId))
    assertNoActiveQuest("folder final finish must clear active quest")
    return finishRush
}

async function assertAutoRestartedTwoRoundFolder(folderId, questIds) {
    const firstStart = await startBattle(questIds[0], 1, true)
    assert.equal(firstStart.statusCode, 200, firstStart.body)
    assert.equal(getPlayerRushEventSync(playerId, eventId).activeRushBattleFolderId, folderId)

    const firstFinish = await finishBattle(questIds[0])
    assert.equal(firstFinish.statusCode, 200, firstFinish.body)
    assertPlayedQuestIds(
        decodeResponse(firstFinish).data.rush_event.rush_battle_played_party_list,
        [questIds[0]],
    )

    const secondStart = await startBattle(questIds[1], 2, true)
    assert.equal(secondStart.statusCode, 200, secondStart.body)
    const secondFinish = await finishBattle(questIds[1])
    assert.equal(secondFinish.statusCode, 200, secondFinish.body)
    const finishRush = decodeResponse(secondFinish).data.rush_event
    assertPlayedQuestIds(finishRush.rush_battle_played_party_list, [])
    assertNoActiveQuest("auto-restarted folder final finish must clear active quest")
    return finishRush
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

test("中级两 lap 真实链允许客户端不重复 select_folder 直接开始后续 lap", async () => {
    await fastify.register(rushEventRoutes, { prefix: "/api/index.php/event/rush" })
    await fastify.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await fastify.ready()
    const firstLap = await assertTwoRoundFolder(
        RushEventFolder.INTERMEDIATE,
        [700007001, 700007002],
    )
    assert.ok(firstLap.rush_battle_reward_list.length > 0)
    assert.equal(clientAutoRetryTransition(firstLap, 2), "auto-retry")

    const secondLap = await assertAutoRestartedTwoRoundFolder(
        RushEventFolder.INTERMEDIATE,
        [700007001, 700007002],
    )
    assert.ok(secondLap.rush_battle_reward_list.length > 0)
    assert.equal(clientAutoRetryTransition(secondLap, 1), "auto-retry")
    assert.equal(clientAutoRetryTransition(secondLap, 0), "complete")
})

test("700011 高级两 lap 走真实兼容奖励并保持响应与库存一致", async () => {
    const folderId = RushEventFolder.ADVANCED
    const questIds = [700011003, 700011004]
    const rewards = getRushEventFolderClearRewards(compatibilityEventId, folderId)
    assert.ok(rewards?.length > 0)
    const expectedResponseRewards = rewards.map(reward => ({
        kind: 1,
        kind_id: reward.id,
        number: reward.count,
    }))
    const beforeTotals = Object.fromEntries(rewards.map(reward => [
        reward.id,
        getStoredItemAndMailTotal(reward.id),
    ]))

    const selected = await selectFolder(folderId, compatibilityEventId)
    assert.equal(selected.statusCode, 200, selected.body)
    const firstStart = await startBattle(questIds[0], 1, true)
    assert.equal(firstStart.statusCode, 200, firstStart.body)
    assert.equal((await finishBattle(questIds[0])).statusCode, 200)
    const firstFinalStart = await startBattle(questIds[1], 2, true)
    assert.equal(firstFinalStart.statusCode, 200, firstFinalStart.body)
    const firstFinal = await finishBattle(questIds[1])
    assert.equal(firstFinal.statusCode, 200, firstFinal.body)
    assert.deepEqual(
        decodeResponse(firstFinal).data.rush_event.rush_battle_reward_list,
        expectedResponseRewards,
    )

    const secondLapPlayId = `rush-live-repro-${randomUUID()}`
    const secondStart = await startBattle(questIds[0], 1, true, secondLapPlayId)
    assert.equal(secondStart.statusCode, 200, secondStart.body)
    assert.equal(
        getPlayerRushEventSync(playerId, compatibilityEventId).activeRushBattleFolderId,
        folderId,
    )
    assert.equal(getPlayerActiveQuestSync(playerId).playId, secondLapPlayId)
    assert.equal(activeQuests[playerId].playId, secondLapPlayId)
    assert.equal((await finishBattle(questIds[0])).statusCode, 200)
    const secondFinalStart = await startBattle(questIds[1], 2, true)
    assert.equal(secondFinalStart.statusCode, 200, secondFinalStart.body)
    const secondFinal = await finishBattle(questIds[1])
    assert.equal(secondFinal.statusCode, 200, secondFinal.body)
    assert.deepEqual(
        decodeResponse(secondFinal).data.rush_event.rush_battle_reward_list,
        expectedResponseRewards,
    )

    for (const reward of rewards) {
        assert.equal(
            getStoredItemAndMailTotal(reward.id) - beforeTotals[reward.id],
            reward.count * 2,
            `item ${reward.id} 必须实际入库两次`,
        )
    }
})

test("高级首关 finish 与 summary 立即一致，第二关可使用 party2 并完成两关结算", async () => {
    const finish = await assertTwoRoundFolder(
        RushEventFolder.ADVANCED,
        [700007003, 700007004],
    )
    assert.ok(finish.rush_battle_reward_list.length > 0)
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

test("自动续战只可从已通关且状态干净的 folder 第一关重启", async () => {
    const rejectAutoStart = async (questId, setup, label, autoStartValue = true) => {
        clearFolderState()
        db.prepare(`
            DELETE FROM players_rush_events_cleared_folders
            WHERE player_id = ? AND event_id = ?
        `).run(playerId, eventId)
        setup()
        const response = await startBattle(questId, 1, autoStartValue)
        try {
            assert.equal(response.statusCode, 400, `${label}: ${response.body}`)
            assertNoActiveQuest(label)
        } finally {
            clearFolderState()
        }
    }

    await rejectAutoStart(700007001, () => {}, "未通关 folder 不得跳过 select_folder")
    await rejectAutoStart(700007002, () => {
        insertPlayerRushEventClearedFolderSync(playerId, eventId, RushEventFolder.INTERMEDIATE)
    }, "后续 lap 必须从 folder 第一关开始")
    await rejectAutoStart(700007001, () => {
        insertPlayerRushEventClearedFolderSync(playerId, eventId, RushEventFolder.INTERMEDIATE)
        insertFolderParty(700007003)
    }, "残留 folder party 时不得隐式重启")
    for (const invalidAutoStartValue of [1, "true", null]) {
        await rejectAutoStart(700007001, () => {
            insertPlayerRushEventClearedFolderSync(playerId, eventId, RushEventFolder.INTERMEDIATE)
        }, `auto start 必须是 boolean：${String(invalidAutoStartValue)}`, invalidAutoStartValue)
    }

    clearFolderState()
})

test("自动续战恢复 folder 与创建 active quest 共同回滚", async () => {
    clearFolderState()
    insertPlayerRushEventClearedFolderSync(playerId, eventId, RushEventFolder.INTERMEDIATE)
    db.exec(`
        CREATE TRIGGER fail_rush_auto_restart_active_quest
        BEFORE INSERT ON players_active_quests
        BEGIN
            SELECT RAISE(ABORT, 'injected rush auto restart rollback');
        END;
    `)
    try {
        const response = await startBattle(700007001, 1, true)
        assert.equal(response.statusCode, 500, response.body)
        assert.equal(getPlayerRushEventSync(playerId, eventId).activeRushBattleFolderId, null)
        assertNoActiveQuest("自动续战 active quest 写入失败必须完整回滚")
        assert.deepEqual(
            getPlayerRushEventPlayedPartiesSync(playerId, eventId)
                .filter(party => party.battleType === RushEventBattleType.FOLDER),
            [],
        )
    } finally {
        db.exec("DROP TRIGGER fail_rush_auto_restart_active_quest")
        clearFolderState()
    }
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
