"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const zlib = require("node:zlib")

require("ts-node/register/transpile-only")

const {
    parseNestedTextOrderedMap,
    parseOrderedMap,
    parseTextOrderedMap,
} = require("../src/content/sync/ordered-map")

function uint32(value) {
    const output = Buffer.allocUnsafe(4)
    output.writeUInt32LE(value)
    return output
}

function createOrderedMap(entries, options = {}) {
    const keyBuffers = entries.map(entry => Buffer.from(entry.key, "utf8"))
    const rowBuffers = entries.map(entry => (
        entry.value.length === 0 ? Buffer.alloc(0) : zlib.deflateSync(entry.value)
    ))

    let keyEnd = 0
    let rowEnd = 0
    const pairs = entries.map((_, index) => {
        keyEnd += keyBuffers[index].length
        rowEnd += rowBuffers[index].length
        return { keyEnd, rowEnd }
    })

    const indexPayload = Buffer.concat([
        uint32(entries.length),
        ...pairs.map(pair => Buffer.concat([uint32(pair.keyEnd), uint32(pair.rowEnd)])),
        ...keyBuffers,
    ])
    const indexBlock = options.indexBlock || zlib.deflateSync(indexPayload)
    const body = options.body || Buffer.concat(rowBuffers)

    return Buffer.concat([uint32(indexBlock.length), indexBlock, body])
}

function createRaw(indexPayload, body = Buffer.alloc(0)) {
    const indexBlock = zlib.deflateSync(indexPayload)
    return Buffer.concat([uint32(indexBlock.length), indexBlock, body])
}

function expectThrows(parser, raw, pattern, message) {
    assert.throws(
        () => parser(raw),
        error => error instanceof Error && pattern.test(error.message),
        message,
    )
}

test("parses orderedmap rows, including empty maps and rows", () => {
    const raw = createOrderedMap([
        { key: "alpha", value: Buffer.from("first", "utf8") },
        { key: "empty", value: Buffer.alloc(0) },
        { key: "zh", value: Buffer.from("\u5185\u5bb9", "utf8") },
    ])

    const rows = parseOrderedMap(raw)
    assert.deepEqual(rows.map(row => [row.key, row.value.toString("utf8")]), [
        ["alpha", "first"],
        ["empty", ""],
        ["zh", "\u5185\u5bb9"],
    ])
    assert.ok(Object.isFrozen(rows))
    assert.ok(Object.isFrozen(rows[0]))

    const parsedAgain = parseOrderedMap(raw)
    assert.notStrictEqual(rows[0].value, parsedAgain[0].value)
    rows[0].value.fill(0)
    assert.equal(parsedAgain[0].value.toString("utf8"), "first")

    const empty = parseOrderedMap(createOrderedMap([]))
    assert.deepEqual(empty, [])
    assert.ok(Object.isFrozen(empty))

    assert.deepEqual(parseOrderedMap(createOrderedMap([
        { key: "", value: Buffer.from("empty key", "utf8") },
    ])).map(row => [row.key, row.value.toString("utf8")]), [["", "empty key"]])
})

test("parses text and nested text orderedmaps", () => {
    const nested = createOrderedMap([
        { key: "first", value: Buffer.from("first text", "utf8") },
        { key: "second", value: Buffer.from("\u7b2c\u4e8c\u884c", "utf8") },
    ])
    const raw = createOrderedMap([{ key: "outer-id", value: nested }])

    const textRows = parseTextOrderedMap(nested)
    assert.deepEqual(textRows, [
        { key: "first", text: "first text" },
        { key: "second", text: "\u7b2c\u4e8c\u884c" },
    ])
    assert.ok(Object.isFrozen(textRows))
    assert.ok(Object.isFrozen(textRows[0]))

    assert.deepEqual(parseNestedTextOrderedMap(raw, "outer-id"), textRows)
})

test("strictly rejects malformed orderedmap data", () => {
    const valid = createOrderedMap([{ key: "key", value: Buffer.from("value", "utf8") }])
    const indexLength = valid.readUInt32LE(0)
    const bodyOffset = 4 + indexLength
    const invalidUtf8Key = Buffer.concat([
        uint32(1),
        uint32(1),
        uint32(0),
        Buffer.from([0xff]),
    ])
    const duplicateKeys = createOrderedMap([
        { key: "same", value: Buffer.from("one", "utf8") },
        { key: "same", value: Buffer.from("two", "utf8") },
    ])
    const malformedRow = Buffer.from(valid)
    malformedRow[bodyOffset] ^= 0xff
    const trailingBody = Buffer.concat([valid, Buffer.from([0x00])])
    const indexForEmptyMap = zlib.deflateSync(uint32(0))
    const indexWithTrailingData = Buffer.concat([
        uint32(indexForEmptyMap.length + 1),
        indexForEmptyMap,
        Buffer.from([0x00]),
    ])
    const rowWithTrailingData = Buffer.concat([
        zlib.deflateSync(Buffer.from("value", "utf8")),
        Buffer.from([0x00]),
    ])
    const rowWithTrailingDataIndex = Buffer.concat([
        uint32(1),
        uint32(3),
        uint32(rowWithTrailingData.length),
        Buffer.from("key", "utf8"),
    ])
    const invalidText = createOrderedMap([
        { key: "text", value: Buffer.from([0xff]) },
    ])
    const nonMonotonicKeyEnds = Buffer.concat([
        uint32(2),
        uint32(1),
        uint32(0),
        uint32(0),
        uint32(0),
        Buffer.from("ab", "utf8"),
    ])
    const nonMonotonicRowEnds = Buffer.concat([
        uint32(2),
        uint32(1),
        uint32(1),
        uint32(2),
        uint32(0),
        Buffer.from("ab", "utf8"),
    ])
    const wrongFinalEnds = Buffer.concat([
        uint32(1),
        uint32(2),
        uint32(0),
        Buffer.from("key", "utf8"),
    ])
    const outOfBoundsEnds = Buffer.concat([
        uint32(1),
        uint32(4),
        uint32(1),
        Buffer.from("key", "utf8"),
    ])

    for (const [raw, pattern, message] of [
        [null, /source must be a Buffer/, "non-Buffers"],
        [Buffer.alloc(3), /shorter than the index length/, "headers shorter than four bytes"],
        [Buffer.alloc(4), /index length must be positive/, "zero index lengths"],
        [Buffer.from([1, 0, 0, 0, 0]), /index is not valid zlib data/, "damaged indexes"],
        [Buffer.concat([uint32(3), Buffer.from([1, 2, 3])]), /index is not valid zlib data/, "damaged indexes"],
        [createRaw(Buffer.alloc(3)), /missing its row count/, "indexes without a count"],
        [createRaw(uint32(1)), /missing row pairs/, "indexes without all pairs"],
        [createRaw(nonMonotonicKeyEnds), /key boundary is invalid/, "non-monotonic key ends"],
        [createRaw(nonMonotonicRowEnds, Buffer.from([0x00, 0x00])), /row boundary is invalid/, "non-monotonic row ends"],
        [createRaw(outOfBoundsEnds), /key boundary is invalid/, "out-of-bounds ends"],
        [createRaw(wrongFinalEnds), /key boundaries do not consume/, "final ends that do not match blobs"],
        [createRaw(invalidUtf8Key), /key 0 is not valid UTF-8/, "invalid UTF-8 keys"],
        [duplicateKeys, /duplicate key: same/, "duplicate keys"],
        [malformedRow, /row 0 is not valid zlib data/, "damaged row blocks"],
        [indexWithTrailingData, /index has trailing zlib data/, "trailing data in the index block"],
        [createRaw(rowWithTrailingDataIndex, rowWithTrailingData), /row 0 has trailing zlib data/, "trailing data in row blocks"],
        [trailingBody, /row boundaries do not consume/, "trailing body data"],
    ]) {
        expectThrows(parseOrderedMap, raw, pattern, message)
    }

    expectThrows(parseTextOrderedMap, invalidText, /row 0 text is not valid UTF-8/, "invalid UTF-8 text")
})

test("nested text orderedmaps require one matching outer key", () => {
    const nested = createOrderedMap([{ key: "row", value: Buffer.from("text", "utf8") }])
    const multiple = createOrderedMap([
        { key: "one", value: nested },
        { key: "two", value: nested },
    ])
    const wrongKey = createOrderedMap([{ key: "actual", value: nested }])

    expectThrows(
        parseNestedTextOrderedMap,
        multiple,
        /nested source must contain exactly one outer row/,
        "multiple outer rows",
    )
    assert.throws(
        () => parseNestedTextOrderedMap(wrongKey, "expected"),
        /nested outer key must be expected/,
    )
})
