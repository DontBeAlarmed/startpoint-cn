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

console.log("msgpack compatibility tests passed")
