"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-reward-owner-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const BetterSqlite3 = require("better-sqlite3")
const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCharactersSync } = require("../src/data/domains/character")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { MailType } = require("../src/data/domains/mail")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const CHARACTER_ID = 1
const EQUIPMENT_ID = 3010006
const ITEM_ID = 30005

let database
let restoreContentSnapshot
let sqlTrace = null

function captureSql(operation) {
    const statements = []
    sqlTrace = statements
    try {
        return { result: operation(), statements }
    } finally {
        sqlTrace = null
    }
}

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function mail(id, type, typeId, number) {
    return {
        id,
        player_id: 1,
        reason_id: 0,
        subject: null,
        description: null,
        type,
        type_id: typeId,
        number,
        receive_time: "0000-00-00 00:00:00",
        create_time: "2026-08-18 00:00:00",
        reward_period_limited: 0,
        reward_limit_time: null,
    }
}

function assertOwnerSql(statements) {
    assert.equal(
        statements.filter(statement => /^\s*SELECT[\s\S]*\bFROM\s+players\b/i.test(statement)).length,
        0,
        statements.join("\n---\n"),
    )
    assert.equal(
        statements.filter(statement => /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)).length,
        0,
        statements.join("\n---\n"),
    )
}

function historyCount(playerId) {
    return database.prepare(
        "SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?",
    ).get(playerId).count
}

test.before(() => {
    restoreContentSnapshot = installBundledGameplaySnapshot()
    database = data.initializeDatabase({
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: statement => {
                if (sqlTrace !== null) sqlTrace.push(statement)
            },
        }),
    })
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("single mail owner callback performs no player SELECT or transaction statement", () => {
    const { settleMailRewardsInTransactionOwnerSync } = require("../src/lib/mail-reward-grant")
    assert.equal(typeof settleMailRewardsInTransactionOwnerSync, "function")
    const playerId = createPlayer("single")
    const player = getPlayerSync(playerId)
    let measured

    database.transaction(() => {
        measured = captureSql(() => settleMailRewardsInTransactionOwnerSync(
            playerId,
            [mail(1, MailType.FREE_MANA, null, 5)],
            player,
        ))
    })()

    assertOwnerSql(measured.statements)
    assert.equal(
        measured.statements.some(statement => /^\s*UPDATE\s+players\s+SET\s+vmoney\b/i.test(statement)),
        false,
        measured.statements.join("\n---\n"),
    )
    assert.deepEqual(measured.result, {
        characterList: [],
        equipmentList: [],
        itemList: {},
        userInfo: { free_mana: player.freeMana + 5 },
    })
    assert.equal(historyCount(playerId), 1)
})

test("batch mail owner callback uses one snapshot and projects final mixed state", () => {
    const { settleMailRewardsInTransactionOwnerSync } = require("../src/lib/mail-reward-grant")
    assert.equal(typeof settleMailRewardsInTransactionOwnerSync, "function")
    const playerId = createPlayer("batch")
    const player = getPlayerSync(playerId)
    const itemBefore = getPlayerItemSync(playerId, ITEM_ID) ?? 0
    const characterBefore = getPlayerCharactersSync(playerId)[CHARACTER_ID]
    const mails = [
        mail(10, MailType.ITEM, ITEM_ID, 2),
        mail(11, MailType.FREE_VMONEY, null, 3),
        mail(12, MailType.CHARACTER, CHARACTER_ID, 3),
        mail(13, MailType.EQUIPMENT, EQUIPMENT_ID, 2),
        mail(14, MailType.FREE_MANA, null, 5),
        mail(15, MailType.EXP_POOL, null, 6),
        mail(16, MailType.PAID_VMONEY, null, 7),
        mail(17, MailType.STAR_CRUMB, null, 8),
        mail(18, MailType.BOND_TOKEN, null, 9),
        mail(19, MailType.BOSS_BOOST_POINT, null, 10),
        mail(20, MailType.BOOST_POINT, null, 11),
        mail(21, MailType.RANK_POINT, null, 12),
        mail(22, MailType.ITEM, ITEM_ID, 13),
    ]
    let measured

    database.transaction(() => {
        measured = captureSql(() => settleMailRewardsInTransactionOwnerSync(
            playerId,
            mails,
            player,
        ))
    })()

    assertOwnerSql(measured.statements)
    assert.deepEqual(measured.result.userInfo, {
        free_vmoney: player.freeVmoney + 3,
        free_mana: player.freeMana + 5,
        exp_pool: player.expPool + 6,
        vmoney: player.vmoney + 7,
        star_crumb: player.starCrumb + 8,
        bond_token: player.bondToken + 9,
        boss_boost_point: player.bossBoostPoint + 10,
        boost_point: player.boostPoint + 11,
        rank_point: player.rankPoint + 12,
    })
    assert.equal(measured.result.itemList[ITEM_ID], itemBefore + 15)
    const compensationId = Object.keys(measured.result.itemList).find(id => Number(id) !== ITEM_ID)
    assert.ok(compensationId)
    assert.equal(
        measured.result.itemList[compensationId],
        getPlayerItemSync(playerId, Number(compensationId)),
    )
    assert.equal(measured.result.itemList[compensationId], 3)
    assert.equal(measured.result.characterList.length, 1)
    assert.equal(measured.result.characterList[0].character_id, CHARACTER_ID)
    assert.equal(measured.result.characterList[0].stack, characterBefore.stack + 3)
    assert.equal(measured.result.equipmentList.length, 1)
    assert.equal(measured.result.equipmentList[0].equipment_id, EQUIPMENT_ID)
    assert.equal(measured.result.equipmentList[0].stack, 1)
    assert.equal(historyCount(playerId), mails.length)
    const serialized = JSON.stringify(measured.result)
    for (const field of ["source", "mailId", "attachmentIndex", "isNew", "itemDeltas", "joined_character_id_list"]) {
        assert.equal(serialized.includes(`\"${field}\"`), false, serialized)
    }
})
