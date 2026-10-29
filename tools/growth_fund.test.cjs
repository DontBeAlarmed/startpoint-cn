"use strict";

// 成长基金（growth_fund）回归：
// ① 购买身份——load 的 user_info 五个 is_bought_fund_* 恒 true（2026-10-29 裁定，
//    不做购买路径）；② 领取——条件校验（rank / section 1 主线 / section 4 EX）、
//    石类与 999003 券类奖励发放、fund_receive_list 持久化与 load 回传。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "growth-fund-"))
process.env.WDFP_DATABASE_DIR = databaseDirectory

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot({
        additionalTableNames: ["growth_fund.json"],
    })

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerSync, insertDefaultPlayerSync, updatePlayerSync,
} = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { insertPlayerQuestProgressSync } = require("../src/data/domains/quest")
const { getPlayerItemSync } = require("../src/data/domains/item")
const { grantInventoryFixtureItemSync } = require("./helpers/inventory-fixture.cjs")
const { SessionType } = require("../src/data/types")
const { receiveGrowthFundBonusSync } = require("../src/lib/growth-fund")

function cleanup() {
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    delete process.env.WDFP_DATABASE_DIR
}
process.once("exit", cleanup)

data.initializeDatabase()

let playerSeq = 0
async function createPlayer(label) {
    playerSeq += 1
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `growth-fund-${label}-${playerSeq}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 890000000 + playerSeq
    await insertSessionWithToken({
        token: String(viewerId), accountId: account.id,
        expires: new Date("2099-01-01"), type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

test("load identity: user_info carries all five is_bought_fund_* as true", async () => {
    const { playerId } = await createPlayer("identity")
    const { getClientSerializedData } = require("../src/data/utils/player-data")
    const clientData = getClientSerializedData(playerId, {})
    const userInfo = clientData.user_info
    for (const key of [
        "is_bought_fund_main_quest", "is_bought_fund_laite", "is_bought_fund_laite2",
        "is_bought_fund_laite3", "is_bought_fund_ex_quest",
    ]) {
        assert.equal(userInfo[key], true, `${key} 必须默认 true（购买身份）`)
    }
    assert.deepEqual(clientData.fund_receive_list, [], "初始领取列表为空")
})

test("claim laite rank-1 bonus grants free stones and records the id", async () => {
    const { playerId } = await createPlayer("laite-rank1")
    const before = getPlayerSync(playerId)

    const result = receiveGrowthFundBonusSync({ playerId, bonusIds: [1] })
    assert.equal(result.ok, true, result.ok ? "" : result.message)
    assert.deepEqual([...result.result.fundReceiveList], [1])

    const after = getPlayerSync(playerId)
    // bonus 1 = Laite rank1：免费星导石 ×1500（charge=0）
    assert.equal(after.freeVmoney, before.freeVmoney + 1500)
    assert.equal(after.vmoney, before.vmoney, "付费石不动")
})

test("claim main-quest bonus grants stones plus the 999003 ticket", async () => {
    const { playerId } = await createPlayer("main-quest")
    // bonus 12 = 主线 2009007（section 1）：150 免费石 + 999003 单抽券 ×1
    insertPlayerQuestProgressSync(playerId, 1, { questId: 2009007, finished: true })
    grantInventoryFixtureItemSync(playerId, 999003, 5)
    const before = getPlayerSync(playerId)

    const result = receiveGrowthFundBonusSync({ playerId, bonusIds: [12] })
    assert.equal(result.ok, true, result.ok ? "" : result.message)

    const after = getPlayerSync(playerId)
    assert.equal(after.freeVmoney, before.freeVmoney + 150)
    assert.equal(getPlayerItemSync(playerId, 999003), 6, "角色单抽券到账（5+1）")
    // 响应 item_list 是 SET 语义：必须回绝对余额（6），增量 1 会把客户端本地错设
    assert.equal(result.result.items["999003"], 6)
    assert.deepEqual([...result.result.fundReceiveList], [12])
})

test("claim without the condition (uncleared main quest) is rejected in-band", async () => {
    const { playerId } = await createPlayer("condition-fail")
    const before = getPlayerSync(playerId)

    // bonus 13 = 主线 3013003，未通关 → 拒绝
    const result = receiveGrowthFundBonusSync({ playerId, bonusIds: [13] })
    assert.equal(result.ok, false)
    assert.deepEqual(result.rejections, [{ kind: "conditionNotMet", bonusId: 13 }])
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney, "拒绝时不发石")
    assert.equal(getPlayerItemSync(playerId, 999003) ?? 0, 0, "拒绝时不发券")
})

test("double claim is rejected and does not double-grant", async () => {
    const { playerId } = await createPlayer("double")
    const first = receiveGrowthFundBonusSync({ playerId, bonusIds: [1] })
    assert.equal(first.ok, true)
    const granted = getPlayerSync(playerId).freeVmoney

    const second = receiveGrowthFundBonusSync({ playerId, bonusIds: [1] })
    assert.equal(second.ok, false)
    assert.deepEqual(second.rejections, [{ kind: "alreadyReceived", bonusId: 1 }])
    assert.equal(getPlayerSync(playerId).freeVmoney, granted, "不重复发放")
})

test("unknown bonus id is rejected", async () => {
    const { playerId } = await createPlayer("unknown")
    const result = receiveGrowthFundBonusSync({ playerId, bonusIds: [999999] })
    assert.equal(result.ok, false)
    assert.deepEqual(result.rejections, [{ kind: "unknownBonus", bonusId: 999999 }])
})

test("mixed request is all-or-nothing", async () => {
    const { playerId } = await createPlayer("mixed")
    const before = getPlayerSync(playerId)
    // 1 可领，13 条件不足 → 整批拒绝
    const result = receiveGrowthFundBonusSync({ playerId, bonusIds: [1, 13] })
    assert.equal(result.ok, false)
    assert.deepEqual(result.rejections, [{ kind: "conditionNotMet", bonusId: 13 }])
    assert.equal(getPlayerSync(playerId).freeVmoney, before.freeVmoney, "整批不发放")
    const { getPlayerGrowthFundReceivedIdsSync } = require("../src/data/domains/growth-fund")
    assert.deepEqual(getPlayerGrowthFundReceivedIdsSync(playerId), [])
})
