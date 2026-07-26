require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const fs = require("node:fs")
const { pack, unpack } = require("msgpackr")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tutorial-route-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const projectRoot = path.resolve(__dirname, "..")
const { BUNDLED_CDN_CATALOG_VERSION } = require("../src/content/constants")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")
const previousSnapshot = productionContentSnapshotProvider.snapshot
const tableCache = new Map()
productionContentSnapshotProvider.snapshot = {
    cdn: { targetVersion: BUNDLED_CDN_CATALOG_VERSION },
    repository: {
        info: () => ({
            source: "bundled",
            assetVersion: BUNDLED_CDN_CATALOG_VERSION,
            generatorVersion: 1,
            releaseDigest: null,
        }),
        table(tableName) {
            if (!tableCache.has(tableName)) {
                tableCache.set(tableName, require(path.join(projectRoot, "assets", tableName)))
            }
            return tableCache.get(tableName)
        },
    },
}

const { closeDatabase, initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerMailCountSync } = require("../src/data/domains/mail")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertPlayerTriggeredTutorialSync } = require("../src/data/domains/tutorial")
const { getClientSerializedData } = require("../src/data/utils/player-data")
const { givePlayerCharacterSync } = require("../src/lib/character")
const tutorialRoutes = require("../src/routes/api/tutorial").default

initializeDatabase()
const db = getDb()

function createPlayer(viewerId) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `tutorial-route-test-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    db.prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(viewerId), account.id, new Date("2099-12-31T23:59:59.000Z").toISOString(), 2)
    return playerId
}

function encodeRequest(body) {
    return pack(body).toString("base64")
}

function decodeResponse(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function updateStep(fastify, viewerId, body) {
    return fastify.inject({
        method: "POST",
        url: "/api/index.php/tutorial/update_step",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeRequest({
            viewer_id: viewerId,
            api_count: 1,
            statistics: {},
            skip: false,
            ...body,
        }),
    })
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
    await fastify.register(tutorialRoutes, { prefix: "/api/index.php/tutorial" })
    await fastify.ready()

    try {
        const viewerId = 800000201
        const playerId = createPlayer(viewerId)
        updatePlayerSync({ id: playerId, tutorialStep: 14, tutorialSkipFlag: false, freeVmoney: 1000 })

        db.exec(`
            CREATE TRIGGER fail_tutorial_receive_history
            BEFORE INSERT ON players_receive_history
            BEGIN
                SELECT RAISE(ABORT, 'forced tutorial failure');
            END
        `)
        const failedDraw = await updateStep(fastify, viewerId, { step: 14, gacha_id: 1 })
        assert.equal(failedDraw.statusCode, 500)
        assert.equal(getPlayerSync(playerId).tutorialStep, 14)
        assert.equal(getPlayerSync(playerId).freeVmoney, 1000)
        const awardedAfterFailure = db.prepare(`
            SELECT COUNT(*) AS count
            FROM players_characters
            WHERE player_id = ? AND id BETWEEN 251001 AND 251008
        `).get(playerId)
        assert.equal(awardedAfterFailure.count, 0)
        db.exec("DROP TRIGGER fail_tutorial_receive_history")

        const firstDraw = await updateStep(fastify, viewerId, { step: 14, gacha_id: 1 })
        assert.equal(firstDraw.statusCode, 200, firstDraw.body)
        const firstDrawData = decodeResponse(firstDraw).data
        const tutorialCharacterId = firstDrawData.gacha.draw[0].character_id
        const afterFirstDraw = getPlayerSync(playerId)
        assert.equal(afterFirstDraw.tutorialStep, 15)
        assert.equal(afterFirstDraw.tutorialGachaCharacterId, tutorialCharacterId)
        assert.equal(afterFirstDraw.freeVmoney, 850)

        const repeatedDraw = await updateStep(fastify, viewerId, { step: 14, gacha_id: 1 })
        assert.equal(repeatedDraw.statusCode, 200, repeatedDraw.body)
        const repeatedDrawData = decodeResponse(repeatedDraw).data
        assert.deepEqual(repeatedDrawData, firstDrawData)
        assert.equal(typeof repeatedDrawData.character_list[0].join_time, "string")
        assert.equal(typeof repeatedDrawData.character_list[0].update_time, "string")
        const afterRepeatedDraw = getPlayerSync(playerId)
        assert.equal(afterRepeatedDraw.tutorialStep, 15)
        assert.equal(afterRepeatedDraw.tutorialGachaCharacterId, tutorialCharacterId)
        assert.equal(afterRepeatedDraw.freeVmoney, 850)

        db.exec(`
            CREATE TRIGGER fail_tutorial_mail
            BEFORE INSERT ON players_mails
            BEGIN
                SELECT RAISE(ABORT, 'forced tutorial mail failure');
            END
        `)
        const failedPresent = await updateStep(fastify, viewerId, { step: 15 })
        assert.equal(failedPresent.statusCode, 500)
        assert.equal(getPlayerSync(playerId).tutorialStep, 15)
        assert.equal(getPlayerSync(playerId).freeVmoney, 850)
        assert.equal(getPlayerMailCountSync(playerId), 0)
        assert.equal(db.prepare(`
            SELECT COUNT(*) AS count
            FROM players_characters
            WHERE player_id = ? AND id = 243001
        `).get(playerId).count, 0)
        db.exec("DROP TRIGGER fail_tutorial_mail")

        const present = await updateStep(fastify, viewerId, { step: 15 })
        assert.equal(present.statusCode, 200, present.body)
        const presentData = decodeResponse(present).data
        assert.equal(getPlayerSync(playerId).tutorialStep, 16)
        assert.equal(getPlayerSync(playerId).freeVmoney, 2350)
        assert.equal(getPlayerMailCountSync(playerId), 1)

        const repeatedPresent = await updateStep(fastify, viewerId, { step: 15 })
        assert.equal(repeatedPresent.statusCode, 200, repeatedPresent.body)
        assert.deepEqual(decodeResponse(repeatedPresent).data, presentData)
        assert.equal(getPlayerSync(playerId).tutorialStep, 16)
        assert.equal(getPlayerSync(playerId).freeVmoney, 2350)
        assert.equal(getPlayerMailCountSync(playerId), 1)

        const finish = await updateStep(fastify, viewerId, { step: 16 })
        assert.equal(finish.statusCode, 200, finish.body)
        const finishData = decodeResponse(finish).data
        assert.equal(getPlayerSync(playerId).tutorialStep, null)

        const repeatedFinish = await updateStep(fastify, viewerId, { step: 16 })
        assert.equal(repeatedFinish.statusCode, 200, repeatedFinish.body)
        assert.deepEqual(decodeResponse(repeatedFinish).data, finishData)
        assert.equal(getPlayerSync(playerId).tutorialStep, null)

        updatePlayerSync({ id: playerId, tutorialStep: 17, tutorialSkipFlag: false })
        const legacyCompletedLoad = getClientSerializedData(playerId, { viewerId })
        assert.equal(legacyCompletedLoad.user_tutorial, null)

        const shortenedViewerId = 800000205
        const shortenedPlayerId = createPlayer(shortenedViewerId)
        updatePlayerSync({
            id: shortenedPlayerId,
            tutorialStep: 3,
            tutorialSkipFlag: true,
            freeVmoney: 1000,
        })
        const shortenedDraw = await updateStep(fastify, shortenedViewerId, {
            step: 3,
            skip: true,
            gacha_id: 1,
        })
        assert.equal(shortenedDraw.statusCode, 200, shortenedDraw.body)
        assert.equal(decodeResponse(shortenedDraw).data.step, 15)
        assert.equal(getPlayerSync(shortenedPlayerId).tutorialStep, 4)
        const shortenedPresent = await updateStep(fastify, shortenedViewerId, {
            step: 4,
            skip: true,
        })
        assert.equal(shortenedPresent.statusCode, 200, shortenedPresent.body)
        assert.equal(decodeResponse(shortenedPresent).data.step, 16)
        assert.equal(getPlayerSync(shortenedPlayerId).tutorialStep, 5)
        const shortenedFinish = await updateStep(fastify, shortenedViewerId, {
            step: 5,
            skip: true,
        })
        assert.equal(shortenedFinish.statusCode, 200, shortenedFinish.body)
        assert.equal(getPlayerSync(shortenedPlayerId).tutorialStep, null)
        updatePlayerSync({
            id: shortenedPlayerId,
            tutorialStep: 6,
            tutorialSkipFlag: true,
        })
        assert.equal(
            getClientSerializedData(shortenedPlayerId, { viewerId: shortenedViewerId }).user_tutorial,
            null,
        )

        const earlyTriggeredViewerId = 800000202
        const earlyTriggeredPlayerId = createPlayer(earlyTriggeredViewerId)
        insertPlayerTriggeredTutorialSync(earlyTriggeredPlayerId, 12)
        const beginDespiteGuideMarker = await updateStep(fastify, earlyTriggeredViewerId, { step: 0 })
        assert.equal(beginDespiteGuideMarker.statusCode, 200, beginDespiteGuideMarker.body)
        assert.equal(getPlayerSync(earlyTriggeredPlayerId).tutorialStep, 1)
        const earlyTriggeredLoad = getClientSerializedData(earlyTriggeredPlayerId, {
            viewerId: earlyTriggeredViewerId,
        })
        assert.equal(earlyTriggeredLoad.user_tutorial.tutorial_step, 1)

        const nameViewerId = 800000206
        const namePlayerId = createPlayer(nameViewerId)
        updatePlayerSync({ id: namePlayerId, tutorialStep: 2, tutorialSkipFlag: false })
        const changedName = await updateStep(fastify, nameViewerId, {
            step: 2,
            name: "教程重试名",
        })
        assert.equal(changedName.statusCode, 200, changedName.body)
        const repeatedName = await updateStep(fastify, nameViewerId, {
            step: 2,
            name: "教程重试名",
        })
        assert.equal(repeatedName.statusCode, 200, repeatedName.body)
        assert.equal(decodeResponse(repeatedName).data.name, "教程重试名")

        const branchViewerId = 800000207
        const branchPlayerId = createPlayer(branchViewerId)
        updatePlayerSync({ id: branchPlayerId, tutorialStep: 4, tutorialSkipFlag: false })
        const switchedBranch = await updateStep(fastify, branchViewerId, {
            step: 4,
            skip: true,
        })
        assert.equal(switchedBranch.statusCode, 400)
        assert.equal(getPlayerSync(branchPlayerId).tutorialStep, 4)
        assert.equal(getPlayerSync(branchPlayerId).tutorialSkipFlag, false)

        const interruptedViewerId = 800000203
        const interruptedPlayerId = createPlayer(interruptedViewerId)
        updatePlayerSync({
            id: interruptedPlayerId,
            tutorialStep: 15,
            tutorialSkipFlag: false,
            tutorialGachaCharacterId: null,
        })
        const interruptedLoad = getClientSerializedData(interruptedPlayerId, {
            viewerId: interruptedViewerId,
        })
        assert.equal(getPlayerSync(interruptedPlayerId).tutorialStep, 14)
        assert.equal(interruptedLoad.user_tutorial.tutorial_step, 14)

        const awardedViewerId = 800000204
        const awardedPlayerId = createPlayer(awardedViewerId)
        updatePlayerSync({
            id: awardedPlayerId,
            tutorialStep: 15,
            tutorialSkipFlag: false,
            tutorialGachaCharacterId: null,
        })
        givePlayerCharacterSync(awardedPlayerId, 251001)
        const awardedLoad = getClientSerializedData(awardedPlayerId, { viewerId: awardedViewerId })
        assert.equal(getPlayerSync(awardedPlayerId).tutorialStep, 14)
        assert.equal(getPlayerSync(awardedPlayerId).tutorialGachaCharacterId, null)
        assert.equal(awardedLoad.user_tutorial.tutorial_step, 14)
        assert.equal(awardedLoad.tutorial_gacha, null)

        const duplicateViewerId = 800000208
        const duplicatePlayerId = createPlayer(duplicateViewerId)
        for (const characterId of [251001, 251002, 251003, 251004, 251005, 251006, 251007, 251008]) {
            givePlayerCharacterSync(duplicatePlayerId, characterId)
        }
        updatePlayerSync({
            id: duplicatePlayerId,
            tutorialStep: 14,
            tutorialSkipFlag: false,
            freeVmoney: 1000,
        })
        const duplicateDraw = await updateStep(fastify, duplicateViewerId, {
            step: 14,
            gacha_id: 1,
        })
        assert.equal(duplicateDraw.statusCode, 200, duplicateDraw.body)
        const duplicateDrawData = decodeResponse(duplicateDraw).data
        assert.equal(Object.keys(duplicateDrawData.item_list).length > 0, true)
        const repeatedDuplicateDraw = await updateStep(fastify, duplicateViewerId, {
            step: 14,
            gacha_id: 1,
        })
        assert.equal(repeatedDuplicateDraw.statusCode, 200, repeatedDuplicateDraw.body)
        assert.deepEqual(decodeResponse(repeatedDuplicateDraw).data, duplicateDrawData)
    } finally {
        await fastify.close()
    }
}

main().then(
    () => console.log("tutorial update-step tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
).finally(() => {
    if (db.open) closeDatabase()
    productionContentSnapshotProvider.snapshot = previousSnapshot
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})
