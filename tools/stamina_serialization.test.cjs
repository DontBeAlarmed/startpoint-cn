"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

require("ts-node/register/transpile-only")

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stamina-serialization-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = dataDirectory
delete process.env.WDFP_DATABASE_DIR

let restoreSnapshot = () => {}
let closeDatabase = () => {}

function cleanup() {
    restoreSnapshot()
    closeDatabase()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanup)

const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")
restoreSnapshot = installBundledGameplaySnapshot()

const data = require("../src/data")
closeDatabase = data.closeDatabase
data.initializeDatabase()

const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
const { serializePlayerData } = require("../src/data/utils/serialize-player")
const { realToVirtual } = require("../src/utils")
const singleBattleSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/api/singleBattleQuest.ts"),
    "utf8",
)
const multiBattleSource = fs.readFileSync(
    path.join(__dirname, "../src/multi/http/battle.ts"),
    "utf8",
)
const itemSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/api/item.ts"),
    "utf8",
)
const shopSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/api/shop.ts"),
    "utf8",
)

const account = insertAccountSync({
    appId: "wf_cn",
    idpAlias: "",
    idpCode: "stamina-serialization",
    idpId: "stamina-serialization",
    status: "normal",
})
const playerId = insertDefaultPlayerSync(account.id).id
const staleHealTime = new Date(Date.now() - 3_600_000)
updatePlayerSync({ id: playerId, stamina: 5, staminaHealTime: staleHealTime })

const serialized = serializePlayerData(getMergedPlayerDataSync(playerId))
const persisted = getPlayerSync(playerId)
assert.notEqual(persisted, null)
assert.equal(serialized.user_info.stamina, persisted.stamina)
assert.equal(
    serialized.user_info.stamina_heal_time,
    realToVirtual(persisted.staminaHealTime),
)
assert.ok(persisted.staminaHealTime.getTime() > staleHealTime.getTime())
assert.match(singleBattleSource, /"stamina_heal_time": realToVirtual\(startTime\)/)
assert.doesNotMatch(singleBattleSource, /"stamina_heal_time": realToVirtual\(new Date\(\)\)/)
assert.match(multiBattleSource, /"stamina_heal_time": realToVirtual\(startTime\)/)
assert.match(itemSource, /"stamina_heal_time": realToVirtual\(recoveryTime\)/)
assert.match(shopSource, /"stamina_heal_time": realToVirtual\(recoveryTime\)/)

console.log("stamina serialization snapshot tests passed")
cleanup()
process.removeListener("exit", cleanup)
