"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ex-boost-pending-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory
const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharacterSync, updatePlayerCharacterSync } = require("../src/data/domains/character")
const { givePlayerItemSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const { deserializeNumberList, serializeNumberList } = require("../src/data/utils")

async function createApp() {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    const routePath = require.resolve("../src/routes/api/exBoost")
    delete require.cache[routePath]
    await app.register(require(routePath).default, { prefix: "/ex" })
    await app.ready()
    return app
}

async function main() {
    assert.deepEqual(deserializeNumberList(serializeNumberList([])), [])
    data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `ex-pending-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 840000001
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    updatePlayerCharacterSync(playerId, 1, { overLimitStep: 6 })
    givePlayerItemSync(playerId, 10002, 1)

    const drawApp = await createApp()
    const drawResponse = await drawApp.inject({
        method: "POST",
        url: "/ex/draw",
        payload: { viewer_id: viewerId, character_id: 1, cost_item_id: 10002 },
    })
    assert.equal(drawResponse.statusCode, 200, drawResponse.body)
    await drawApp.close()

    const selectApp = await createApp()
    const selectResponse = await selectApp.inject({
        method: "POST",
        url: "/ex/select",
        payload: { viewer_id: viewerId, is_confirm: true },
    })
    assert.equal(selectResponse.statusCode, 200, selectResponse.body)
    assert.notEqual(getPlayerCharacterSync(playerId, 1).exBoost, undefined)
    await selectApp.close()

    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

main().then(
    () => console.log("ex boost pending draw tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
