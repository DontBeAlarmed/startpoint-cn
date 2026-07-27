"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const Fastify = require("fastify")

require("ts-node/register/transpile-only")

const seedRoutes = require("../src/routes/web_api/seeds").default

test("seed API exposes readonly catalog and quarantine status", async t => {
    const fastify = Fastify()
    t.after(() => fastify.close())
    await fastify.register(seedRoutes, {
        prefix: "/api/seeds",
        catalog: {
            status: () => ({
                schemaVersion: 1,
                clientVersion: "1.8.1",
                cdnVersion: "1.4.54",
                seedRange: { start: 10_000_000, end: 10_019_999 },
                totalSeedCount: 80_000,
                movies: [
                    { movieId: "normal", rarityCounts: { "3": 13_891, "4": 5_151, "5": 958 } },
                ],
            }),
        },
        quarantine: {
            stats: () => ({ total: 25, movies: { normal: 25 } }),
            samples: limit => {
                assert.equal(limit, 20)
                return { normal: Array.from({ length: limit }, (_, index) => 10_000_001 + index) }
            },
        },
    })

    const response = await fastify.inject({ method: "GET", url: "/api/seeds/status" })
    assert.equal(response.statusCode, 200)
    assert.deepStrictEqual(response.json(), {
        catalog: {
            schemaVersion: 1,
            clientVersion: "1.8.1",
            cdnVersion: "1.4.54",
            seedRange: { start: 10_000_000, end: 10_019_999 },
            totalSeedCount: 80_000,
            movies: [
                { movieId: "normal", rarityCounts: { "3": 13_891, "4": 5_151, "5": 958 } },
            ],
        },
        quarantine: {
            total: 25,
            movies: { normal: 25 },
            samples: { normal: Array.from({ length: 20 }, (_, index) => 10_000_001 + index) },
        },
    })

    for (const request of [
        { method: "GET", url: "/api/seeds/stats" },
        { method: "GET", url: "/api/seeds/list" },
        { method: "POST", url: "/api/seeds/mode", payload: { mode: "test" } },
        { method: "POST", url: "/api/seeds/tag", payload: { seed: 1 } },
        { method: "POST", url: "/api/seeds/test-seed", payload: { seed: 1 } },
        { method: "DELETE", url: "/api/seeds/test-seed?rarity=3" },
    ]) {
        const rejected = await fastify.inject(request)
        assert.equal(rejected.statusCode, 404, `${request.method} ${request.url}`)
    }
})
