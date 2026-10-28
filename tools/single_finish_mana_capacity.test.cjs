"use strict";

// R-F03 反例回归：单人 finish 的固定+战斗玛纳入账走总额容量口径
//（planManaCapacity，与 item-sell/event-trade/reward-grant 引擎一致）——
// 越顶部分转 FREE_MANA 溢出邮件，钱包封顶，响应投影封顶后值。

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const test = require("node:test")

const { withSingleBattleHarness } = require("./perf/single_battle_settlement_harness.cjs")
const { getCurrencyCapacityPolicySync } = require("../src/lib/config-content")

const HUGE_FIELD_MANA = 1_000_000

test("single finish caps fixed+field mana at the free+paid total and mails the overflow (R-F03)", async () => {
    await withSingleBattleHarness("finish-mana-capacity", async harness => {
        harness.makeAwakeEligible()
        const maxMana = getCurrencyCapacityPolicySync().maxMana
        // 钱包顶到上限-10：本次入账无论固定玛纳多少，容量只剩 10
        harness.updatePlayer({ freeMana: maxMana - 10, paidMana: 0 })
        harness.insertActiveQuest(harness.createActiveQuest({ playId: "rf03-mana-cap" }))

        const response = await harness.post(
            "finish",
            harness.finishPayload({ playId: "rf03-mana-cap", addMana: HUGE_FIELD_MANA }),
        )
        assert.equal(response.statusCode, 200, response.body)

        // 钱包封顶：不得超过 max（旧实现直写 max-10+fixed+1e6）
        const player = harness.getPlayer()
        assert.equal(player.freeMana, maxMana, "finish 入账后 freeMana 必须封顶在总额上限")

        // 溢出部分必须转 FREE_MANA 邮件（type=8）：溢出量 = fixed+1e6-10，
        // fixed 为 bundled 任务玛纳奖励（≥0 且远小于 1e6）——夹逼验证
        const overflowMails = harness.db.prepare(
            "SELECT number FROM players_mails WHERE player_id = ? AND type = 8 AND receive_time = '0000-00-00 00:00:00'"
        ).all(player.id).map(row => row.number)
        assert.ok(overflowMails.length > 0, "越顶部分必须落入 FREE_MANA 溢出邮件")
        const mailedTotal = overflowMails.reduce((sum, n) => sum + n, 0)
        assert.ok(
            mailedTotal >= HUGE_FIELD_MANA - 10 && mailedTotal <= HUGE_FIELD_MANA + 10_000,
            `溢出邮件总量必须≈fixed+${HUGE_FIELD_MANA}-10（实际 ${mailedTotal}）`,
        )

        // 响应投影封顶后值（N-06 投影链；post 已解码 msgpack）
        const userInfo = response.data?.user_info ?? {}
        assert.equal(userInfo.free_mana, maxMana, "finish 响应 user_info.free_mana 必须投影封顶后值")
    })
})
