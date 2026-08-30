"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-gift-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { createGiftSync } = require("../src/data/domains/gift")
const { receiveGiftCodeSync } = require("../src/lib/gift-code/redemption")

let giftRoutes
try {
    giftRoutes = require("../src/routes/web_api/gift").default
} catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
}

let app
let paddedGift
let accountOne
let playerOne
let accountTwo
let playerTwo
let playerThree

const itemReward = { position: 0, type: 1, typeId: 1, number: 2 }
const beadsReward = { position: 1, type: 4, typeId: null, number: 10 }
const characterReward = { position: 2, type: 5, typeId: 1, number: 1 }
const equipmentReward = { position: 3, type: 6, typeId: 100001, number: 1 }
const manaReward = { position: 4, type: 8, typeId: null, number: 100 }
const expReward = { position: 5, type: 9, typeId: null, number: 250 }
const allRewards = [
    itemReward,
    beadsReward,
    characterReward,
    equipmentReward,
    manaReward,
    expReward,
]

function draft(code, rewards = allRewards, note = null) {
    return { code, note, rewards }
}

function json(response) {
    return JSON.parse(response.payload)
}

async function inject(method, url, payload) {
    return app.inject({ method, url, payload })
}

function insertInheritedRedemption(giftId, rewardRevision) {
    getDb().prepare(`
        INSERT INTO players_gift_redemptions (
            gift_id,
            player_id,
            reward_revision,
            reward_snapshot,
            redeemed_at,
            inherited_from_player_id
        ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        giftId,
        playerThree.id,
        rewardRevision,
        JSON.stringify([{ position: 0, type: 1, type_id: 1, number: 2 }]),
        "2026-08-30T02:00:00.000Z",
        playerOne.id,
    )
}

test.before(async () => {
    assert.equal(typeof giftRoutes, "function", "admin gift plugin should exist")
    data.initializeDatabase()

    accountOne = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "admin-gift-account-one",
        status: "normal",
    })
    playerOne = insertDefaultPlayerSync(accountOne.id)
    accountTwo = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "admin-gift-account-two",
        status: "normal",
    })
    playerTwo = insertDefaultPlayerSync(accountTwo.id)
    playerThree = insertDefaultPlayerSync(accountTwo.id)
    getDb().prepare("UPDATE players SET name = ? WHERE id = ?").run("Alice", playerOne.id)
    getDb().prepare("UPDATE players SET name = ? WHERE id = ?").run("Bob%_Match", playerTwo.id)
    getDb().prepare("UPDATE players SET name = ? WHERE id = ?").run("Carol", playerThree.id)

    app = Fastify({ logger: false })
    app.register(giftRoutes, { prefix: "/api/gifts" })
    await app.ready()
})

test.after(async () => {
    await app?.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test("creates, lists, and reads exact gift definitions", async () => {
    const createdResponse = await inject("POST", "/api/gifts", draft("  Case Key  "))
    assert.equal(createdResponse.statusCode, 201, createdResponse.payload)
    const created = json(createdResponse)
    paddedGift = created

    assert.equal(created.code, "  Case Key  ")
    assert.equal(created.status, "stopped")
    assert.equal(created.rewardRevision, 1)
    assert.equal(created.revision, 1)
    assert.equal(created.redemptionCount, 0)
    assert.deepEqual(created.rewards, allRewards)

    const duplicateResponse = await inject("POST", "/api/gifts", draft("  Case Key  "))
    assert.equal(duplicateResponse.statusCode, 409)
    assert.deepEqual(json(duplicateResponse), { error: "礼包 code 已存在" })

    const listResponse = await inject("GET", "/api/gifts?page=1&pageSize=100")
    assert.equal(listResponse.statusCode, 200, listResponse.payload)
    const listed = json(listResponse)
    assert.equal(listed.page, 1)
    assert.equal(listed.pageSize, 100)
    assert.equal(listed.totalCount, 1)
    assert.deepEqual(listed.rows, [created])

    const detailResponse = await inject("GET", `/api/gifts/${created.id}`)
    assert.equal(detailResponse.statusCode, 200)
    assert.deepEqual(json(detailResponse), created)
})

test("updates only stopped gifts with exact code and reward revisions", async () => {
    const editedResponse = await inject("PATCH", `/api/gifts/${paddedGift.id}`, {
        ...draft("  changed key  ", allRewards, "最新说明"),
        revision: paddedGift.revision,
    })
    assert.equal(editedResponse.statusCode, 200, editedResponse.payload)
    const edited = json(editedResponse)
    assert.equal(edited.code, "  changed key  ")
    assert.equal(edited.note, "最新说明")
    assert.equal(edited.revision, paddedGift.revision + 1)
    assert.equal(edited.rewardRevision, paddedGift.rewardRevision)

    const rewardEditedResponse = await inject("PATCH", `/api/gifts/${paddedGift.id}`, {
        ...draft("  changed key  ", [{ ...itemReward, number: 3 }], "最新说明"),
        revision: edited.revision,
    })
    assert.equal(rewardEditedResponse.statusCode, 200, rewardEditedResponse.payload)
    const rewardEdited = json(rewardEditedResponse)
    assert.equal(rewardEdited.rewardRevision, edited.rewardRevision + 1)

    const invalidResponse = await inject("PATCH", `/api/gifts/${paddedGift.id}`, {
        code: "invalid",
        note: null,
        rewards: [{ ...itemReward, number: 999999999 }],
        revision: rewardEdited.revision,
    })
    assert.equal(invalidResponse.statusCode, 400)
    assert.deepEqual(json(invalidResponse), { error: "礼包内容无效" })
})

test("protects active definitions and then stops them", async () => {
    const activeResponse = await inject("POST", `/api/gifts/${paddedGift.id}/start`, {
        revision: paddedGift.revision,
    })
    assert.equal(activeResponse.statusCode, 409, activeResponse.payload)

    const currentResponse = await inject("GET", `/api/gifts/${paddedGift.id}`)
    const current = json(currentResponse)
    const startedResponse = await inject("POST", `/api/gifts/${paddedGift.id}/start`, {
        revision: current.revision,
    })
    assert.equal(startedResponse.statusCode, 200, startedResponse.payload)
    const started = json(startedResponse)
    assert.equal(started.status, "active")
    assert.equal(started.revision, current.revision + 1)

    const activeEdit = await inject("PATCH", `/api/gifts/${paddedGift.id}`, {
        ...draft("blocked", [{ ...itemReward }]),
        revision: started.revision,
    })
    assert.equal(activeEdit.statusCode, 409)
    assert.equal(json(activeEdit).error, "礼包状态不允许该操作")

    const activeDelete = await inject(
        "DELETE",
        `/api/gifts/${paddedGift.id}?revision=${started.revision}`,
    )
    assert.equal(activeDelete.statusCode, 409)

    const stoppedResponse = await inject("POST", `/api/gifts/${paddedGift.id}/stop`, {
        revision: started.revision,
    })
    assert.equal(stoppedResponse.statusCode, 200, stoppedResponse.payload)
    const stopped = json(stoppedResponse)
    assert.equal(stopped.status, "stopped")
    assert.equal(stopped.revision, started.revision + 1)
    paddedGift = stopped
})

test("deletes stopped gifts with redemptions and allows the same code to be redeemed again", async () => {
    assert.equal(getDb().prepare(
        "SELECT status FROM server_gift_codes WHERE id = ?",
    ).get(paddedGift.id).status, "stopped")
    const restarted = json(await inject("POST", `/api/gifts/${paddedGift.id}/start`, {
        revision: paddedGift.revision,
    }))
    assert.equal(restarted.status, "active")
    paddedGift = restarted
    assert.equal(receiveGiftCodeSync(playerOne.id, paddedGift.code).resultCode, 1)
    const withRedemption = json(await inject("GET", `/api/gifts/${paddedGift.id}`))
    assert.equal(withRedemption.redemptionCount, 1)

    const stoppedAgain = json(await inject("POST", `/api/gifts/${paddedGift.id}/stop`, {
        revision: paddedGift.revision,
    }))
    assert.equal(stoppedAgain.status, "stopped")
    paddedGift = stoppedAgain

    const deletedResponse = await inject(
        "DELETE",
        `/api/gifts/${paddedGift.id}?revision=${paddedGift.revision}`,
    )
    assert.equal(deletedResponse.statusCode, 200, deletedResponse.payload)
    assert.deepEqual(json(deletedResponse), { ok: true })
    assert.equal(await inject("GET", `/api/gifts/${paddedGift.id}`).then(json).then(row => row.error), "礼包不存在")

    const recreatedResponse = await inject(
        "POST",
        "/api/gifts",
        draft(paddedGift.code, [{ ...itemReward }]),
    )
    assert.equal(recreatedResponse.statusCode, 201, recreatedResponse.payload)
    const recreated = json(recreatedResponse)
    const activatedResponse = await inject("POST", `/api/gifts/${recreated.id}/start`, {
        revision: recreated.revision,
    })
    assert.equal(activatedResponse.statusCode, 200, activatedResponse.payload)

    const redeemedAgain = receiveGiftCodeSync(playerOne.id, paddedGift.code)
    assert.equal(redeemedAgain.resultCode, 1)
    assert.deepEqual(redeemedAgain.rewards, [{ ...itemReward }])
    assert.equal(json(await inject("GET", `/api/gifts/${recreated.id}`)).redemptionCount, 1)
})

test("returns read-only redemption snapshots with inheritance metadata", async () => {
    const currentGiftId = getDb().prepare(
        "SELECT id FROM server_gift_codes WHERE code = ?",
    ).get(paddedGift.code).id
    insertInheritedRedemption(currentGiftId, 1)

    const response = await inject(
        "GET",
        `/api/gifts/${currentGiftId}/redemptions?page=1&pageSize=50`,
    )
    assert.equal(response.statusCode, 200, response.payload)
    const page = json(response)
    assert.equal(page.page, 1)
    assert.equal(page.pageSize, 50)
    assert.equal(page.totalCount, 2)
    assert.equal(page.rows.length, 2)

    const direct = page.rows.find(row => row.playerId === playerOne.id)
    assert.deepEqual(direct, {
        playerId: playerOne.id,
        accountId: accountOne.id,
        playerName: "Alice",
        redeemedAt: direct.redeemedAt,
        rewardRevision: 1,
        rewardSnapshot: [{ position: 0, type: 1, typeId: 1, number: 2 }],
        inherited: false,
        sourcePlayerId: null,
    })

    const inherited = page.rows.find(row => row.playerId === playerThree.id)
    assert.deepEqual(inherited, {
        playerId: playerThree.id,
        accountId: accountTwo.id,
        playerName: "Carol",
        redeemedAt: "2026-08-30T02:00:00.000Z",
        rewardRevision: 1,
        rewardSnapshot: [{ position: 0, type: 1, typeId: 1, number: 2 }],
        inherited: true,
        sourcePlayerId: playerOne.id,
    })
})

test("searches redemption records by name and exact numeric ids", async () => {
    const giftId = getDb().prepare(
        "SELECT id FROM server_gift_codes WHERE code = ?",
    ).get(paddedGift.code).id
    assert.equal(receiveGiftCodeSync(playerTwo.id, paddedGift.code).resultCode, 1)
    const url = (query) => `/api/gifts/${giftId}/redemptions?page=1&pageSize=50&q=${encodeURIComponent(query)}`

    const byPlayerId = json(await inject("GET", url(String(playerOne.id))))
    assert.deepEqual(byPlayerId.rows.map(row => row.playerId), [playerOne.id])
    const byAccountId = json(await inject("GET", url(String(accountOne.id))))
    assert.deepEqual(byAccountId.rows.map(row => row.accountId), [accountOne.id])

    const byNamePart = json(await inject("GET", url("li")))
    assert.deepEqual(byNamePart.rows.map(row => row.playerId), [playerOne.id])
    const byEscapedName = json(await inject("GET", url("Bob%_Match")))
    assert.deepEqual(byEscapedName.rows.map(row => row.playerId), [playerTwo.id])
    const literalPercent = json(await inject("GET", url("%")))
    assert.deepEqual(literalPercent.rows.map(row => row.playerId), [playerTwo.id])
    const repeatedWildcards = json(await inject("GET", url("%%")))
    assert.deepEqual(repeatedWildcards.rows, [])

    const pageSize = json(await inject("GET", `/api/gifts/${giftId}/redemptions?page=1&pageSize=1`))
    assert.equal(pageSize.totalCount, 3)
    assert.equal(pageSize.rows.length, 1)
})

test("rejects invalid ids, revisions, pagination, and unknown gifts", async () => {
    for (const pageSize of ["0", "101", "1.5", "abc"]) {
        const response = await inject("GET", `/api/gifts?page=1&pageSize=${pageSize}`)
        assert.equal(response.statusCode, 400, pageSize)
        assert.deepEqual(json(response), { error: "礼包内容无效" })
    }
    for (const page of ["0", "-1", "abc"]) {
        const response = await inject("GET", `/api/gifts?page=${page}&pageSize=20`)
        assert.equal(response.statusCode, 400, page)
    }

    const invalidBody = await inject("POST", "/api/gifts", null)
    assert.equal(invalidBody.statusCode, 400)
    const invalidRevision = await inject("POST", `/api/gifts/${paddedGift.id}/stop`, {
        revision: 0,
    })
    assert.equal(invalidRevision.statusCode, 400)
    const missing = await inject("GET", "/api/gifts/999999")
    assert.deepEqual(json(missing), { error: "礼包不存在" })
    const missingRedemptions = await inject(
        "GET",
        "/api/gifts/999999/redemptions?page=1&pageSize=50",
    )
    assert.equal(missingRedemptions.statusCode, 404)
})

test("accepts an omitted redemption search as an unfiltered page", async () => {
    const giftId = getDb().prepare(
        "SELECT id FROM server_gift_codes WHERE code = ?",
    ).get(paddedGift.code).id
    const response = await inject("GET", `/api/gifts/${giftId}/redemptions?page=2&pageSize=2`)
    assert.equal(response.statusCode, 200, response.payload)
    const page = json(response)
    assert.equal(page.page, 2)
    assert.equal(page.pageSize, 2)
    assert.equal(page.totalCount, 3)
    assert.equal(page.rows.length, 1)
})
