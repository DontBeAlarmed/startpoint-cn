"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { IdempotencyCache } = require("../src/multi/hub/idempotency")

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

const okResponse = value => ({
    statusCode: 200,
    body: JSON.stringify({ ok: true, value }),
})

test("pending entries are shared and reject new keys when capacity is exhausted", async () => {
    const firstResult = deferred()
    const cache = new IdempotencyCache({ maxEntries: 1, ttlMs: 1_000 })
    let firstCalls = 0
    let secondCalls = 0
    const executeFirst = () => cache.execute("credential-a", "rooms.create", "key-a", async () => {
        firstCalls++
        return firstResult.promise
    })
    const pending = executeFirst()
    await new Promise(resolve => setImmediate(resolve))

    const atCapacity = cache.execute("credential-a", "rooms.create", "key-b", async () => {
        secondCalls++
        return okResponse("second")
    })
    const capacityResultPromise = atCapacity.then(
        value => ({ status: "resolved", value }),
        error => ({ status: "rejected", error }),
    )
    const replay = executeFirst()
    const sharedPending = replay === pending
    firstResult.resolve(okResponse("first"))
    assert.deepEqual(await pending, okResponse("first"))
    assert.deepEqual(await replay, okResponse("first"))
    const capacityResult = await capacityResultPromise

    assert.equal(sharedPending, true)
    assert.equal(capacityResult.status, "rejected")
    assert.equal(capacityResult.error?.code, "IDEMPOTENCY_CAPACITY_EXCEEDED")
    assert.equal(firstCalls, 1)
    assert.equal(secondCalls, 0)
})

test("settled entries are evicted by capacity and bounded failure responses stay cached", async () => {
    let now = 1_000
    const cache = new IdempotencyCache({
        now: () => now,
        maxEntries: 1,
        ttlMs: 100,
    })
    let firstCalls = 0
    let secondCalls = 0
    const unavailable = {
        statusCode: 503,
        body: JSON.stringify({ ok: false, code: "HUB_UNAVAILABLE" }),
    }
    const first = await cache.execute("credential-a", "rooms.create", "key-a", async () => {
        firstCalls++
        return unavailable
    })
    const replay = await cache.execute("credential-a", "rooms.create", "key-a", async () => {
        firstCalls++
        return okResponse("unexpected")
    })
    assert.deepEqual(first, unavailable)
    assert.deepEqual(replay, unavailable)
    assert.equal(firstCalls, 1)

    assert.deepEqual(await cache.execute("credential-a", "rooms.create", "key-b", async () => {
        secondCalls++
        return okResponse("second")
    }), okResponse("second"))
    assert.equal(secondCalls, 1)

    now = 1_101
    assert.deepEqual(await cache.execute("credential-b", "rooms.create", "key-b", async () => {
        secondCalls++
        return okResponse("isolated")
    }), okResponse("isolated"))
    assert.equal(secondCalls, 2)
})

test("rejected handlers remain replayable until normal cache eviction", async () => {
    const cache = new IdempotencyCache({ maxEntries: 2, ttlMs: 1_000 })
    const failure = Object.assign(new Error("operation failed"), { code: "E_OPERATION" })
    let calls = 0
    const execute = () => cache.execute("credential-a", "rooms.create", "key-a", async () => {
        calls++
        throw failure
    })
    const first = execute()
    await assert.rejects(first, error => error === failure)
    const replay = execute()

    await assert.rejects(replay, error => error === failure)
    assert.equal(replay, first)
    assert.equal(calls, 1)
})

test("cache identity remains isolated by credential operation and key", async () => {
    const cache = new IdempotencyCache({ maxEntries: 4, ttlMs: 1_000 })
    let calls = 0
    const execute = (credential, operation, key) => cache.execute(credential, operation, key, async () => {
        calls++
        return okResponse(`${credential}:${operation}:${key}`)
    })

    await execute("credential-a", "rooms.create", "key-a")
    await execute("credential-b", "rooms.create", "key-a")
    await execute("credential-a", "battles.start", "key-a")
    await execute("credential-a", "rooms.create", "key-b")
    assert.equal(calls, 4)

    assert.deepEqual(
        await execute("credential-a", "rooms.create", "key-a"),
        okResponse("credential-a:rooms.create:key-a"),
    )
    assert.equal(calls, 4)
})
