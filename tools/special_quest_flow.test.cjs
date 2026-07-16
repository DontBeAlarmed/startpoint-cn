const assert = require("node:assert/strict")

const { handleCarnivalEventFinish } = require("../out/lib/quest/finish/carnival-handler")
const { handleRaidEventFinish } = require("../out/lib/quest/finish/raid-handler")
const { handleRushEventFinish } = require("../out/lib/quest/finish/rush-handler")
const { QuestCategory, RushEventFolder } = require("../out/lib/types")

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
        getRecordsFn: () => [{ bestScore: 300000 }, { bestScore: 250000 }],
        upsertFn: (...args) => { upsert = args },
    })

    assert.equal(result.score.difficulty_bonus, 200000)
    assert.equal(result.score.time_bonus, 100000)
    assert.equal(result.previous_total_best_score, 550000)
    assert.deepEqual(upsert.slice(0, 4), [7, 1, 1, 300000])
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
testFailedSpecialQuestsDoNotProgress()
testRushEndlessProgressAndRaidResponse()
console.log("special quest flow tests passed")
