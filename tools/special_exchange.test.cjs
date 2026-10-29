"use strict";

// 特殊交换所活动（special_exchange）回归：
// ① buy_ticket——有偿星导石（players.vmoney）扣费、自选券 + 对应十连券入包、status=2；
// ② 余额不足——带内 result_code 0 防御路径，余额与券不动；
// ③ exchange_character——券扣减、角色到账、status=3、load 回传列表；
// ④ 重复交换拒绝；
// ⑤ enter_campaign 幂等且不降级已购/已交换状态；
// ⑥ 交换目标不在该 campaign 的 lineup 内拒绝；
// ⑦ exchange_equipment 变体（campaign 12）。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "special-exchange-"))
process.env.WDFP_DATABASE_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({
        additionalTableNames: [
            "special_exchange_campaign.json",
            "special_exchange_campaign_character.json",
            "special_exchange_campaign_equipment.json",
        ],
    })

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getPlayerCharacterSync } = require("../src/data/domains/character")
const {
    getPlayerSpecialExchangeCampaignStatusSync,
    upsertPlayerSpecialExchangeCampaignStatusSync,
} = require("../src/data/domains/campaign")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")

function cleanup() {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    delete process.env.WDFP_DATABASE_DIR
}
process.once("exit", cleanup)

// 虚拟时间 2024-08-14：落在活跃 campaign 11（half_anniversary_2021，JST
// 2021-08-30 12:00 ~ 2099-01-01 11:59:59）与 12（half_anniversary_weapon_2021）
// 的 campaign/exchange 期内。
const { setServerTimeOffset } = require("../src/utils")
setServerTimeOffset(Date.parse("2024-08-14T12:00:00.000Z") - Date.now())
data.initializeDatabase()
const db = getDb()

const CAMPAIGN_CHARACTER = 11
const CAMPAIGN_EQUIPMENT = 12
const CHARACTER_TICKET = 999010
const EQUIPMENT_TICKET = 999011
const WILDCARD_CHARACTER_TEN = 999001
const WILDCARD_EQUIPMENT_TEN = 999004

let playerSeq = 0
async function createPlayer(label) {
    playerSeq += 1
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `special-exchange-${label}-${playerSeq}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 880000000 + playerSeq
    await insertSessionWithToken({
        token: String(viewerId), accountId: account.id,
        expires: new Date("2099-01-01"), type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function buildFastify() {
    const fastify = Fastify({ logger: false })
    fastify.addContentTypeParser(
        "application/x-www-form-urlencoded", { parseAs: "string" },
        (_r, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    fastify.addHook("onSend", (_r, reply, payload, done) => {
        if (String(reply.getHeader("content-type") ?? "").includes("x-msgpack")) {
            done(null, pack(payload).toString("base64")); return
        }
        done(null, payload)
    })
    return fastify
}

async function withRoutes(run) {
    const fastify = buildFastify()
    const { default: specialExchangeRoutes } = require("../src/routes/api/specialExchange")
    await fastify.register(specialExchangeRoutes, { prefix: "/api/index.php/special_exchange" })
    await fastify.ready()
    try {
        return await run(fastify)
    } finally {
        await fastify.close()
    }
}

function post(fastify, url, payload) {
    return fastify.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
}
const decode = r => unpack(Buffer.from(r.body, "base64"))

// ---------- ① buy_ticket 成功路径 ----------

test("buy_ticket deducts paid vmoney, grants both tickets, and sets status 2", async () => {
    await withRoutes(async fastify => {
        const { playerId, viewerId } = await createPlayer("buy-ok")
        updatePlayerSync({ id: playerId, vmoney: 1500, freeVmoney: 77 })

        const entered = await post(fastify, "/api/index.php/special_exchange/enter_campaign", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })
        assert.equal(entered.statusCode, 200)
        const enteredBody = decode(entered)
        assert.deepEqual(enteredBody.data.special_exchange_campaign_list, [
            { campaign_id: CAMPAIGN_CHARACTER, status: 1 },
        ])

        const bought = await post(fastify, "/api/index.php/special_exchange/buy_ticket", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })
        assert.equal(bought.statusCode, 200)
        const body = decode(bought)
        assert.equal(body.data.user_info.vmoney, 0, "有偿星导石扣 1500")
        assert.equal(body.data.user_info.free_vmoney, 77, "免费余额不动")
        assert.equal(body.data.item_list[String(CHARACTER_TICKET)], 1, "自选券入包")
        assert.equal(body.data.item_list[String(WILDCARD_CHARACTER_TEN)], 1, "十连券入包")
        assert.deepEqual(body.data.special_exchange_campaign_list, [
            { campaign_id: CAMPAIGN_CHARACTER, status: 2 },
        ])
        assert.equal(body.data.mail_arrived, false)
        assert.equal(getPlayerSpecialExchangeCampaignStatusSync(playerId, CAMPAIGN_CHARACTER), 2)
    })
})

// ---------- ② 余额不足（防御路径） ----------

test("buy_ticket without paid vmoney fails in-band and changes nothing", async () => {
    await withRoutes(async fastify => {
        const { playerId, viewerId } = await createPlayer("buy-poor")
        updatePlayerSync({ id: playerId, vmoney: 1499, freeVmoney: 999999 })

        const response = await post(fastify, "/api/index.php/special_exchange/buy_ticket", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })
        assert.equal(response.statusCode, 200)
        const body = decode(response)
        assert.equal(body.data_headers.result_code, 0, "带内 result_code 0 防御路径")

        const player = getPlayerSync(playerId)
        assert.equal(player.vmoney, 1499, "拒绝时有偿余额不动")
        assert.equal(player.freeVmoney, 999999)
        assert.equal(getPlayerItemSync(playerId, CHARACTER_TICKET), null, "券不入包")
        assert.equal(getPlayerSpecialExchangeCampaignStatusSync(playerId, CAMPAIGN_CHARACTER), 0)
    })
})

// ---------- ③ exchange_character ----------

test("exchange_character grants the chosen character and sets status 3", async () => {
    await withRoutes(async fastify => {
        const { playerId, viewerId } = await createPlayer("exchange-char")
        updatePlayerSync({ id: playerId, vmoney: 1500 })
        await post(fastify, "/api/index.php/special_exchange/enter_campaign", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })
        await post(fastify, "/api/index.php/special_exchange/buy_ticket", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })

        const response = await post(fastify, "/api/index.php/special_exchange/exchange_character", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER, character_id: 111001,
        })
        assert.equal(response.statusCode, 200)
        const body = decode(response)
        assert.equal(body.data.character_list[0].character_id, 111001)
        assert.equal(body.data.item_list[String(CHARACTER_TICKET)], 0, "券清零")
        assert.deepEqual(body.data.special_exchange_campaign_list, [
            { campaign_id: CAMPAIGN_CHARACTER, status: 3 },
        ])
        assert.equal(getPlayerSpecialExchangeCampaignStatusSync(playerId, CAMPAIGN_CHARACTER), 3)
        assert.notEqual(getPlayerCharacterSync(playerId, 111001), null, "角色到账")

        // load 回传列表
        const { getClientSerializedData } = require("../src/data/utils/player-data")
        const clientData = getClientSerializedData(playerId, {})
        assert.ok(Array.isArray(clientData.special_exchange_campaign_list))
        assert.deepEqual(
            clientData.special_exchange_campaign_list.find(entry => entry.campaign_id === CAMPAIGN_CHARACTER),
            { campaign_id: CAMPAIGN_CHARACTER, status: 3 },
        )
    })
})

// ---------- ④ 重复交换拒绝 ----------

test("exchange after exchange is rejected", async () => {
    await withRoutes(async fastify => {
        const { playerId, viewerId } = await createPlayer("exchange-twice")
        updatePlayerSync({ id: playerId, vmoney: 1500 })
        await post(fastify, "/api/index.php/special_exchange/enter_campaign", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })
        await post(fastify, "/api/index.php/special_exchange/buy_ticket", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })
        const first = await post(fastify, "/api/index.php/special_exchange/exchange_character", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER, character_id: 111001,
        })
        assert.equal(first.statusCode, 200)

        const second = await post(fastify, "/api/index.php/special_exchange/exchange_character", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER, character_id: 111002,
        })
        assert.equal(second.statusCode, 400)
        assert.equal(getPlayerSpecialExchangeCampaignStatusSync(playerId, CAMPAIGN_CHARACTER), 3)
        assert.equal(getPlayerCharacterSync(playerId, 111002), null, "第二个角色未发放")
    })
})

// ---------- ⑤ enter_campaign 幂等 ----------

test("enter_campaign is idempotent and never downgrades later states", async () => {
    await withRoutes(async fastify => {
        const { playerId, viewerId } = await createPlayer("enter-idempotent")

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await post(fastify, "/api/index.php/special_exchange/enter_campaign", {
                viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
            })
            assert.equal(response.statusCode, 200)
            assert.deepEqual(decode(response).data.special_exchange_campaign_list, [
                { campaign_id: CAMPAIGN_CHARACTER, status: 1 },
            ])
        }
        assert.equal(getPlayerSpecialExchangeCampaignStatusSync(playerId, CAMPAIGN_CHARACTER), 1)

        // 模拟已购（status 2）后再进页：不得降级回 1
        upsertPlayerSpecialExchangeCampaignStatusSync(playerId, CAMPAIGN_CHARACTER, 2)
        const again = await post(fastify, "/api/index.php/special_exchange/enter_campaign", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })
        assert.equal(again.statusCode, 200)
        assert.deepEqual(decode(again).data.special_exchange_campaign_list, [
            { campaign_id: CAMPAIGN_CHARACTER, status: 2 },
        ])
    })
})

// ---------- ⑤b 礼物型（obtain_source==1）：enter 即发券（双审 P1 修复回归） ----------

test("gift campaign enter grants the ticket once and sets status 2", async () => {
    const { getTimeOffset, setServerTimeOffset } = require("../src/utils")
    const previousOffset = getTimeOffset()
    // campaign 1012（装备礼物，券 999006）窗口 2024-07-11 12:00 ~ 2024-08-01 23:59:59 JST
    setServerTimeOffset(Date.parse("2024-07-15T12:00:00Z") - Date.now())
    try {
        await withRoutes(async fastify => {
            const { playerId, viewerId } = await createPlayer("gift-enter")

            const first = await post(fastify, "/api/index.php/special_exchange/enter_campaign", {
                viewer_id: viewerId, campaign_id: 1012,
            })
            assert.equal(first.statusCode, 200)
            const firstData = decode(first).data
            assert.deepEqual(firstData.special_exchange_campaign_list, [
                { campaign_id: 1012, status: 2 },
            ])
            const ticketsAfterFirst = getPlayerItemSync(playerId, 999006)
            assert.equal(ticketsAfterFirst, 1, "礼物券入包")
            assert.ok(firstData.item_list && Number(firstData.item_list["999006"]) >= 1,
                "响应带 item_list 片段")

            // 二次进入：不重复发券
            const second = await post(fastify, "/api/index.php/special_exchange/enter_campaign", {
                viewer_id: viewerId, campaign_id: 1012,
            })
            assert.equal(second.statusCode, 200)
            assert.deepEqual(decode(second).data.special_exchange_campaign_list, [
                { campaign_id: 1012, status: 2 },
            ])
            assert.equal(getPlayerItemSync(playerId, 999006), ticketsAfterFirst, "不重复发券")
        })
    } finally {
        setServerTimeOffset(previousOffset)
    }
})

// ---------- ⑥ 非 lineup 角色 ----------

test("exchange rejects a character outside the campaign lineup", async () => {
    await withRoutes(async fastify => {
        const { playerId, viewerId } = await createPlayer("exchange-foreign")
        updatePlayerSync({ id: playerId, vmoney: 1500 })
        await post(fastify, "/api/index.php/special_exchange/enter_campaign", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })
        await post(fastify, "/api/index.php/special_exchange/buy_ticket", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER,
        })

        // 111007 属于 campaign 1 的 lineup，不在 campaign 11 中
        const response = await post(fastify, "/api/index.php/special_exchange/exchange_character", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_CHARACTER, character_id: 111007,
        })
        assert.equal(response.statusCode, 400)
        assert.equal(getPlayerSpecialExchangeCampaignStatusSync(playerId, CAMPAIGN_CHARACTER), 2)
        assert.equal(getPlayerItemSync(playerId, CHARACTER_TICKET), 1, "券未扣")
        assert.equal(getPlayerCharacterSync(playerId, 111007), null)
    })
})

// ---------- ⑦ exchange_equipment 变体 ----------

test("equipment campaign: buy_ticket grants equipment tickets and exchange_equipment works", async () => {
    await withRoutes(async fastify => {
        const { playerId, viewerId } = await createPlayer("exchange-equip")
        updatePlayerSync({ id: playerId, vmoney: 750 })

        const bought = await post(fastify, "/api/index.php/special_exchange/buy_ticket", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_EQUIPMENT,
        })
        assert.equal(bought.statusCode, 200)
        const boughtBody = decode(bought)
        assert.equal(boughtBody.data.user_info.vmoney, 0, "装备券售价 750")
        assert.equal(boughtBody.data.item_list[String(EQUIPMENT_TICKET)], 1)
        assert.equal(boughtBody.data.item_list[String(WILDCARD_EQUIPMENT_TEN)], 1)
        assert.deepEqual(boughtBody.data.special_exchange_campaign_list, [
            { campaign_id: CAMPAIGN_EQUIPMENT, status: 2 },
        ])

        const response = await post(fastify, "/api/index.php/special_exchange/exchange_equipment", {
            viewer_id: viewerId, campaign_id: CAMPAIGN_EQUIPMENT, equipment_id: 5020008,
        })
        assert.equal(response.statusCode, 200)
        const body = decode(response)
        assert.equal(body.data.equipment_list[0].equipment_id, 5020008)
        assert.equal(body.data.item_list[String(EQUIPMENT_TICKET)], 0)
        assert.deepEqual(body.data.special_exchange_campaign_list, [
            { campaign_id: CAMPAIGN_EQUIPMENT, status: 3 },
        ])
        assert.equal(getPlayerSpecialExchangeCampaignStatusSync(playerId, CAMPAIGN_EQUIPMENT), 3)
    })
})
