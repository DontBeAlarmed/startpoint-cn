"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const { pack } = require("msgpackr")
const {
    createNonMultiMixedHttpHarness,
} = require("./non_multi_mixed_http.cjs")
const { executeScenario } = require("./non_multi_mixed_scenarios.cjs")

function responseApp(payload, { msgpack = false } = {}) {
    return {
        async inject() {
            return {
                statusCode: 200,
                headers: {
                    "content-type": msgpack ? "application/x-msgpack" : "application/json",
                },
                body: msgpack ? pack(payload).toString("base64") : JSON.stringify(payload),
            }
        },
    }
}

function validLoadPayload() {
    return {
        data_headers: { result_code: 1, viewer_id: 11, asset_update: false },
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

test("successful lifecycle responses reject JSON 200 and accept CN MsgPack 200", async () => {
    const identity = { entryName: "load", accountId: 11, playerId: 21, viewerId: 31 }
    await assert.rejects(
        () => executeScenario(responseApp(validLoadPayload()), identity),
        /application\/x-msgpack/,
    )
    assert.equal(
        (await executeScenario(responseApp(validLoadPayload(), { msgpack: true }), identity)).resultCode,
        1,
    )
})

function createLifecycleProbe({ failAt, closeFails = false } = {}) {
    const calls = { close: 0, factory: 0 }
    const app = {
        addContentTypeParser() {},
        register() {
            if (failAt === "register") throw new Error("register failed")
        },
        async ready() {
            if (failAt === "ready") throw new Error("ready failed")
        },
        async close() {
            calls.close++
            if (closeFails) throw new Error("close failed")
        },
    }
    return {
        calls,
        fastifyFactory() {
            calls.factory++
            return app
        },
        registerMsgpackOnSend() {
            if (failAt === "hook") throw new Error("hook failed")
        },
    }
}

test("harness validates every route descriptor before creating Fastify", async () => {
    const invalidRoutes = [
        null,
        {},
        { plugin: "not-a-function" },
        { plugin() {}, prefix: 123 },
        { plugin() {}, options: [] },
    ]
    for (const route of invalidRoutes) {
        const probe = createLifecycleProbe()
        const pending = createNonMultiMixedHttpHarness({
            fastifyFactory: probe.fastifyFactory,
            registerMsgpackOnSend: probe.registerMsgpackOnSend,
            routePlugins: [route],
        })
        assert.equal(typeof pending?.then, "function", "harness creation must be async")
        await assert.rejects(pending, /route plugin|prefix|options/)
        assert.equal(probe.calls.factory, 0)
        assert.equal(probe.calls.close, 0)
    }
})

test("harness closes Fastify when hook, register, or ready fails", async () => {
    for (const failAt of ["hook", "register", "ready"]) {
        const probe = createLifecycleProbe({ failAt })
        await assert.rejects(
            createNonMultiMixedHttpHarness({
                fastifyFactory: probe.fastifyFactory,
                registerMsgpackOnSend: probe.registerMsgpackOnSend,
                routePlugins: [{ plugin() {}, prefix: "/valid", options: {} }],
            }),
            new RegExp(`${failAt} failed`),
        )
        assert.equal(probe.calls.factory, 1)
        assert.equal(probe.calls.close, 1)
    }
})

test("harness preserves setup and close failures", async () => {
    const probe = createLifecycleProbe({ failAt: "ready", closeFails: true })
    await assert.rejects(
        createNonMultiMixedHttpHarness({
            fastifyFactory: probe.fastifyFactory,
            registerMsgpackOnSend: probe.registerMsgpackOnSend,
            routePlugins: [],
        }),
        error => {
            assert.ok(error instanceof AggregateError)
            assert.deepEqual(error.errors.map(item => item.message), ["ready failed", "close failed"])
            return true
        },
    )
    assert.equal(probe.calls.close, 1)
})
