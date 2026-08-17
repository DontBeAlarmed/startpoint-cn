"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-reward-fixture-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { insertMailSync, MailType } = require("../src/data/domains/mail")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const mailRoutes = require("../src/routes/api/mail").default
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const CHARACTER_ID = 1
const EQUIPMENT_ID = 3010006
const ITEM_ID = 30005

let app
let database
let nextViewerId = 920000000
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
        subject: "fixture",
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

function decode(response) {
    return unpack(Buffer.from(response.body, "base64")).data
}

function historyCount(playerId) {
    return database.prepare(
        "SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?",
    ).get(playerId).count
}

function assertNoInternalRewardFields(value) {
    const serialized = JSON.stringify(value)
    for (const field of ["source", "isNew", "itemDeltas", "joined_character_id_list"]) {
        assert.equal(serialized.includes(`\"${field}\"`), false, serialized)
    }
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

test("single receive response fixture covers every standard and dedicated mail type", async () => {
    const fixtures = [
        { type: MailType.ITEM, typeId: ITEM_ID, field: "item_list", amount: 2 },
        { type: MailType.FREE_VMONEY, typeId: null, userField: "free_vmoney", playerField: "freeVmoney", amount: 3 },
        { type: MailType.CHARACTER, typeId: CHARACTER_ID, field: "character_list", amount: 1 },
        { type: MailType.EQUIPMENT, typeId: EQUIPMENT_ID, field: "equipment_list", amount: 1 },
        { type: MailType.FREE_MANA, typeId: null, userField: "free_mana", playerField: "freeMana", amount: 5 },
        { type: MailType.EXP_POOL, typeId: null, userField: "exp_pool", playerField: "expPool", amount: 6 },
        { type: MailType.PAID_VMONEY, typeId: null, userField: "vmoney", playerField: "vmoney", amount: 7 },
        { type: MailType.STAR_CRUMB, typeId: null, userField: "star_crumb", playerField: "starCrumb", amount: 8 },
        { type: MailType.BOND_TOKEN, typeId: null, userField: "bond_token", playerField: "bondToken", amount: 9 },
        { type: MailType.BOSS_BOOST_POINT, typeId: null, userField: "boss_boost_point", playerField: "bossBoostPoint", amount: 10 },
        { type: MailType.BOOST_POINT, typeId: null, userField: "boost_point", playerField: "boostPoint", amount: 11 },
        { type: MailType.RANK_POINT, typeId: null, userField: "rank_point", playerField: "rankPoint", amount: 12 },
    ]

    for (const fixture of fixtures) {
        const { playerId, viewerId } = await createPlayer(`single-${fixture.type}`)
        const playerBefore = getPlayerSync(playerId)
        const itemBefore = getPlayerItemSync(playerId, ITEM_ID) ?? 0
        const mailId = addMail(playerId, fixture.type, fixture.typeId, fixture.amount)
        const response = await app.inject({
            method: "POST",
            url: "/receive",
            payload: { viewer_id: viewerId, mail_id: mailId },
        })

        assert.equal(response.statusCode, 200, response.body)
        const result = decode(response)
        assert.equal(result.auto_sale_expired_mail, false)
        assert.equal(result.dispose_expired_mail, false)
        assert.equal(result.total_count, 1)
        assert.equal(result.mail_arrived, false)
        assert.equal(historyCount(playerId), 1)

        if (fixture.userField !== undefined) {
            assert.deepEqual(result.user_info, {
                [fixture.userField]: playerBefore[fixture.playerField] + fixture.amount,
            })
        } else if (fixture.type === MailType.ITEM) {
            assert.deepEqual(result.item_list, { [ITEM_ID]: itemBefore + fixture.amount })
        } else if (fixture.type === MailType.CHARACTER) {
            assert.equal(result.character_list.length, 1)
            assert.equal(result.character_list[0].character_id, CHARACTER_ID)
            assert.equal(result.character_list[0].stack, 1)
            const compensationIds = Object.keys(result.item_list)
            assert.equal(compensationIds.length, 1)
            assert.equal(result.item_list[compensationIds[0]], 1)
        } else {
            assert.deepEqual(result.equipment_list, [{
                equipment_id: EQUIPMENT_ID,
                protection: false,
                level: 1,
                enhancement_level: 0,
                stack: 0,
            }])
        }
        assertNoInternalRewardFields(result)
    }
})

test("receive_all response fixture preserves mixed ordering, dedupe, and final inventories", async () => {
    const { playerId, viewerId } = await createPlayer("mixed-batch")
    const playerBefore = getPlayerSync(playerId)
    const characterBefore = getPlayerCharactersSync(playerId)[CHARACTER_ID]
    const itemBefore = getPlayerItemSync(playerId, ITEM_ID) ?? 0
    const mails = [
        [MailType.ITEM, ITEM_ID, 2],
        [MailType.FREE_VMONEY, null, 3],
        [MailType.CHARACTER, CHARACTER_ID, 3],
        [MailType.EQUIPMENT, EQUIPMENT_ID, 2],
        [MailType.FREE_MANA, null, 5],
        [MailType.EXP_POOL, null, 6],
        [MailType.PAID_VMONEY, null, 7],
        [MailType.STAR_CRUMB, null, 8],
        [MailType.BOND_TOKEN, null, 9],
        [MailType.BOSS_BOOST_POINT, null, 10],
        [MailType.BOOST_POINT, null, 11],
        [MailType.RANK_POINT, null, 12],
        [MailType.ITEM, ITEM_ID, 13],
    ]
    const mailIds = mails.map(([type, typeId, amount]) => addMail(playerId, type, typeId, amount))

    const response = await app.inject({
        method: "POST",
        url: "/receive_all",
        payload: { viewer_id: viewerId, mail_ids: [...mailIds, mailIds[0]] },
    })

    assert.equal(response.statusCode, 200, response.body)
    const result = decode(response)
    assert.deepEqual(result.mail_ids, mailIds)
    assert.equal(result.already_mail_count, 0)
    assert.equal(result.auto_sale_expired_mail_count, 0)
    assert.equal(result.deleted_mail_count, 0)
    assert.equal(result.dispose_expired_mail_count, 0)
    assert.deepEqual(result.ex_boost_item_list, [])
    assert.equal(result.max_overed_mail_count, 0)
    assert.equal(result.outdated_mail_count, 0)
    assert.equal(result.total_count, mails.length)
    assert.equal(result.mail_arrived, false)
    assert.deepEqual(result.user_info, {
        free_vmoney: playerBefore.freeVmoney + 3,
        free_mana: playerBefore.freeMana + 5,
        exp_pool: playerBefore.expPool + 6,
        vmoney: playerBefore.vmoney + 7,
        star_crumb: playerBefore.starCrumb + 8,
        bond_token: playerBefore.bondToken + 9,
        boss_boost_point: playerBefore.bossBoostPoint + 10,
        boost_point: playerBefore.boostPoint + 11,
        rank_point: playerBefore.rankPoint + 12,
    })
    assert.equal(result.character_list.length, 1)
    assert.equal(result.character_list[0].character_id, CHARACTER_ID)
    assert.equal(result.character_list[0].stack, characterBefore.stack + 3)
    assert.deepEqual(result.equipment_list, [{
        equipment_id: EQUIPMENT_ID,
        protection: false,
        level: 1,
        enhancement_level: 0,
        stack: 1,
    }])
    assert.equal(result.item_list[ITEM_ID], itemBefore + 15)
    const compensationId = Object.keys(result.item_list).find(id => Number(id) !== ITEM_ID)
    assert.ok(compensationId)
    assert.equal(result.item_list[compensationId], getPlayerItemSync(playerId, Number(compensationId)))
    assert.equal(result.item_list[compensationId], 3)
    assert.equal(historyCount(playerId), mails.length)
    assertNoInternalRewardFields(result)
})
