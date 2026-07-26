require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")

const { resolveQuestRewardEligibility } = require("../src/lib/quest/first-clear-reward")

const cases = [
    {
        name: "失败结算不发首通或 S+",
        input: { questAccomplished: false, clearRank: 5, questProgress: null },
        expected: { firstClear: false, sPlus: false },
    },
    {
        name: "无历史进度的首次 S+ 同时发首通和 S+",
        input: { questAccomplished: true, clearRank: 5, questProgress: null },
        expected: { firstClear: true, sPlus: true },
    },
    {
        name: "unfinished 历史行的首次 S+ 同时发首通和 S+",
        input: {
            questAccomplished: true,
            clearRank: 5,
            questProgress: { finished: false, clearRank: 4 },
        },
        expected: { firstClear: true, sPlus: true },
    },
    {
        name: "finished 历史行不再发首通但可首次发 S+",
        input: {
            questAccomplished: true,
            clearRank: 5,
            questProgress: { finished: true, clearRank: 4 },
        },
        expected: { firstClear: false, sPlus: true },
    },
    {
        name: "重复 S+ 不重复发任何资格奖励",
        input: {
            questAccomplished: true,
            clearRank: 5,
            questProgress: { finished: true, clearRank: 5 },
        },
        expected: { firstClear: false, sPlus: false },
    },
    {
        name: "首次成功但未到 S+ 只发首通",
        input: { questAccomplished: true, clearRank: 4, questProgress: null },
        expected: { firstClear: true, sPlus: false },
    },
]

for (const testCase of cases) {
    assert.deepEqual(
        resolveQuestRewardEligibility(testCase.input),
        testCase.expected,
        testCase.name,
    )
}

console.log("first clear reward tests passed")
