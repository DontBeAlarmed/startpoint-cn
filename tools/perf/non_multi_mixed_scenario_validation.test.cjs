"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const { pack } = require("msgpackr")
const { executeScenario } = require("./non_multi_mixed_scenarios.cjs")
const { requireRejected } = require("./non_multi_mixed_battle.cjs")
const {
    projectNonMultiMixedOwnerState,
    quoteSqlIdentifier,
} = require("./non_multi_mixed_state_snapshot.cjs")

function responseApp(payload, statusCode = 200, { msgpack = false } = {}) {
    return {
        async inject() {
            return {
                statusCode,
                headers: {
                    "content-type": msgpack ? "application/x-msgpack" : "application/json",
                },
                body: msgpack ? pack(payload).toString("base64") : JSON.stringify(payload),
            }
        },
    }
}

function responseSequenceApp(payloads) {
    let index = 0
    return {
        async inject() {
            const payload = payloads[index++]
            if (payload === undefined) throw new Error("unexpected extra HTTP request")
            return {
                statusCode: 200,
                headers: { "content-type": "application/x-msgpack" },
                body: pack(payload).toString("base64"),
            }
        },
    }
}

function scenarioIdentity(entryName) {
    return { entryName, accountId: 11, playerId: 21, viewerId: 31, deviceId: 41 }
}

function validAuthContext(identity, sessionOverrides = {}) {
    return {
        inspectAuthIdentity: () => ({
            binding: { device_id: identity.deviceId, account_id: identity.accountId },
            viewerSessions: [{
                token: String(identity.viewerId),
                account_id: identity.accountId,
                type: 2,
                ...sessionOverrides,
            }],
        }),
    }
}

function validLoadPayload(identity) {
    return {
        data_headers: {
            result_code: 1,
            viewer_id: identity.accountId,
            asset_update: false,
        },
        data: {
            available_asset_version: "1.4.54",
            character_list: [],
            equipment_list: {},
            item_list: [],
            unfinished_quest_list: [],
            unfinished_multi_quest_list: [],
        },
    }
}

function validMissionPayload(identity) {
    return {
        data_headers: { result_code: 1, viewer_id: identity.viewerId },
        data: {
            mission_progress_list: [{
                mission_category: 1,
                mission_id: 100,
                progress_value: 0,
                stage: 0,
            }],
        },
    }
}

function writeScenarioContext(entry) {
    if (entry === "shop") return {
        prepareShopIdentity() {},
        inspectShopIdentity: () => ({
            bondToken: 500,
            purchaseCount: 0,
            rewardEquipmentCount: 0,
        }),
    }
    if (entry === "mail") return {
        prepareMailIdentity: () => ({ mailId: 1 }),
        inspectMailIdentity: () => ({
            itemCount: 0,
            unreceivedMailCount: 1,
            receiveHistoryCount: 0,
        }),
    }
    if (entry === "gacha") return {
        prepareGachaIdentity() {},
        inspectGachaIdentity: () => ({
            freeVmoney: 1000,
            exchangePoint: 0,
            receiveHistoryCount: 0,
            characterCount: 0,
            partyCharacterReferenceCount: 0,
            activeMissionGachaCount: 0,
        }),
    }
    throw new Error(`unsupported validation context: ${entry}`)
}

test("single battle rejection helper accepts only the expected bad-request shape", () => {
    assert.doesNotThrow(() => requireRejected({
        statusCode: 400,
        payload: { error: "Bad Request", message: "invalid active quest" },
    }, "expected rejection"))
    for (const response of [
        { statusCode: 500, payload: { error: "Internal Server Error" } },
        { statusCode: 200, payload: { data_headers: { result_code: 0 } } },
        { statusCode: 400, payload: { error: "Unexpected Error" } },
        { statusCode: 400, payload: "Bad Request" },
    ]) {
        assert.throws(
            () => requireRejected(response, "malformed rejection"),
            /must be rejected with HTTP 400 Bad Request/,
        )
    }
})

test("all scenarios reject HTTP 200 responses with a non-success result code", async () => {
    const cases = [
        ["auth", identity => ({
            data_headers: { result_code: 0 },
            data: { newAccount: 0 },
        }), identity => validAuthContext(identity)],
        ["load", identity => {
            const payload = validLoadPayload(identity)
            payload.data_headers.result_code = 0
            return payload
        }, () => ({})],
        ["mission-progress", identity => {
            const payload = validMissionPayload(identity)
            payload.data_headers.result_code = 0
            return payload
        }, () => ({})],
    ]
    for (const entry of ["shop", "mail", "gacha"]) {
        cases.push([
            entry,
            () => ({ data_headers: { result_code: 0 }, data: {} }),
            () => writeScenarioContext(entry),
        ])
    }
    for (const [entry, createPayload, createContext] of cases) {
        const identity = scenarioIdentity(entry)
        await assert.rejects(
            () => executeScenario(
                responseApp(createPayload(identity)),
                identity,
                createContext(identity),
            ),
            /result_code must be 1/,
        )
    }
})

test("shop, mail, and gacha read paths reject malformed response collections", async () => {
    const cases = [
        ["shop", { sales_list: {} }, /sales_list/],
        ["mail", { mail: {}, total_count: 0 }, /mail index list/],
        ["gacha", { gacha_info_list: {} }, /gacha_info_list/],
    ]
    for (const [entry, data, message] of cases) {
        const identity = scenarioIdentity(entry)
        await assert.rejects(
            () => executeScenario(
                responseApp({
                    data_headers: {
                        result_code: 1,
                        viewer_id: entry === "gacha" ? identity.accountId : identity.viewerId,
                    },
                    data,
                }, 200, { msgpack: true }),
                identity,
                writeScenarioContext(entry),
            ),
            message,
        )
    }
})

test("shop rejects a buy response that omits the purchased equipment", async () => {
    const identity = scenarioIdentity("shop")
    let inspections = 0
    const context = {
        prepareShopIdentity() {},
        inspectShopIdentity() {
            inspections++
            return inspections === 1
                ? { bondToken: 500, purchaseCount: 0, rewardEquipmentCount: 0 }
                : { bondToken: 450, purchaseCount: 1, rewardEquipmentCount: 1 }
        },
    }
    await assert.rejects(
        () => executeScenario(responseSequenceApp([{
            data_headers: { result_code: 1, viewer_id: identity.viewerId },
            data: {
                sales_list: [{
                    shop_type: 8,
                    shop_item_id: 100001,
                    stock_quantity: 1,
                    total_purchase_num: 0,
                }],
            },
        }, {
            data_headers: { result_code: 1, viewer_id: identity.viewerId },
            data: { user_info: { bond_token: 450 }, equipment_list: [] },
        }]), identity, context),
        /purchased equipment/,
    )
})

test("mail rejects a listed fixture mail with mismatched attachment fields", async () => {
    const identity = scenarioIdentity("mail")
    let inspections = 0
    const context = {
        prepareMailIdentity: () => ({ mailId: 1 }),
        inspectMailIdentity() {
            inspections++
            return inspections === 1
                ? { itemCount: 0, unreceivedMailCount: 1, receiveHistoryCount: 0 }
                : { itemCount: 2, unreceivedMailCount: 0, receiveHistoryCount: 1 }
        },
    }
    await assert.rejects(
        () => executeScenario(responseSequenceApp([{
            data_headers: { result_code: 1, viewer_id: identity.viewerId },
            data: {
                mail: [{
                    id: 1,
                    type: 0,
                    type_id: 99999,
                    number: 0,
                    receive_time: "0000-00-00 00:00:00",
                }],
                total_count: 1,
            },
        }, {
            data_headers: { result_code: 1, viewer_id: identity.viewerId },
            data: {
                item_list: { 30005: 2 },
                total_count: 1,
                mail_arrived: false,
            },
        }]), identity, context),
        /fixture attachment/,
    )
})

test("gacha rejects null draw entries even when response counts match", async () => {
    const identity = scenarioIdentity("gacha")
    let inspections = 0
    const context = {
        prepareGachaIdentity() {},
        inspectGachaIdentity() {
            inspections++
            return inspections === 1
                ? {
                    freeVmoney: 1000,
                    exchangePoint: 0,
                    receiveHistoryCount: 0,
                    characterCount: 0,
                    partyCharacterReferenceCount: 0,
                    activeMissionGachaCount: 0,
                }
                : {
                    freeVmoney: 850,
                    exchangePoint: 1,
                    receiveHistoryCount: 1,
                    characterCount: 1,
                    partyCharacterReferenceCount: 0,
                    activeMissionGachaCount: 1,
                }
        },
    }
    await assert.rejects(
        () => executeScenario(responseSequenceApp([{
            data_headers: { result_code: 1, viewer_id: identity.accountId },
            data: { gacha_info_list: [], user_info: { free_vmoney: 1000 } },
        }, {
            data_headers: { result_code: 1, viewer_id: identity.viewerId },
            data: {
                user_info: { free_vmoney: 850 },
                draw: [null],
                character_list: [{ character_id: 1, entry_count: 1 }],
                item_list: {},
                gacha_info_list: [{ gacha_id: 1638, gacha_exchange_point: 1 }],
                gacha_campaign_list: [],
                encyclopedia_info: [],
            },
        }]), identity, context),
        /draw entry/,
    )
})

test("auth rejects a viewer session with the wrong token or type", async () => {
    const identity = scenarioIdentity("auth")
    const payload = {
        data_headers: { result_code: 1 },
        data: { newAccount: 0 },
    }
    for (const sessionOverrides of [
        { token: "wrong-viewer-token" },
        { type: 1 },
    ]) {
        await assert.rejects(
            () => executeScenario(
                responseApp(payload, 200, { msgpack: true }),
                identity,
                validAuthContext(identity, sessionOverrides),
            ),
            /auth identity session invariant/,
        )
    }
})

test("load rejects mismatched viewer and client-owned asset state", async () => {
    const identity = scenarioIdentity("load")
    const cases = [
        ["viewer", payload => { payload.data_headers.viewer_id++ }],
        ["asset update", payload => { payload.data_headers.asset_update = true }],
        ["asset version", payload => { payload.data.available_asset_version = "1.4.55" }],
        ["missing asset version", payload => { delete payload.data.available_asset_version }],
    ]
    for (const [label, mutate] of cases) {
        const payload = validLoadPayload(identity)
        mutate(payload)
        await assert.rejects(
            () => executeScenario(responseApp(payload, 200, { msgpack: true }), identity),
            /viewer_id|asset_update|available_asset_version/,
            label,
        )
    }
})

test("load rejects missing and malformed response collections", async () => {
    const identity = scenarioIdentity("load")
    const fields = [
        ["character_list", "bad"],
        ["equipment_list", null],
        ["item_list", 1],
        ["unfinished_quest_list", {}],
        ["unfinished_multi_quest_list", "bad"],
    ]
    for (const [field, invalidValue] of fields) {
        for (const missing of [true, false]) {
            const payload = validLoadPayload(identity)
            if (missing) delete payload.data[field]
            else payload.data[field] = invalidValue
            await assert.rejects(
                () => executeScenario(responseApp(payload, 200, { msgpack: true }), identity),
                new RegExp(field),
            )
        }
    }
})

test("mission-progress rejects viewer mismatch and absent progress", async () => {
    const identity = scenarioIdentity("mission-progress")
    const cases = [
        ["viewer mismatch", payload => { payload.data_headers.viewer_id++ }],
        ["empty list", payload => { payload.data.mission_progress_list = [] }],
        ["missing list", payload => { delete payload.data.mission_progress_list }],
        ["wrong list type", payload => { payload.data.mission_progress_list = {} }],
    ]
    for (const [label, mutate] of cases) {
        const payload = validMissionPayload(identity)
        mutate(payload)
        await assert.rejects(
            () => executeScenario(responseApp(payload, 200, { msgpack: true }), identity),
            /viewer_id|mission_progress_list/,
            label,
        )
    }
})

test("mission-progress rejects malformed mission progress elements", async () => {
    const identity = scenarioIdentity("mission-progress")
    const fields = ["mission_category", "mission_id", "progress_value", "stage"]
    const cases = [["empty object", {}]]
    for (const field of fields) {
        cases.push([`${field} missing`, entry => { delete entry[field] }])
        cases.push([`${field} null`, entry => { entry[field] = null }])
        cases.push([`${field} string`, entry => { entry[field] = "1" }])
        cases.push([`${field} negative`, entry => { entry[field] = -1 }])
    }
    cases.push(["progress NaN", entry => { entry.progress_value = Number.NaN }])
    cases.push(["progress Infinity", entry => { entry.progress_value = Number.POSITIVE_INFINITY }])

    for (const [label, mutate] of cases) {
        const payload = validMissionPayload(identity)
        const entry = label === "empty object"
            ? {}
            : { ...payload.data.mission_progress_list[0] }
        if (typeof mutate === "function") mutate(entry)
        payload.data.mission_progress_list = [entry]
        await assert.rejects(
            () => executeScenario(responseApp(payload, 200, { msgpack: true }), identity),
            /mission-progress element schema/,
            label,
        )
    }
})

test("owner projection removes only the target and preserves newly created owners", () => {
    assert.equal(quoteSqlIdentifier('owner"audit'), '"owner""audit"')

    const target = scenarioIdentity("load")
    const baseState = {
        tables: [{
            name: "accounts",
            accountOwnerColumns: ["id"],
            playerOwnerColumns: [],
            rows: [
                { id: target.accountId, label: "target" },
                { id: 12, label: "other" },
            ],
        }, {
            name: "players",
            accountOwnerColumns: ["account_id"],
            playerOwnerColumns: ["id"],
            rows: [
                { id: target.playerId, account_id: target.accountId },
                { id: 22, account_id: 12 },
            ],
        }, {
            name: "device_bindings",
            accountOwnerColumns: ["account_id"],
            playerOwnerColumns: [],
            rows: [
                { device_id: 41, account_id: target.accountId },
                { device_id: 42, account_id: 12 },
            ],
        }, {
            name: "sessions",
            accountOwnerColumns: ["account_id"],
            playerOwnerColumns: [],
            rows: [
                { token: "31", account_id: target.accountId },
                { token: "32", account_id: 12 },
            ],
        }],
    }
    const projected = projectNonMultiMixedOwnerState(baseState, target)
    assert.deepEqual(projected.tables.map(table => table.rows), [
        [{ id: 12, label: "other" }],
        [{ id: 22, account_id: 12 }],
        [{ device_id: 42, account_id: 12 }],
        [{ token: "32", account_id: 12 }],
    ])

    const extraRows = [
        { id: 13, label: "unexpected" },
        { id: 23, account_id: 13 },
        { device_id: 43, account_id: 13 },
        { token: "33", account_id: 13 },
    ]
    for (let index = 0; index < extraRows.length; index++) {
        const polluted = structuredClone(baseState)
        polluted.tables[index].rows.push(extraRows[index])
        assert.notDeepEqual(
            projectNonMultiMixedOwnerState(polluted, target),
            projected,
            `an extra owner in ${polluted.tables[index].name} must remain observable`,
        )
    }
})
