const assert = require("node:assert/strict")
require("ts-node/register/transpile-only")

const { handleCarnivalEventFinish } = require("../src/lib/quest/finish/carnival-handler")
const { handleRaidEventFinish } = require("../src/lib/quest/finish/raid-handler")
const { handleRushEventFinish } = require("../src/lib/quest/finish/rush-handler")
const { QuestCategory, RushEventFolder } = require("../src/lib/types")
const carnivalEventQuests = require("../assets/carnival_event_quest.json")

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
        folderMaxRounds: {},
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
        folderMaxRounds: {},
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
    })
    assert.equal(raid.quest_boss.kill_count, 5)
    assert.equal(raid.is_out_of_period, false)
}

testCarnivalScoreAndPreviousTotal()
testCarnivalFrameLimitIsConvertedToMilliseconds()
testCarnivalScoreRoundsClearTime()
testCarnivalTimeBonusDoesNotBecomeNegative()
testCarnivalUnclaimedRewardsAreGrantedAtomically()
testFailedSpecialQuestsDoNotProgress()
testRushEndlessProgressAndRaidResponse()
console.log("special quest flow tests passed")
