"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    canonicalJson,
    createBehaviorSignature,
} = require("./multi_hub_load_metrics.cjs")

const GOLDEN_HOST_RESULT = {
    ownerSide: "host",
    hostRewarded: true,
    guestRewarded: true,
    duplicateFinishRejected: 2,
}
const GOLDEN_HOST_SHA256 = "sha256:574691a3eb0659697ff8db0537a767d683d71862680527bd760a2db38521ed7c"

test("canonicalJson recursively sorts object keys while preserving array order", () => {
    assert.equal(
        canonicalJson({ z: 3, a: { y: 2, x: 1 }, list: [{ b: 2, a: 1 }, 0] }),
        '{"a":{"x":1,"y":2},"list":[{"a":1,"b":2},0],"z":3}',
    )
    assert.equal(canonicalJson({ value: -0 }), '{"value":0}')
})

test("canonicalJson sorts integer-style keys lexicographically at every depth", () => {
    assert.equal(
        canonicalJson({ "2": "two", "10": "ten" }),
        '{"10":"ten","2":"two"}',
    )
    assert.equal(
        canonicalJson({ nested: { "3": "three", "11": "eleven" } }),
        '{"nested":{"11":"eleven","3":"three"}}',
    )
})

test("canonicalJson JSON-escapes control characters in sorted keys and values", () => {
    const firstKey = 'a"\\\n\t\u0000'
    const secondKey = 'z\u0000\t\n\\"'
    const value = {
        [secondKey]: 'second"\\\n\t\u0000',
        [firstKey]: 'first\u0000\t\n\\"',
    }
    const expected = `{${[firstKey, secondKey].sort().map(key => (
        `${JSON.stringify(key)}:${JSON.stringify(value[key])}`
    )).join(",")}}`
    const actual = canonicalJson(value)
    assert.equal(actual, expected)
    assert.deepEqual(JSON.parse(actual), value)
})

test("canonicalJson rejects cycles, sparse arrays, and non-JSON values", () => {
    const circular = {}
    circular.self = circular
    const sparse = new Array(2)
    sparse[1] = "present"
    for (const invalid of [
        circular,
        sparse,
        NaN,
        Infinity,
        -Infinity,
        undefined,
        () => {},
        Symbol("value"),
        1n,
        new Date(0),
        new Map(),
    ]) {
        assert.throws(() => canonicalJson(invalid), TypeError)
    }
})

test("canonicalJson rejects accessors, symbols, and non-JSON array properties", () => {
    const accessor = {}
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 })
    const symbolKey = { value: 1 }
    symbolKey[Symbol("hidden")] = true
    const decoratedArray = [1]
    decoratedArray.extra = 2
    const inheritedArray = [1]
    Object.setPrototypeOf(
        inheritedArray,
        Object.assign(Object.create(Array.prototype), { injected: true }),
    )
    for (const invalid of [accessor, symbolKey, decoratedArray, inheritedArray]) {
        assert.throws(() => canonicalJson(invalid), TypeError)
    }
})

test("behavior signatures are canonical SHA256 values for normalized room results", () => {
    const left = createBehaviorSignature({
        ownerSide: "client",
        hostRewarded: true,
        guestRewarded: false,
        duplicateFinishRejected: 2,
    })
    const right = createBehaviorSignature({
        duplicateFinishRejected: 2,
        guestRewarded: false,
        hostRewarded: true,
        ownerSide: "client",
    })
    assert.equal(left, right)
    assert.match(left, /^sha256:[a-f0-9]{64}$/)
})

test("behavior signature matches the independently calculated golden digest", () => {
    assert.equal(createBehaviorSignature(GOLDEN_HOST_RESULT), GOLDEN_HOST_SHA256)
})

test("behavior signatures reject invalid normalized values and dynamic fields", () => {
    for (const invalid of [
        null,
        { ownerSide: "server", hostRewarded: true, guestRewarded: true, duplicateFinishRejected: 2 },
        { ownerSide: "host", hostRewarded: 1, guestRewarded: true, duplicateFinishRejected: 2 },
        { ownerSide: "host", hostRewarded: true, guestRewarded: false, duplicateFinishRejected: -1 },
        { ownerSide: "host", hostRewarded: true, guestRewarded: false, duplicateFinishRejected: 1.5 },
        { ownerSide: "host", hostRewarded: true, guestRewarded: false, duplicateFinishRejected: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
        assert.throws(() => createBehaviorSignature(invalid), TypeError)
    }

    for (const field of [
        "roomNumber",
        "viewerId",
        "deviceId",
        "timestamp",
        "time",
        "port",
        "latencyMs",
        "rawPayload",
    ]) {
        assert.throws(() => createBehaviorSignature({
            ...GOLDEN_HOST_RESULT,
            [field]: "dynamic",
        }), TypeError)
    }
})

test("behavior signature rejects a proxy that hides raw payload", () => {
    const target = { ...GOLDEN_HOST_RESULT, rawPayload: "dynamic" }
    const behavior = new Proxy(target, {
        ownKeys() {
            return Reflect.ownKeys(target).filter(key => key !== "rawPayload")
        },
    })
    assert.throws(() => createBehaviorSignature(behavior), TypeError)
})

test("canonicalJson rejects object and array proxies before proxy traps run", () => {
    let traps = 0
    const variants = [
        new Proxy({ value: 1 }, {
            ownKeys(target) {
                traps++
                return Reflect.ownKeys(target)
            },
        }),
        new Proxy([undefined], {
            get(target, property, receiver) {
                traps++
                if (property === "map") return () => []
                return Reflect.get(target, property, receiver)
            },
        }),
    ]
    for (const variant of variants) assert.throws(() => canonicalJson(variant), TypeError)
    assert.equal(traps, 0)
})

test("canonicalJson rejects revoked object and array proxies without leaking traps", () => {
    const variants = [
        Proxy.revocable({ value: 1 }, {
            ownKeys() { throw new Error("object revoke trap leaked") },
        }),
        Proxy.revocable([1], {
            get() { throw new Error("array revoke trap leaked") },
        }),
    ]
    for (const variant of variants) {
        variant.revoke()
        assert.throws(
            () => canonicalJson(variant.proxy),
            error => error instanceof TypeError && !/revoke trap leaked/.test(error.message),
        )
    }
})
