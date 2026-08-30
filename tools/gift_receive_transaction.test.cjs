"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Sqlite = require("better-sqlite3")

const previousDataDirectory = process.env.DATA_DIR
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-receive-tx-"))
process.env.DATA_DIR = path.join(dataDirectory, "data")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    createGiftSync,
    startGiftSync,
    stopGiftSync,
} = require("../src/data/domains/gift")
const {
    getPlayerCharactersSync,
} = require("../src/data/domains/character")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { getPlayerEquipmentSync } = require("../src/data/domains/equipment")
const { getPlayerSync } = require("../src/data/domains/player")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { receiveGiftCodeSync } = require("../src/lib/gift-code/redemption")

const rewards = [
    { position: 0, type: 1, typeId: 1, number: 3 },
    { position: 1, type: 4, typeId: null, number: 5000 },
    { position: 2, type: 5, typeId: 111001, number: 1 },
    { position: 3, type: 6, typeId: 100001, number: 1 },
    { position: 4, type: 8, typeId: null, number: 700 },
    { position: 5, type: 9, typeId: null, number: 900 },
]
const expectedProjection = rewards.map(reward => ({
    type: reward.type,
    typeId: reward.typeId,
    position: reward.position,
    number: reward.number,
}))

function createActiveGift(code) {
    const gift = createGiftSync({ code, note: null, rewards })
    return startGiftSync(gift.id, gift.revision)
}

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `gift-tx-${label}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function state(playerId) {
    const player = getPlayerSync(playerId)
    return {
        player: {
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            expPool: player.expPool,
        },
        item: getPlayerItemSync(playerId, 1) ?? 0,
        characters: getPlayerCharactersSync(playerId),
        equipment: getPlayerEquipmentSync(playerId, 100001),
        redemptions: getDb().prepare(
            "SELECT * FROM players_gift_redemptions WHERE player_id = ?",
        ).all(playerId),
        history: getDb().prepare(
            "SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?",
        ).get(playerId).count,
    }
}

function redemption(giftId, playerId) {
    return getDb().prepare(`
        SELECT gift_id, player_id, reward_revision, reward_snapshot, redeemed_at
        FROM players_gift_redemptions
        WHERE gift_id = ? AND player_id = ?
    `).get(giftId, playerId)
}

test("invalid raw keys return 6101 before any grant or redemption write", () => {
    const playerId = createPlayer("invalid")
    const before = state(playerId)
    assert.deepEqual(receiveGiftCodeSync(playerId, 42), {
        resultCode: 6101,
        rewards: [],
    })
    assert.deepEqual(state(playerId), before)
})

test("redeems the exact active code atomically with a fixed-key snapshot and history", () => {
    const gift = createActiveGift("transaction-code")
    const playerId = createPlayer("exact")
    const before = state(playerId)
    const result = receiveGiftCodeSync(playerId, gift.code)
    assert.deepEqual(result, { resultCode: 1, rewards: expectedProjection })

    const saved = redemption(gift.id, playerId)
    assert.equal(saved.reward_revision, gift.rewardRevision)
    assert.equal(typeof saved.redeemed_at, "string")
    assert.equal(saved.reward_snapshot, JSON.stringify(rewards.map(reward => ({
        position: reward.position,
        type: reward.type,
        type_id: reward.typeId,
        number: reward.number,
    }))))
    assert.equal(getPlayerItemSync(playerId, 1), before.item + 3)
    assert.notEqual(getPlayerCharactersSync(playerId)[111001], undefined)
    assert.notEqual(getPlayerEquipmentSync(playerId, 100001), null)
    assert.equal(state(playerId).history, 6)

    assert.deepEqual(receiveGiftCodeSync(playerId, gift.code), {
        resultCode: 6104,
        rewards: [],
    })
})

test("exact lookups separate players and reject stopped definitions", () => {
    const shared = createActiveGift("transaction-shared")
    const first = createPlayer("shared-first")
    const second = createPlayer("shared-second")
    assert.equal(receiveGiftCodeSync(first, shared.code).resultCode, 1)
    assert.equal(receiveGiftCodeSync(second, shared.code).resultCode, 1)

    const stopped = createActiveGift("transaction-stopped")
    stopGiftSync(stopped.id, stopped.revision)
    const player = createPlayer("stopped")
    assert.deepEqual(receiveGiftCodeSync(player, stopped.code), {
        resultCode: 6103,
        rewards: [],
    })
    assert.equal(state(player).redemptions.length, 0)
})

test("concurrent requests grant the shared reward exactly once", async t => {
    const gift = createActiveGift("transaction-race")
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "gift-tx-race-account",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const Fastify = require("fastify")
    const { insertSessionWithToken } = require("../src/data/domains/session")
    const { SessionType } = require("../src/data/types")
    const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
    const giftRoutes = require("../src/routes/api/gift").default
    const { unpack } = require("msgpackr")
    await insertSessionWithToken({
        token: "932000001",
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    app.register(giftRoutes, { prefix: "/api/index.php/gift" })
    await app.ready()
    t.after(() => app.close())

    const responses = await Promise.all(["932000001", "932000001"].map(viewerId => app.inject({
        method: "POST",
        url: "/api/index.php/gift/receive",
        payload: { viewer_id: Number(viewerId), key: gift.code },
    })))
    const resultCodes = responses.map(response => {
        assert.equal(response.statusCode, 200, response.body)
        return unpack(Buffer.from(response.body, "base64")).data.result_code
    })
    assert.deepEqual(resultCodes.sort(), [1, 6104])
    assert.equal(getPlayerItemSync(playerId, 1), 3)
    assert.equal(redemption(gift.id, playerId).reward_snapshot.includes(`"number":3`), true)
})

test("reward-grant failure rolls back redemption, rewards, and receive history", async t => {
    const gift = createActiveGift("fail-grant")
    const playerId = createPlayer("fail-grant")
    const before = state(playerId)
    const database = getDb()
    database.exec(`
        CREATE TRIGGER fail_gift_owner_update
        BEFORE UPDATE ON players
        WHEN NEW.id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'forced gift reward failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER fail_gift_owner_update"))

    assert.throws(
        () => receiveGiftCodeSync(playerId, gift.code),
        error => error.code === "SQLITE_CONSTRAINT_TRIGGER",
    )
    assert.deepEqual(state(playerId), before)
})

test("receive-history failure rolls back the entire redemption transaction", async t => {
    const gift = createActiveGift("fail-history")
    const playerId = createPlayer("fail-history")
    const before = state(playerId)
    const database = getDb()
    database.exec(`
        CREATE TRIGGER fail_gift_receive_history
        BEFORE INSERT ON players_receive_history
        WHEN NEW.player_id = ${playerId}
        BEGIN
            SELECT RAISE(ABORT, 'forced gift history failure');
        END;
    `)
    t.after(() => database.exec("DROP TRIGGER fail_gift_receive_history"))

    assert.throws(
        () => receiveGiftCodeSync(playerId, gift.code),
        error => error.code === "SQLITE_CONSTRAINT_TRIGGER",
    )
    assert.deepEqual(state(playerId), before)
})

test("rejects unsafe gift authority values at redemption time", () => {
    const unsafeRevision = createActiveGift("unsafe-revision")
    getDb().prepare("UPDATE server_gift_codes SET revision = ? WHERE id = ?")
        .run("9007199254740993", unsafeRevision.id)
    assert.throws(
        () => receiveGiftCodeSync(createPlayer("unsafe-revision"), unsafeRevision.code),
        /Gift revision is invalid/,
    )

    const unsafeRewardRevision = createActiveGift("bad-reward-revision")
    getDb().prepare("UPDATE server_gift_codes SET reward_revision = ? WHERE id = ?")
        .run("9007199254740993", unsafeRewardRevision.id)
    assert.throws(
        () => receiveGiftCodeSync(
            createPlayer("unsafe-reward-revision"),
            unsafeRewardRevision.code,
        ),
        /Gift reward revision is invalid/,
    )
})

test("revalidates active reward rows at redemption time", () => {
    const gift = createActiveGift("corrupt-reward")
    getDb().prepare(`
        UPDATE server_gift_rewards
        SET type_id = 1
        WHERE gift_id = ? AND position = 1
    `).run(gift.id)
    const playerId = createPlayer("corrupt-reward")
    const before = state(playerId)
    assert.throws(
        () => receiveGiftCodeSync(playerId, gift.code),
        error => error.name === "GiftRewardValidationError",
    )
    assert.deepEqual(state(playerId), before)
})

test("commit ordering deterministically selects stop-first rejection or receive-first success", () => {
    const stopFirstGift = createActiveGift("stop-first")
    const stopFirstPlayer = createPlayer("stop-first")
    const liveDatabasePath = getDb().name
    const external = new Sqlite(liveDatabasePath)
    external.exec(`
        BEGIN IMMEDIATE;
        UPDATE server_gift_codes SET status = 'stopped' WHERE id = ${stopFirstGift.id};
        COMMIT;
    `)
    external.close()
    assert.equal(receiveGiftCodeSync(stopFirstPlayer, stopFirstGift.code).resultCode, 6103)

    const receiveFirstGift = createActiveGift("receive-first")
    const receiveFirstPlayer = createPlayer("receive-first")
    assert.equal(receiveGiftCodeSync(receiveFirstPlayer, receiveFirstGift.code).resultCode, 1)
    const secondExternal = new Sqlite(liveDatabasePath)
    secondExternal.exec(`
        BEGIN IMMEDIATE;
        UPDATE server_gift_codes SET status = 'stopped' WHERE id = ${receiveFirstGift.id};
        COMMIT;
    `)
    secondExternal.close()
    assert.equal(redemption(receiveFirstGift.id, receiveFirstPlayer).gift_id, receiveFirstGift.id)
})

test.after(() => {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test.before(() => {
    data.initializeDatabase()
})
