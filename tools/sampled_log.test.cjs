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

test("rejects intervals that are not positive safe integers", () => {
    for (const interval of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(
            () => createSampledLogger({ interval, sink: () => undefined }),
            /positive safe integer/,
        )
    }
})
