"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    createActiveQuest,
    createFixture,
    createInput,
    lifecycle,
} = require("./helpers/single-continue-fixture.cjs")

test("spends free currency first and increments the stored continue count", () => {
    const memoryQuest = createActiveQuest()
    const fixture = createFixture()

    const result = lifecycle.runSingleContinueLifecycleTransaction(
        createInput(memoryQuest),
        fixture.dependencies,
    )

    assert.deepEqual(result, {
        ok: true,
        freeVmoney: 0,
        vmoney: 20,
        continueCount: 3,
    })
    assert.deepEqual(fixture.getState().player, { freeVmoney: 0, vmoney: 20 })
    assert.equal(fixture.getState().storedQuest.continueCount, 3)
    assert.equal(memoryQuest.continueCount, 3)
    assert.deepEqual(fixture.writes, ["player", "activeQuest"])
})

test("supports free-only and paid-only payment without touching the other balance", async t => {
    for (const scenario of [
        {
            name: "free-only",
            player: { freeVmoney: 70, vmoney: 40 },
            expected: { freeVmoney: 20, vmoney: 40 },
        },
        {
            name: "paid-only",
            player: { freeVmoney: 0, vmoney: 70 },
            expected: { freeVmoney: 0, vmoney: 20 },
        },
    ]) {
        await t.test(scenario.name, () => {
            const memoryQuest = createActiveQuest()
            const fixture = createFixture({ player: scenario.player })
            const result = lifecycle.runSingleContinueLifecycleTransaction(
                createInput(memoryQuest),
                fixture.dependencies,
            )

            assert.equal(result.ok, true)
            assert.deepEqual(fixture.getState().player, scenario.expected)
            assert.equal(fixture.getState().storedQuest.continueCount, 3)
            assert.equal(memoryQuest.continueCount, 3)
        })
    }
})

test("rejects insufficient total currency without writes", () => {
    const memoryQuest = createActiveQuest()
    const fixture = createFixture({ player: { freeVmoney: 30, vmoney: 19 } })

    const result = lifecycle.runSingleContinueLifecycleTransaction(
        createInput(memoryQuest),
        fixture.dependencies,
    )

    assert.deepEqual(result, { ok: false, message: "Not enough vmoney to continue" })
    assert.deepEqual(fixture.getState().player, { freeVmoney: 30, vmoney: 19 })
    assert.equal(fixture.getState().storedQuest.continueCount, 2)
    assert.equal(memoryQuest.continueCount, 2)
    assert.deepEqual(fixture.writes, [])
})

test("rejects stale, multi, and missing authoritative state without writes", async t => {
    const scenarios = [
        {
            name: "stale request identity",
            input: createInput(createActiveQuest(), { playId: "stale-play" }),
            fixture: createFixture(),
            message: "Active quest does not match continue request.",
        },
        {
            name: "memory multi quest",
            input: createInput(createActiveQuest({ isMulti: true })),
            fixture: createFixture(),
            message: "Active quest is not a single battle.",
        },
        {
            name: "stored multi quest",
            input: createInput(createActiveQuest()),
            fixture: createFixture({ storedQuest: createActiveQuest({ isMulti: true }) }),
            message: "Persisted active quest does not match continue request.",
        },
        {
            name: "missing player",
            input: createInput(createActiveQuest()),
            fixture: createFixture({ player: null }),
            message: "Player not found.",
        },
        {
            name: "missing stored quest",
            input: createInput(createActiveQuest()),
            fixture: createFixture({ storedQuest: null }),
            message: "No persisted active quest to continue.",
        },
    ]

    for (const scenario of scenarios) {
        await t.test(scenario.name, () => {
            const memoryCount = scenario.input.memoryQuest.continueCount
            const before = scenario.fixture.getState()
            const result = lifecycle.runSingleContinueLifecycleTransaction(
                scenario.input,
                scenario.fixture.dependencies,
            )

            assert.deepEqual(result, { ok: false, message: scenario.message })
            assert.deepEqual(scenario.fixture.getState(), before)
            assert.equal(scenario.input.memoryQuest.continueCount, memoryCount)
            assert.deepEqual(scenario.fixture.writes, [])
        })
    }
})

test("uses Player state changed after identity resolution and before the transaction", async t => {
    await t.test("deleted Player fails closed", () => {
        const fixture = createFixture({
            player: { freeVmoney: 100, vmoney: 100 },
            beforeTransaction: state => { state.player = null },
        })
        const result = lifecycle.runSingleContinueLifecycleTransaction(
            createInput(createActiveQuest()),
            fixture.dependencies,
        )

        assert.deepEqual(result, { ok: false, message: "Player not found." })
        assert.equal(fixture.getState().player, null)
        assert.deepEqual(fixture.writes, [])
    })

    await t.test("changed balance is authoritative", () => {
        const fixture = createFixture({
            player: { freeVmoney: 100, vmoney: 100 },
            beforeTransaction: state => {
                state.player = { freeVmoney: 0, vmoney: 20 }
            },
        })
        const result = lifecycle.runSingleContinueLifecycleTransaction(
            createInput(createActiveQuest()),
            fixture.dependencies,
        )

        assert.deepEqual(result, { ok: false, message: "Not enough vmoney to continue" })
        assert.deepEqual(fixture.getState().player, { freeVmoney: 0, vmoney: 20 })
        assert.deepEqual(fixture.writes, [])
    })
})

test("rejects each stored single identity mismatch inside the transaction without writes", async t => {
    for (const scenario of [
        { field: "playId", value: "other-stored-play" },
        { field: "questId", value: 1001002 },
        { field: "category", value: 2 },
    ]) {
        await t.test(scenario.field, () => {
            const memoryQuest = createActiveQuest()
            const fixture = createFixture({
                player: { freeVmoney: 30, vmoney: 40 },
                storedQuest: createActiveQuest({ [scenario.field]: scenario.value }),
            })
            const before = fixture.getState()

            const result = lifecycle.runSingleContinueLifecycleTransaction(
                createInput(memoryQuest),
                fixture.dependencies,
            )

            assert.deepEqual(result, {
                ok: false,
                message: "Persisted active quest does not match continue request.",
            })
            assert.equal(fixture.getTransactionCalls(), 1)
            assert.deepEqual(fixture.getState().player, before.player)
            assert.equal(
                fixture.getState().storedQuest.continueCount,
                before.storedQuest.continueCount,
            )
            assert.equal(memoryQuest.continueCount, 2)
            assert.deepEqual(fixture.writes, [])
        })
    }
})

test("rejects invalid currency balances without writes", async t => {
    const invalidValues = [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]
    for (const field of ["freeVmoney", "vmoney"]) {
        for (const value of invalidValues) {
            await t.test(`${field}=${String(value)}`, () => {
                const player = { freeVmoney: 100, vmoney: 100, [field]: value }
                const memoryQuest = createActiveQuest()
                const fixture = createFixture({ player })
                const before = fixture.getState()

                const result = lifecycle.runSingleContinueLifecycleTransaction(
                    createInput(memoryQuest),
                    fixture.dependencies,
                )

                assert.deepEqual(result, {
                    ok: false,
                    message: "Player vmoney balance is invalid.",
                })
                assert.deepEqual(fixture.getState(), before)
                assert.equal(memoryQuest.continueCount, 2)
                assert.deepEqual(fixture.writes, [])
            })
        }
    }
})

test("rejects invalid expected and stored continue counts and costs without writes", async t => {
    const invalidValues = [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]
    for (const value of [...invalidValues, "2"]) {
        await t.test(`expectedContinueCount=${String(value)}`, () => {
            const memoryQuest = createActiveQuest()
            const fixture = createFixture()
            const before = fixture.getState()

            const result = lifecycle.runSingleContinueLifecycleTransaction(
                createInput(memoryQuest, { expectedContinueCount: value }),
                fixture.dependencies,
            )

            assert.deepEqual(result, {
                ok: false,
                message: "Expected continue count is invalid.",
            })
            assert.deepEqual(fixture.getState(), before)
            assert.equal(memoryQuest.continueCount, 2)
            assert.equal(fixture.getTransactionCalls(), 0)
            assert.deepEqual(fixture.writes, [])
        })
    }

    for (const value of invalidValues) {
        await t.test(`continueCount=${String(value)}`, () => {
            const memoryQuest = createActiveQuest()
            const fixture = createFixture({
                storedQuest: createActiveQuest({ continueCount: value }),
            })
            const before = fixture.getState()

            const result = lifecycle.runSingleContinueLifecycleTransaction(
                createInput(memoryQuest),
                fixture.dependencies,
            )

            assert.deepEqual(result, {
                ok: false,
                message: "Persisted continue count is invalid.",
            })
            assert.deepEqual(fixture.getState(), before)
            assert.equal(memoryQuest.continueCount, 2)
            assert.deepEqual(fixture.writes, [])
        })
    }

    for (const value of [0, ...invalidValues]) {
        await t.test(`cost=${String(value)}`, () => {
            const memoryQuest = createActiveQuest()
            const fixture = createFixture()
            const before = fixture.getState()

            const result = lifecycle.runSingleContinueLifecycleTransaction(
                createInput(memoryQuest, { cost: value }),
                fixture.dependencies,
            )

            assert.deepEqual(result, { ok: false, message: "Continue cost is invalid." })
            assert.deepEqual(fixture.getState(), before)
            assert.equal(memoryQuest.continueCount, 2)
            assert.deepEqual(fixture.writes, [])
        })
    }
})

test("rolls database writes back and leaves memory unchanged when commit fails", () => {
    const memoryQuest = createActiveQuest()
    const fixture = createFixture({ failCommit: true })
    const before = fixture.getState()

    assert.throws(
        () => lifecycle.runSingleContinueLifecycleTransaction(
            createInput(memoryQuest),
            fixture.dependencies,
        ),
        /simulated continue commit failure/,
    )
    assert.deepEqual(fixture.getState(), before)
    assert.equal(memoryQuest.continueCount, 2)
})

test("single battle continue route delegates transaction and writes to the lifecycle service", () => {
    const routeSource = fs.readFileSync(
        path.resolve(__dirname, "../src/routes/api/singleBattleQuest.ts"),
        "utf8",
    )
    const continueBlock = routeSource.slice(
        routeSource.indexOf('fastify.post("/play_continue"'),
    )

    assert.match(continueBlock, /runSingleContinueLifecycleTransaction\s*\(/)
    assert.match(continueBlock, /parseSingleContinueExpectedCount/)
    assert.match(continueBlock, /getConfigSync\(\)\.continue_virtual_money/)
    assert.doesNotMatch(continueBlock, /statistics\.continue_count/)
    assert.doesNotMatch(continueBlock, /const continueVmoneyCost = 50/)
    assert.doesNotMatch(continueBlock, /getDb\(\)\.transaction\s*\(/)
    assert.doesNotMatch(continueBlock, /updatePlayerSync\s*\(/)
    assert.doesNotMatch(continueBlock, /updatePlayerActiveQuestContinueCountSync\s*\(/)
})
