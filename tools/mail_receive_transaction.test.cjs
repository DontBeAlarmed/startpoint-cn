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
const BetterSqlite3 = require("better-sqlite3")
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
let sqlTrace = null

async function captureSql(operation) {
    const statements = []
    sqlTrace = statements
    try {
        return { result: await operation(), statements }
    } finally {
        sqlTrace = null
    }
}

function playerSnapshots(statements) {
    return statements.filter(statement => /^\s*SELECT\s+id,\s*stamina,[\s\S]*\bFROM\s+players\b/i.test(statement))
}

function nestedTransactionStatements(statements) {
    return statements.filter(statement => /^\s*(?:SAVEPOINT|RELEASE)\b/i.test(statement))
}

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

function addExpiredMail(playerId, type, typeId, number) {
    return insertMailSync(playerId, {
        reason_id: 0,
        subject: "expired transaction test",
        description: null,
        type,
        type_id: typeId,
        number,
        receive_time: "0000-00-00 00:00:00",
        create_time: "2020-01-01 00:00:00",
        reward_period_limited: 1,
        reward_limit_time: "2020-02-01 00:00:00",
    })
}

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

function mailState(mailId) {
    return database.prepare("SELECT receive_time FROM players_mails WHERE id = ?").get(mailId)?.receive_time ?? null
}

function receiveHistoryCount(playerId) {
    return database.prepare("SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?")
        .get(playerId).count
}

test.before(async () => {
    restoreContentSnapshot = installBundledGameplaySnapshot()
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: statement => {
                if (sqlTrace !== null) sqlTrace.push(statement)
            },
        }),
    })
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

test("single receive rejects an expired limited mail without granting its attachment", async () => {
    const { playerId, viewerId } = await createPlayer("expired-single")
    const itemId = 30005
    const before = getPlayerItemSync(playerId, itemId) ?? 0
    const mailId = addExpiredMail(playerId, MailType.ITEM, itemId, 3)

    const response = await app.inject({
        method: "POST",
        url: "/receive",
        payload: { viewer_id: viewerId, mail_id: mailId },
    })

    assert.equal(response.statusCode, 400, response.body)
    assert.equal(getPlayerItemSync(playerId, itemId) ?? 0, before)
    assert.equal(mailState(mailId), null)
    assert.equal(receiveHistoryCount(playerId), 0)
})

test("mail index deletes expired limited mails before pagination", async () => {
    const { playerId, viewerId } = await createPlayer("expired-index")
    const expiredMailId = addExpiredMail(playerId, MailType.ITEM, 30005, 2)
    const validMailId = addMail(playerId, MailType.ITEM, 30005, 4)

    const response = await app.inject({
        method: "POST",
        url: "/index",
        payload: { viewer_id: viewerId, current_page: 1 },
    })

    assert.equal(response.statusCode, 200, response.body)
    const result = decode(response).data
    assert.deepEqual(result.mail.map(mail => mail.id), [validMailId])
    assert.equal(result.total_count, 1)
    assert.equal(mailState(expiredMailId), null)
})

test("receive_all skips expired limited mails and grants remaining valid mails", async () => {
    const { playerId, viewerId } = await createPlayer("expired-batch")
    const itemId = 30005
    const before = getPlayerItemSync(playerId, itemId) ?? 0
    const expiredMailId = addExpiredMail(playerId, MailType.ITEM, itemId, 2)
    const validMailId = addMail(playerId, MailType.ITEM, itemId, 4)

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: [expiredMailId, validMailId] },
    })

    assert.equal(response.statusCode, 200, response.body)
    const result = decode(response).data
    assert.deepEqual(result.mail_ids, [validMailId])
    assert.equal(result.outdated_mail_count, 1)
    assert.equal(getPlayerItemSync(playerId, itemId), before + 4)
    assert.equal(mailState(expiredMailId), null)
    assert.equal(receiveHistoryCount(playerId), 1)
})

test("expired cleanup leaves already-received mail out of batch counts", async () => {
    const { playerId, viewerId } = await createPlayer("expired-already-received")
    const expiredMailId = addExpiredMail(playerId, MailType.ITEM, 30005, 2)
    database.prepare("UPDATE players_mails SET receive_time = ? WHERE id = ?")
        .run("2026-08-18 00:00:01", expiredMailId)

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: [expiredMailId] },
    })

    assert.equal(response.statusCode, 200, response.body)
    const result = decode(response).data
    assert.deepEqual(result.mail_ids, [])
    assert.equal(result.already_mail_count, 1)
    assert.equal(result.outdated_mail_count, 0)
    assert.notEqual(mailState(expiredMailId), null)
})

test("single receive owns one player snapshot without nested reward transaction SQL", async () => {
    const { playerId, viewerId } = await createPlayer("single-owner-sql")
    const mailId = addMail(playerId, MailType.ITEM, 30005, 2)

    const measured = await captureSql(() => app.inject({
        method: "POST",
        url: "/receive",
        payload: { viewer_id: viewerId, mail_id: mailId },
    }))

    assert.equal(measured.result.statusCode, 200, measured.result.body)
    assert.equal(playerSnapshots(measured.statements).length, 1, measured.statements.join("\n---\n"))
    assert.equal(nestedTransactionStatements(measured.statements).length, 2, measured.statements.join("\n---\n"))
    assert.equal(
        measured.statements.filter(statement => /SELECT \* FROM players_mails WHERE player_id = \?/i.test(statement)).length,
        0,
        measured.statements.join("\n---\n"),
    )
    assert.equal(
        measured.statements.filter(statement => /^\s*DELETE\s+FROM\s+players_mails\b/i.test(statement)).length,
        0,
        measured.statements.join("\n---\n"),
    )
})

test("receive_all reads one owner reward snapshot plus one bounded Awake player fact reread", async () => {
    const { playerId, viewerId } = await createPlayer("batch-owner-sql")
    const firstMailId = addMail(playerId, MailType.FREE_MANA, null, 2)
    const secondMailId = addMail(playerId, MailType.EXP_POOL, null, 3)
    const thirdMailId = addMail(playerId, MailType.FREE_VMONEY, null, 4)

    const measured = await captureSql(() => app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: [firstMailId, secondMailId, thirdMailId] },
    }))

    assert.equal(measured.result.statusCode, 200, measured.result.body)
    const playerSnapshotIndexes = measured.statements
        .map((statement, index) => playerSnapshots([statement]).length === 1 ? index : -1)
        .filter(index => index !== -1)
    const playerWriteIndexes = measured.statements
        .map((statement, index) => /^\s*UPDATE\s+players\s+SET\b/i.test(statement) ? index : -1)
        .filter(index => index !== -1)
    const mailWriteIndexes = measured.statements
        .map((statement, index) => /^\s*UPDATE\s+players_mails\s+SET\s+receive_time\b/i.test(statement) ? index : -1)
        .filter(index => index !== -1)
    const authoritativeWriteIndexes = [...playerWriteIndexes, ...mailWriteIndexes].sort((left, right) => left - right)

    assert.equal(playerSnapshotIndexes.length, 2, measured.statements.join("\n---\n"))
    assert.ok(playerWriteIndexes.length > 0, measured.statements.join("\n---\n"))
    assert.ok(mailWriteIndexes.length > 0, measured.statements.join("\n---\n"))
    assert.ok(playerSnapshotIndexes[0] < authoritativeWriteIndexes[0], measured.statements.join("\n---\n"))
    assert.ok(playerSnapshotIndexes[1] > authoritativeWriteIndexes.at(-1), measured.statements.join("\n---\n"))
    assert.equal(nestedTransactionStatements(measured.statements).length, 2, measured.statements.join("\n---\n"))
    assert.equal(
        measured.statements.filter(statement => /LIMIT \? OFFSET \?/i.test(statement)).length,
        0,
        measured.statements.join("\n---\n"),
    )
    assert.equal(
        measured.statements.filter(statement => /^\s*DELETE\s+FROM\s+players_mails\b/i.test(statement)).length,
        0,
        measured.statements.join("\n---\n"),
    )
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

test("receive_all keeps expired cleanup committed when reward settlement fails", async () => {
    const { playerId, viewerId } = await createPlayer("expired-batch-failure")
    const expiredMailId = addExpiredMail(playerId, MailType.ITEM, 30005, 2)
    const unsupportedMailId = addMail(playerId, MailType.DEGREE, 1001, 1)

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: [expiredMailId, unsupportedMailId] },
    })

    assert.equal(response.statusCode, 400, response.body)
    assert.equal(mailState(expiredMailId), null)
    assert.equal(mailState(unsupportedMailId), "0000-00-00 00:00:00")
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

test("receive_all keeps duplicate, missing, and already-received ID compatibility", async () => {
    const { playerId, viewerId } = await createPlayer("id-compatibility")
    const itemId = 30005
    const before = getPlayerItemSync(playerId, itemId) ?? 0
    const validMailId = addMail(playerId, MailType.ITEM, itemId, 3)
    const alreadyMailId = addMail(playerId, MailType.FREE_MANA, null, 4)
    database.prepare("UPDATE players_mails SET receive_time = ? WHERE id = ?")
        .run("2026-08-18 00:00:01", alreadyMailId)
    const missingMailId = alreadyMailId + 999999

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: {
            viewer_id: viewerId,
            mail_ids: [missingMailId, validMailId, validMailId, alreadyMailId],
        },
    })

    assert.equal(response.statusCode, 200, response.body)
    const result = decode(response).data
    assert.deepEqual(result.mail_ids, [validMailId])
    assert.equal(result.already_mail_count, 2)
    assert.equal(getPlayerItemSync(playerId, itemId), before + 3)
    assert.equal(receiveHistoryCount(playerId), 1)
})

test("unsupported attachment in a mixed batch rolls every valid mail back", async () => {
    const { playerId, viewerId } = await createPlayer("unsupported-mixed")
    const itemId = 30005
    const before = getPlayerItemSync(playerId, itemId) ?? 0
    const itemMailId = addMail(playerId, MailType.ITEM, itemId, 3)
    const unsupportedMailId = addMail(playerId, MailType.DEGREE, 1001, 1)

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: [itemMailId, unsupportedMailId] },
    })

    assert.equal(response.statusCode, 400, response.body)
    assert.equal(getPlayerItemSync(playerId, itemId) ?? 0, before)
    assert.equal(mailState(itemMailId), "0000-00-00 00:00:00")
    assert.equal(mailState(unsupportedMailId), "0000-00-00 00:00:00")
    assert.equal(receiveHistoryCount(playerId), 0)
})
