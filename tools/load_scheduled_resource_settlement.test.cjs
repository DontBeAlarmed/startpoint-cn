"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/cn/load.ts"),
    "utf8",
)

test("CN load settles scheduled resources from the captured real-time context", () => {
    assert.match(
        source,
        /import \{ settleScheduledResourcesSync \} from ["']\.\.\/\.\.\/lib\/scheduled-resource-settlement["']/,
    )
    assert.match(source, /const scheduledResourceSettlement = settleScheduledResourcesSync\(\{[\s\S]*?player,[\s\S]*?realNow: gameTime\.realNow,[\s\S]*?dailyResetHour: options\.dailyResetHour \?\? 5,[\s\S]*?itemMaxCounts:[\s\S]*?maxFreeVmoney:[\s\S]*?\}\)/)

    const loginBonusPosition = source.indexOf("const loginBonusSettlement")
    const scheduledPosition = source.indexOf("const scheduledResourceSettlement")
    const serializePosition = source.indexOf("getClientSerializedData(playerId")
    assert.equal(loginBonusPosition >= 0, true)
    assert.equal(scheduledPosition > loginBonusPosition, true)
    assert.equal(serializePosition > scheduledPosition, true)
})

test("CN load refreshes the player only after a successful scheduled grant", () => {
    assert.match(
        source,
        /if \(scheduledResourceSettlement\.status === ["']granted["']\) \{[\s\S]*?player = refreshedPlayer;?[\s\S]*?\}/,
    )
    assert.equal(source.includes("scheduled_resource_bonus"), false)
    assert.equal(source.includes("scheduled_resource_banner"), false)
})

console.log("load scheduled resource settlement tests loaded")
