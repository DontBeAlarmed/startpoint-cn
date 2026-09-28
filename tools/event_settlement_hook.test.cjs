"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    dispatchBuiltInEventSettlement,
    getOperatorRushHookPhase,
} = require("../src/lib/quest/finish/event-settlement-hook")

function hooks(calls) {
    return Object.fromEntries(["rush", "raid", "carnival", "scoreAttack"].map(kind => [
        kind,
        descriptor => {
            calls.push(kind)
            return descriptor.questId
        },
    ]))
}

test("one closed descriptor invokes exactly one matching built-in hook", () => {
    for (const kind of ["rush", "raid", "carnival", "scoreAttack"]) {
        const calls = []
        const result = dispatchBuiltInEventSettlement(
            { kind, questId: 123, window: { availableFromMs: null, availableUntilMs: null } },
            hooks(calls),
        )
        assert.deepEqual(calls, [kind])
        assert.deepEqual(result, { kind, value: 123 })
        assert.equal(Object.isFrozen(result), true)
    }
})

test("a non-Event descriptor invokes no built-in hook", () => {
    const calls = []
    assert.deepEqual(
        dispatchBuiltInEventSettlement({ kind: "none" }, hooks(calls)),
        { kind: "none" },
    )
    assert.deepEqual(calls, [])
})

test("descriptor windows remain descriptive and do not reject an in-flight finish", () => {
    const calls = []
    const result = dispatchBuiltInEventSettlement({
        kind: "rush",
        questId: 123,
        eventId: 700001,
        folderId: 1,
        round: 2,
        window: { availableFromMs: 100, availableUntilMs: 200 },
    }, hooks(calls))
    assert.deepEqual(calls, ["rush"])
    assert.deepEqual(result, { kind: "rush", value: 123 })
})

test("operator Rush hook ordering preserves the pre-D26 cross-category contract", () => {
    assert.equal(getOperatorRushHookPhase({ kind: "none" }), "beforeBuiltIn")
    for (const kind of ["raid", "carnival", "scoreAttack"]) {
        assert.equal(getOperatorRushHookPhase({ kind }), "beforeBuiltIn")
    }
    assert.equal(getOperatorRushHookPhase({ kind: "rush" }), "afterBuiltIn")
})
