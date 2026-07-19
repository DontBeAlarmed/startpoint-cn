const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const { fixUint32Tags } = require("../src/lib/msgpack-compat")
const scoreAttackQuests = require("../assets/score_attack_event_quest.json")
const cnServerSource = fs.readFileSync(path.resolve(__dirname, "../src/cn-server.ts"), "utf8")

assert.match(cnServerSource, /import\s+\{\s*fixUint32Tags\s*\}\s+from\s+["']\.\/lib\/msgpack-compat["']/)
assert.doesNotMatch(cnServerSource, /function\s+fixUint32Tags\s*\(/)

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

console.log("msgpack compatibility tests passed")
