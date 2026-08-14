require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createSampledLogger } = require("../src/lib/sampled-log")

test("logs the first event and every configured interval independently by key", () => {
    const messages = []
    const factoryCalls = []
    const sampledLog = createSampledLogger({
        interval: 100,
        sink: message => messages.push(message),
    })

    for (let count = 1; count <= 200; count += 1) {
        sampledLog("gacha", () => {
            factoryCalls.push(count)
            return `gacha-${count}`
        })
        if (count === 50) sampledLog("quest", () => "quest-1")
    }

    assert.deepEqual(factoryCalls, [1, 100, 200])
    assert.deepEqual(messages, ["gacha-1", "quest-1", "gacha-100", "gacha-200"])
})

test("does not invoke the message factory for unsampled events", () => {
    const sampledLog = createSampledLogger({ interval: 100, sink: () => undefined })
    let factoryCalls = 0

    sampledLog("hot-path", () => "first")
    for (let count = 2; count < 100; count += 1) {
        sampledLog("hot-path", () => {
            factoryCalls += 1
            return "unexpected"
        })
    }

    assert.equal(factoryCalls, 0)
})

test("message factory failures do not propagate and sampling counts keep advancing", () => {
    const messages = []
    const factoryCalls = []
    const sampledLog = createSampledLogger({
        interval: 3,
        sink: message => messages.push(message),
    })

    assert.doesNotThrow(() => sampledLog("quest", () => {
        factoryCalls.push(1)
        throw new Error("format failed")
    }))
    sampledLog("quest", () => {
        factoryCalls.push(2)
        return "unexpected-second"
    })
    sampledLog("quest", () => {
        factoryCalls.push(3)
        return "third"
    })

    assert.deepEqual(factoryCalls, [1, 3])
    assert.deepEqual(messages, ["third"])
})

test("sink failures do not propagate and sampling counts keep advancing", () => {
    const factoryCalls = []
    let sinkCalls = 0
    const sampledLog = createSampledLogger({
        interval: 3,
        sink: () => {
            sinkCalls += 1
            if (sinkCalls === 1) throw new Error("sink failed")
        },
    })

    for (let count = 1; count <= 3; count += 1) {
        assert.doesNotThrow(() => sampledLog("gacha", () => {
            factoryCalls.push(count)
            return `gacha-${count}`
        }))
    }

    assert.deepEqual(factoryCalls, [1, 3])
    assert.equal(sinkCalls, 2)
})

test("default logger resolves console.log when a sampled event is emitted", () => {
    const sampledLog = createSampledLogger({ interval: 1 })
    const originalLog = console.log
    const messages = []

    try {
        console.log = message => messages.push(message)
        sampledLog("dynamic-console", () => "rerouted")
    } finally {
        console.log = originalLog
    }

    assert.deepEqual(messages, ["rerouted"])
})

test("rejects intervals that are not positive safe integers", () => {
    for (const interval of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(
            () => createSampledLogger({ interval, sink: () => undefined }),
            /positive safe integer/,
        )
    }
})
