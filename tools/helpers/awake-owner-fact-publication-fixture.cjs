"use strict"

require("ts-node/register/transpile-only")

const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const BetterSqlite3 = require("better-sqlite3")
const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const AWAKE_CHARACTER_ID = 263002
const AWAKE_MANA_THRESHOLD = 604800
const ACTIVE_EVENT_ID = 998
const ACTIVE_MISSION_ID = 99801
const ACTIVE_MANA_REWARD = 5
const CHARACTER_QUEST_IDS = Object.freeze([26300201, 26300202, 26300203])
const MAIN_QUEST_ID = 1001002
const MULTI_QUEST = Object.freeze({ category: 13, questId: 2001 })

function activeMissionRow() {
    const row = []
    row[0] = String(ACTIVE_EVENT_ID)
    row[1] = "1"
    row[3] = "awake_owner_fact_publication"
    row[29] = "0"
    row[56] = "(None)"
    row[58] = "(None)"
    row[60] = "2020-01-01 00:00:00"
    row[61] = "(None)"
    return row
}

function activeEventRow() {
    const row = []
    row[0] = "awake_owner_fact_publication_event"
    row[2] = "0"
    row[3] = "1"
    row[14] = "2020-01-01 00:00:00"
    row[15] = "(None)"
    row[22] = "(None)"
    return row
}

function activeRewardRow() {
    const row = []
    row[3] = "1"
    row[4] = "(None)"
    row[7] = "3"
    row[8] = String(ACTIVE_MANA_REWARD)
    row[9] = "(None)"
    return row
}

function contentOverrides() {
    const activeMissions = require("../../assets/mission_active.json")
    const activeEvents = require("../../assets/mission_active_event.json")
    const activeRewards = require("../../assets/mission_active_reward.json")
    if (activeMissions[ACTIVE_MISSION_ID] || activeEvents[ACTIVE_EVENT_ID]) {
        throw new Error("Awake owner fixture collides with bundled Active Mission content")
    }
    const hardMultiQuests = structuredClone(require("../../assets/hard_multi_event_quest.json"))
    delete hardMultiQuests[String(MULTI_QUEST.questId)].commonRewardCounts
    return {
        "hard_multi_event_quest.json": hardMultiQuests,
        "mission_active.json": {
            ...activeMissions,
            [ACTIVE_MISSION_ID]: [activeMissionRow()],
        },
        "mission_active_event.json": {
            ...activeEvents,
            [ACTIVE_EVENT_ID]: [activeEventRow()],
        },
        "mission_active_reward.json": {
            ...activeRewards,
            [ACTIVE_MISSION_ID]: { 1: [activeRewardRow()] },
        },
        "rare_score_reward.json": {},
    }
}

function decodeResponse(response) {
    if (!String(response.headers["content-type"]).includes("application/x-msgpack")) {
        return JSON.parse(response.body)
    }
    return unpack(Buffer.from(response.body, "base64"))
}

async function createAwakeOwnerFactPublicationFixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-owner-facts-"))
    const previousDataDirectory = process.env.DATA_DIR
    const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
    process.env.DATA_DIR = directory
    delete process.env.WDFP_DATABASE_DIR

    let app = null
    let restoreContent = () => {}
    let restoreTimeOffset = () => {}
    let initialized = false
    try {
        restoreContent = require("./install-bundled-gameplay-snapshot.cjs")
            .installBundledGameplaySnapshot({
                additionalTableNames: [
                    "event_item_shop.json",
                    "event_item_shop_id_map.json",
                    "general_shop.json",
                    "raid_event_overall_reward.json",
                ],
                tableOverrides: contentOverrides(),
            })
        const data = require("../../src/data")
        const { getDb } = require("../../src/data/db")
        const { insertAccountSync } = require("../../src/data/domains/account")
        const characterDomain = require("../../src/data/domains/character")
        const awakeDomain = require("../../src/data/domains/character_awake")
        const missionDomain = require("../../src/data/domains/mission")
        const itemDomain = require("../../src/data/domains/item")
        const passCardDomain = require("../../src/data/domains/pass-card")
        const playerDomain = require("../../src/data/domains/player")
        const questDomain = require("../../src/data/domains/quest")
        const raidEventDomain = require("../../src/data/domains/raidEvent")
        const { insertSessionWithToken } = require("../../src/data/domains/session")
        const { SessionType } = require("../../src/data/types")
        const characterAssets = require("../../src/lib/assets")
        const { characterExpCaps } = require("../../src/lib/character")
        const { createAwakeRequestContext } = require("../../src/lib/mission/awake-request-context")
        const {
            activeQuests,
            insertActiveQuest,
        } = require("../../src/lib/quest/active-quest-service")
        const { validateMultiFinishRequest } = require("../../src/lib/quest/multi-battle-validation")
        const {
            runMultiplayerSettlementOrchestration,
        } = require("../../src/multi/settlement/orchestrator")
        const { registerCnMsgpackOnSend } = require("../../src/routes/cn/msgpack")
        const { getTimeOffset, setServerTimeOffset } = require("../../src/utils")

        const previousTimeOffset = getTimeOffset()
        restoreTimeOffset = () => setServerTimeOffset(previousTimeOffset)
        setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())

        const database = data.initializeDatabase({
            databaseFactory: databasePath => new BetterSqlite3(databasePath),
        })
        initialized = true
        app = Fastify({ logger: false })
        registerCnMsgpackOnSend(app)
        await app.register(require("../../src/routes/api/storyQuest").default, { prefix: "/story" })
        await app.register(require("../../src/routes/api/activeMission").default, { prefix: "/active" })
        await app.register(require("../../src/routes/api/passCard").default, { prefix: "/pass-card" })
        await app.register(require("../../src/routes/api/raidEvent").default, { prefix: "/raid" })
        await app.register(require("../../src/routes/api/singleBattleQuest").default, { prefix: "/single" })
        await app.ready()

        let nextViewerId = 880000000
        async function createPlayer(label) {
            const account = insertAccountSync({
                appId: "wf_cn",
                idpAlias: "",
                idpCode: "test",
                idpId: `${label}-${randomUUID()}`,
                status: "normal",
            })
            const playerId = playerDomain.insertDefaultPlayerSync(account.id).id
            const viewerId = nextViewerId++
            await insertSessionWithToken({
                token: String(viewerId),
                accountId: account.id,
                expires: new Date("2099-01-01T00:00:00.000Z"),
                type: SessionType.VIEWER,
            })
            return { playerId, viewerId }
        }

        function makeCharacterBaseReady(playerId) {
            characterDomain.insertDefaultPlayerCharacterSync(playerId, AWAKE_CHARACTER_ID)
            const character = characterAssets.getCharacterDataSync(AWAKE_CHARACTER_ID)
            characterDomain.updatePlayerCharacterSync(playerId, AWAKE_CHARACTER_ID, {
                exp: characterExpCaps[character.rarity][0],
            })
            characterDomain.insertPlayerCharacterManaNodesSync(
                playerId,
                AWAKE_CHARACTER_ID,
                Object.keys(characterAssets.getCharacterManaNodesSync(AWAKE_CHARACTER_ID, 1))
                    .map(Number),
            )
        }

        function prepareForManaUnlock(playerId, totalManaObtained) {
            makeCharacterBaseReady(playerId)
            if (characterDomain.getPlayerCharacterSync(playerId, 1) === null) {
                characterDomain.insertDefaultPlayerCharacterSync(playerId, 1)
            }
            missionDomain.updatePlayerCategoryMissionSync(playerId, 9, 2630021, 3)
            missionDomain.updatePlayerCategoryMissionSync(playerId, 9, 2630023, 1)
            playerDomain.updatePlayerSync({ id: playerId, totalManaObtained })
        }

        function prepareForStoryUnlock(playerId) {
            makeCharacterBaseReady(playerId)
            missionDomain.updatePlayerCategoryMissionSync(
                playerId,
                9,
                2630022,
                AWAKE_MANA_THRESHOLD,
            )
            missionDomain.updatePlayerCategoryMissionSync(playerId, 9, 2630023, 1)
            for (const questId of CHARACTER_QUEST_IDS.slice(0, 2)) {
                questDomain.insertPlayerQuestProgressSync(playerId, 3, {
                    questId,
                    finished: true,
                    clearRank: 5,
                })
            }
        }

        function awakeUnlock(playerId) {
            return awakeDomain.getPlayerCharacterAwakeUnlocksSync(playerId)
                .get(String(AWAKE_CHARACTER_ID))
        }

        function awakeCharacter(characterList) {
            return characterList?.find(character => (
                character.character_id === AWAKE_CHARACTER_ID
            ))
        }

        async function post(prefix, route, payload) {
            const response = await app.inject({ method: "POST", url: `${prefix}/${route}`, payload })
            return { response, body: decodeResponse(response) }
        }

        function singleFinishPayload(viewerId, playId, characterId = AWAKE_CHARACTER_ID) {
            return {
                viewer_id: viewerId,
                api_count: 1,
                play_id: playId,
                quest_id: MAIN_QUEST_ID,
                category: 1,
                score: 123456,
                elapsed_time_ms: 1000,
                add_mana: 1,
                is_accomplished: true,
                is_restored: false,
                continue_count: 0,
                statistics: {
                    clear_phase: 1,
                    max_combo_count: 30,
                    zones: [{
                        use_power_flip_count: 5,
                        use_dash_count: 5,
                        use_skill_count: 5,
                        damage_deal_total: 1000,
                        members: [{ origin_damage: 1000 }, null, null],
                    }],
                    party: {
                        characters: [{ id: characterId }, null, null],
                        unison_characters: [null, null, null],
                        equipments: [null, null, null],
                        ability_soul_ids: [null, null, null],
                    },
                },
            }
        }

        function multiFinishBody(viewerId, playId, characterId) {
            return {
                add_mana: 1,
                api_count: 2,
                category: MULTI_QUEST.category,
                continue_count: 0,
                elapsed_time_ms: 1000,
                is_accomplished: true,
                mate_player_result: [],
                play_id: playId,
                quest_id: MULTI_QUEST.questId,
                room_number: "123456",
                score: 0,
                statistics: {
                    clear_phase: 1,
                    max_combo_count: 0,
                    party: {
                        ability_soul_ids: [null, null, null],
                        characters: [{ id: characterId }, null, null],
                        equipments: [null, null, null],
                        unison_characters: [null, null, null],
                    },
                    zones: [{ use_power_flip_count: 1 }],
                },
                viewer_id: viewerId,
            }
        }

        function runMultiSettlement(playerId, viewerId, playId, characterId = AWAKE_CHARACTER_ID) {
            const activeQuest = {
                questId: MULTI_QUEST.questId,
                category: MULTI_QUEST.category,
                useBossBoostPoint: false,
                useBoostPoint: false,
                isAutoStartMode: false,
                isMulti: true,
                coordinatorOrigin: "local",
                roomNumber: "123456",
                battleSessionId: "123e4567-e89b-42d3-a456-426614174099",
                playId,
                continueCount: 0,
            }
            insertActiveQuest(playerId, activeQuest)
            const body = multiFinishBody(viewerId, playId, characterId)
            const validation = validateMultiFinishRequest(body, activeQuest)
            if (!validation.ok) throw new Error(validation.message)
            const questData = characterAssets.getQuestFromCategorySync(
                MULTI_QUEST.category,
                MULTI_QUEST.questId,
            )
            if (!questData || !("rankPointReward" in questData)) {
                throw new Error("Awake owner fixture multi quest is missing")
            }
            return runMultiplayerSettlementOrchestration({
                activeQuest: activeQuests[playerId],
                body,
                finishValidation: validation,
                isRoomHost: true,
                playerId,
                questData,
            })
        }

        return {
            app,
            database,
            directory,
            previousDataDirectory,
            previousDatabaseDirectory,
            restoreContent,
            restoreTimeOffset,
            itemDomain,
            passCardDomain,
            playerDomain,
            missionDomain,
            questDomain,
            raidEventDomain,
            ACTIVE_MANA_REWARD,
            ACTIVE_MISSION_ID,
            AWAKE_CHARACTER_ID,
            AWAKE_MANA_THRESHOLD,
            CHARACTER_QUEST_IDS,
            MAIN_QUEST_ID,
            activeQuests,
            awakeCharacter,
            awakeUnlock,
            createAwakeRequestContext,
            createPlayer,
            insertActiveQuest,
            post,
            prepareForManaUnlock,
            prepareForStoryUnlock,
            runMultiSettlement,
            singleFinishPayload,
        }
    } catch (error) {
        if (app !== null) await app.close().catch(() => {})
        if (initialized) require("../../src/data").closeDatabase()
        restoreContent()
        restoreTimeOffset()
        fs.rmSync(directory, { recursive: true, force: true })
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
        if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
        else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
        throw error
    }
}

async function closeAwakeOwnerFactPublicationFixture(fixture) {
    const errors = []
    for (const cleanup of [
        async () => fixture.app?.close(),
        () => { for (const playerId of Object.keys(fixture.activeQuests)) delete fixture.activeQuests[playerId] },
        () => require("../../src/data").closeDatabase(),
        () => fixture.restoreContent?.(),
        () => fixture.restoreTimeOffset?.(),
        () => fs.rmSync(fixture.directory, { recursive: true, force: true }),
        () => {
            if (fixture.previousDataDirectory === undefined) delete process.env.DATA_DIR
            else process.env.DATA_DIR = fixture.previousDataDirectory
            if (fixture.previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
            else process.env.WDFP_DATABASE_DIR = fixture.previousDatabaseDirectory
        },
    ]) {
        try { await cleanup() } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Awake owner fixture cleanup failed")
}

module.exports = {
    ACTIVE_MANA_REWARD,
    ACTIVE_MISSION_ID,
    AWAKE_CHARACTER_ID,
    AWAKE_MANA_THRESHOLD,
    CHARACTER_QUEST_IDS,
    MAIN_QUEST_ID,
    closeAwakeOwnerFactPublicationFixture,
    createAwakeOwnerFactPublicationFixture,
}
