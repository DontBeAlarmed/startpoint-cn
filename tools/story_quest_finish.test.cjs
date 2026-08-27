"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "story-finish-db-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
let db
let restoreContentSnapshot = () => {}

function cleanup() {
    if (db?.open) db.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreContentSnapshot = installBundledGameplaySnapshot()

const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const { insertPlayerCharacterManaNodesSync, updatePlayerCharacterSync } = require("../src/data/domains/character")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getPlayerSingleQuestProgressSync } = require("../src/data/domains/quest")
const { getPlayerActiveMissionsSync } = require("../src/data/domains/mission")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const storyRoutes = require("../src/routes/api/storyQuest").default
const characterRoutes = require("../src/routes/api/character").default

async function createPlayer(sequence) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `story-finish-${sequence}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 810000000 + sequence
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function finish(app, viewerId, questId, pathName = "/story/finish", category = 1) {
    return app.inject({
        method: "POST",
        url: pathName,
        payload: {
            category,
            quest_id: questId,
            party_id: 1,
            viewer_id: viewerId,
            api_count: 1,
        },
    })
}

async function main() {
    db = initializeDatabase()
    const app = Fastify({ logger: false })
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    await app.register(storyRoutes, { prefix: "/story" })
    await app.register(characterRoutes, { prefix: "/character" })
    await app.ready()

    const direct = await createPlayer(1)
    const first = await finish(app, direct.viewerId, 2009007)
    assert.equal(first.statusCode, 200, first.body)
    const firstData = decode(first).data
    assert.equal(Array.isArray(firstData), false)
    assert.deepEqual(firstData.story_join_character_id_list, [10])
    assert.ok(firstData.character_list.some(character => character.character_id === 10))
    assert.deepEqual(firstData.item_list, {})
    assert.equal("items" in firstData, false)
    assert.ok(getPlayerCharacterSync(direct.playerId, 10))

    const repeated = await finish(app, direct.viewerId, 2009007)
    assert.equal(repeated.statusCode, 200, repeated.body)
    const repeatedData = decode(repeated).data
    assert.equal(Array.isArray(repeatedData), false)
    assert.deepEqual(repeatedData.story_join_character_id_list, [])
    assert.deepEqual(repeatedData.character_list, [])
    assert.equal(getPlayerCharacterSync(direct.playerId, 10).stack, 0)

    const ownedStoryCharacter = await createPlayer(7)
    const { givePlayerCharacterSync } = require("../src/lib/character")
    assert.ok(givePlayerCharacterSync(ownedStoryCharacter.playerId, 10)?.character)
    const { getCharacterDataSync, getCharacterManaNodesSync } = require("../src/lib/assets")
    const { characterExpCaps } = require("../src/lib/character")
    const ownedAsset = getCharacterDataSync(10)
    const ownedManaNodes = getCharacterManaNodesSync(10, 1)
    assert.ok(ownedAsset && ownedManaNodes)
    updatePlayerCharacterSync(
        ownedStoryCharacter.playerId,
        10,
        { exp: characterExpCaps[ownedAsset.rarity][0] },
    )
    insertPlayerCharacterManaNodesSync(
        ownedStoryCharacter.playerId,
        10,
        Object.keys(ownedManaNodes).map(Number),
    )
    const defaultStoryCharacter = getCharacterDataSync(1)
    const defaultStoryManaNodes = getCharacterManaNodesSync(1, 1)
    assert.ok(defaultStoryCharacter && defaultStoryManaNodes)
    updatePlayerCharacterSync(
        ownedStoryCharacter.playerId,
        1,
        { exp: characterExpCaps[defaultStoryCharacter.rarity][0] },
    )
    insertPlayerCharacterManaNodesSync(
        ownedStoryCharacter.playerId,
        1,
        Object.keys(defaultStoryManaNodes).map(Number),
    )
    for (const characterStoryQuestId of [101, 102]) {
        const response = await finish(
            app,
            ownedStoryCharacter.viewerId,
            characterStoryQuestId,
            "/story/finish",
            3,
        )
        assert.equal(response.statusCode, 200, response.body)
    }
    const awakeContextModule = require("../src/lib/mission/awake-best-effort-context")
    const originalCreateAwakeRequestContextBestEffort = awakeContextModule.createAwakeRequestContextBestEffort
    let observedCandidateCharacterIds
    awakeContextModule.createAwakeRequestContextBestEffort = (playerId, candidateCharacterIds) => {
        observedCandidateCharacterIds = [...candidateCharacterIds]
        return originalCreateAwakeRequestContextBestEffort(playerId, candidateCharacterIds)
    }
    const ownedStoryFinish = await finish(app, ownedStoryCharacter.viewerId, 2009007)
    awakeContextModule.createAwakeRequestContextBestEffort = originalCreateAwakeRequestContextBestEffort
    assert.equal(ownedStoryFinish.statusCode, 200, ownedStoryFinish.body)
    const ownedStoryData = decode(ownedStoryFinish).data
    const { createAwakeRequestContext } = require("../src/lib/mission/awake-request-context")
    const debugContext = createAwakeRequestContext({
        playerId: ownedStoryCharacter.playerId,
        candidateCharacterIds: [1],
    })
    assert.deepEqual(observedCandidateCharacterIds, [10])
    assert.deepEqual(
        debugContext.evaluate([1]).find(entry => entry.missionId === 11),
        { missionId: 11, progress: 2 },
    )
    assert.deepEqual(
        ownedStoryData.story_join_character_id_list,
        [],
        "already-owned story character must remain absent from the response grant list",
    )

    const characterEpisode = await createPlayer(5)
    const characterEpisodeFinish = await finish(
        app,
        characterEpisode.viewerId,
        101,
        "/story/finish",
        3,
    )
    assert.equal(characterEpisodeFinish.statusCode, 200, characterEpisodeFinish.body)
    const characterEpisodeData = decode(characterEpisodeFinish).data
    assert.deepEqual(
        characterEpisodeData.mission_info.filter(entry => (
            entry.mission_category_id === 1 && entry.mission_id === 23
        )),
        [{
            mission_category_id: 1,
            mission_id: 23,
            mission_reward_id: 23001,
        }],
        "普通角色故事任务必须在首次通关响应中完成并发奖",
    )
    assert.deepEqual(
        characterEpisodeData.active_mission_list.find(entry => entry.mission_id === 11010),
        {
            mission_id: 11010,
            progress_value: 1,
            stages: [{ stage: 1, received: false }],
        },
        "角色故事首次完成后必须在同一响应刷新成长任务",
    )
    assert.equal(getPlayerActiveMissionsSync(characterEpisode.playerId)[11010].progress, 1)

    const activeMissionRollback = await createPlayer(6)
    db.exec(`
        CREATE TRIGGER reject_story_active_mission
        BEFORE INSERT ON players_active_missions
        WHEN NEW.player_id = ${activeMissionRollback.playerId} AND NEW.id = 11010
        BEGIN
            SELECT RAISE(ABORT, 'forced story active mission failure');
        END;
    `)
    const failedActiveMission = await finish(
        app,
        activeMissionRollback.viewerId,
        101,
        "/story/finish",
        3,
    )
    assert.equal(failedActiveMission.statusCode, 500)
    assert.equal(getPlayerSingleQuestProgressSync(activeMissionRollback.playerId, 3, 101), null)
    assert.equal(getPlayerActiveMissionsSync(activeMissionRollback.playerId)[11010], undefined)
    db.exec("DROP TRIGGER reject_story_active_mission")

    const skipped = await createPlayer(2)
    const skipResponse = await finish(
        app,
        skipped.viewerId,
        10015003,
        "/story/finish_with_skip",
    )
    assert.equal(skipResponse.statusCode, 200, skipResponse.body)
    assert.deepEqual(decode(skipResponse).data.story_join_character_id_list, [213013])
    assert.ok(getPlayerCharacterSync(skipped.playerId, 213013))

    const town = await createPlayer(3)
    const prematureTownClaim = await app.inject({
        method: "POST",
        url: "/character/add_character_from_town",
        payload: { character_id: 512001, viewer_id: town.viewerId, api_count: 1 },
    })
    assert.equal(prematureTownClaim.statusCode, 400)

    const townUnlock = await finish(app, town.viewerId, 1008004)
    assert.equal(townUnlock.statusCode, 200, townUnlock.body)
    assert.deepEqual(decode(townUnlock).data.story_join_character_id_list, [])
    assert.equal(getPlayerCharacterSync(town.playerId, 512001), null)

    const townClaim = await app.inject({
        method: "POST",
        url: "/character/add_character_from_town",
        payload: { character_id: 512001, viewer_id: town.viewerId, api_count: 2 },
    })
    assert.equal(townClaim.statusCode, 200, townClaim.body)
    assert.ok(getPlayerCharacterSync(town.playerId, 512001))

    const duplicateTownClaim = await app.inject({
        method: "POST",
        url: "/character/add_character_from_town",
        payload: { character_id: 512001, viewer_id: town.viewerId, api_count: 3 },
    })
    assert.equal(duplicateTownClaim.statusCode, 400)
    assert.equal(getPlayerCharacterSync(town.playerId, 512001).stack, 0)

    const arbitraryTownClaim = await app.inject({
        method: "POST",
        url: "/character/add_character_from_town",
        payload: { character_id: 213013, viewer_id: town.viewerId, api_count: 4 },
    })
    assert.equal(arbitraryTownClaim.statusCode, 400)

    const rollback = await createPlayer(4)
    db.exec(`
        CREATE TRIGGER reject_story_progress
        BEFORE INSERT ON players_quest_progress
        WHEN NEW.player_id = ${rollback.playerId} AND NEW.quest_id = 10015003
        BEGIN
            SELECT RAISE(ABORT, 'forced story progress failure');
        END;
    `)
    const beforeEquipment = db.prepare(`
        SELECT COUNT(*) AS count FROM players_equipment
        WHERE player_id = ? AND id = 100010
    `).get(rollback.playerId).count
    const failed = await finish(app, rollback.viewerId, 10015003)
    assert.equal(failed.statusCode, 500)
    assert.equal(getPlayerCharacterSync(rollback.playerId, 213013), null)
    assert.equal(getPlayerSingleQuestProgressSync(rollback.playerId, 1, 10015003), null)
    const afterEquipment = db.prepare(`
        SELECT COUNT(*) AS count FROM players_equipment
        WHERE player_id = ? AND id = 100010
    `).get(rollback.playerId).count
    assert.equal(afterEquipment, beforeEquipment, "奖励和剧情角色必须随进度写入一起回滚")

    await app.close()
    cleanup()
    process.removeListener("exit", cleanup)
}

main().then(
    () => console.log("story quest finish tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
