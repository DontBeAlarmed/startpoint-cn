require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const source = fs.readFileSync(path.join(__dirname, "../src/lib/gacha-reward-grant.ts"), "utf8")
const functionStart = source.indexOf("function scheduleCharacterLog(")
const functionEnd = source.indexOf("function projectCharacters(", functionStart)
const functionSource = source.slice(functionStart, functionEnd)

test("formats duplicate character draws with their exact movie plans as one line", () => {
    let formatters
    assert.doesNotThrow(() => {
        formatters = require("../src/lib/hot-path-log-formatters")
    })
    assert.equal(typeof formatters.formatGachaCharacterDrawsSummary, "function")

    const message = formatters.formatGachaCharacterDrawsSummary({
        playerId: 9,
        draws: [
            { character_id: 100, movie_id: "normal", seed: 11, entry_count: 1 },
            { character_id: 100, movie_id: "normal_guarantee", seed: 22, entry_count: 1 },
            { character_id: 200, movie_id: "rarity_5_guarantee", seed: 200000, entry_count: 1 },
        ],
        moviePlans: [
            { characterId: 100, movieId: "normal_guarantee", seed: 22, rarity: 5, requiresVerification: true },
            { characterId: 200, movieId: "rarity_5_guarantee", seed: 200000, rarity: 5, requiresVerification: false },
            { characterId: 100, movieId: "normal", seed: 11, rarity: 4, requiresVerification: true },
        ],
    })

    assert.equal(
        message,
        '[GACHA] reward_summary playerId=9 draws=3 characters=[{"character_id":100,"movie_id":"normal","seed":11,"rarity":4,"verification":"VERIFY"},{"character_id":100,"movie_id":"normal_guarantee","seed":22,"rarity":5,"verification":"VERIFY"},{"character_id":200,"movie_id":"rarity_5_guarantee","seed":200000,"rarity":5,"verification":"SKIP"}]',
    )
    assert.equal(message.includes("\n"), false)
})

test("character gacha settlement captures one sampled lazy draw summary", () => {
    assert.doesNotMatch(functionSource, /console\.log\(`\[GACHA\] rarity=/)
    assert.equal(functionSource.match(/sampledLog\("gacha-character-draws"/g)?.length, 1)

    const sampledCall = functionSource.indexOf('sampledLog("gacha-character-draws"')
    const factory = functionSource.indexOf("() =>", sampledCall)
    const formatter = functionSource.indexOf("formatGachaCharacterDrawsSummary", sampledCall)
    assert(sampledCall >= 0)
    assert(factory > sampledCall)
    assert(formatter > factory)
    assert.equal(functionSource.match(/formatGachaCharacterDrawsSummary\(/g)?.length, 1)
    assert.doesNotMatch(functionSource, /JSON\.stringify/)
    assert(!functionSource.slice(sampledCall).includes("\\n"), "summary should stay on one line")

})

test("character projection keeps quarantine marking outside log scheduling", () => {
    const projection = source.slice(source.indexOf("function projectCharacters("))
    assert.equal(projection.match(/gachaSeedQuarantine\.markSent\(/g)?.length, 1)
    assert.ok(projection.indexOf("gachaSeedQuarantine.markSent") < projection.indexOf("scheduleCharacterLog"))
})
