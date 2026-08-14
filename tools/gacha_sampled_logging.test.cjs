const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const source = fs.readFileSync(path.join(__dirname, "../src/lib/gacha.ts"), "utf8")
const functionStart = source.indexOf("export function rewardPlayerGachaDrawResultSync(")
const functionEnd = source.indexOf("/**\n * Performs box gacha draws", functionStart)
const functionSource = source.slice(functionStart, functionEnd)

test("character gacha settlement emits one sampled lazy draw summary", () => {
    assert.doesNotMatch(functionSource, /console\.log\(`\[GACHA\] rarity=/)
    assert.equal(functionSource.match(/sampledLog\("gacha-character-draws"/g)?.length, 1)

    const sampledCall = functionSource.indexOf('sampledLog("gacha-character-draws"')
    const factory = functionSource.indexOf("() =>", sampledCall)
    const mappedDraws = functionSource.indexOf("draws.map", sampledCall)
    const stringify = functionSource.indexOf("JSON.stringify", sampledCall)
    assert(sampledCall >= 0)
    assert(factory > sampledCall)
    assert(mappedDraws > factory)
    assert(stringify > factory)
    assert(!functionSource.slice(sampledCall).includes("\\n"), "summary should stay on one line")

    for (const detail of ["playerId", "draws.length", "character_id", "movie_id", "seed", "SKIP"]) {
        assert(functionSource.slice(sampledCall).includes(detail), `summary should include ${detail}`)
    }

    assert.equal(functionSource.match(/gachaSeedQuarantine\.markSent\(/g)?.length, 1)
})
