"use strict"

const clearRewards = require("../../assets/clear_reward.json")
const mainQuests = require("../../assets/main_quest.json")
const {
    ENTRY_CATEGORY,
    ENTRY_QUEST_ID,
    MAIN_CATEGORY,
    MAIN_QUEST_ID,
    VIEWER_ID,
} = require("./single_battle_settlement_harness.cjs")

const MAIN_QUEST_KEY = `${MAIN_CATEGORY}_${MAIN_QUEST_ID}`
const ENTRY_QUEST_KEY = `${ENTRY_CATEGORY}_${ENTRY_QUEST_ID}`

function assertSuccessful(response, label) {
    if (response.statusCode !== 200) {
        throw new Error(`${label} failed: ${JSON.stringify(response)}`)
    }
}

function mergeSqlSnapshots(snapshots) {
    const merged = {
        statements: 0,
        selectStatements: 0,
        writeStatements: 0,
        transactionStatements: 0,
        byTable: {},
    }
    for (const snapshot of snapshots) {
        merged.statements += snapshot.statements
        merged.selectStatements += snapshot.selectStatements
        merged.writeStatements += snapshot.writeStatements
        merged.transactionStatements += snapshot.transactionStatements
        for (const [table, counts] of Object.entries(snapshot.byTable)) {
            const target = merged.byTable[table] ?? { statements: 0, reads: 0, writes: 0 }
            target.statements += counts.statements
            target.reads += counts.reads
            target.writes += counts.writes
            merged.byTable[table] = target
        }
    }
    merged.byTable = Object.fromEntries(Object.entries(merged.byTable)
        .sort(([left], [right]) => left.localeCompare(right)))
    return merged
}

function mapActiveState(state) {
    return {
        player: state.player,
        activeQuest: state.databaseActive,
        questProgress: state.questProgress,
        items: state.items,
        missionProgress: state.missionProgress,
        missionStages: state.missionStages,
        characterClear: state.characterClear,
        awakeUnlocks: state.awakeUnlocks,
    }
}

function rewardSummary(response, { firstClear, sPlus }) {
    const data = response.data
    const missionInfo = data.mission_info ?? []
    return {
        firstClear,
        sPlus,
        normal: {
            rewards: data.rewards,
            addExpList: data.add_exp_list,
            currency: {
                freeMana: data.user_info.free_mana,
                freeVmoney: data.user_info.free_vmoney,
                expPool: data.user_info.exp_pool,
            },
        },
        score: data.drop_score_reward_ids ?? [],
        rareScore: data.drop_rare_reward_ids ?? [],
        additional: data.drop_additional_reward_ids ?? [],
        mission: missionInfo.filter(entry => entry.mission_category_id !== 9),
        awake: missionInfo.filter(entry => entry.mission_category_id === 9),
    }
}

function startPayload({
    category = MAIN_CATEGORY,
    questId = MAIN_QUEST_ID,
    partyId = 2,
    playId = "gate-task-18-start",
} = {}) {
    return {
        viewer_id: VIEWER_ID,
        api_count: 1,
        quest_id: questId,
        category,
        party_id: partyId,
        play_id: playId,
        use_boost_point: false,
        use_boss_boost_point: false,
        is_auto_start_mode: false,
    }
}

function configuredClearReward() {
    return clearRewards[String(mainQuests[String(MAIN_QUEST_ID)].clearRewardId)]
}

function configuredSPlusReward() {
    return clearRewards[String(mainQuests[String(MAIN_QUEST_ID)].sPlusRewardId)]
}

module.exports = {
    ENTRY_QUEST_KEY,
    MAIN_QUEST_KEY,
    assertSuccessful,
    configuredClearReward,
    configuredSPlusReward,
    mapActiveState,
    mergeSqlSnapshots,
    rewardSummary,
    startPayload,
}
