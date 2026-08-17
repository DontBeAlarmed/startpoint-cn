"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-reward-rollback-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { insertMailSync, MailType } = require("../src/data/domains/mail")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const mailRoutes = require("../src/routes/api/mail").default
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const ITEM_ID = 930001
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

let app
let database
let nextViewerId = 930000000
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
        subject: "rollback",
        description: null,
        type,
        type_id: typeId,
        number,
        receive_time: "0000-00-00 00:00:00",
        create_time: "2026-08-18 00:00:00",
        reward_period_limited: 0,
        reward_limit_time: null,
    })
}

function assertUnreceived(mailIds) {
    for (const mailId of mailIds) {
        const row = database.prepare("SELECT receive_time FROM players_mails WHERE id = ?").get(mailId)
        assert.equal(row.receive_time, "0000-00-00 00:00:00")
    }
}

function historyCount(playerId) {
    return database.prepare(
        "SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?",
    ).get(playerId).count
}

async function receiveAll(viewerId, mailIds) {
    return app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: mailIds },
    })
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

test("owner item write failure rolls the whole mail request back", async t => {
    const { playerId, viewerId } = await createPlayer("owner-write")
    const mailId = addMail(playerId, MailType.ITEM, ITEM_ID, 2)
    database.exec(`
        CREATE TRIGGER fail_mail_owner_item
        BEFORE INSERT ON players_items
        WHEN NEW.player_id = ${playerId} AND NEW.id = ${ITEM_ID}
        BEGIN
            SELECT RAISE(ABORT, 'forced owner item failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS fail_mail_owner_item"))

    const response = await receiveAll(viewerId, [mailId])

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), null)
    assertUnreceived([mailId])
    assert.equal(historyCount(playerId), 0)
})

test("dedicated late write failure rolls earlier standard rewards back", async t => {
    const { playerId, viewerId } = await createPlayer("dedicated-write")
    const itemMailId = addMail(playerId, MailType.ITEM, ITEM_ID, 2)
    const crumbMailId = addMail(playerId, MailType.STAR_CRUMB, null, 3)
    const before = getPlayerSync(playerId)
    database.exec(`
        CREATE TRIGGER fail_mail_dedicated_update
        BEFORE UPDATE OF star_crumb ON players
        WHEN NEW.id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'forced dedicated update failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS fail_mail_dedicated_update"))

    const response = await receiveAll(viewerId, [itemMailId, crumbMailId])

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), null)
    assert.equal(getPlayerSync(playerId).starCrumb, before.starCrumb)
    assertUnreceived([itemMailId, crumbMailId])
    assert.equal(historyCount(playerId), 0)
})

test("history failure rolls standard and dedicated rewards back", async t => {
    const { playerId, viewerId } = await createPlayer("history-write")
    const manaMailId = addMail(playerId, MailType.FREE_MANA, null, 5)
    const rankMailId = addMail(playerId, MailType.RANK_POINT, null, 7)
    const before = getPlayerSync(playerId)
    database.exec(`
        CREATE TRIGGER fail_mail_history
        BEFORE INSERT ON players_receive_history
        WHEN NEW.player_id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'forced history failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER IF EXISTS fail_mail_history"))

    const response = await receiveAll(viewerId, [manaMailId, rankMailId])

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerSync(playerId).freeMana, before.freeMana)
    assert.equal(getPlayerSync(playerId).rankPoint, before.rankPoint)
    assertUnreceived([manaMailId, rankMailId])
    assert.equal(historyCount(playerId), 0)
})

test("unknown character rolls every earlier batch reward back", async () => {
    const { playerId, viewerId } = await createPlayer("unknown-character")
    const itemMailId = addMail(playerId, MailType.ITEM, ITEM_ID, 2)
    const characterMailId = addMail(playerId, MailType.CHARACTER, 999999999, 1)

    const response = await receiveAll(viewerId, [itemMailId, characterMailId])

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), null)
    assertUnreceived([itemMailId, characterMailId])
    assert.equal(historyCount(playerId), 0)
})

test("owner currency overflow rolls earlier batch rewards back", async () => {
    const { playerId, viewerId } = await createPlayer("owner-overflow")
    updatePlayerSync({ id: playerId, freeVmoney: MAX_SAFE_INTEGER })
    const itemMailId = addMail(playerId, MailType.ITEM, ITEM_ID, 2)
    const beadsMailId = addMail(playerId, MailType.FREE_VMONEY, null, 1)

    const response = await receiveAll(viewerId, [itemMailId, beadsMailId])

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerSync(playerId).freeVmoney, MAX_SAFE_INTEGER)
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), null)
    assertUnreceived([itemMailId, beadsMailId])
    assert.equal(historyCount(playerId), 0)
})

test("dedicated currency overflow rejects the mixed batch without writes", async () => {
    const { playerId, viewerId } = await createPlayer("dedicated-overflow")
    updatePlayerSync({ id: playerId, vmoney: MAX_SAFE_INTEGER })
    const itemMailId = addMail(playerId, MailType.ITEM, ITEM_ID, 2)
    const paidMailId = addMail(playerId, MailType.PAID_VMONEY, null, 1)

    const response = await receiveAll(viewerId, [itemMailId, paidMailId])

    assert.equal(response.statusCode, 500)
    assert.equal(getPlayerSync(playerId).vmoney, MAX_SAFE_INTEGER)
    assert.equal(getPlayerItemSync(playerId, ITEM_ID), null)
    assertUnreceived([itemMailId, paidMailId])
    assert.equal(historyCount(playerId), 0)
})
