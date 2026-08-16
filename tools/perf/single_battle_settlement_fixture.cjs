"use strict"

require("ts-node/register/transpile-only")

const { getDb } = require("../../src/data/db")
const { insertAccountSync } = require("../../src/data/domains/account")
const {
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../../src/data/domains/character")
const { getPlayerItemsSync } = require("../../src/data/domains/item")
const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../../src/data/domains/player")
const { getPlayerSingleQuestProgressSync } = require("../../src/data/domains/quest")
const { getPlayerActiveQuestSync } = require("../../src/data/domains/quest_active")
const characterAssets = require("../../src/lib/assets")
const { characterExpCaps } = require("../../src/lib/character")
const { activeQuests } = require("../../src/lib/quest/active-quest-service")
const { getRankDegree } = require("../../src/lib/stamina")
const { normalizeDynamicFields } = require("./single_battle_settlement_time.cjs")

const VIEWER_ID = 800000018
const MAIN_CATEGORY = 1
const MAIN_QUEST_ID = 1001002
const ENTRY_CATEGORY = 7
const ENTRY_QUEST_ID = 200076009
const AWAKE_CHARACTER_ID = 341005

const DETERMINISTIC_SCORE_REWARDS = Object.freeze({
    40000: [{
        position: 1,
        name: "gate-task-18-score",
        type: 0,
        reward_type: 0,
        count: 2,
        field5: 1,
        id: 910001,
    }],
})
const DETERMINISTIC_ADDITIONAL_REWARDS = Object.freeze({
    groups: {
        910018: [{
            index: 1,
            groupStringId: "gate_task_18_additional",
            type: 0,
            id: 910002,
            number: 3,
            weight: 1,
        }],
    },
    collectItemRules: [{
        eventId: 910018,
        startAtMs: Date.parse("2024-12-31T00:00:00.000Z"),
        endAtMs: Date.parse("2025-01-02T00:00:00.000Z"),
        prerequisite: null,
        categories: [MAIN_CATEGORY],
        keyQueries: [[1], [1], [2]],
        thresholds: [{ enemyLevelMin: 0, groupId: 910018 }],
    }],
    bossPickupRules: [],
})

function stableActiveQuest(quest) {
    if (!quest) return null
    return {
        playId: quest.playId,
        questId: quest.questId,
        category: quest.category,
        useBossBoostPoint: quest.useBossBoostPoint,
        useBoostPoint: quest.useBoostPoint,
        isAutoStartMode: quest.isAutoStartMode,
        isMulti: quest.isMulti,
        coordinatorOrigin: quest.coordinatorOrigin ?? null,
        roomNumber: quest.roomNumber ?? null,
        battleSessionId: quest.battleSessionId ?? null,
        entryItemId: quest.entryItemId ?? null,
        entryItemCount: quest.entryItemCount ?? null,
        eventId: quest.eventId ?? null,
        continueCount: quest.continueCount,
    }
}

function stablePlayer(playerId, staminaHealTimeTracker) {
    const player = getPlayerSync(playerId)
    if (!player) return null
    return {
        stamina: player.stamina,
        staminaHealTime: staminaHealTimeTracker.summarizeDatabase(player.staminaHealTime),
        rankPoint: player.rankPoint,
        degreeId: player.degreeId,
        partySlot: player.partySlot,
        freeMana: player.freeMana,
        expPool: player.expPool,
        freeVmoney: player.freeVmoney,
        vmoney: player.vmoney,
        totalStaminaUsed: player.totalStaminaUsed,
        totalManaObtained: player.totalManaObtained,
        maxComboAchieved: player.maxComboAchieved,
    }
}

function stableQuestProgress(playerId, category, questId) {
    const progress = getPlayerSingleQuestProgressSync(playerId, category, questId)
    if (!progress) return null
    return {
        questId: progress.questId,
        finished: progress.finished,
        unlocked: progress.unlocked ?? null,
        highScore: progress.highScore ?? null,
        clearRank: progress.clearRank ?? null,
        bestElapsedTimeMs: progress.bestElapsedTimeMs ?? null,
        leaderCharacterId: progress.leaderCharacterId ?? null,
        hostFinished: progress.hostFinished ?? null,
    }
}

function snapshotSettlementState(playerId, {
    category = MAIN_CATEGORY,
    questId = MAIN_QUEST_ID,
    staminaHealTimeTracker,
} = {}) {
    const db = getDb()
    const missionProgress = db.prepare(`
        SELECT category, id, progress FROM players_category_missions
        WHERE player_id = ? ORDER BY category, id
    `).all(playerId)
    const missionStages = db.prepare(`
        SELECT category, mission_id, id AS stage, status
        FROM players_category_mission_stages
        WHERE player_id = ? ORDER BY category, mission_id, id
    `).all(playerId)
    const characterClear = db.prepare(`
        SELECT character_id, clear_count, multi_count, leader_clear_count,
               leader_multi_count, leader_power_flip_count
        FROM players_character_quest_clears
        WHERE player_id = ? ORDER BY character_id
    `).all(playerId)
    const awakeUnlocks = db.prepare(`
        SELECT character_id, board_index, awake_level
        FROM players_character_awake_unlocks
        WHERE player_id = ? ORDER BY character_id, board_index
    `).all(playerId)
    return {
        player: stablePlayer(playerId, staminaHealTimeTracker),
        rankDegree: getRankDegree(getPlayerSync(playerId)?.rankPoint ?? 0),
        databaseActive: stableActiveQuest(getPlayerActiveQuestSync(playerId)),
        memoryActive: stableActiveQuest(activeQuests[playerId]),
        questProgress: stableQuestProgress(playerId, category, questId),
        items: Object.fromEntries(Object.entries(getPlayerItemsSync(playerId))
            .sort(([left], [right]) => Number(left) - Number(right))),
        missionProgress,
        missionStages,
        characterClear,
        awakeUnlocks,
    }
}

function createActiveQuest({
    category = MAIN_CATEGORY,
    questId = MAIN_QUEST_ID,
    playId = "gate-task-18",
    entryItemId,
    entryItemCount,
} = {}) {
    return {
        questId,
        category,
        useBossBoostPoint: false,
        useBoostPoint: false,
        isAutoStartMode: false,
        isMulti: false,
        coordinatorOrigin: null,
        entryItemId,
        entryItemCount,
        playId,
        continueCount: 0,
    }
}

function finishPayload({
    characterId = AWAKE_CHARACTER_ID,
    elapsedTimeMs = 1_000,
    playId = "gate-task-18-finish",
} = {}) {
    return {
        viewer_id: VIEWER_ID,
        api_count: 1,
        play_id: playId,
        quest_id: MAIN_QUEST_ID,
        category: MAIN_CATEGORY,
        score: 123_456,
        elapsed_time_ms: elapsedTimeMs,
        add_mana: 11,
        is_accomplished: true,
        is_restored: false,
        continue_count: 0,
        statistics: {
            clear_phase: 1,
            max_combo_count: 30,
            zones: [{
                use_power_flip_count: 5,
                use_dash_count: 5,
                use_skill_count: 5,
                damage_deal_total: 1_000,
                members: [{ origin_damage: 1_000 }, null, null],
            }],
            party: {
                characters: [{ id: characterId }, null, null],
                unison_characters: [null, null, null],
                equipments: [null, null, null],
                ability_soul_ids: [null, null, null],
            },
        },
    }
}

function createFixturePlayer() {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "single-battle-baseline",
        idpId: "gate-task-18", status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    getDb().prepare("INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, ?)")
        .run(String(VIEWER_ID), account.id, "2099-12-31T23:59:59.000Z", 2)
    updatePlayerSync({
        id: playerId,
        stamina: 100,
        staminaHealTime: new Date(Date.now() - 60_000),
        freeVmoney: 100,
        vmoney: 100,
    })
    return playerId
}

function makeAwakeEligible(playerId) {
    insertDefaultPlayerCharacterSync(playerId, AWAKE_CHARACTER_ID)
    const rarity = characterAssets.getCharacterDataSync(AWAKE_CHARACTER_ID).rarity
    updatePlayerCharacterSync(playerId, AWAKE_CHARACTER_ID, { exp: characterExpCaps[rarity][0] })
    insertPlayerCharacterManaNodesSync(
        playerId,
        AWAKE_CHARACTER_ID,
        Object.keys(characterAssets.getCharacterManaNodesSync(AWAKE_CHARACTER_ID, 1)).map(Number),
    )
    getDb().prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, ?, 4, 0, 0, 0, 0)
    `).run(playerId, AWAKE_CHARACTER_ID)
}

module.exports = {
    AWAKE_CHARACTER_ID, DETERMINISTIC_ADDITIONAL_REWARDS, DETERMINISTIC_SCORE_REWARDS,
    ENTRY_CATEGORY, ENTRY_QUEST_ID, MAIN_CATEGORY, MAIN_QUEST_ID, VIEWER_ID,
    createActiveQuest, createFixturePlayer, finishPayload, makeAwakeEligible,
    normalizeDynamicFields, snapshotSettlementState, stableActiveQuest,
}
