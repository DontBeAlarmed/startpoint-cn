require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "forced-news-delivery-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = dataDirectory

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    hasForcedNewsDeliverySync,
    claimForcedNewsDeliverySync,
} = require("../src/data/domains/news")
const {
    getPlayerOptionsSync,
    updatePlayerOptionsSync,
} = require("../src/data/domains/option")

try {
    initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "forced-news",
        idpCode: "test",
        idpId: "forced-news-player",
        status: "normal",
    })
    const player = insertDefaultPlayerSync(account.id)
    const clientOptionsBefore = getPlayerOptionsSync(player.id)

    assert.equal(hasForcedNewsDeliverySync(player.id, 1), false)
    assert.equal(claimForcedNewsDeliverySync(player.id, 1), true)
    assert.equal(hasForcedNewsDeliverySync(player.id, 1), true)
    assert.deepEqual(
        getPlayerOptionsSync(player.id),
        clientOptionsBefore,
        "服务端公告标记不能下发客户端",
    )
    updatePlayerOptionsSync(player.id, { "server.forced_news.2": true })
    assert.equal(
        hasForcedNewsDeliverySync(player.id, 2),
        false,
        "客户端选项写入不能伪造服务端公告状态",
    )
    assert.equal(
        claimForcedNewsDeliverySync(player.id, 1),
        false,
        "同一玩家同一公告只能领取一次",
    )
} finally {
    const database = getDb()
    if (database.open) database.close()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
}

console.log("forced news delivery tests passed")
