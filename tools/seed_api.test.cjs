"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")

require("ts-node/register/transpile-only")

const { createSeedValidator } = require("../src/lib/seed-validator")
const { resolveRuntimeDataPaths } = require("../src/runtime/data-paths")
const { SEED_MOVIE_IDS } = require("../src/runtime/seed-state-schema")
const seedRoutes = require("../src/routes/web_api/seeds").default

const STATE_BASELINES = {
    "confirmed_seeds.json": { fes: { 101: 0 } },
    "purified_seeds.json": { fes: {} },
    "verified_seeds.json": { fes: {} },
    "pool_config.json": { selectedMovieId: "fes" },
    "test_seeds.json": [null, null, null],
}

function digestDirectory(directory) {
    return Object.fromEntries(fs.readdirSync(directory).sort().map(fileName => [
        fileName,
        crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, fileName))).digest("hex"),
    ]))
}

test("backend seed API persists through an injected DATA_DIR without changing assets", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seed-api-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const assetsDir = path.join(root, "assets")
    fs.mkdirSync(assetsDir)
    for (const [fileName, value] of Object.entries(STATE_BASELINES)) {
        fs.writeFileSync(path.join(assetsDir, fileName), `${JSON.stringify(value, null, 2)}\n`)
    }
    fs.writeFileSync(path.join(assetsDir, "gacha_movie_seeds_fes.json"), JSON.stringify({
        3: { 0: [1, 2, 3] },
    }))
    const before = digestDirectory(assetsDir)
    const dataPaths = resolveRuntimeDataPaths({ DATA_DIR: path.join(root, "data") })
    const validator = createSeedValidator({ assetsDir, dataPaths })
    const fastify = Fastify()
    t.after(() => fastify.close())
    await fastify.register(seedRoutes, {
        assetsDir,
        seedValidator: validator,
        prefix: "/api/seeds",
    })

    const initialStats = await fastify.inject({
        method: "GET",
        url: "/api/seeds/stats",
    })
    assert.equal(initialStats.statusCode, 200)
    assert.deepEqual(initialStats.json().movieIds, [...SEED_MOVIE_IDS])

    for (const selectedMovieId of [" fes", "fes ", "__proto__", "unknown", 123, null]) {
        const response = await fastify.inject({
            method: "POST",
            url: "/api/seeds/mode",
            payload: { mode: "natural", selectedMovieId },
        })
        assert.equal(response.statusCode, 400, String(selectedMovieId))
        assert.equal(fs.existsSync(dataPaths.seedStateFile), false)
    }
    validator.setMode("play")
    const rejectedModeRequest = await fastify.inject({
        method: "POST",
        url: "/api/seeds/mode",
        payload: { mode: "test", selectedMovieId: "unknown" },
    })
    assert.equal(rejectedModeRequest.statusCode, 400)
    assert.equal(validator.getMode(), "play")
    assert.equal(validator.getSelectedMovieId(), "fes")
    for (const seed of [null, 1.5, 9_999_999, 10_400_000]) {
        const response = await fastify.inject({
            method: "POST",
            url: "/api/seeds/test-seed",
            payload: { rarity: 4, seed },
        })
        assert.equal(response.statusCode, 400, String(seed))
        assert.equal(fs.existsSync(dataPaths.seedStateFile), false)
    }
    const invalidTagMovie = await fastify.inject({
        method: "POST",
        url: "/api/seeds/tag",
        payload: { seed: 101, tag: "未测试", movieId: "constructor" },
    })
    assert.equal(invalidTagMovie.statusCode, 400)
    assert.equal(fs.existsSync(dataPaths.seedStateFile), false)

    const modeResponse = await fastify.inject({
        method: "POST",
        url: "/api/seeds/mode",
        payload: { mode: "natural", selectedMovieId: "rarity_5_guarantee" },
    })
    assert.equal(modeResponse.statusCode, 200)
    assert.deepEqual(modeResponse.json(), {
        mode: "natural",
        selectedMovieId: "rarity_5_guarantee",
    })

    const testSeedResponse = await fastify.inject({
        method: "POST",
        url: "/api/seeds/test-seed",
        payload: { rarity: 4, seed: 10_000_123 },
    })
    assert.equal(testSeedResponse.statusCode, 200)
    assert.deepEqual(testSeedResponse.json(), { ok: true })

    assert.deepEqual(digestDirectory(assetsDir), before)
    assert.deepEqual(fs.readdirSync(dataPaths.seedStateDir), ["seed-state.json"])
    const snapshot = JSON.parse(fs.readFileSync(
        path.join(dataPaths.seedStateDir, "seed-state.json"),
        "utf8",
    ))
    assert.equal(snapshot.schemaVersion, 1)
    assert.deepEqual(snapshot.config, { selectedMovieId: "rarity_5_guarantee" })
    assert.deepEqual(snapshot.testSeeds, [null, 10_000_123, null])
    for (const key of ["confirmed", "pending", "play", "verified"]) {
        assert.equal(Object.hasOwn(snapshot, key), true, key)
    }
    assert.equal(
        createSeedValidator({ assetsDir, dataPaths }).getSelectedMovieId(),
        "rarity_5_guarantee",
    )
})

test("seed API rejects unsafe stats queries and malformed mutation inputs without side effects", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seed-api-invalid-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const assetsDir = path.join(root, "assets")
    fs.mkdirSync(assetsDir)
    for (const [fileName, value] of Object.entries(STATE_BASELINES)) {
        fs.writeFileSync(path.join(assetsDir, fileName), `${JSON.stringify(value, null, 2)}\n`)
    }
    fs.writeFileSync(path.join(root, "secret.json"), JSON.stringify({
        3: { 0: [123456] },
    }))
    const beforeAssets = digestDirectory(assetsDir)
    const dataPaths = resolveRuntimeDataPaths({ DATA_DIR: path.join(root, "data") })
    const validator = createSeedValidator({ assetsDir, dataPaths })
    const beforeStats = validator.stats("fes")
    const fastify = Fastify()
    t.after(() => fastify.close())
    await fastify.register(seedRoutes, {
        assetsDir,
        seedValidator: validator,
        prefix: "/api/seeds",
    })

    for (const url of [
        "/api/seeds/stats?movieId=..%2F..%2F..%2Fsecret",
        "/api/seeds/stats?movieId=unknown",
        "/api/seeds/stats?movieId=normal&movieId=fes",
        "/api/seeds/stats?movieId=",
    ]) {
        const response = await fastify.inject({ method: "GET", url })
        assert.equal(response.statusCode, 400, url)
    }

    for (const url of ["/api/seeds/tag", "/api/seeds/test-seed"]) {
        for (const payload of [null, [], "bad", 7, {}]) {
            const response = await fastify.inject({
                method: "POST",
                url,
                payload,
                headers: { "content-type": "application/json" },
            })
            assert.equal(response.statusCode, 400, `${url}: ${JSON.stringify(payload)}`)
        }
    }

    for (const url of [
        "/api/seeds/test-seed",
        "/api/seeds/test-seed?rarity=3&rarity=4",
        "/api/seeds/test-seed?rarity%5B%5D=3",
        "/api/seeds/test-seed?rarity=bad",
    ]) {
        const response = await fastify.inject({ method: "DELETE", url })
        assert.equal(response.statusCode, 400, url)
    }

    assert.deepEqual(validator.stats("fes"), beforeStats)
    assert.deepEqual(digestDirectory(assetsDir), beforeAssets)
    assert.equal(fs.existsSync(dataPaths.seedStateFile), false)
})
