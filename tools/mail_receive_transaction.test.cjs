"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-receive-transaction-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { insertMailSync, MailType } = require("../src/data/domains/mail")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const mailRoutes = require("../src/routes/api/mail").default
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

let database
let app
let nextViewerId = 910000000
let restoreContentSnapshot

async function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function addMail(playerId, type, typeId, number) {
    return insertMailSync(playerId, {
        reason_id: 0,
        subject: "transaction test",
        description: null,
        type,
        type_id: typeId,
        number,
        receive_time: "0000-00-00 00:00:00",
        create_time: "2026-07-28 00:00:00",
        reward_period_limited: 0,
        reward_limit_time: null,
    })
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

function mailState(mailId) {
    return database.prepare("SELECT receive_time FROM players_mails WHERE id = ?").get(mailId).receive_time
}

function receiveHistoryCount(playerId) {
    return database.prepare("SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?")
        .get(playerId).count
}

test.before(async () => {
    restoreContentSnapshot = installBundledGameplaySnapshot()
    database = data.initializeDatabase()
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    app.register(mailRoutes)
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("character mail uses the shared duplicate-character stack rules", async () => {
    const { playerId, viewerId } = await createPlayer("character")
    const characterId = Number(Object.keys(getPlayerCharactersSync(playerId))[0])
    const before = getPlayerCharactersSync(playerId)[characterId]
    const mailId = addMail(playerId, MailType.CHARACTER, characterId, 1)

    const response = await app.inject({
        method: "POST",
        url: "/receive",
        payload: { viewer_id: viewerId, mail_id: mailId },
    })
    assert.equal(response.statusCode, 200, response.body)
    const after = getPlayerCharactersSync(playerId)[characterId]
    assert.equal(after.stack, before.stack + 1)
    assert.equal(after.entryCount, before.entryCount)
    assert.notEqual(mailState(mailId), "0000-00-00 00:00:00")
    assert.equal(receiveHistoryCount(playerId), 1)
    assert.equal(Array.isArray(decode(response).data.character_list), true)
})

test("receive_all grants each requested mail id at most once", async () => {
    const { playerId, viewerId } = await createPlayer("duplicate-id")
    const itemId = 30005
    const before = getPlayerItemSync(playerId, itemId) ?? 0
    const mailId = addMail(playerId, MailType.ITEM, itemId, 3)

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: [mailId, mailId] },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(getPlayerItemSync(playerId, itemId), before + 3)
    assert.deepEqual(decode(response).data.mail_ids, [mailId])
    assert.equal(receiveHistoryCount(playerId), 1)
})

test("single receive rolls reward and history back when marking the mail fails", async t => {
    const { playerId, viewerId } = await createPlayer("single-rollback")
    const itemId = 30005
    const before = getPlayerItemSync(playerId, itemId) ?? 0
    const mailId = addMail(playerId, MailType.ITEM, itemId, 5)
    database.exec(`
        CREATE TRIGGER fail_single_mail_receive
        BEFORE UPDATE OF receive_time ON players_mails
        WHEN NEW.id = ${mailId}
        BEGIN
            SELECT RAISE(ABORT, 'forced mail receive failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS fail_single_mail_receive"))

    const response = await app.inject({
        method: "POST",
        url: "/receive",
        payload: { viewer_id: viewerId, mail_id: mailId },
    })
    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerItemSync(playerId, itemId) ?? 0, before)
    assert.equal(mailState(mailId), "0000-00-00 00:00:00")
    assert.equal(receiveHistoryCount(playerId), 0)
})

test("receive_all rolls every reward back when one mail cannot be marked", async t => {
    const { playerId, viewerId } = await createPlayer("batch-rollback")
    const itemId = 30005
    const before = getPlayerItemSync(playerId, itemId) ?? 0
    const firstMailId = addMail(playerId, MailType.ITEM, itemId, 2)
    const secondMailId = addMail(playerId, MailType.ITEM, itemId, 4)
    database.exec(`
        CREATE TRIGGER fail_batch_mail_receive
        BEFORE UPDATE OF receive_time ON players_mails
        WHEN NEW.id = ${secondMailId}
        BEGIN
            SELECT RAISE(ABORT, 'forced batch mail receive failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS fail_batch_mail_receive"))

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: [firstMailId, secondMailId] },
    })
    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerItemSync(playerId, itemId) ?? 0, before)
    assert.equal(mailState(firstMailId), "0000-00-00 00:00:00")
    assert.equal(mailState(secondMailId), "0000-00-00 00:00:00")
    assert.equal(receiveHistoryCount(playerId), 0)
})

test("unsupported attachments remain unreceived instead of being silently consumed", async () => {
    const { playerId, viewerId } = await createPlayer("unsupported")
    const mailId = addMail(playerId, MailType.DEGREE, 1001, 1)

    const response = await app.inject({
        method: "POST",
        url: "/receive",
        payload: { viewer_id: viewerId, mail_id: mailId },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(mailState(mailId), "0000-00-00 00:00:00")
    assert.equal(receiveHistoryCount(playerId), 0)
})
