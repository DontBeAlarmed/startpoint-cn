"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { MailType } = require("../src/data/domains/mail")
const { RewardType } = require("../src/lib/types")

function mail(id, type, typeId, number) {
    return {
        id,
        player_id: 1,
        reason_id: 0,
        subject: null,
        description: null,
        type,
        type_id: typeId,
        number,
        receive_time: "0000-00-00 00:00:00",
        create_time: "2026-08-18 00:00:00",
        reward_period_limited: 0,
        reward_limit_time: null,
    }
}

test("mail adapter maps only standard rewards and preserves source order", () => {
    let createMailRewardPlan
    assert.doesNotThrow(() => {
        ({ createMailRewardPlan } = require("../src/lib/mail-reward-grant"))
    }, "mail reward adapter must exist")

    const plan = createMailRewardPlan([
        mail(10, MailType.ITEM, 30005, 2),
        mail(11, MailType.PAID_VMONEY, null, 3),
        mail(12, MailType.CHARACTER, 1, 3),
        mail(13, MailType.FREE_VMONEY, null, 4),
        mail(14, MailType.EQUIPMENT, 3010006, 2),
        mail(15, MailType.FREE_MANA, null, 5),
        mail(16, MailType.EXP_POOL, null, 6),
        mail(17, MailType.STAR_CRUMB, null, 7),
    ])

    assert.deepEqual(plan.entries.map(entry => entry.source), [
        { mailId: 10, attachmentIndex: 0 },
        { mailId: 12, attachmentIndex: 0 },
        { mailId: 12, attachmentIndex: 1 },
        { mailId: 12, attachmentIndex: 2 },
        { mailId: 13, attachmentIndex: 0 },
        { mailId: 14, attachmentIndex: 0 },
        { mailId: 15, attachmentIndex: 0 },
        { mailId: 16, attachmentIndex: 0 },
    ])
    assert.deepEqual(plan.entries.map(entry => entry.reward), [
        { type: RewardType.ITEM, id: 30005, count: 2 },
        { type: RewardType.CHARACTER, id: 1 },
        { type: RewardType.CHARACTER, id: 1 },
        { type: RewardType.CHARACTER, id: 1 },
        { type: RewardType.BEADS, count: 4 },
        { type: RewardType.EQUIPMENT, id: 3010006, count: 2 },
        { type: RewardType.MANA, count: 5 },
        { type: RewardType.EXP, count: 6 },
    ])
})
