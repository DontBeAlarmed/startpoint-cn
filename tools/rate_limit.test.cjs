"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const {
    clientKeyOf,
    createRateLimiter,
    enforceRateLimit,
    rateLimitRule,
} = require("../src/lib/rate-limit")

function fakeRequest({ ip = "10.0.0.1", headers = {} } = {}) {
    return { ip, headers }
}

function withEnv(patches, fn) {
    const previous = {}
    for (const [key, value] of Object.entries(patches)) {
        previous[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        fn()
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test("clientKeyOf: XFF trust off pins the socket address (default posture)", () => {
    withEnv({ TRUST_PROXY_XFF: undefined }, () => {
        const request = fakeRequest({ ip: "198.51.100.7", headers: { "x-forwarded-for": "192.0.2.4" } })
        assert.equal(clientKeyOf(request), "198.51.100.7")
    })
})

test("clientKeyOf: XFF trust on takes the LAST segment (proxy-appended), not the client-forgeable first", () => {
    withEnv({ TRUST_PROXY_XFF: "1" }, () => {
        assert.equal(
            clientKeyOf(fakeRequest({ headers: { "x-forwarded-for": "192.0.2.9, 192.0.2.8, 203.0.113.5" } })),
            "203.0.113.5",
        )
        assert.equal(
            clientKeyOf(fakeRequest({ headers: { "x-forwarded-for": ["192.0.2.9", "203.0.113.6"] } })),
            "203.0.113.6",
            "array header form joins before segmenting",
        )
        assert.equal(
            clientKeyOf(fakeRequest({ headers: {} })),
            "10.0.0.1",
            "missing XFF falls back to the socket address",
        )
    })
})

test("rateLimitRule: env overrides parse positive ints, junk keeps defaults", () => {
    withEnv({ RATE_LIMIT_TEST_MAX: "7", RATE_LIMIT_TEST_WINDOW_MS: "not-a-number" }, () => {
        const rule = rateLimitRule("TEST", 3, 60_000)
        assert.equal(rule.max, 7)
        assert.equal(rule.windowMs, 60_000)
    })
})

test("fixed window: allows up to max, rejects beyond, resets when the window expires", async () => {
    const limiter = createRateLimiter({ name: "T", max: 2, windowMs: 50 })
    const request = fakeRequest({ ip: "1.1.1.1" })
    assert.equal(limiter(request), false)
    assert.equal(limiter(request), false)
    assert.equal(limiter(request), true, "3rd hit inside the window exceeds max=2")
    assert.equal(limiter(request), true)
    // 真实钟窗口过期
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(limiter(request), false)
})

test("buckets stay bounded: a fresh key fails closed at capacity, existing keys keep counting", () => {
    // 长窗口保证清扫无过期可回收 → 容量耗尽路径可观测
    const limiter = createRateLimiter({ name: "CAP", max: 1_000_000, windowMs: 60_000 })
    const first = fakeRequest({ ip: "10.9.0.1" })
    assert.equal(limiter(first), false, "first key admits")
    // 洪泛新 key 至超过 MAX_BUCKETS（10000）
    let rejected = 0
    for (let index = 0; index < 12_000; index += 1) {
        const admitted = limiter(fakeRequest({ ip: `10.8.${Math.floor(index / 256) % 256}.${index % 256}-${index}` }))
        if (!admitted) rejected += 1
    }
    assert.ok(rejected < 12_000, "capacity bound must reject some flood keys (fail-closed)")
    assert.equal(limiter(first), false, "existing key keeps its window (not evicted while active)")
})

test("enforceRateLimit: over-limit answers 429 with Retry-After; under-limit passes through", async () => {
    const app = Fastify({ logger: false })
    const limiter = createRateLimiter({ name: "E", max: 1, windowMs: 60_000 })
    app.get("/hit", async (request, reply) => {
        const limited = await enforceRateLimit(request, reply, limiter)
        if (limited !== undefined) return limited
        return { ok: true }
    })
    await app.ready()
    const first = await app.inject({ method: "GET", url: "/hit" })
    assert.equal(first.statusCode, 200)
    const second = await app.inject({ method: "GET", url: "/hit" })
    assert.equal(second.statusCode, 429)
    assert.equal(second.headers["retry-after"], "60")
    assert.match(second.body, /Too Many Requests/)
    await app.close()
})
