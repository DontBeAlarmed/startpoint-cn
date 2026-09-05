"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { handleRushEventFinish } = require("../src/lib/quest/finish/rush-handler")
const { QuestCategory } = require("../src/lib/types")

function clientTransition(rushEvent, battleStartRemainingTimes) {
    if (rushEvent.rush_battle_reward_list.length === 0) return "no-clear-dialog"
    return battleStartRemainingTimes > 0 ? "auto-retry" : "complete"
}

function finalFolderFinish(isFirstClear) {
    let granted = 0
    const settlement = handleRushEventFinish({
        questCategory: QuestCategory.RUSH_EVENT,
        questAccomplished: true,
        questData: {
            rushEventId: 700001,
            rushEventFolderId: 1,
            rushEventRound: 2,
        },
        clearTime: 1_000,
        party: {
            characters: [null, null, null],
            unison_characters: [null, null, null],
            equipments: [null, null, null],
            ability_soul_ids: [null, null, null],
        },
        playerId: 1,
        questId: 700001002,
        getEvoLevels: () => [null, null, null],
        folderMaxRound: 2,
        getRushEvent: () => null,
        updateRushEvent: () => {},
        insertParty: () => assert.fail("final round must not store the next party"),
        insertClearedFolder: () => isFirstClear,
        deletePartyList: () => {},
        getSerializedParties: () => ({ folderParties: {}, endlessParties: {} }),
        getFolderRewards: () => [{ type: 0, id: 2370001, count: 100 }],
        giveRewards: () => {
            granted++
            return { items: { "2370001": 100 } }
        },
        transaction: operation => operation(),
    })
    return { ...settlement, granted }
}

test("current first-clear response provides the CN client AutoRetry transition", () => {
    const result = finalFolderFinish(true)
    assert.equal(result.granted, 1)
    assert.equal(clientTransition(result.rushEventData, 1), "auto-retry")
})

test("current repeated-clear response characterizes the unresolved AutoRetry gap", () => {
    const result = finalFolderFinish(false)
    assert.equal(result.granted, 0)
    assert.deepEqual(result.rushEventData.rush_battle_reward_list, [])
    assert.equal(clientTransition(result.rushEventData, 1), "no-clear-dialog")
})
