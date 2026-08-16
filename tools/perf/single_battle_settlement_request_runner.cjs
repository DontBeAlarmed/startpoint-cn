"use strict"

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

const singleBattleRoutes = require("../../src/routes/api/singleBattleQuest").default
function createSingleBattleApp() {
    const app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    app.addHook("onSend", (_request, reply, payload, done) => {
        if (String(reply.getHeader("content-type")).includes("application/x-msgpack")) {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    app.register(singleBattleRoutes, { prefix: "/api/index.php/single_battle_quest" })
    return app
}

function createRequestSqlRunner(app, counter, measurementState, {
    getTimeOffset,
    readStaminaHealTime,
    staminaHealTimeTracker,
}) {
    function readUnmeasuredStaminaHealTime() {
        const wasActive = measurementState.active
        measurementState.active = false
        try {
            return readStaminaHealTime()
        } finally {
            measurementState.active = wasActive
        }
    }

    async function post(route, payload) {
        const beforeDatabaseValue = readUnmeasuredStaminaHealTime()
        const requestStartedAtMs = Date.now()
        const response = await app.inject({
            method: "POST",
            url: `/api/index.php/single_battle_quest/${route}`,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            payload: pack(payload).toString("base64"),
        })
        const requestEndedAtMs = Date.now()
        const afterDatabaseValue = readUnmeasuredStaminaHealTime()
        let decoded
        if (String(response.headers["content-type"]).includes("application/x-msgpack")) {
            decoded = unpack(Buffer.from(response.body, "base64"))
        } else {
            try { decoded = JSON.parse(response.body) } catch { decoded = { body: response.body } }
        }
        return staminaHealTimeTracker.normalizeRequest(
            { statusCode: response.statusCode, ...decoded },
            {
                beforeDatabaseValue,
                afterDatabaseValue,
                requestStartedAtMs,
                requestEndedAtMs,
                timeOffsetMs: getTimeOffset() ?? 0,
            },
        )
    }

    async function measure(request) {
        counter.reset()
        measurementState.active = true
        try {
            const value = await request()
            return { value, error: null, sql: counter.snapshot() }
        } catch (error) {
            return { value: null, error, sql: counter.snapshot() }
        } finally {
            measurementState.active = false
        }
    }

    return { measure, post }
}

module.exports = { createRequestSqlRunner, createSingleBattleApp }
