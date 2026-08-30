"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const previousDataDirectory = process.env.DATA_DIR
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-capability-"))
process.env.DATA_DIR = path.join(dataDirectory, "data")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const {
    getGiftSync,
    createGiftSync,
    startGiftSync,
    stopGiftSync,
} = require("../src/data/domains/gift")
const { isGiftCodeEnabledSync } = require("../src/lib/gift-code/capability")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const cnToolRoutes = require("../src/routes/cn/tool").default
const cnLoadRoutes = require("../src/routes/cn/load").default

let app
let player

function decode(response) {
    assert.equal(response.statusCode, 200, response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

async function loadCapability(viewerId) {
    const loadResponse = decode(await app.inject({
        method: "POST",
        url: "/api/index.php/load",
        payload: {
            device_id: viewerId,
            device_token: String(viewerId),
            keychain: viewerId,
            graphics_device_name: "test",
            platform_os_version: "test",
            storage_directory_path: "test",
            viewer_id: viewerId,
        },
    }))
    const checkResponse = decode(await app.inject({
        method: "POST",
        url: "/api/index.php/tool/check_enable_gift",
        payload: { viewer_id: viewerId },
    }))
    return {
        load: loadResponse.data.enable_gift,
        check: checkResponse.data.enable_gift,
        service: isGiftCodeEnabledSync(),
    }
}

test.before(async () => {
    data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "gift-capability",
        status: "normal",
    })
    player = insertDefaultPlayerSync(account.id)
    await insertSessionWithToken({
        token: "930000001",
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })

    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    app.register(cnToolRoutes, { prefix: "/api/index.php/tool" })
    app.register(cnLoadRoutes, {
        prefix: "/api/index.php",
        assetProvider: { mode: "client-owned" },
    })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("load and check capability exactly follow the active gift service", async () => {
    const viewerId = 930000001
    const disabled = await loadCapability(viewerId)
    assert.deepEqual(disabled, { load: false, check: false, service: false })

    const created = createGiftSync({
        code: "capability-code",
        note: null,
        rewards: [{ position: 0, type: 1, typeId: 1, number: 1 }],
    })
    const active = startGiftSync(created.id, created.revision)
    assert.deepEqual(
        getGiftSync(created.id),
        { ...getGiftSync(created.id), status: "active", revision: created.revision + 1 },
    )
    const enabled = await loadCapability(viewerId)
    assert.deepEqual(enabled, { load: true, check: true, service: true })

    stopGiftSync(active.id, active.revision)
    const stopped = await loadCapability(viewerId)
    assert.deepEqual(stopped, { load: false, check: false, service: false })
})
