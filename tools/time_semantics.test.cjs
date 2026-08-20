"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

require("ts-node/register/transpile-only")

const utils = require("../src/utils")
const gameTime = require("../src/runtime/time/game-time")
const originalOffset = utils.getTimeOffset()
const realDate = new Date("2026-08-20T00:00:00.000Z")
const offsetMs = -24 * 60 * 60 * 1000

try {
    utils.setServerTimeOffset(offsetMs)
    const context = gameTime.getGameTimeContext(realDate.getTime())
    assert.equal(context.realNowMs, realDate.getTime())
    assert.equal(context.virtualNowMs, realDate.getTime() + offsetMs)
    assert.equal(gameTime.getVirtualElapsedSeconds(realDate.getTime() + offsetMs - 120_000, context.virtualNowMs), 120)
    assert.equal(gameTime.getRealElapsedSeconds(realDate.getTime() - 120_000, context.realNowMs), 120)
    const virtualSeconds = utils.realToVirtual(realDate)
    assert.equal(
        utils.realDateFromServerTime(virtualSeconds).getTime(),
        realDate.getTime(),
        "real-time persistence fields must round-trip through the virtual client timestamp",
    )

    const staminaSource = fs.readFileSync(
        path.join(__dirname, "../src/lib/stamina.ts"),
        "utf8",
    )
    assert.match(staminaSource, /getRealNowMs\(\)/)
    assert.doesNotMatch(staminaSource, /getServerTime\(|getServerDate\(/)

    const playerSource = fs.readFileSync(
        path.join(__dirname, "../src/data/domains/player.ts"),
        "utf8",
    )
    assert.match(
        playerSource,
        /collectPlayerDataPooledExpSync\([\s\S]*?dateNow: Date = getVirtualNow\(\)/,
    )

    const clientSource = fs.readFileSync(
        path.join(
            __dirname,
            "../../wf-2.1.125-cn-decompiled/scripts/scripts/pinball/common/data/player/PlayerLogic.as",
        ),
        "utf8",
    )
    assert.match(clientSource, /get_currentPooledExp[\s\S]*?timeProvider\.getTime\(\)/)
    assert.match(clientSource, /pooled_exp_gain_time/)

    console.log("time semantics tests passed")
} finally {
    utils.setServerTimeOffset(originalOffset)
}
