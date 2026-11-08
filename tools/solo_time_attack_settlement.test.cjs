"use strict"

// 极时试炼(solo_time_attack)结算测试:
// - #20 契约:finish 响应补 solo_time_attack_event 块(时间/历史最佳/新跨档 id)
// - #16 时间线奖励:通关时间 ≤ 分线阈值即获得该档;最佳时间单调 → 只补发
//   「本次新跨过」的档;奖励=星导石,按行内 reason_id 发 FREE_VMONEY 邮件
//   (帮助 Event_solo_time_attack L41-43 + 客户端 BattleQuestFinishRealRemote
//   :2257-2373 契约)

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const test = require("node:test")

const { handleSoloTimeAttackEventFinish } = require("../src/lib/quest/finish/solo-time-attack-handler")
const { createEventSettlementDescriptor } = require("../src/lib/quest/finish/event-settlement-descriptor")
const { QuestCategory } = require("../src/lib/types")

// 内容层真值抽验(事件 1 / 任务 3 的前两档):阈值秒数与星导石数
const TIERS = [
    { id: 111, eventId: 1, questId: 3, name: "7分以内通关", clearTimeSeconds: 420, mailReasonId: 15007, stoneCount: 10 },
    { id: 110, eventId: 1, questId: 3, name: "6分50秒以内通关", clearTimeSeconds: 410, mailReasonId: 15007, stoneCount: 10 },
    { id: 109, eventId: 1, questId: 3, name: "6分40秒以内通关", clearTimeSeconds: 400, mailReasonId: 15007, stoneCount: 10 },
    { id: 75, eventId: 1, questId: 2, name: "别的任务线", clearTimeSeconds: 420, mailReasonId: 15007, stoneCount: 10 },
]

const PARTY = { characters: [{ id: 211003 }, { id: 221003 }, { id: 231003 }] }

function runHandler(t, { elapsedMs, previous, isAccomplished = true }) {
    const mails = []
    let progress = previous ?? null
    const deleted = []
    const result = handleSoloTimeAttackEventFinish({
        playerId: 1,
        questId: 1003,
        eventId: 1,
        soloQuestId: 3,
        elapsedTimeMs: elapsedMs,
        isAccomplished,
        clearRank: 3,
        party: PARTY,
        // dispatcher 契约:tiers 已按(event, quest)解析——与
        // resolveSoloTimeAttackTimelineTiers 同口径
        tiers: TIERS.filter(tier => tier.eventId === 1 && tier.questId === 3),
    }, {
        transaction: operation => operation(),
        getProgress: () => progress,
        insertProgress: (pid, category, row) => { progress = row },
        updateProgress: (pid, category, row) => { progress = row },
        deleteActiveQuest: pid => deleted.push(pid),
        insertRewardMail: (pid, mail) => mails.push(mail),
    })
    return { result, mails, progress, deleted }
}

test("descriptor: solo time attack quests resolve the soloTimeAttack kind", () => {
    const descriptor = createEventSettlementDescriptor({
        questCategory: QuestCategory.SOLO_TIME_ATTACK_EVENT,
        questId: 1003,
        quest: { eventId: 1, soloTimeAttackQuestId: 3 },
    })
    assert.equal(descriptor.kind, "soloTimeAttack")
    assert.equal(descriptor.eventId, 1)
    assert.equal(descriptor.soloQuestId, 3)
})

test("first clear grants every crossed tier as reward mails and reports the response block", t => {
    const { result, mails, progress } = runHandler(t, { elapsedMs: 405_000 })
    // 405s:跨 420/410 两档(400 档需 ≤400s,405 未达)
    assert.deepEqual(result.soloTimeAttackEvent.reward_ids, [111, 110])
    assert.equal(result.soloTimeAttackEvent.elapsed_time_ms, 405_000)
    assert.deepEqual(result.soloTimeAttackEvent.main_character_ids, { 0: 211003, 1: 221003, 2: 231003 })
    assert.equal(result.soloTimeAttackEvent.previous_best_elapsed_time_ms, null)
    assert.deepEqual(result.soloTimeAttackEvent.new_degree_ids, [])
    assert.equal(mails.length, 2)
    assert.ok(mails.every(mail => mail.stoneCount === 10))
    assert.deepEqual(mails.map(mail => mail.reasonId), [15007, 15007])
    assert.equal(progress.bestElapsedTimeMs, 405_000)
    assert.equal(progress.finished, true)
    assert.deepEqual(result.rewardResult, null)
})

test("repeat finish only grants newly crossed tiers and never regresses the best", t => {
    const { result, mails, progress } = runHandler(t, {
        elapsedMs: 395_000,
        previous: {
            questId: 1003, finished: true, highScore: 0, clearRank: 3,
            bestElapsedTimeMs: 405_000, leaderCharacterId: 211003,
        },
    })
    // 395s:只有 400→新跨(420/410 早已跨过);395 ≤ 400 且 405 > 400
    assert.deepEqual(result.soloTimeAttackEvent.reward_ids, [109])
    assert.equal(mails.length, 1)
    assert.equal(progress.bestElapsedTimeMs, 395_000)

    // 更差的一次:不跨新线、最佳不回退、无邮件
    const worse = runHandler(t, {
        elapsedMs: 415_000,
        previous: {
            questId: 1003, finished: true, highScore: 0, clearRank: 3,
            bestElapsedTimeMs: 395_000, leaderCharacterId: 211003,
        },
    })
    assert.deepEqual(worse.result.soloTimeAttackEvent.reward_ids, [])
    assert.equal(worse.mails.length, 0)
    assert.equal(worse.progress.bestElapsedTimeMs, 395_000)
    assert.deepEqual(worse.result.soloTimeAttackEvent.previous_best_elapsed_time_ms, 395_000)
})

test("failed runs grant nothing and other quest lines are filtered out", t => {
    const failed = runHandler(t, { elapsedMs: 100_000, isAccomplished: false })
    assert.deepEqual(failed.result.soloTimeAttackEvent.reward_ids, [])
    assert.equal(failed.mails.length, 0)
    assert.equal(failed.progress, null)

    // 别的任务线(questId 2)的档不参与本任务结算
    const other = runHandler(t, { elapsedMs: 100_000, previous: null })
    assert.ok(other.result.soloTimeAttackEvent.reward_ids.every(id => id !== 75))
})
