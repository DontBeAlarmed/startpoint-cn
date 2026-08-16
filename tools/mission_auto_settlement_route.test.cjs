require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-auto-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR
let db
let restoreContentSnapshot = () => {}
let restoreTimeOffset = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    restoreTimeOffset()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot({
    additionalTableNames: ["event_item_shop.json"],
})

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    insertPlayerCharacterManaNodesSync,
    insertPlayerCharacterSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const { getPlayerCharacterAwakeUnlocksSync } = require("../src/data/domains/character_awake")
const { recordMissionBattleResultSync } = require("../src/data/domains/mission_battle_facts")
const { getPlayerItemSync, givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerActiveQuestSync } = require("../src/data/domains/quest_active")
const {
    getPlayerActiveMissionsSync,
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const { getCharacterDataSync, getCharacterManaNodesSync } = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const {
    createCharacterAwakeEligibilityResolver,
    getAwakeBattleMissionIds,
    getMissionCatalog,
} = require("../src/lib/mission")
const singleBattleRoutes = require("../src/routes/api/singleBattleQuest").default
const missionRoutes = require("../src/routes/api/mission").default
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
    idpId: `mission-auto-route-${randomUUID()}`,
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const viewerId = 800000198
const degreeCharacterIds = [111001, 111002, 111003]
const degreeCharacterTime = new Date("2024-01-01T00:00:00.000Z")
for (const characterId of degreeCharacterIds) {
    insertPlayerCharacterSync(playerId, characterId, {
        entryCount: 1,
        evolutionLevel: 0,
        overLimitStep: 4,
        protection: false,
        joinTime: degreeCharacterTime,
        updateTime: degreeCharacterTime,
        exp: 379988,
        stack: 0,
        manaBoardIndex: 1,
        bondTokenList: [{ manaBoardIndex: 1, status: 1 }],
    })
}
const alkCharacterId = 1
const alkRarity = getCharacterDataSync(alkCharacterId).rarity
updatePlayerCharacterSync(playerId, alkCharacterId, { exp: characterExpCaps[alkRarity][0] })
db.prepare("DELETE FROM players_characters_mana_nodes WHERE player_id = ? AND character_id = ?")
    .run(playerId, alkCharacterId)
insertPlayerCharacterManaNodesSync(
    playerId,
    alkCharacterId,
    Object.keys(getCharacterManaNodesSync(alkCharacterId, 1)).map(Number),
)
insertPlayerCharacterManaNodesSync(
    playerId,
    111001,
    Object.keys(getCharacterManaNodesSync(111001, 1)).map(Number),
)
db.prepare(`
    INSERT INTO players_character_quest_clears (
        player_id, character_id, clear_count, multi_count,
        leader_clear_count, leader_multi_count, leader_power_flip_count
    ) VALUES (?, 111001, 5, 0, 0, 0, 0)
`).run(playerId)
for (const [missionId, progress] of [[11, 3], [12, 100]]) {
    updatePlayerCategoryMissionSync(playerId, 9, missionId, progress)
    updatePlayerCategoryMissionStageSync(playerId, 9, 1, missionId, true)
}
assert.deepEqual(getAwakeBattleMissionIds([1], [13]), [11, 12, 13, 14])
assert.equal(
    createCharacterAwakeEligibilityResolver(
        playerId,
        new Date("2024-08-14T12:00:00.000Z"),
    ).getBaseReadiness(1),
    "ready",
)
db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
    .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
db.prepare(`
    INSERT INTO players_mails
        (player_id, reason_id, subject, description, type, type_id, number, receive_time, create_time)
    VALUES (?, 0, 'test', '', 1, 1, 1, '0000-00-00 00:00:00', ?)
`).run(playerId, new Date().toISOString())

updatePlayerSync({
    id: playerId,
    stamina: 100,
    totalStaminaUsed: 40,
    totalDashes: 10,
})
for (let index = 0; index < 2; index++) {
    recordMissionBattleResultSync(playerId, { isMulti: false, accomplished: true, clearRank: 5 })
}
recordMissionBattleResultSync(playerId, {
    isMulti: true,
    isHost: true,
    accomplished: true,
    clearRank: 5,
})

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function main() {
    const fastify = Fastify()
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
    await fastify.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    await fastify.register(missionRoutes, { prefix: "/api/index.php/mission" })
    await fastify.ready()

    try {
        const start = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/start",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                quest_id: 2001,
                category: 22,
                party_id: 1,
                use_boost_point: false,
                use_boss_boost_point: false,
                is_auto_start_mode: false,
                play_id: "mission-auto-settlement",
            }),
        })
        assert.equal(start.statusCode, 200, start.body)
        const startData = decodeResponse(start).data
        assert.deepEqual(
            startData.mission_info
                .filter(entry => entry.mission_category_id === 2)
                .map(entry => entry.mission_id),
            [13, 14, 16],
        )
        assert.equal(startData.mail_arrived, true)

        const finishPayload = {
            viewer_id: viewerId,
            api_count: 1,
            play_id: "mission-auto-settlement",
            quest_id: 2001,
            category: 22,
            score: 0,
            elapsed_time_ms: 1000,
            add_mana: 0,
            is_accomplished: true,
            is_restored: false,
            continue_count: 0,
            statistics: {
                clear_phase: 1,
                max_combo_count: 0,
                max_power: 3000,
                zones: [{ use_power_flip_count: 100 }],
                party: {
                    characters: [{ id: 1 }, null, null],
                    unison_characters: [null, null, null],
                    equipments: [null, null, null],
                    ability_soul_ids: [null, null, null],
                },
            },
        }
        db.exec(`
            CREATE TRIGGER fail_awake_fact_finish
            AFTER DELETE ON players_active_quests
            BEGIN
                SELECT RAISE(ABORT, 'injected awake fact rollback');
            END;
        `)
        const awakeItemsBeforeRollback = {
            3: getPlayerItemSync(playerId, 3) ?? 0,
            4: getPlayerItemSync(playerId, 4) ?? 0,
        }
        const activeMissionsBeforeRollback = structuredClone(getPlayerActiveMissionsSync(playerId))
        const rolledBackFinish = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/finish",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest(finishPayload),
        })
        assert.equal(rolledBackFinish.statusCode, 500)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 9)[13], undefined)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 9)[14], undefined)
        assert.equal(getPlayerItemSync(playerId, 3) ?? 0, awakeItemsBeforeRollback[3])
        assert.equal(getPlayerItemSync(playerId, 4) ?? 0, awakeItemsBeforeRollback[4])
        assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("1"), false)
        assert.deepEqual(
            getPlayerActiveMissionsSync(playerId),
            activeMissionsBeforeRollback,
            "结算后段失败时 Active Mission 写入必须随战斗事务回滚",
        )
        assert.notEqual(getPlayerActiveQuestSync(playerId), null)
        db.exec("DROP TRIGGER fail_awake_fact_finish")

        const finish = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/finish",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest(finishPayload),
        })
        assert.equal(finish.statusCode, 200, finish.body)
        const finishData = decodeResponse(finish).data
        const awakeProgressAfterFinish = getPlayerCategoryMissionsSync(playerId, 9)
        assert.equal(awakeProgressAfterFinish[13]?.progress, 100, "本场 powerflip fact 必须先写入")
        assert.equal(awakeProgressAfterFinish[14]?.progress, 3, "awake candidate settlement 必须计算 ALL_COMPLETE")
        assert.deepEqual(
            finishData.mission_info
                .filter(entry => entry.mission_category_id === 9)
                .map(entry => entry.mission_id),
            [13, 14],
            "本场觉醒任务与 ALL_COMPLETE 必须随同一次 finish 返回",
        )
        assert.deepEqual(
            finishData.character_list.find(character => character.character_id === 1)
                ?.mana_board_awake,
            { 1: 1 },
            "觉醒 board unlock 必须在同次 character_list 即时可见",
        )
        assert.equal(
            finishData.character_list.filter(character => character.character_id === 1).length,
            1,
            "同一角色的经验与觉醒更新不得产生重复 character_list 条目",
        )
        assert.equal(finishData.item_list[3], awakeItemsBeforeRollback[3] + 3)
        assert.equal(finishData.item_list[4], awakeItemsBeforeRollback[4] + 1)
        assert.equal(
            finishData.mission_info.some(entry => (
                entry.mission_category_id === 9
                && Math.floor(entry.mission_id / 10) === 111001
            )),
            false,
            "未出战角色不得在本场 finish 结算",
        )
        assert.deepEqual(
            finishData.mission_info
                .filter(entry => entry.mission_category_id === 2)
                .map(entry => entry.mission_id),
            [11, 17],
        )
        assert.deepEqual(
            finishData.mission_info.find(entry => (
                entry.mission_category_id === 5 && entry.mission_id === 15000
            )),
            {
                mission_category_id: 5,
                mission_id: 15000,
                mission_reward_id: 15000001,
            },
            "本场满足的称号任务必须随同一次 finish 返回",
        )
        assert.equal(
            finishData.degree_list.some(entry => entry.degree_id === 15000),
            true,
            "称号奖励必须沿 mission settlement response 路径返回",
        )
        assert.deepEqual(
            finishData.mission_info.find(entry => (
                entry.mission_category_id === 5 && entry.mission_id === 32000
            )),
            {
                mission_category_id: 5,
                mission_id: 32000,
                mission_reward_id: 32000001,
            },
            "本场 max_power 权威事实必须在同一次 finish 结算称号",
        )
        assert.equal(
            finishData.degree_list.some(entry => entry.degree_id === 32000),
            true,
            "condition 27 称号奖励必须沿既有 response 路径返回",
        )
        assert.equal(finishData.mail_arrived, true)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 9)[13].progress, 100)

        const duplicateFinish = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/finish",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest(finishPayload),
        })
        assert.equal(duplicateFinish.statusCode, 400)
        assert.equal(getPlayerCategoryMissionsSync(playerId, 9)[13].progress, 100)

        const dailyMazeStart = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/start",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 2,
                quest_id: 19001,
                category: 6,
                party_id: 1,
                use_boost_point: false,
                use_boss_boost_point: false,
                is_auto_start_mode: false,
                play_id: "active-mission-daily-maze",
            }),
        })
        assert.equal(dailyMazeStart.statusCode, 200, dailyMazeStart.body)
        const dailyMazeFinish = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/finish",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                ...finishPayload,
                api_count: 2,
                play_id: "active-mission-daily-maze",
                quest_id: 19001,
                category: 6,
                statistics: {
                    ...finishPayload.statistics,
                    party: {
                        characters: [{ id: 111001 }, null, null],
                        unison_characters: [{ id: 111002 }, null, null],
                        equipments: [null, null, null],
                        ability_soul_ids: [null, null, null],
                    },
                },
            }),
        })
        assert.equal(dailyMazeFinish.statusCode, 200, dailyMazeFinish.body)
        const dailyMazeData = decodeResponse(dailyMazeFinish).data
        const dailyMazeActiveMissions = Object.fromEntries(
            dailyMazeData.active_mission_list.map(entry => [entry.mission_id, entry]),
        )
        assert.deepEqual(dailyMazeActiveMissions[11060], {
            mission_id: 11060,
            progress_value: 1,
            stages: [{ stage: 1, received: false }],
        })
        const degreeMissionIds = dailyMazeData.mission_info
            .filter(entry => entry.mission_category_id === 5)
            .map(entry => entry.mission_id)
        assert.equal(degreeMissionIds.includes(111001), true, "main 角色称号必须同场结算")
        assert.equal(degreeMissionIds.includes(111002), true, "Sub 角色称号必须同场结算")
        assert.equal(degreeMissionIds.includes(111003), false, "未出战角色称号不得进入本场结算")
        const degreeIds = dailyMazeData.degree_list.map(entry => entry.degree_id)
        assert.equal(degreeIds.includes(111001), true, "main 角色称号奖励必须同次返回")
        assert.equal(degreeIds.includes(111002), true, "Sub 角色称号奖励必须同次返回")
        assert.equal(degreeIds.includes(111003), false, "未出战角色称号奖励不得返回")

        const dailyExpManaStart = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/start",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 3,
                quest_id: 1001,
                category: 14,
                party_id: 1,
                use_boost_point: false,
                use_boss_boost_point: false,
                is_auto_start_mode: false,
                play_id: "active-mission-daily-exp-mana",
            }),
        })
        assert.equal(dailyExpManaStart.statusCode, 200, dailyExpManaStart.body)
        const dailyExpManaFinish = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/finish",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                ...finishPayload,
                api_count: 3,
                play_id: "active-mission-daily-exp-mana",
                quest_id: 1001,
                category: 14,
            }),
        })
        assert.equal(dailyExpManaFinish.statusCode, 200, dailyExpManaFinish.body)
        const dailyExpManaData = decodeResponse(dailyExpManaFinish).data
        assert.deepEqual(
            dailyExpManaData.active_mission_list.find(entry => entry.mission_id === 11080),
            {
                mission_id: 11080,
                progress_value: 1,
                stages: [{ stage: 1, received: false }],
            },
        )

        updatePlayerSync({
            id: playerId,
            stamina: 0,
            staminaHealTime: new Date("2099-12-31T23:59:59.000Z"),
        })
        const exhaustedAutoStart = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/start",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 2,
                quest_id: 1001002,
                category: 1,
                party_id: 1,
                use_boost_point: false,
                use_boss_boost_point: false,
                is_auto_start_mode: true,
                play_id: "auto-stamina-exhausted",
            }),
        })
        assert.equal(exhaustedAutoStart.statusCode, 200, exhaustedAutoStart.body)
        const exhaustedAutoData = decodeResponse(exhaustedAutoStart)
        assert.equal(exhaustedAutoData.data_headers.result_code, 4050)
        assert.deepEqual(exhaustedAutoData.data, {})
        assert.equal(getPlayerActiveQuestSync(playerId), null)

        const exhaustedManualStart = await fastify.inject({
            method: "POST",
            url: "/api/index.php/single_battle_quest/start",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 3,
                quest_id: 1001002,
                category: 1,
                party_id: 1,
                use_boost_point: false,
                use_boss_boost_point: false,
                is_auto_start_mode: false,
                play_id: "manual-stamina-exhausted",
            }),
        })
        assert.equal(exhaustedManualStart.statusCode, 400)
        assert.equal(getPlayerActiveQuestSync(playerId), null)

        db.prepare(`
            DELETE FROM players_category_mission_stages
            WHERE player_id = ? AND category = 2 AND mission_id = 17
        `).run(playerId)
        db.prepare(`
            DELETE FROM players_category_missions
            WHERE player_id = ? AND category = 2 AND id = 17
        `).run(playerId)
        const dailyPage = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 2 }],
            }),
        })
        assert.equal(dailyPage.statusCode, 200, dailyPage.body)
        const dailyPageData = decodeResponse(dailyPage).data
        assert.deepEqual(dailyPageData.mission_info.map(entry => entry.mission_id), [17])
        assert.equal(
            dailyPageData.mission_progress_list.find(entry => entry.mission_id === 17).progress_value,
            4,
            "同一任务页响应的 all-clear 进度必须与已发放奖励一致",
        )

        updatePlayerSync({ id: playerId, totalLoginDays: 3 })
        const weekly = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 10 }],
            }),
        })
        assert.equal(weekly.statusCode, 200, weekly.body)
        const weeklyData = decodeResponse(weekly).data
        assert.deepEqual(
            weeklyData.mission_info.map(entry => entry.mission_id),
            [1],
        )
        assert.equal(weeklyData.mail_arrived, true)

        setServerTimeOffset(Date.parse("2020-02-21T04:00:00.000Z") - Date.now())
        givePlayerItemSync(playerId, 80001, 50)
        const collectPage = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 4, event_id: 1 }],
            }),
        })
        assert.equal(collectPage.statusCode, 200, collectPage.body)
        const collectPageData = decodeResponse(collectPage).data
        assert.deepEqual(collectPageData.mission_info, [{
            mission_category_id: 4,
            mission_id: 1500,
            mission_reward_id: 1500001,
        }])
        assert.equal(
            collectPageData.mission_progress_list.find(entry => entry.mission_id === 1500).progress_value,
            50,
        )

        setServerTimeOffset(Date.parse("2020-07-21T04:00:00.000Z") - Date.now())
        const catalog = getMissionCatalog()
        const category4Definitions = catalog.getDefinitions(4)
        const event3MissionIds = category4Definitions
            .filter(definition => catalog.isEnabledAt(4, definition.missionId, new Date("2020-07-21T04:00:00.000Z"), 3))
            .map(definition => definition.missionId)
        const event10002MissionIds = category4Definitions
            .filter(definition => catalog.isEnabledAt(4, definition.missionId, new Date("2020-07-21T04:00:00.000Z"), 10002))
            .map(definition => definition.missionId)
        assert.equal(event3MissionIds.length, 60)
        assert.equal(event10002MissionIds.length, 8)

        const dualEventPage = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [
                    { category: 4, event_id: 3 },
                    { category: 4, event_id: 10002 },
                ],
            }),
        })
        assert.equal(dualEventPage.statusCode, 200, dualEventPage.body)
        const dualEventMissionIds = decodeResponse(dualEventPage).data.mission_progress_list
            .map(entry => entry.mission_id)
        assert.equal(dualEventMissionIds.length, 68)
        assert.deepEqual(dualEventMissionIds, [
            ...event3MissionIds,
            ...event10002MissionIds,
        ])

        setServerTimeOffset(Date.parse("2023-12-01T04:00:00.000Z") - Date.now())
        givePlayerItemSync(playerId, 80111, 10)
        const eventItemPage = await fastify.inject({
            method: "POST",
            url: "/api/index.php/mission/get_mission_progress",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: encodeRequest({
                viewer_id: viewerId,
                api_count: 1,
                category_list: [{ category: 3 }],
            }),
        })
        assert.equal(eventItemPage.statusCode, 200, eventItemPage.body)
        const eventItemPageData = decodeResponse(eventItemPage).data
        assert.deepEqual(eventItemPageData.mission_info, [{
            mission_category_id: 3,
            mission_id: 2316,
            mission_reward_id: 2316001,
        }])
        assert.equal(
            eventItemPageData.mission_progress_list.find(entry => entry.mission_id === 2316).progress_value,
            10,
        )
        assert.equal(eventItemPageData.item_list[224], 5)
    } finally {
        await fastify.close()
        cleanup()
        process.removeListener("exit", cleanup)
    }
}

main().then(
    () => console.log("mission auto settlement route tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
