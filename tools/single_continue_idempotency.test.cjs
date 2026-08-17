"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    createActiveQuest,
    createFixture,
    createInput,
    lifecycle,
} = require("./helpers/single-continue-fixture.cjs")

test("charges the same payload once, replays without writes, and admits the next count", () => {
    const memoryQuest = createActiveQuest({ continueCount: 0 })
    const fixture = createFixture({
        player: { freeVmoney: 30, vmoney: 100 },
        storedQuest: createActiveQuest({ continueCount: 0 }),
    })
    const firstInput = createInput(memoryQuest, { expectedContinueCount: 0 })

    assert.deepEqual(lifecycle.runSingleContinueLifecycleTransaction(
        firstInput,
        fixture.dependencies,
    ), { ok: true, freeVmoney: 0, vmoney: 80, continueCount: 1 })
    assert.deepEqual(fixture.writes, ["player", "activeQuest"])

    fixture.writes.length = 0
    assert.deepEqual(lifecycle.runSingleContinueLifecycleTransaction(
        firstInput,
        fixture.dependencies,
    ), { ok: true, freeVmoney: 0, vmoney: 80, continueCount: 1 })
    assert.deepEqual(fixture.writes, [])
    assert.equal(memoryQuest.continueCount, 1)

    assert.deepEqual(lifecycle.runSingleContinueLifecycleTransaction(
        createInput(memoryQuest, { expectedContinueCount: 1 }),
        fixture.dependencies,
    ), { ok: true, freeVmoney: 0, vmoney: 30, continueCount: 2 })
    assert.deepEqual(fixture.writes, ["player", "activeQuest"])
})

test("replays from stored count and repairs stale memory after a service restart", () => {
    const memoryQuest = createActiveQuest({ continueCount: 0 })
    const fixture = createFixture({
        player: { freeVmoney: 0, vmoney: 20 },
        storedQuest: createActiveQuest({ continueCount: 1 }),
    })

    const result = lifecycle.runSingleContinueLifecycleTransaction(
        createInput(memoryQuest, { expectedContinueCount: 0 }),
        fixture.dependencies,
    )

    assert.deepEqual(result, { ok: true, freeVmoney: 0, vmoney: 20, continueCount: 1 })
    assert.equal(memoryQuest.continueCount, 1)
    assert.deepEqual(fixture.writes, [])
})

test("rejects stale and future expected continue counts without writes", async t => {
    for (const expectedContinueCount of [1, 4]) {
        await t.test(`expected=${expectedContinueCount}`, () => {
            const memoryQuest = createActiveQuest({ continueCount: 3 })
            const fixture = createFixture({
                storedQuest: createActiveQuest({ continueCount: 3 }),
            })
            const before = fixture.getState()

            const result = lifecycle.runSingleContinueLifecycleTransaction(
                createInput(memoryQuest, { expectedContinueCount }),
                fixture.dependencies,
            )

            assert.deepEqual(result, {
                ok: false,
                message: "Continue count does not match persisted active quest.",
            })
            assert.deepEqual(fixture.getState(), before)
            assert.equal(memoryQuest.continueCount, 3)
            assert.deepEqual(fixture.writes, [])
        })
    }
})

test("handles first and replay requests safely at the MAX_SAFE boundary", async t => {
    await t.test("first request cannot increment", () => {
        const memoryQuest = createActiveQuest({ continueCount: Number.MAX_SAFE_INTEGER })
        const fixture = createFixture({
            storedQuest: createActiveQuest({ continueCount: Number.MAX_SAFE_INTEGER }),
        })
        const before = fixture.getState()

        const result = lifecycle.runSingleContinueLifecycleTransaction(
            createInput(memoryQuest, { expectedContinueCount: Number.MAX_SAFE_INTEGER }),
            fixture.dependencies,
        )

        assert.deepEqual(result, {
            ok: false,
            message: "Persisted continue count cannot be incremented.",
        })
        assert.deepEqual(fixture.getState(), before)
        assert.equal(memoryQuest.continueCount, Number.MAX_SAFE_INTEGER)
        assert.deepEqual(fixture.writes, [])
    })

    await t.test("one-less expected count replays", () => {
        const memoryQuest = createActiveQuest({ continueCount: 0 })
        const fixture = createFixture({
            storedQuest: createActiveQuest({ continueCount: Number.MAX_SAFE_INTEGER }),
        })

        const result = lifecycle.runSingleContinueLifecycleTransaction(
            createInput(memoryQuest, {
                expectedContinueCount: Number.MAX_SAFE_INTEGER - 1,
            }),
            fixture.dependencies,
        )

        assert.deepEqual(result, {
            ok: true,
            freeVmoney: 30,
            vmoney: 40,
            continueCount: Number.MAX_SAFE_INTEGER,
        })
        assert.equal(memoryQuest.continueCount, Number.MAX_SAFE_INTEGER)
        assert.deepEqual(fixture.writes, [])
    })
})
