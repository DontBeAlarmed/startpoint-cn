"use strict"

const assert = require("node:assert/strict")
const {
    postCnRequest,
    requireSuccessfulCnResponse,
} = require("./non_multi_mixed_http.cjs")

const GACHA_ID = 1638
const LOAD_RES_VERSION = "1.4.54"

function requireGachaState(context, identity, label) {
    if (typeof context.inspectGachaIdentity !== "function") {
        throw new TypeError("gacha scenario requires context.inspectGachaIdentity")
    }
    const state = context.inspectGachaIdentity(identity)
    for (const field of [
        "freeVmoney",
        "exchangePoint",
        "receiveHistoryCount",
        "characterCount",
        "partyCharacterReferenceCount",
        "activeMissionGachaCount",
    ]) {
        assert.ok(Number.isSafeInteger(state?.[field]) && state[field] >= 0, `${label} ${field}`)
    }
    return state
}

async function executeGachaScenario(app, identity, context = {}) {
    if (typeof context.prepareGachaIdentity !== "function") {
        throw new TypeError("gacha scenario requires context.prepareGachaIdentity")
    }
    if (!context.skipPrepare) context.prepareGachaIdentity(identity)
    const before = requireGachaState(context, identity, "gacha before")

    const loadResponse = await postCnRequest(app, "/api/index.php/load", {
        viewer_id: identity.viewerId,
        keychain: identity.viewerId,
        device_id: identity.deviceId,
        device_token: `performance-fixture-${identity.deviceId}`,
        graphics_device_name: "performance-fixture",
        platform_os_version: "test",
        storage_directory_path: "",
    }, { res_ver: LOAD_RES_VERSION })
    const loadPayload = requireSuccessfulCnResponse(loadResponse, "gacha load")
    assert.equal(loadPayload.data_headers?.viewer_id, identity.accountId)
    const loadGachaInfo = loadPayload.data?.gacha_info_list
    assert.ok(Array.isArray(loadGachaInfo), "gacha load gacha_info_list must be an array")

    const execResponse = await postCnRequest(app, "/api/index.php/gacha/exec", {
        viewer_id: identity.viewerId,
        gacha_id: GACHA_ID,
        payment_type: 1,
        number_of_exec: 1,
        type: 1,
        api_count: 1,
    })
    const execPayload = requireSuccessfulCnResponse(execResponse, "gacha exec")
    assert.equal(execPayload.data_headers?.viewer_id, identity.viewerId)
    const after = requireGachaState(context, identity, "gacha after")
    assert.equal(after.freeVmoney, before.freeVmoney - 150)
    assert.equal(after.exchangePoint, before.exchangePoint + 1)
    assert.equal(after.receiveHistoryCount, before.receiveHistoryCount + 1)
    assert.equal(before.characterCount, 0)
    assert.equal(after.characterCount, 1)
    assert.equal(before.partyCharacterReferenceCount, 0)
    assert.equal(after.partyCharacterReferenceCount, 0)
    assert.equal(before.activeMissionGachaCount, 0)
    assert.equal(after.activeMissionGachaCount, 1)

    const data = execPayload.data
    assert.ok(Array.isArray(data?.draw) && data.draw.length === 1, "gacha draw count")
    assert.ok(Array.isArray(data.character_list) && data.character_list.length === 1, "gacha character count")
    assert.ok(data.item_list !== null && typeof data.item_list === "object" && !Array.isArray(data.item_list))
    assert.ok(Array.isArray(data.gacha_info_list) && data.gacha_info_list.length === 1)
    assert.ok(Array.isArray(data.gacha_campaign_list))
    assert.ok(Array.isArray(data.encyclopedia_info))
    assert.equal(data.user_info?.free_vmoney, after.freeVmoney)
    assert.equal(data.gacha_info_list[0]?.gacha_id, GACHA_ID)
    assert.equal(data.gacha_info_list[0]?.gacha_exchange_point, after.exchangePoint)
    const draw = data.draw[0]
    assert.ok(draw !== null && typeof draw === "object" && !Array.isArray(draw), "gacha draw entry")
    assert.ok(Number.isSafeInteger(draw.character_id) && draw.character_id > 0, "gacha draw character_id")
    assert.ok(typeof draw.movie_id === "string" && draw.movie_id.length > 0, "gacha draw movie_id")
    assert.ok(Number.isSafeInteger(draw.seed) && draw.seed > 0, "gacha draw seed")
    assert.equal(draw.entry_count, 1, "gacha draw entry_count")
    const character = data.character_list[0]
    assert.ok(character !== null && typeof character === "object" && !Array.isArray(character), "gacha character entry")
    assert.equal(character.character_id, draw.character_id)
    assert.equal(character.entry_count, 1)
    assert.deepEqual(data.item_list, {})

    return {
        entry: "gacha",
        adapter: "fastify-route:/api/index.php/load->gacha/exec",
        statusCode: execResponse.statusCode,
        resultCode: execPayload.data_headers.result_code,
        gachaId: GACHA_ID,
        loadGachaInfoCount: loadGachaInfo.length,
        currency: {
            before: before.freeVmoney,
            after: after.freeVmoney,
            spent: before.freeVmoney - after.freeVmoney,
        },
        exchangePoint: {
            before: before.exchangePoint,
            after: after.exchangePoint,
            delta: after.exchangePoint - before.exchangePoint,
        },
        receiveHistory: {
            before: before.receiveHistoryCount,
            after: after.receiveHistoryCount,
            delta: after.receiveHistoryCount - before.receiveHistoryCount,
        },
        activeMissionGacha: {
            before: before.activeMissionGachaCount,
            after: after.activeMissionGachaCount,
            delta: after.activeMissionGachaCount - before.activeMissionGachaCount,
        },
        responseCounts: {
            draw: data.draw.length,
            character: data.character_list.length,
            item: Object.keys(data.item_list).length,
            gachaInfo: data.gacha_info_list.length,
            gachaCampaign: data.gacha_campaign_list.length,
            encyclopedia: data.encyclopedia_info.length,
        },
    }
}

module.exports = { GACHA_ID, executeGachaScenario }
