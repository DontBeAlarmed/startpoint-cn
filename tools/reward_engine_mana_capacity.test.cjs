"use strict";

// R-G01 反例回归：奖励引擎直发 RewardType.MANA 走总额容量口径（free+paid ≤ max），
// 越顶部分转 FREE_MANA 溢出邮件（type=8）——与 item-sell/event-trade/single-finish
// 同政。两个载体：引擎直发（计划级）+ 礼包码兑换（真实生产者，经引擎）。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reward-engine-mana-cap-"))
process.env.WDFP_DATABASE_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../src/data/domains/player")
const { getCurrencyCapacityPolicySync } = require("../src/lib/config-content")

function cleanup() {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    delete process.env.WDFP_DATABASE_DIR
}
process.once("exit", cleanup)

data.initializeDatabase()

let playerSeq = 0
function createPlayer(label) {
    playerSeq += 1
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `mana-cap-${label}-${playerSeq}-${path.basename(databaseDirectory)}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

function overflowManaMailTotal(playerId) {
    return getDb().prepare(
        "SELECT number FROM players_mails WHERE player_id = ? AND type = 8 AND receive_time = '0000-00-00 00:00:00'"
    ).all(playerId).reduce((sum, row) => sum + row.number, 0)
}

function nearTopWallet(playerId, margin = 10, paidMana = 900) {
    const maxMana = getCurrencyCapacityPolicySync().maxMana
    updatePlayerSync({ id: playerId, freeMana: maxMana - margin - paidMana, paidMana })
    return maxMana
}

test("engine direct MANA grant caps the free+paid total and mails the overflow (R-G01)", () => {
    const {
        createRewardGrantExecutionPlan,
        executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    } = require("../src/lib/reward-grant")
    const { RewardType } = require("../src/lib/types/rewards")

    const playerId = createPlayer("engine-direct")
    const maxMana = nearTopWallet(playerId)
    // 容量只剩 10：直发 100 玛纳，90 必须转邮件
    const plan = createRewardGrantExecutionPlan([
        { type: RewardType.MANA, count: 100 },
    ])

    getDb().transaction(() => {
        executeRewardGrantExecutionPlanAsTransactionOwnerSync(
            playerId,
            plan,
            {
                playerId,
                freeMana: getPlayerSync(playerId).freeMana,
                freeVmoney: getPlayerSync(playerId).freeVmoney,
                expPool: getPlayerSync(playerId).expPool,
            },
        )
    })()

    const player = getPlayerSync(playerId)
    assert.equal(player.freeMana + player.paidMana, maxMana,
        "引擎直发玛纳后 free+paid 总额必须封顶在 maxMana")
    assert.equal(overflowManaMailTotal(playerId), 90,
        "越顶 90 点必须落入 FREE_MANA 溢出邮件")
})

test("gift code redemption caps direct MANA reward at the wallet total (R-G01)", () => {
    const { createGiftSync, startGiftSync } = require("../src/data/domains/gift")
    const { receiveGiftCodeSync } = require("../src/lib/gift-code/redemption")

    const playerId = createPlayer("gift-redeem")
    const maxMana = nearTopWallet(playerId)

    const gift = createGiftSync({
        code: "R-G01-MANA-100",
        note: "mana capacity counterexample",
        rewards: [{ position: 0, type: 8, typeId: null, number: 100 }],
    })
    startGiftSync(gift.id, gift.revision)

    const result = receiveGiftCodeSync(playerId, "R-G01-MANA-100")
    assert.notEqual(result.kind, "invalid", `礼包码必须有效（实际 ${result.kind}）`)

    const player = getPlayerSync(playerId)
    assert.equal(player.freeMana + player.paidMana, maxMana,
        "兑换直发玛纳后 free+paid 总额必须封顶在 maxMana")
    assert.equal(overflowManaMailTotal(playerId), 90,
        "越顶 90 点必须落入 FREE_MANA 溢出邮件")
})
