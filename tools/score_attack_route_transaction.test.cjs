const assert = require("node:assert/strict")
const Database = require("better-sqlite3")
const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

const db = new Database(":memory:")
db.exec(`
CREATE TABLE player_state (
    player_id INTEGER PRIMARY KEY,
    free_mana INTEGER NOT NULL,
    exp_pool INTEGER NOT NULL,
    rank_point INTEGER NOT NULL,
    total_mana INTEGER NOT NULL,
    total_powerflips INTEGER NOT NULL
);
CREATE TABLE character_state (
    player_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    exp INTEGER NOT NULL,
    PRIMARY KEY (player_id, character_id)
);
CREATE TABLE mission_state (
    player_id INTEGER PRIMARY KEY,
    clear_count INTEGER NOT NULL
);
CREATE TABLE item_state (
    player_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (player_id, item_id)
);
CREATE TABLE quest_progress (
    player_id INTEGER NOT NULL,
    category INTEGER NOT NULL,
    quest_id INTEGER NOT NULL,
    high_score INTEGER NOT NULL,
    clear_rank INTEGER NOT NULL,
    PRIMARY KEY (player_id, category, quest_id)
);
CREATE TABLE players_active_quests (
    player_id INTEGER PRIMARY KEY,
    play_id TEXT NOT NULL,
    quest_id INTEGER NOT NULL,
    category INTEGER NOT NULL,
    use_boss_boost_point INTEGER NOT NULL DEFAULT 0,
    use_boost_point INTEGER NOT NULL DEFAULT 0,
    is_auto_start_mode INTEGER NOT NULL DEFAULT 0,
    is_multi INTEGER NOT NULL DEFAULT 0,
    entry_item_id INTEGER,
    entry_item_count INTEGER,
    event_id INTEGER,
    continue_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE score_history (
    player_id INTEGER NOT NULL,
    play_id TEXT NOT NULL,
    total_damage REAL NOT NULL,
    score REAL,
    UNIQUE (player_id, play_id)
);
CREATE TABLE practice_history (
    player_id INTEGER NOT NULL,
    play_id TEXT NOT NULL,
    total_damage REAL NOT NULL,
    score REAL,
    UNIQUE (player_id, play_id)
);
INSERT INTO player_state VALUES (17, 1000, 2000, 3000, 0, 0);
INSERT INTO character_state VALUES (17, 101, 100);
INSERT INTO mission_state VALUES (17, 0);
INSERT INTO item_state VALUES (17, 40501, 7);
INSERT INTO players_active_quests (player_id, play_id, quest_id, category)
VALUES (17, 'score-play', 1101, 27);
CREATE TRIGGER fail_score_attack_active_delete
AFTER DELETE ON players_active_quests
BEGIN
    SELECT RAISE(ABORT, 'injected active delete failure');
END;
`)

function playerRow() {
    const row = db.prepare("SELECT * FROM player_state WHERE player_id = 17").get()
    return {
        id: 17,
        freeMana: row.free_mana,
        expPool: row.exp_pool,
        rankPoint: row.rank_point,
        totalManaObtained: row.total_mana,
        totalPowerflips: row.total_powerflips,
        totalDashes: 0,
        boostPoint: 0,
        bossBoostPoint: 0,
        freeVmoney: 0,
        maxComboAchieved: 0,
        stamina: 100,
        staminaHealTime: new Date(0),
        expPooledTime: new Date(0),
        degreeId: 1,
    }
}

function updatePlayer(data) {
    writeAttempts++
    const fields = {
        freeMana: "free_mana",
        expPool: "exp_pool",
        rankPoint: "rank_point",
        totalManaObtained: "total_mana",
        totalPowerflips: "total_powerflips",
    }
    for (const [key, column] of Object.entries(fields)) {
        if (data[key] !== undefined) {
            db.prepare(`UPDATE player_state SET ${column} = ? WHERE player_id = ?`).run(data[key], data.id)
        }
    }
}

let writeAttempts = 0
let failActiveDeleteAfterWrite = false
const rewardCampaignCalls = []
let scoreRewardOptions = null
const rewardCampaignLogic = require("../src/lib/reward-campaign")
const scoreQuest = {
    name: "无限演武",
    enemyLevel: 60,
    eventId: 1,
    scoreAttackQuestId: 999999,
    bRankScore: 100,
    aRankScore: 200,
    sRankScore: 300,
    ssRankScore: 400,
    bRankTime: 0,
    aRankTime: 0,
    sRankTime: 0,
    sPlusRankTime: 0,
    rankPointReward: 10,
    characterExpReward: 15,
    manaReward: 15,
    poolExpReward: 15,
    scoreRewardGroupId: 990099,
    scoreRewardGroup: [{
        position: 1,
        name: "",
        type: 0,
        reward_type: 6,
        id: 4,
        count: 1,
        field5: 1,
    }],
    commonRewardCount: 1,
}
const activeQuests = {
    17: {
        questId: 1101,
        category: 27,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId: "score-play",
        continueCount: 0,
    },
}

stubModule("../src/data/db", { getDb: () => db })
stubModule("../src/data/domains/server-settings", {
    getServerGameplaySettingsSync: () => ({ dropMultiplier: 3 }),
})
stubModule("../src/content/runtime/content-snapshot", {
    getContentSnapshot: () => ({ repository: {} }),
})
stubModule("../src/content/runtime/table-access", {
    getRuntimeContentTableSync(tableName, fallback) {
        if (tableName !== "additional_reward_rules.json") return fallback
        return {
            groups: {
                9001: [{ index: 1, groupStringId: "test", type: 0, id: 40502, number: 2, weight: 1 }],
            },
            collectItemRules: [{
                eventId: 1,
                startAtMs: 0,
                endAtMs: 4_102_444_800_000,
                prerequisite: null,
                categories: [27],
                keyQueries: [null, null],
                thresholds: [{ enemyLevelMin: 60, groupId: 9001 }],
            }],
            bossPickupRules: [],
        }
    },
})
stubModule("../src/data/domains/quest_active", {
    getPlayerActiveQuestSync(playerId) {
        const row = db.prepare("SELECT * FROM players_active_quests WHERE player_id = ?").get(playerId)
        return row ? {
            playerId: row.player_id,
            playId: row.play_id,
            questId: row.quest_id,
            category: row.category,
            useBossBoostPoint: row.use_boss_boost_point === 1,
            useBoostPoint: row.use_boost_point === 1,
            isAutoStartMode: row.is_auto_start_mode === 1,
            isMulti: row.is_multi === 1,
            coordinatorOrigin: null,
            entryItemId: row.entry_item_id,
            entryItemCount: row.entry_item_count,
            eventId: row.event_id,
            continueCount: row.continue_count,
        } : null
    },
    deletePlayerActiveQuestSync(playerId) {
        writeAttempts++
        db.prepare("DELETE FROM players_active_quests WHERE player_id = ?").run(playerId)
        if (failActiveDeleteAfterWrite) throw new Error("injected active delete post-write failure")
    },
    updatePlayerActiveQuestContinueCountSync() {},
})
stubModule("../src/data/domains/player", {
    getPlayerSync: () => playerRow(),
    updatePlayerSync: updatePlayer,
    getPlayerDailyChallengePointListSync: () => [],
    updatePlayerDailyChallengePointSync() {},
})
stubModule("../src/data/domains/item", {
    getPlayerItemSync(playerId, itemId) {
        return db.prepare("SELECT count FROM item_state WHERE player_id = ? AND item_id = ?").get(playerId, itemId)?.count ?? null
    },
    givePlayerItemSync(playerId, itemId, count) {
        writeAttempts++
        db.prepare(`
            INSERT INTO item_state VALUES (?, ?, ?)
            ON CONFLICT(player_id, item_id) DO UPDATE SET count = count + excluded.count
        `).run(playerId, itemId, count)
        return db.prepare("SELECT count FROM item_state WHERE player_id = ? AND item_id = ?").get(playerId, itemId).count
    },
    setPlayerItemWithinTransactionSync(playerId, itemId, amount, hasExistingRow) {
        writeAttempts++
        if (hasExistingRow) {
            db.prepare("UPDATE item_state SET count = ? WHERE player_id = ? AND item_id = ?")
                .run(amount, playerId, itemId)
        } else {
            db.prepare("INSERT INTO item_state (player_id, item_id, count) VALUES (?, ?, ?)")
                .run(playerId, itemId, amount)
        }
    },
    recordPlayerCollectedItemWithinTransactionSync() {},
    updatePlayerItemSync() {},
})
stubModule("../src/data/domains/mail", { getPlayerMailCountSync: () => 0 })
stubModule("../src/data/domains/quest", {
    getPlayerSingleQuestProgressSync(playerId, category, questId) {
        const row = db.prepare("SELECT * FROM quest_progress WHERE player_id = ? AND category = ? AND quest_id = ?").get(playerId, category, questId)
        return row ? { questId, finished: true, highScore: row.high_score, clearRank: row.clear_rank } : null
    },
    insertPlayerQuestProgressSync(playerId, category, progress) {
        writeAttempts++
        db.prepare("INSERT INTO quest_progress VALUES (?, ?, ?, ?, ?)").run(
            playerId, category, progress.questId, progress.highScore, progress.clearRank,
        )
    },
    updatePlayerQuestProgressSync() {},
})
stubModule("../src/data/domains/character_clear", { incrementPlayerCharacterClearSync() {} })
stubModule("../src/data/domains/mission_battle_facts", { recordMissionBattleResultSync() {} })
stubModule("../src/lib/mission/degree-battle-stat-facts", { recordDegreeBattleStatisticsSync() {} })
stubModule("../src/lib/mission/battle-facts", {
    buildBattleMissionSettlementScopes: () => [
        1,
        2,
        3,
        { category: 5, missionIds: [] },
        6,
        7,
        8,
        10,
    ],
    recordMissionBattleFacts() {
        writeAttempts++
        db.prepare("UPDATE mission_state SET clear_count = clear_count + 1 WHERE player_id = 17").run()
        return { awakeMissionIds: [] }
    },
})
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentListSync: () => ({}),
    updatePlayerEquipmentSync() {},
})
stubModule("../src/data/domains/score-attack-history", {
    insertPlayerScoreAttackBattleHistorySync(record) {
        writeAttempts++
        return db.prepare(`
            INSERT OR IGNORE INTO score_history (player_id, play_id, total_damage, score)
            VALUES (?, ?, ?, ?)
        `).run(record.playerId, record.playId, record.total_damage, record.score).changes === 1
    },
})
stubModule("../src/data/domains/practice-battle-history", {
    insertPlayerPracticeBattleHistorySync(record) {
        writeAttempts++
        return db.prepare(`
            INSERT OR IGNORE INTO practice_history (player_id, play_id, total_damage, score)
            VALUES (?, ?, ?, ?)
        `).run(record.playerId, record.playId, record.total_damage, record.score).changes === 1
    },
})
stubModule("../src/data/domains/session", { getSession: () => null })
stubModule("../src/data/domains/rushEvent", {
    deletePlayerRushEventPlayedPartyListSync() {},
    getPlayerRushEventPlayedPartiesSync: () => [],
    getPlayerRushEventSync: () => null,
    insertPlayerRushEventClearedFolderSync() {},
    insertPlayerRushEventPlayedPartySync() {},
    updatePlayerRushEventSync() {},
})
stubModule("../src/data/domains/carnivalEvent", {
    getPlayerCarnivalEventRecordsSync: () => [],
    getPlayerClaimedCarnivalRewardIdsSync: () => new Set(),
    insertPlayerClaimedCarnivalRewardIdsSync() {},
    runCarnivalEventTransactionSync: operation => operation(),
    upsertPlayerCarnivalEventRecordSync() {},
})
stubModule("../src/data/domains/degree", { givePlayerDegreeSync: () => false })
stubModule("../src/data/activeAccount", { resolvePlayerIdSync: () => 17 })
stubModule("../src/lib/assets", {
    getQuestFromCategorySync: () => scoreQuest,
    getRushEventFolderClearRewards: () => [],
    getScoreAttackBorderRewards: () => require("../assets/score_attack_border_reward.json"),
})
stubModule("../src/lib/character", {
    getCharactersEvolutionImgLevels: () => [1],
    givePlayerCharactersExpSync(playerId, characterIds, amount) {
        writeAttempts++
        for (const characterId of characterIds) {
            db.prepare("UPDATE character_state SET exp = exp + ? WHERE player_id = ? AND character_id = ?").run(amount, playerId, characterId)
        }
        return {
            add_exp_list: [],
            character_list: [],
            bond_token_status_list: {},
            exp_pool: playerRow().expPool,
        }
    },
})
stubModule("../src/lib/quest", {
    givePlayerRewardSync: () => null,
    givePlayerScoreRewardsSync: (...args) => {
        scoreRewardOptions = args[5]
        return ({
        drop_score_reward_ids: [],
        drop_rare_reward_ids: [],
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
        })
    },
    givePlayerRewardsSync(playerId, rewards) {
        const items = {}
        for (const reward of rewards) {
            items[String(reward.id)] = require("../src/data/domains/item").givePlayerItemSync(
                playerId, reward.id, reward.count,
            )
        }
        return {
            user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
            character_list: [],
            joined_character_id_list: [],
            equipment_list: [],
            items,
        }
    },
})
stubModule("../src/lib/reward-campaign", {
    calculateCharacterBattleExp: rewardCampaignLogic.calculateCharacterBattleExp,
    calculateFixedQuestMana: rewardCampaignLogic.calculateFixedQuestMana,
    calculateFixedQuestPoolExp: rewardCampaignLogic.calculateFixedQuestPoolExp,
    calculateScoreRewardAmount: rewardCampaignLogic.calculateScoreRewardAmount,
    getRewardCampaignRates(category, questId, now) {
        rewardCampaignCalls.push({ category, questId, now })
        return { item: 2, exp: 2, mana: 2 }
    },
})
stubModule("../src/routes/api/rushEvent", { rushEventFolderMaxRounds: {} })
stubModule("../src/lib/rush", { getSerializedPlayerRushEventPlayedPartiesSync: () => ({ folderParties: null, endlessParties: null }) })
stubModule("../src/lib/mission", {
    getAwakeBattleMissionIds: () => [],
    reconcileActiveMissionFacts: () => [],
    reconcileAwakeUnlockCharacterList: (_playerId, list) => list,
    settleAwakeMissionCandidatesWithEvaluation: () => ({
        settlement: {
            missionInfo: [],
            itemList: {},
            characterList: [],
            equipmentList: [],
            degreeIds: [],
            passCardPoints: {},
        },
        invalidatedFactKeys: [],
    }),
    settleAwakeBattleMissions: () => ({
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
        passCardPoints: {},
    }),
    settleMissionCategories: () => ({
        missionInfo: [],
        itemList: {},
        characterList: [],
        equipmentList: [],
        degreeIds: [],
    }),
    settleMissionCategoriesWithEvaluation: () => ({
        settlement: {
            missionInfo: [],
            itemList: {},
            characterList: [],
            equipmentList: [],
            degreeIds: [],
            passCardPoints: {},
        },
        invalidatedFactKeys: [],
    }),
    mergeMissionSettlementResponse() {},
})
stubModule("../src/lib/carnival-rewards", { getCarnivalRewardDefinitions: () => [], grantCarnivalRewards: () => null })
stubModule("../src/lib/equipment", { givePlayerEquipmentSync: () => ({}) })
stubModule("../src/lib/stamina", {
    computeRealTimeStamina: () => 100,
    getRankDegree: () => 1,
    getMaxStamina: () => 100,
})
stubModule("../src/lib/stamina-cost", { getStaminaCost: () => 0 })
stubModule("../src/lib/quest/finish/session-validator", {
    validateSessionAndPlayer: async () => ({ playerId: 17, playerData: playerRow() }),
    validateSessionIdentity: async () => ({ accountId: 1, playerId: 17 }),
})
stubModule("../src/lib/quest/finish/challenge-point", { handleDailyChallengePoint: () => [] })
stubModule("../src/lib/quest/finish/character-clear-tracker", {
    trackCharacterClears() {
        writeAttempts++
        db.prepare("UPDATE mission_state SET clear_count = clear_count + 1 WHERE player_id = 17").run()
    },
})
stubModule("../src/lib/quest/finish/powerflip-tracker", {
    trackPowerflip(ctx) {
        updatePlayer({ id: ctx.playerId, totalPowerflips: playerRow().totalPowerflips + 1 })
    },
})
stubModule("../src/lib/quest/finish/leader-powerflip-tracker", { trackLeaderPowerflip() {} })
stubModule("../src/lib/quest/finish/party-co-clear-tracker", { trackPartyCoClears() {} })
stubModule("../src/lib/quest/active-quest-service", {
    activeQuests,
    persistActiveQuest() {},
    publishActiveQuest() {},
    runAbortActiveQuestTransaction: () => ({ cancelled: false, activeQuest: null, itemList: {} }),
})

const initialState = {
    player: db.prepare("SELECT * FROM player_state").get(),
    character: db.prepare("SELECT * FROM character_state").get(),
    mission: db.prepare("SELECT * FROM mission_state").get(),
    item: db.prepare("SELECT * FROM item_state").get(),
}

function finishStatistics() {
    return {
        clear_phase: 1,
        max_combo_count: 0,
        party: {
            characters: [{ id: 101 }, null, null],
            unison_characters: [null, null, null],
            equipments: [null, null, null],
            ability_soul_ids: [null, null, null],
        },
        zones: [{
            use_power_flip_count: 1,
            use_dash_count: 0,
            damage_deal_total: 1234.5,
            members: [{ origin_damage: 1234.5 }, null, null],
        }],
    }
}

async function finish(fastify, payloadOverrides = {}) {
    const activeQuest = activeQuests[17]
    return fastify.inject({
        method: "POST",
        url: "/finish",
        payload: {
            viewer_id: 800000017,
            play_id: activeQuest.playId,
            quest_id: activeQuest.questId,
            category: activeQuest.category,
            score: 1_500_000,
            elapsed_time_ms: 90000,
            add_mana: 5,
            is_accomplished: true,
            is_restored: false,
            continue_count: 0,
            api_count: 1,
            statistics: finishStatistics(),
            ...payloadOverrides,
        },
    })
}

function transactionalState() {
    return {
        player: db.prepare("SELECT * FROM player_state").get(),
        character: db.prepare("SELECT * FROM character_state").get(),
        mission: db.prepare("SELECT * FROM mission_state").get(),
        item: db.prepare("SELECT * FROM item_state").get(),
        questProgress: db.prepare("SELECT * FROM quest_progress ORDER BY category, quest_id").all(),
        scoreHistory: db.prepare("SELECT * FROM score_history ORDER BY play_id").all(),
        practiceHistory: db.prepare("SELECT * FROM practice_history ORDER BY play_id").all(),
        activeQuest: db.prepare("SELECT * FROM players_active_quests").get(),
    }
}

async function main() {
    let scoreRecordCalls = 0
    const scoreSelection = require("../src/lib/quest/score-reward-selection")
    const selectScoreRewardGrantPlan = scoreSelection.selectScoreRewardGrantPlan
    stubModule("../src/lib/quest/score-reward-selection", {
        ...scoreSelection,
        selectScoreRewardGrantPlan(...args) {
            scoreRewardOptions = args[4]
            return selectScoreRewardGrantPlan(...args)
        },
    })
    const scoreSettlement = require("../src/lib/quest/score-reward-settlement")
    const recordScoreRewardSettlement = scoreSettlement.recordScoreRewardSettlement
    stubModule("../src/lib/quest/score-reward-settlement", {
        ...scoreSettlement,
        recordScoreRewardSettlement(...args) {
            scoreRecordCalls++
            return recordScoreRewardSettlement(...args)
        },
    })
    const routes = require("../src/routes/api/singleBattleQuest").default
    const fastify = Fastify()
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"))
            return
        }
        done(null, payload)
    })
    fastify.register(routes)

    const missingTiers = await finish(fastify)
    assert.equal(missingTiers.statusCode, 500)
    assert.equal(writeAttempts, 0)
    assert.deepEqual(db.prepare("SELECT * FROM player_state").get(), initialState.player)
    assert.deepEqual(db.prepare("SELECT * FROM character_state").get(), initialState.character)
    assert.deepEqual(db.prepare("SELECT * FROM mission_state").get(), initialState.mission)
    assert.deepEqual(db.prepare("SELECT * FROM item_state").get(), initialState.item)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quest_progress").get().count, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM score_history").get().count, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_active_quests").get().count, 1)
    assert.ok(activeQuests[17])

    scoreQuest.scoreAttackQuestId = 101
    writeAttempts = 0
    const failed = await finish(fastify)
    assert.equal(failed.statusCode, 500)
    assert.deepEqual(db.prepare("SELECT * FROM player_state").get(), initialState.player)
    assert.deepEqual(db.prepare("SELECT * FROM character_state").get(), initialState.character)
    assert.deepEqual(db.prepare("SELECT * FROM mission_state").get(), initialState.mission)
    assert.deepEqual(db.prepare("SELECT * FROM item_state").get(), initialState.item)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quest_progress").get().count, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM score_history").get().count, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_active_quests").get().count, 1)
    assert.ok(activeQuests[17])
    assert.ok(writeAttempts > 0, failed.body)
    assert.equal(scoreRecordCalls, 0)

    db.exec("DROP TRIGGER fail_score_attack_active_delete")
    writeAttempts = 0
    rewardCampaignCalls.length = 0
    scoreRewardOptions = null
    const succeeded = await finish(fastify)
    assert.equal(succeeded.statusCode, 200, succeeded.body)
    assert.equal(db.prepare("SELECT free_mana FROM player_state WHERE player_id = 17").get().free_mana, 1035)
    assert.equal(db.prepare("SELECT exp_pool FROM player_state WHERE player_id = 17").get().exp_pool, 2030)
    assert.equal(db.prepare("SELECT rank_point FROM player_state WHERE player_id = 17").get().rank_point, 3010)
    assert.equal(db.prepare("SELECT exp FROM character_state WHERE player_id = 17 AND character_id = 101").get().exp, 130)
    assert.equal(db.prepare("SELECT clear_count FROM mission_state WHERE player_id = 17").get().clear_count, 1)
    assert.equal(db.prepare("SELECT count FROM item_state WHERE player_id = 17 AND item_id = 40501").get().count, 8)
    assert.equal(db.prepare("SELECT count FROM item_state WHERE player_id = 17 AND item_id = 40502").get().count, 12)
    assert.equal(db.prepare("SELECT count FROM item_state WHERE player_id = 17 AND item_id = 16").get().count, 6)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM quest_progress").get().count, 1)
    assert.deepEqual(db.prepare("SELECT * FROM score_history").all(), [{
        player_id: 17,
        play_id: "score-play",
        total_damage: 1234.5,
        score: 1_500_000,
    }])
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_active_quests").get().count, 0)
    assert.equal(activeQuests[17], undefined)
    const decoded = unpack(Buffer.from(succeeded.body, "base64"))
    assert.equal(decoded.data.item_list["40501"], 8)
    assert.equal(decoded.data.item_list["40502"], 12)
    assert.deepEqual(decoded.data.drop_additional_reward_ids, [
        { group_id: 9001, index: 1, number: 12 },
    ])
    assert.deepEqual(decoded.data.rewards, {
        overflow_pool_exp: 0,
        converted_pool_exp: 0,
        reward_pool_exp: 30,
        reward_mana: 30,
        field_mana: 5,
    })
    assert.equal(decoded.data.user_info.free_mana, 1035)
    assert.equal(rewardCampaignCalls.length, 1)
    assert.equal(rewardCampaignCalls[0].category, 27)
    assert.equal(rewardCampaignCalls[0].questId, 1101)
    assert.equal(scoreRewardOptions.rewardDate, rewardCampaignCalls[0].now)
    assert.deepEqual(scoreRewardOptions.rewardCampaignRates, { item: 2, exp: 2, mana: 2 })
    assert.equal(scoreRecordCalls, 1)

    activeQuests[17] = {
        questId: 1101,
        category: 1,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId: "normal-play",
        continueCount: 0,
    }
    db.prepare(`
        INSERT INTO players_active_quests (player_id, play_id, quest_id, category)
        VALUES (?, ?, ?, ?)
    `).run(17, "normal-play", 1101, 1)
    const beforeNormalFailure = {
        player: db.prepare("SELECT * FROM player_state").get(),
        character: db.prepare("SELECT * FROM character_state").get(),
        mission: db.prepare("SELECT * FROM mission_state").get(),
        item: db.prepare("SELECT * FROM item_state").get(),
        questProgress: db.prepare("SELECT * FROM quest_progress ORDER BY category, quest_id").all(),
    }

    failActiveDeleteAfterWrite = true
    const failedNormal = await finish(fastify)
    failActiveDeleteAfterWrite = false
    assert.equal(failedNormal.statusCode, 500)
    assert.deepEqual(db.prepare("SELECT * FROM player_state").get(), beforeNormalFailure.player)
    assert.deepEqual(db.prepare("SELECT * FROM character_state").get(), beforeNormalFailure.character)
    assert.deepEqual(db.prepare("SELECT * FROM mission_state").get(), beforeNormalFailure.mission)
    assert.deepEqual(db.prepare("SELECT * FROM item_state").get(), beforeNormalFailure.item)
    assert.deepEqual(
        db.prepare("SELECT * FROM quest_progress ORDER BY category, quest_id").all(),
        beforeNormalFailure.questProgress,
    )
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players_active_quests").get().count, 1)
    assert.ok(activeQuests[17])
    assert.equal(scoreRecordCalls, 1)

    activeQuests[17] = {
        questId: 1101,
        category: 15,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        playId: "practice-play",
        continueCount: 0,
    }
    db.prepare(`
        UPDATE players_active_quests SET play_id = ?, category = 15 WHERE player_id = 17
    `).run("practice-play")
    for (const [name, zones] of [
        ["empty zones", []],
        ["missing total damage", [{}]],
        ["member damage overflow", [
            { damage_deal_total: 1, members: [{ origin_damage: 1e308 }] },
            { damage_deal_total: 1, members: [{ origin_damage: 1e308 }] },
        ]],
    ]) {
        writeAttempts = 0
        const before = transactionalState()
        const rejected = await finish(fastify, {
            statistics: { ...finishStatistics(), zones },
        })
        const response = JSON.parse(rejected.body)
        assert.equal(rejected.statusCode, 400, name)
        assert.equal(response.message, "Invalid request body.", name)
        assert.equal(writeAttempts, 0, name)
        assert.deepEqual(transactionalState(), before, name)
        assert.ok(activeQuests[17], name)
    }
    const practiceFinished = await finish(fastify)
    assert.equal(practiceFinished.statusCode, 200, practiceFinished.body)
    assert.deepEqual(db.prepare("SELECT * FROM practice_history").all(), [{
        player_id: 17,
        play_id: "practice-play",
        total_damage: 1234.5,
        score: 1_500_000,
    }])

    await fastify.close()
    db.close()
}

main().then(
    () => console.log("score attack route transaction tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
