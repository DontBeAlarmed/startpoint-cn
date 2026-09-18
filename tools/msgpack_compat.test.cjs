const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const { fixUint32Tags } = require("../src/lib/msgpack-compat")
const Fastify = require("fastify")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const scoreAttackQuests = require("../assets/score_attack_event_quest.json")
const cnServerSource = fs.readFileSync(path.resolve(__dirname, "../src/cn-server.ts"), "utf8")
const msgpackHookSource = fs.readFileSync(path.resolve(__dirname, "../src/routes/cn/msgpack.ts"), "utf8")

assert.match(cnServerSource, /registerCnMsgpackOnSend/)
assert.match(msgpackHookSource, /fixUint32Tags\(pack\(payload\)\)/)
assert.doesNotMatch(cnServerSource, /function\s+fixUint32Tags\s*\(/)
assert.equal((cnServerSource.match(/registerCnMsgpackOnSend\(fastify\)/g) ?? []).length, 1)

function msgpackInt32Token(tag, value) {
    const token = Buffer.alloc(5)
    token[0] = tag
    token.writeUInt32BE(value, 1)
    return token
}

function assertCnInt32Token(wire, value) {
    assert.equal(wire.indexOf(msgpackInt32Token(0xce, value)), -1)
    assert.notEqual(wire.indexOf(msgpackInt32Token(0xd2, value)), -1)
}

const values = [
    2_147_483_647,
    2_147_483_648,
    2_426_000_000,
    4_157_600_000,
    4_294_967_296,
    9_692_180_000,
]

for (const value of values) {
    const fixed = fixUint32Tags(pack(value))
    const decoded = unpack(fixed)
    assert.equal(decoded, value)
    assert.ok(decoded >= 0)
    if (value >= 0x80000000 && value <= 0xffffffff) {
        assert.equal(fixed[0], 0xcb, `${value} 应编码为 float64`)
    }
}

const nested = { score: values[2], list: [values[3], values[4], values[5]] }
assert.deepEqual(unpack(fixUint32Tags(pack(nested))), nested)

const thresholds = Object.values(scoreAttackQuests).flatMap(quest => [
    quest.bRankScore,
    quest.aRankScore,
    quest.sRankScore,
    quest.ssRankScore,
])
assert.ok(thresholds.some(value => value >= 0x80000000 && value <= 0xffffffff))
assert.ok(thresholds.includes(2_426_000_000))
assert.ok(thresholds.includes(4_157_600_000))
assert.ok(thresholds.includes(9_692_180_000))

test("production CN MsgPack hook packs, fixes uint32, and Base64-encodes exactly once", async t => {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    const payload = {
        total_size: 987_654,
        unrelated_bytes: Buffer.from([0xce, 0xd2, 0xaa, 0xbb, 0xcc, 0xdd]),
        unrelated_text: "CE and D2 are data, not MsgPack tokens",
    }
    app.get("/msgpack", (_request, reply) => reply.type("application/x-msgpack").send(payload))
    await app.ready()
    t.after(() => app.close())

    for (let iteration = 0; iteration < 10; iteration++) {
        const response = await app.inject({ method: "GET", url: "/msgpack" })
        const wire = Buffer.from(response.body, "base64")
        assert.equal(response.headers["content-type"], "application/x-msgpack")
        assertCnInt32Token(wire, 987_654)
        assert.deepEqual(unpack(wire), payload)
    }
})

// Reference copy of the pre-optimization byte-by-byte rewriter, kept so the
// span-copy implementation must stay byte-identical to the original wire form.
function referenceFixUint32Tags(buf) {
    const out = Buffer.allocUnsafe(buf.length * 2)
    let writePosition = 0
    const put = (byte) => { out[writePosition++] = byte }
    const copy = (offset, length) => {
        for (let index = 0; index < length; index++) out[writePosition++] = buf[offset + index]
    }
    function walk(offset) {
        const tag = buf[offset]
        let position = offset + 1
        if (tag <= 0x7f || tag >= 0xe0) { put(tag); return position }
        switch (tag) {
            case 0xc0: case 0xc2: case 0xc3: put(tag); return position
            case 0xcc: case 0xd0: copy(offset, 2); return position + 1
            case 0xcd: case 0xd1: copy(offset, 3); return position + 2
            case 0xce: {
                const value = buf.readUInt32BE(position)
                if (value < 0x80000000) {
                    put(0xd2)
                    copy(position, 4)
                } else {
                    put(0xcb)
                    const float = Buffer.allocUnsafe(8)
                    float.writeDoubleBE(value)
                    for (let index = 0; index < 8; index++) put(float[index])
                }
                return position + 4
            }
            case 0xd2: copy(offset, 5); return position + 4
            case 0xcf: case 0xd3: copy(offset, 9); return position + 8
            case 0xca: copy(offset, 5); return position + 4
            case 0xcb: copy(offset, 9); return position + 8
            case 0xd9: { const l = buf[position]; copy(offset, 2 + l); return position + 1 + l }
            case 0xda: { const l = buf.readUInt16BE(position); copy(offset, 3 + l); return position + 2 + l }
            case 0xdb: { const l = buf.readUInt32BE(position); copy(offset, 5 + l); return position + 4 + l }
            case 0xc4: { const l = buf[position]; copy(offset, 2 + l); return position + 1 + l }
            case 0xc5: { const l = buf.readUInt16BE(position); copy(offset, 3 + l); return position + 2 + l }
            case 0xc6: { const l = buf.readUInt32BE(position); copy(offset, 5 + l); return position + 4 + l }
            case 0xdc: {
                const count = buf.readUInt16BE(position)
                put(tag); put(buf[offset + 1]); put(buf[offset + 2])
                position += 2
                for (let index = 0; index < count; index++) position = walk(position)
                return position
            }
            case 0xdd: {
                const count = buf.readUInt32BE(position)
                put(tag); copy(offset + 1, 4)
                position += 4
                for (let index = 0; index < count; index++) position = walk(position)
                return position
            }
            case 0xde: {
                const count = buf.readUInt16BE(position)
                put(tag); put(buf[offset + 1]); put(buf[offset + 2])
                position += 2
                for (let index = 0; index < count; index++) { position = walk(position); position = walk(position) }
                return position
            }
            case 0xdf: {
                const count = buf.readUInt32BE(position)
                put(tag); copy(offset + 1, 4)
                position += 4
                for (let index = 0; index < count; index++) { position = walk(position); position = walk(position) }
                return position
            }
            case 0xc7: { const l = buf[position]; copy(offset, 3 + l); return position + 2 + l }
            case 0xc8: { const l = buf.readUInt16BE(position); copy(offset, 4 + l); return position + 3 + l }
            case 0xc9: { const l = buf.readUInt32BE(position); copy(offset, 6 + l); return position + 5 + l }
            case 0xd4: copy(offset, 3); return position + 2
            case 0xd5: copy(offset, 4); return position + 3
            case 0xd6: copy(offset, 6); return position + 5
            case 0xd7: copy(offset, 10); return position + 9
            case 0xd8: copy(offset, 18); return position + 17
            default: {
                if (tag >= 0xa0 && tag <= 0xbf) { const l = tag & 0x1f; copy(offset, 1 + l); return position + l }
                if (tag >= 0x90 && tag <= 0x9f) {
                    put(tag)
                    const count = tag & 0x0f
                    for (let index = 0; index < count; index++) position = walk(position)
                    return position
                }
                if (tag >= 0x80 && tag <= 0x8f) {
                    put(tag)
                    const count = tag & 0x0f
                    for (let index = 0; index < count; index++) { position = walk(position); position = walk(position) }
                    return position
                }
                put(tag)
                return position
            }
        }
    }
    let position = 0
    while (position < buf.length) position = walk(position)
    return out.subarray(0, writePosition)
}

function assertIdenticalRewrite(label, wire) {
    const expected = referenceFixUint32Tags(wire)
    const actual = fixUint32Tags(wire)
    assert.ok(Buffer.isBuffer(actual), `${label}: returns a Buffer`)
    assert.equal(actual.length, expected.length, `${label}: length`)
    assert.ok(actual.equals(expected), `${label}: bytes identical to reference rewrite`)
}

test("fixUint32Tags stays byte-identical across payload shapes", () => {
    // No uint32 tags at all: fixints, strings, empty containers.
    assertIdenticalRewrite("no-uint32", pack({ a: 1, b: "text", list: [1, 2, 3], nested: { deep: { x: -7 } } }))
    assertIdenticalRewrite("fixint-stream", pack([1, -1, 127, -32, 0]))

    // Single and multiple, nested uint32 tags (narrow and widened mix).
    assertIdenticalRewrite("single-uint32", pack({ count: 100_000 }))
    assertIdenticalRewrite("multiple-nested", pack({
        a: { b: [100_000, { c: 200_000, d: 3_000_000_000 }] },
        d: 70_000,
        list: Array.from({ length: 40 }, (_v, i) => 70_000 + i),
    }))
    for (const value of values) assertIdenticalRewrite(`scalar-${value}`, pack(value))

    // Strings across str8/str16/str32 boundaries.
    assertIdenticalRewrite("str8", pack("s".repeat(33)))
    assertIdenticalRewrite("str16", pack("s".repeat(300)))
    assertIdenticalRewrite("str32", pack(`${"s".repeat(70_000)}${100_000}`))

    // Binaries across bin8/bin16/bin32, with 0xce/0xd2 bytes inside the payload.
    const binaryFill = Buffer.alloc(300, 0xce)
    binaryFill[10] = 0xd2
    assertIdenticalRewrite("bin8", pack(Buffer.from([0xce, 0xd2, 0x00, 0x01, 0xce])))
    assertIdenticalRewrite("bin16", pack(binaryFill))
    assertIdenticalRewrite("bin32", pack(Buffer.concat([binaryFill, Buffer.alloc(70_000, 0xce)])))

    // Containers across array16/array32/map16/map32 header widths.
    assertIdenticalRewrite("array16", pack(Array.from({ length: 20 }, () => 100_000)))
    assertIdenticalRewrite("array32", pack(Array.from({ length: 70_000 }, (_v, i) => i)))
    const wideMap = {}
    for (let index = 0; index < 70_000; index++) wideMap[`k${index}`] = index
    assertIdenticalRewrite("map32", pack(wideMap))

    // Empty response and empty top-level stream.
    assertIdenticalRewrite("empty-object", pack({}))
    assertIdenticalRewrite("empty-buffer", Buffer.alloc(0))
    assert.equal(fixUint32Tags(Buffer.alloc(0)).length, 0)

    // Hand-crafted tokens covering the raw walk switch, streamed back to back.
    const be = (bytes) => Buffer.from(bytes)
    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b }
    const crafted = [
        be([0xc0]), be([0xc2]), be([0xc3]), be([0xc1]),                     // nil/bool/unknown
        be([0xcc, 0xff]), be([0xcd, 0x01, 0x00]),                            // uint8/uint16
        Buffer.concat([be([0xce]), u32(1)]),                                 // uint32 narrow
        Buffer.concat([be([0xce]), u32(0x80000000)]),                        // uint32 widened
        Buffer.concat([be([0xce]), u32(0xffffffff)]),                        // uint32 widened max
        be([0xcf, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),          // uint64
        be([0xd0, 0x7f]), be([0xd1, 0x00, 0x01]), be([0xd2, 0, 0, 0, 1]),    // int8/16/32
        be([0xd3, 0, 0, 0, 1, 0, 0, 0, 0]),                                  // int64
        be([0xca, 0x3f, 0x80, 0x00, 0x00]),                                  // float32
        be([0xcb, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0]),                            // float64
        be([0xd9, 0x03, 0x41, 0x42, 0x43]),                                  // str8
        be([0xda, 0x00, 0x03, 0x41, 0x42, 0x43]),                            // str16
        Buffer.concat([be([0xdb]), u32(2), be([0x41, 0x42])]),               // str32
        be([0xc4, 0x02, 0xce, 0xd2]),                                        // bin8
        be([0xc5, 0x00, 0x02, 0xce, 0xd2]),                                  // bin16
        Buffer.concat([be([0xc6]), u32(2), be([0xce, 0xd2])]),               // bin32
        be([0xdc, 0x00, 0x02, 0x01, 0x02]),                                  // array16
        Buffer.concat([be([0xdd]), u32(2), be([0x01, 0x02])]),               // array32
        be([0xde, 0x00, 0x01, 0x01, 0x02]),                                  // map16
        Buffer.concat([be([0xdf]), u32(1), be([0x01, 0x02])]),               // map32
        be([0xd4, 0x01, 0x02]),                                              // fixext1
        be([0xd5, 0x01, 0x02, 0x03]),                                        // fixext2
        be([0xd6, 0x01, 0x02, 0x03, 0x04, 0x05]),                            // fixext4
        be([0xd7, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]),    // fixext8
        be([0xd8, 0x01, ...Array(16).fill(0x09)]),                           // fixext16
        be([0xc7, 0x02, 0x7f, 0x01, 0x02]),                                  // ext8
        be([0xc8, 0x00, 0x02, 0x7f, 0x01, 0x02]),                            // ext16
        Buffer.concat([be([0xc9]), u32(2), be([0x7f, 0x01, 0x02])]),         // ext32
        be([0xa3, 0x41, 0x42, 0x43]),                                        // fixstr
        be([0x92, 0x01, 0x02]),                                              // fixarray
        be([0x81, 0x01, 0x02]),                                              // fixmap
        be([0x7f]), be([0xe0]),                                              // fixint +/- boundaries
    ]
    for (const [index, token] of crafted.entries()) {
        assertIdenticalRewrite(`crafted-${index}`, token)
    }
    assertIdenticalRewrite("crafted-stream", Buffer.concat(crafted))
})

test("fixUint32Tags skips every fixext type and payload before later uint32 tags", () => {
    for (const [tag, payloadLength] of [
        [0xd4, 1], [0xd5, 2], [0xd6, 4], [0xd7, 8], [0xd8, 16],
    ]) {
        // The final payload byte is deliberately 0xce so a one-byte-short
        // walker would interpret it as a second uint32 tag and corrupt it.
        const extension = Buffer.concat([
            Buffer.from([tag, 0xff]),
            Buffer.alloc(payloadLength, 0x01),
        ])
        extension[extension.length - 1] = 0xce
        const wire = Buffer.concat([
            extension,
            Buffer.from([0xce, 0x00, 0x00, 0x00, 0x07]),
        ])
        const expected = Buffer.from(wire)
        expected[extension.length] = 0xd2
        assert.deepEqual(fixUint32Tags(wire), expected, `fixext tag 0x${tag.toString(16)}`)
    }
})

test("fixUint32Tags stays byte-identical on a /load-scale payload", () => {
    const characters = Array.from({ length: 800 }, (_v, index) => ({
        id: 9_100_000 + index,
        exp: 1_000_000 + index * 7,
        level: 50 + (index % 30),
        mana_board_index: index % 5,
        ability_souls: [920_001 + (index % 40), 920_002 + (index % 40)],
        name: `character-${index}-name-payload-padding-padding-padding`,
    }))
    const payload = {
        player: { viewer_id: 800_000_018, stamina: 1_200_000, free_mana: 2_000, last_login_time: 1_723_000_000 },
        characters,
        equipments: Array.from({ length: 1200 }, (_v, index) => ({
            id: 5_000_000 + index, enhancement_level: index % 10, stack: index % 4,
        })),
        quest_progress: Array.from({ length: 2000 }, (_v, index) => ({
            category: index % 11, quest_id: 20_000_000 + index, progress: index % 500,
        })),
        mail_arrived: 4,
    }
    const wire = pack(payload)
    assert.ok(wire.length > 150_000, `/load-scale payload should be large, got ${wire.length}`)
    assert.ok(wire.includes(0xce), "payload should contain uint32 tags to rewrite")
    assertIdenticalRewrite("load-scale", wire)
    assert.deepEqual(unpack(fixUint32Tags(wire)), payload)
})

console.log("msgpack compatibility tests passed")
