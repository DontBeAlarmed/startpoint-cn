"use strict"

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const crypto = require("node:crypto")

const BOX_GACHA_ID = 99001
const BOX_CURRENCY_ITEM_ID = 999001
const BOX_REWARD_ITEM_ID = 10002

const awakeMissionTable = structuredClone(require("../../assets/mission_char_awake.json"))
awakeMissionTable[2630025] = structuredClone(awakeMissionTable[2630021])
awakeMissionTable[2630025][0][2] = "twitter_check"
const awakeMissionRewardTable = structuredClone(
    require("../../assets/mission_char_awake_reward.json"),
)
awakeMissionRewardTable[2630025] = structuredClone(awakeMissionRewardTable[2630021])
const focusedShopItems = Object.freeze({
    880001: {
        costs: [],
        rewards: [{ type: 3, id: 341005, count: 1 }],
        availableFrom: "2015-01-01 00:00:00",
        availableUntil: null,
        stock: 99,
        userCost: { type: 0, amount: 1 },
    },
    880002: {
        costs: [],
        rewards: [{ type: 3, id: 341006, count: 1 }],
        availableFrom: "2015-01-01 00:00:00",
        availableUntil: null,
        stock: 99,
        userCost: { type: 0, amount: 1 },
    },
})

const TABLE_OVERRIDES = Object.freeze({
    "box_gacha.json": {
        [BOX_GACHA_ID]: {
            itemId: BOX_CURRENCY_ITEM_ID,
            count: 10,
            availableCounts: { 1: 10 },
        },
    },
    "box_reward.json": {
        [BOX_GACHA_ID]: {
            1: {
                99001001: {
                    type: 3,
                    count: 5,
                    available: 10,
                    tier: 2,
                },
            },
        },
    },
    "box_gacha_box_settings.json": {
        [BOX_GACHA_ID]: {
            1: {
                requiredBoxId: null,
                resetKind: 0,
                resetLimit: null,
                availableFrom: "2010-01-01 00:00:00",
                availableUntil: "2199-12-31 23:59:59",
                closeKind: 1,
            },
        },
    },
    "event_item_shop.json": { 4: { 999: focusedShopItems } },
    "event_item_shop_id_map.json": {
        880001: { eventType: 4, eventId: 999 },
        880002: { eventType: 4, eventId: 999 },
    },
    "general_shop.json": focusedShopItems,
    "mission_char_awake.json": awakeMissionTable,
    "mission_char_awake_reward.json": awakeMissionRewardTable,
})

function decodeResponse(response) {
    if (!String(response.headers["content-type"]).includes("application/x-msgpack")) {
        return JSON.parse(response.body)
    }
    return unpack(Buffer.from(response.body, "base64"))
}

async function createAwakeOwnerFocusedRouteFixture() {
    const app = Fastify({ logger: false })
    const { registerCnMsgpackOnSend } = require("../../src/routes/cn/msgpack")
    registerCnMsgpackOnSend(app)
    for (const [prefix, modulePath] of [
        ["/box-gacha", "../../src/routes/api/boxGacha"],
        ["/character", "../../src/routes/api/character"],
        ["/bond", "../../src/routes/api/character/bond"],
        ["/mana", "../../src/routes/api/character/mana"],
        ["/exchange", "../../src/routes/api/exchange"],
        ["/gacha", "../../src/routes/api/gacha"],
        ["/item", "../../src/routes/api/item"],
        ["/mail", "../../src/routes/api/mail"],
        ["/mission", "../../src/routes/api/mission"],
        ["/shop", "../../src/routes/api/shop"],
        ["/tutorial", "../../src/routes/api/tutorial"],
    ]) {
        await app.register(require(modulePath).default, { prefix })
    }
    await app.ready()
    return {
        app,
        async post(prefix, route, payload) {
            const response = await app.inject({
                method: "POST",
                url: `${prefix}/${route}`,
                payload,
            })
            return { response, body: decodeResponse(response) }
        },
    }
}

function installDeterministicRandomInt() {
    const original = crypto.randomInt
    crypto.randomInt = (min, max, callback) => {
        let lower = min
        let cb = callback
        if (typeof max === "function") {
            cb = max
            lower = 0
        } else if (max === undefined) {
            lower = 0
        }
        if (typeof cb === "function") {
            queueMicrotask(() => cb(null, lower))
            return undefined
        }
        return lower
    }
    return () => { crypto.randomInt = original }
}

module.exports = {
    BOX_CURRENCY_ITEM_ID,
    BOX_GACHA_ID,
    BOX_REWARD_ITEM_ID,
    TABLE_OVERRIDES,
    createAwakeOwnerFocusedRouteFixture,
    installDeterministicRandomInt,
}
