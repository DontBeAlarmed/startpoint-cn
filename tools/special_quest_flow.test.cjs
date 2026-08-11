const assert = require("node:assert/strict")
require("ts-node/register/transpile-only")

const { handleCarnivalEventFinish } = require("../src/lib/quest/finish/carnival-handler")
const { handleRaidEventFinish } = require("../src/lib/quest/finish/raid-handler")
const { handleRushEventFinish } = require("../src/lib/quest/finish/rush-handler")
const { QuestCategory, RushEventFolder } = require("../src/lib/types")
let hostFinish = {}
try {
    hostFinish = require("../src/lib/quest/host-finish")
} catch {
    // The first TDD run intentionally reaches this branch before the module exists.
}
const carnivalEventQuests = require("../assets/carnival_event_quest.json")

assert.equal(typeof hostFinish.resolveHostFinished, "function")
assert.equal(typeof hostFinish.resolveIsRoomHost, "function")

const party = {
    characters: [{ id: 101 }, { id: 102 }, null],
    unison_characters: [{ id: 201 }, null, null],
    equipments: [{ id: 301 }, null, null],
    ability_soul_ids: [401, null, null],
    leader: { id: 101 },
}

function testCarnivalScoreAndPreviousTotal() {
    let upsert = null
    const result = handleCarnivalEventFinish({
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questAccomplished: true,
        questId: 1001,
        questData: { eventId: 1, folderId: 1, difficultyScore: 200000, timeLimitMs: 108000 },
        clearTime: 8000,
        party,
        playerId: 7,
        getRecordsFn: () => [{ folderId: 1, bestScore: 300000 }, { folderId: 2, bestScore: 250000 }],
        upsertFn: (...args) => { upsert = args },
    })

    assert.equal(result.carnivalEventData.score.difficulty_bonus, 200000)
    assert.equal(result.carnivalEventData.score.time_bonus, 100000)
    assert.equal(result.carnivalEventData.previous_total_best_score, 550000)
    assert.deepEqual(upsert.slice(0, 4), [7, 1, 1, 300000])
}

function testCarnivalLeaderFallsBackToFirstPartyCharacter() {
    const result = handleCarnivalEventFinish({
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questAccomplished: true,
        questId: 1,
        questData: { eventId: 1, folderId: 1, difficultyScore: 200000, timeLimitMs: 108000 },
        clearTime: 8000,
        party: {
            characters: [{ id: 101 }, { id: 102 }, null],
            unison_characters: [{ id: 201 }, null, null],
        },
        playerId: 7,
        getRecordsFn: () => [],
        upsertFn: () => {},
    })

    assert.equal(result.carnivalEventData.leader_character_id, 101)
}

function testCarnivalFrameLimitIsConvertedToMilliseconds() {
    let upsert = null
    const questData = carnivalEventQuests["250604002"]
    const result = handleCarnivalEventFinish({
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questAccomplished: true,
        questId: 250604002,
        questData,
        clearTime: 166277,
        party,
        playerId: 17,
        getRecordsFn: () => [],
        upsertFn: (...args) => { upsert = args },
    })

    assert.equal(questData.timeLimitMs, 1200000)
    assert.equal(result.carnivalEventData.score.time_bonus, 1033723)
    assert.deepEqual(upsert.slice(0, 4), [17, 250604, 1, 3033723])
}

function testCarnivalScoreRoundsClearTime() {
    const result = handleCarnivalEventFinish({
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questAccomplished: true,
        questId: 250604002,
        questData: carnivalEventQuests["250604002"],
        clearTime: 166277.6,
        party,
        playerId: 17,
        getRecordsFn: () => [],
        upsertFn: () => {},
    })

    assert.equal(result.carnivalEventData.score.time_bonus, 1033722)
}

function testCarnivalTimeBonusDoesNotBecomeNegative() {
    const result = handleCarnivalEventFinish({
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questAccomplished: true,
        questId: 250604002,
        questData: carnivalEventQuests["250604002"],
        clearTime: 1200000.6,
        party,
        playerId: 17,
        getRecordsFn: () => [],
        upsertFn: () => {},
    })

    assert.equal(result.carnivalEventData.score.time_bonus, 0)
}

function testCarnivalUnclaimedRewardsAreGrantedAtomically() {
    const calls = []
    const rewardResult = {
        user_info: { free_vmoney: 100, free_mana: 200, exp_pool: 300 },
        item_list: { 1: 50 },
        equipment_list: [{ id: 5001 }],
        new_degree_ids: [61000],
    }
    const result = handleCarnivalEventFinish({
        questCategory: QuestCategory.CARNIVAL_EVENT,
        questAccomplished: true,
        questId: 250604002,
        questData: carnivalEventQuests["250604002"],
        clearTime: 166277,
        party,
        playerId: 17,
        getRecordsFn: () => [
            { folderId: 1, bestScore: 3033723 },
            { folderId: 2, bestScore: 2695509 },
        ],
        upsertFn: () => { calls.push("upsert") },
        getRewardDefinitionsFn: () => [
            { id: 1230, eventId: 250604, score: 5500000, reasonId: 20001, rewards: [] },
            { id: 1231, eventId: 250604, score: 5700000, reasonId: 20001, rewards: [] },
        ],
        getClaimedRewardIdsFn: () => new Set([1230]),
        grantRewardsFn: (_playerId, definitions) => {
            calls.push(`grant:${definitions.map(value => value.id).join(",")}`)
            return rewardResult
        },
        claimRewardIdsFn: (_playerId, _eventId, rewardIds) => {
            calls.push(`claim:${rewardIds.join(",")}`)
        },
        transactionFn: operation => {
            calls.push("begin")
            const value = operation()
            calls.push("commit")
            return value
        },
    })

    assert.deepEqual(calls, ["begin", "upsert", "grant:1231", "claim:1231", "commit"])
    assert.deepEqual(result.carnivalEventData.reward_ids, [1231])
    assert.deepEqual(result.carnivalEventData.new_degree_ids, [61000])
    assert.equal(result.carnivalEventData.previous_total_best_score, 5699999)
    assert.deepEqual(result.rewardResult, rewardResult)
}

function testFailedSpecialQuestsDoNotProgress() {
    let writes = 0
    const rush = handleRushEventFinish({
        questCategory: QuestCategory.RUSH_EVENT,
        questAccomplished: false,
        questData: { rushEventId: 700001, rushEventFolderId: RushEventFolder.INTERMEDIATE, rushEventRound: 0 },
        clearTime: 1000,
        party,
        playerId: 7,
        questId: 700001007,
        getEvoLevels: () => [1, 1, null],
        getRushEvent: () => null,
        updateRushEvent: () => { writes++ },
        insertParty: () => { writes++ },
        insertClearedFolder: () => { writes++ },
        deletePartyList: () => { writes++ },
        getSerializedParties: () => ({ folderParties: null, endlessParties: null }),
        getFolderRewards: () => [],
        giveRewards: () => null,
    })
    const raid = handleRaidEventFinish({
        questCategory: QuestCategory.RAID_EVENT,
        questAccomplished: false,
        activeEventId: 1,
        killCountWeight: 2,
        party,
        playerId: 7,
        questId: 1001,
        getEvoLevelsFn: () => [1, 1, null],
        insertPartyFn: () => { writes++ },
    })

    assert.equal(writes, 0)
    assert.equal(rush.rushEventData, null)
    assert.equal(raid, null)
}

function testAdventHostFinishState() {
    assert.equal(hostFinish.resolveIsRoomHost({
        roomHostPlayerId: 17,
        playerId: 17,
    }), true)
    assert.equal(hostFinish.resolveIsRoomHost({
        roomHostPlayerId: 18,
        playerId: 17,
    }), false)
    assert.equal(hostFinish.resolveIsRoomHost({
        roomHostPlayerId: null,
        playerId: 17,
    }), undefined)

    assert.equal(hostFinish.resolveHostFinished({
        previouslyHostFinished: false,
        questAccomplished: true,
        isRoomHost: true,
    }), true)
    assert.equal(hostFinish.resolveHostFinished({
        previouslyHostFinished: false,
        questAccomplished: true,
        isRoomHost: false,
    }), false)
    assert.equal(hostFinish.resolveHostFinished({
        previouslyHostFinished: false,
        questAccomplished: true,
        isRoomHost: undefined,
    }), false)
    assert.equal(hostFinish.resolveHostFinished({
        previouslyHostFinished: false,
        questAccomplished: false,
        isRoomHost: true,
    }), false)
    assert.equal(hostFinish.resolveHostFinished({
        previouslyHostFinished: true,
        questAccomplished: true,
        isRoomHost: false,
    }), true)
}

function testRushEndlessProgressAndRaidResponse() {
    const writes = []
    const rush = handleRushEventFinish({
        questCategory: QuestCategory.RUSH_EVENT,
        questAccomplished: true,
        questData: { rushEventId: 700001, rushEventFolderId: RushEventFolder.INTERMEDIATE, rushEventRound: 0 },
        clearTime: 12345,
        party,
        playerId: 7,
        questId: 700001007,
        getEvoLevels: () => [1, 1, null],
        getRushEvent: () => ({ endlessBattleNextRound: 1, endlessBattleMaxRound: null, endlessBattleMaxRoundTime: null }),
        updateRushEvent: (_pid, data) => writes.push(data),
        insertParty: (_pid, _eid, data) => writes.push(data),
        insertClearedFolder: () => assert.fail("endless battle cannot clear a folder"),
        deletePartyList: () => assert.fail("endless battle cannot delete folder parties"),
        getSerializedParties: () => ({ folderParties: null, endlessParties: { 1: {} } }),
        getFolderRewards: () => [],
        giveRewards: () => null,
    })
    assert.equal(rush.rushEventData.endless_battle_next_round, 2)
    assert.equal(rush.rushEventData.endless_battle_max_round, 1)

    let raidState
    const raid = handleRaidEventFinish({
        questCategory: QuestCategory.RAID_EVENT,
        questAccomplished: true,
        activeEventId: 3,
        killCountWeight: 5,
        party,
        playerId: 7,
        questId: 3001,
        getEvoLevelsFn: () => [1, 1, null],
        insertPartyFn: () => {},
        getRequiredKillCountFn: () => 100,
        getRaidBossStateFn: () => ({ weightedKillCount: 20, totalKillCount: 7 }),
        updateRaidBossStateFn: (_eventId, state) => { raidState = state },
        incrementQuestKillCountFn: () => 4,
    })
    assert.equal(raid.quest_boss.kill_count, 4)
    assert.deepEqual(raid.raid_boss, { hp_percentage: 75, total_kill_count: 7 })
    assert.deepEqual(raidState, { weightedKillCount: 25, totalKillCount: 7 })
    assert.equal(raid.is_out_of_period, false)
    assert.equal("kill_count_reward_data" in raid, false, "finish 响应不得携带客户端不读取的事件奖励")
}

function testRaidWeightedBossProgress() {
    let state = { weightedKillCount: 499_900, totalKillCount: 1 }
    let questKillCount = 0
    const runFinish = (killCountWeight) => handleRaidEventFinish({
        questCategory: QuestCategory.RAID_EVENT,
        questAccomplished: true,
        activeEventId: 4,
        killCountWeight,
        party,
        playerId: 7,
        questId: 4001,
        getEvoLevelsFn: () => [1, 1, null],
        insertPartyFn: () => {},
        getRequiredKillCountFn: () => 500_000,
        getRaidBossStateFn: () => state,
        updateRaidBossStateFn: (_eventId, nextState) => { state = nextState },
        incrementQuestKillCountFn: () => ++questKillCount,
    })

    const crossing = runFinish(200)
    assert.deepEqual(state, { weightedKillCount: 0, totalKillCount: 2 })
    assert.deepEqual(crossing.raid_boss, { hp_percentage: 100, total_kill_count: 2 })
    assert.equal(crossing.quest_boss.kill_count, 1)

    const next = runFinish(200)
    assert.deepEqual(state, { weightedKillCount: 200, totalKillCount: 2 })
    assert.deepEqual(next.raid_boss, { hp_percentage: 100, total_kill_count: 2 })
    assert.equal(next.quest_boss.kill_count, 2)

    assert.throws(() => handleRaidEventFinish({
        questCategory: QuestCategory.RAID_EVENT,
        questAccomplished: true,
        activeEventId: 4,
        killCountWeight: undefined,
        party,
        playerId: 7,
        questId: 4001,
        getEvoLevelsFn: () => [1, 1, null],
        insertPartyFn: () => {},
        getRequiredKillCountFn: () => 500_000,
        getRaidBossStateFn: () => state,
        updateRaidBossStateFn: () => assert.fail("非法权重不得写 Boss 状态"),
        incrementQuestKillCountFn: () => assert.fail("非法权重不得增加关卡次数"),
    }), /invalid raid quest kill count weight/)
}

function testRushFolderRewardsAreGrantedOnlyOnFirstClear() {
    let firstClear = true
    let grantCount = 0
    const calls = []
    const runFinish = () => handleRushEventFinish({
        questCategory: QuestCategory.RUSH_EVENT,
        questAccomplished: true,
        questData: {
            rushEventId: 700011,
            rushEventFolderId: RushEventFolder.INTERMEDIATE,
            rushEventRound: 2,
        },
        clearTime: 12345,
        party,
        playerId: 7,
        questId: 700011002,
        getEvoLevels: () => [1, 1, null],
        folderMaxRound: 2,
        getRushEvent: () => null,
        updateRushEvent: () => { calls.push("update") },
        insertParty: () => assert.fail("最终回合不能保存下一回合配队"),
        insertClearedFolder: () => {
            calls.push("insert")
            const inserted = firstClear
            firstClear = false
            return inserted
        },
        deletePartyList: () => { calls.push("delete") },
        getSerializedParties: () => ({ folderParties: null, endlessParties: null }),
        getFolderRewards: () => [{ type: 0, id: 2370001, count: 100 }],
        giveRewards: () => {
            grantCount++
            calls.push("grant")
            return { items: { "2370001": 100 } }
        },
        transaction: operation => {
            calls.push("begin")
            const value = operation()
            calls.push("commit")
            return value
        },
    })

    const first = runFinish()
    assert.equal(grantCount, 1)
    assert.deepEqual(first.rushEventData.rush_battle_reward_list, [
        { kind: 1, kind_id: 2370001, number: 100 },
    ])

    calls.length = 0
    const repeated = runFinish()
    assert.equal(grantCount, 1, "重复通关已记录的文件夹不得再次发奖")
    assert.deepEqual(repeated.rushEventData.rush_battle_reward_list, [])
    assert.deepEqual(calls, ["begin", "insert", "update", "delete", "commit"])
}

testCarnivalScoreAndPreviousTotal()
testCarnivalLeaderFallsBackToFirstPartyCharacter()
testCarnivalFrameLimitIsConvertedToMilliseconds()
testCarnivalScoreRoundsClearTime()
testCarnivalTimeBonusDoesNotBecomeNegative()
testCarnivalUnclaimedRewardsAreGrantedAtomically()
testFailedSpecialQuestsDoNotProgress()
testAdventHostFinishState()
testRushEndlessProgressAndRaidResponse()
    testRaidWeightedBossProgress()
testRushFolderRewardsAreGrantedOnlyOnFirstClear()
console.log("special quest flow tests passed")
