"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    createNonMultiMixedHttpHarness,
} = require("./non_multi_mixed_http.cjs")

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
