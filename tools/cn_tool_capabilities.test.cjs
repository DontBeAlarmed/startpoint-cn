"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("./test-workflow/bootstrap.cjs").bootstrap()

const projectRoot = path.resolve(__dirname, "..")
const previousDataDirectory = process.env.DATA_DIR
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cn-tool-capabilities-"))
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
const { createGiftSync, startGiftSync, stopGiftSync } = require("../src/data/domains/gift")
const { isGiftCodeEnabledSync } = require("../src/lib/gift-code/capability")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const cnToolRoutes = require("../src/routes/cn/tool").default
const cnLoadRoutes = require("../src/routes/cn/load").default

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), "utf8")
}

let app

async function loadCapability(viewerId) {
    const loadResponse = unpack(Buffer.from((await app.inject({
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
    })).body, "base64"))
    const checkResponse = unpack(Buffer.from((await app.inject({
        method: "POST",
        url: "/api/index.php/tool/check_enable_gift",
        payload: { viewer_id: viewerId },
    })).body, "base64"))
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
        idpId: "cn-tool-capabilities",
        status: "normal",
    })
    insertDefaultPlayerSync(account.id)
    await insertSessionWithToken({
        token: "934000001",
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

test("load and check share the runtime gift capability owner", async () => {
    const gift = createGiftSync({
        code: "tool-capability-code",
        note: null,
        rewards: [{ position: 0, type: 8, typeId: null, number: 1 }],
    })
    const active = startGiftSync(gift.id, gift.revision)
    assert.deepEqual(await loadCapability(934000001), {
        load: true,
        check: true,
        service: true,
    })

    stopGiftSync(active.id, active.revision)
    assert.deepEqual(await loadCapability(934000001), {
        load: false,
        check: false,
        service: false,
    })
})

test("capability wiring has no hardcoded false owner or cn-server stub", () => {
    const loadSource = readSource("src/routes/cn/load.ts")
    const toolSource = readSource("src/routes/cn/tool.ts")
    const serverSource = readSource("src/cn-server.ts")
    assert.doesNotMatch(loadSource, /d\.enable_gift\s*=\s*false/)
    assert.doesNotMatch(serverSource, /check_enable_gift/)
    assert.match(loadSource, /isGiftCodeEnabledSync\(\)/)
    assert.match(toolSource, /isGiftCodeEnabledSync\(\)/)
})
