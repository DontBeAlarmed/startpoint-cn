"use strict"

const assert = require("node:assert/strict")
const {
    postCnRequest,
    requireSuccessfulCnResponse,
} = require("./non_multi_mixed_http.cjs")

const MAIL_ITEM_ID = 30005
const MAIL_ITEM_TYPE = 1
const UNRECEIVED_TIME = "0000-00-00 00:00:00"

function requireMailState(context, identity, label) {
    if (typeof context.inspectMailIdentity !== "function") {
        throw new TypeError("mail scenario requires context.inspectMailIdentity")
    }
    const state = context.inspectMailIdentity(identity)
    for (const field of ["itemCount", "unreceivedMailCount", "receiveHistoryCount"]) {
        assert.ok(Number.isSafeInteger(state?.[field]) && state[field] >= 0, `${label} ${field}`)
    }
    return state
}

async function executeMailScenario(app, identity, context = {}) {
    if (typeof context.prepareMailIdentity !== "function") {
        throw new TypeError("mail scenario requires context.prepareMailIdentity")
    }
    const fixture = context.prepareMailIdentity(identity)
    assert.ok(Number.isSafeInteger(fixture?.mailId) && fixture.mailId > 0, "mail fixture id")
    const before = requireMailState(context, identity, "mail before")

    const listResponse = await postCnRequest(app, "/api/index.php/mail/index", {
        viewer_id: identity.viewerId,
        api_count: 1,
        current_page: 1,
    })
    const listPayload = requireSuccessfulCnResponse(listResponse, "mail index")
    assert.equal(listPayload.data_headers?.viewer_id, identity.viewerId)
    const mailList = listPayload.data?.mail
    assert.ok(Array.isArray(mailList), "mail index list must be an array")
    assert.equal(listPayload.data?.total_count, mailList.length)
    const listedMail = mailList.find(mail => mail?.id === fixture.mailId)
    assert.ok(listedMail, "mail fixture must be listed")
    assert.equal(listedMail.type, MAIL_ITEM_TYPE, "mail fixture attachment type")
    assert.equal(listedMail.type_id, MAIL_ITEM_ID, "mail fixture attachment item")
    assert.equal(listedMail.number, 2, "mail fixture attachment amount")
    assert.equal(listedMail.receive_time, UNRECEIVED_TIME, "mail fixture receive state")

    const receiveResponse = await postCnRequest(app, "/api/index.php/mail/receive", {
        viewer_id: identity.viewerId,
        api_count: 1,
        mail_id: fixture.mailId,
    })
    const receivePayload = requireSuccessfulCnResponse(receiveResponse, "mail receive")
    assert.equal(receivePayload.data_headers?.viewer_id, identity.viewerId)
    const after = requireMailState(context, identity, "mail after")
    assert.equal(after.itemCount, before.itemCount + 2)
    assert.equal(after.unreceivedMailCount, before.unreceivedMailCount - 1)
    assert.equal(after.receiveHistoryCount, before.receiveHistoryCount + 1)
    assert.equal(receivePayload.data?.item_list?.[MAIL_ITEM_ID], after.itemCount)
    assert.equal(receivePayload.data?.total_count, mailList.length)
    assert.equal(receivePayload.data?.mail_arrived, false)

    return {
        entry: "mail",
        adapter: "fastify-route:/api/index.php/mail/index->receive",
        statusCode: receiveResponse.statusCode,
        resultCode: receivePayload.data_headers.result_code,
        listCount: mailList.length,
        item: {
            itemId: MAIL_ITEM_ID,
            before: before.itemCount,
            after: after.itemCount,
            delta: after.itemCount - before.itemCount,
        },
        unreceived: {
            before: before.unreceivedMailCount,
            after: after.unreceivedMailCount,
        },
        receiveHistory: {
            before: before.receiveHistoryCount,
            after: after.receiveHistoryCount,
            delta: after.receiveHistoryCount - before.receiveHistoryCount,
        },
    }
}

module.exports = { MAIL_ITEM_ID, executeMailScenario }
