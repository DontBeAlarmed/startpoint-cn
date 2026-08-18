"use strict"

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

function encodeCnRequest(payload) {
    return pack(payload).toString("base64")
}

function decodeHttpResponse(response) {
    const contentType = String(response.headers["content-type"] ?? "")
    let payload
    if (contentType.includes("application/x-msgpack")) {
        payload = unpack(Buffer.from(response.body, "base64"))
    } else {
        try { payload = JSON.parse(response.body) } catch { payload = response.body }
    }
    return {
        statusCode: response.statusCode,
        headers: response.headers,
        payload,
    }
}

async function postCnRequest(app, url, payload, headers = {}) {
    const response = await app.inject({
        method: "POST",
        url,
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...headers,
        },
        payload: encodeCnRequest(payload),
    })
    return decodeHttpResponse(response)
}

function requireSuccessfulCnResponse(response, entry) {
    if (response.statusCode !== 200) {
        throw new Error(`${entry} route failed with ${response.statusCode}: ${JSON.stringify(response.payload)}`)
    }
    if (response.payload === null || typeof response.payload !== "object") {
        throw new Error(`${entry} route returned an invalid payload`)
    }
    if (response.payload.data_headers?.result_code !== 1) {
        throw new Error(`${entry} result_code must be 1`)
    }
    const contentType = String(response.headers?.["content-type"] ?? "")
    if (!contentType.includes("application/x-msgpack")) {
        throw new Error(`${entry} response content-type must include application/x-msgpack`)
    }
    return response.payload
}

function isPlainObject(value) {
    if (value === null || typeof value !== "object") return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function validateRoutePlugins(routePlugins) {
    if (!Array.isArray(routePlugins)) {
        throw new TypeError("routePlugins must be an array")
    }
    for (const route of routePlugins) {
        if (!isPlainObject(route) || typeof route.plugin !== "function") {
            throw new TypeError("each route plugin must provide a plugin function")
        }
        if (route.prefix !== undefined && typeof route.prefix !== "string") {
            throw new TypeError("route plugin prefix must be a string")
        }
        if (route.options !== undefined && !isPlainObject(route.options)) {
            throw new TypeError("route plugin options must be a plain object")
        }
    }
}

async function createNonMultiMixedHttpHarness({
    fastifyFactory = Fastify,
    registerMsgpackOnSend,
    routePlugins,
} = {}) {
    if (typeof fastifyFactory !== "function") {
        throw new TypeError("fastifyFactory must be a function")
    }
    if (typeof registerMsgpackOnSend !== "function") {
        throw new TypeError("registerMsgpackOnSend must be a function")
    }
    validateRoutePlugins(routePlugins)

    const app = fastifyFactory({ logger: false })
    try {
        app.addContentTypeParser(
            "application/x-www-form-urlencoded",
            { parseAs: "string" },
            (_request, body, done) => {
                try { done(null, unpack(Buffer.from(body, "base64"))) }
                catch (error) { done(error) }
            },
        )
        registerMsgpackOnSend(app)
        for (const route of routePlugins) {
            app.register(route.plugin, {
                ...(route.options ?? {}),
                ...(route.prefix === undefined ? {} : { prefix: route.prefix }),
            })
        }
        await app.ready()
        return app
    } catch (setupError) {
        try {
            await app.close()
        } catch (closeError) {
            throw new AggregateError(
                [setupError, closeError],
                "non-multi mixed HTTP harness setup and cleanup failed",
            )
        }
        throw setupError
    }
}

module.exports = {
    createNonMultiMixedHttpHarness,
    decodeHttpResponse,
    encodeCnRequest,
    postCnRequest,
    requireSuccessfulCnResponse,
}
