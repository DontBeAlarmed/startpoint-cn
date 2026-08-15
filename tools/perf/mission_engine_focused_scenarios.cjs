"use strict"

const {
    VIEWER_ID,
    createMissionProgressSummary,
    requestMissionPage,
} = require("./mission_engine_focused_helpers.cjs")

const DEGREE_FOCUSED_MISSION_IDS = Object.freeze([
    1000,
    111001,
    33000,
    16000,
    57010,
    70000,
])
const AWAKE_CHARACTER_ID = 341005
const CHARACTER_REWARD_TIME = "2022-12-01T12:00:00.000Z"

function createPlayer(runtime) {
    const playerId = runtime.createBasePlayer()
    const account = runtime.getDb().prepare(
        "SELECT account_id AS accountId FROM players WHERE id = ?",
    ).get(playerId)
    runtime.getDb().prepare(`
        INSERT INTO sessions (token, account_id, expires, type)
        VALUES (?, ?, ?, 2)
    `).run(String(VIEWER_ID), account.accountId, "2099-12-31T23:59:59.000Z")
    return playerId
}

function prepareAwakeCharacter(runtime, playerId) {
    runtime.insertDefaultPlayerCharacterSync(playerId, AWAKE_CHARACTER_ID)
    const rarity = runtime.getCharacterDataSync(AWAKE_CHARACTER_ID).rarity
    runtime.updatePlayerCharacterSync(playerId, AWAKE_CHARACTER_ID, {
        exp: runtime.characterExpCaps[rarity][0],
    })
    runtime.insertPlayerCharacterManaNodesSync(
        playerId,
        AWAKE_CHARACTER_ID,
        Object.keys(runtime.getCharacterManaNodesSync(AWAKE_CHARACTER_ID, 1)).map(Number),
    )
}

function idsFromList(list, keys) {
    return list.map(entry => keys.map(key => entry[key]).find(Number.isFinite))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)
}

function summarizeMissionPage(response) {
    const data = response.data
    return {
        statusCode: response.statusCode,
        ...createMissionProgressSummary(data.mission_progress_list),
        missionRewardIds: data.mission_info
            .map(entry => entry.mission_reward_id)
            .sort((left, right) => left - right),
        itemIds: Object.keys(data.item_list).map(Number).sort((left, right) => left - right),
        characterIds: idsFromList(data.character_list, ["character_id", "id"]),
        equipmentIds: idsFromList(data.equipment_list, ["equipment_id", "id"]),
        degreeIds: idsFromList(data.degree_list, ["degree_id", "id"]),
    }
}

function getTargetMission(data, category, missionId) {
    const target = data.mission_progress_list.find(mission => (
        mission.mission_category === category && mission.mission_id === missionId
    ))
    if (!target) throw new Error(`target mission ${category}:${missionId} missing from response`)
    return {
        mission_category: target.mission_category,
        mission_id: target.mission_id,
        progress_value: target.progress_value,
        stage: target.stage,
    }
}

function prepareReward(runtime, category, missionId, progress) {
    const playerId = createPlayer(runtime)
    runtime.updatePlayerCategoryMissionSync(playerId, category, missionId, progress)
    return playerId
}

function createFinishContext(runtime, playerId, isMulti) {
    const party = { characters: [{ id: AWAKE_CHARACTER_ID }], unison_characters: [] }
    return {
        playerId,
        questCategory: 2,
        questId: 1001001,
        questAccomplished: true,
        clearTime: 60_000,
        clearRank: 5,
        score: 1_000,
        manaObtained: 25,
        party,
        statistics: {
            clear_phase: 1,
            max_combo_count: 10,
            is_mvp: isMulti,
            party,
            zones: [{ use_skill_count: 2, use_dash_count: 1, use_power_flip_count: 1 }],
        },
        player: runtime.getPlayerSync(playerId),
        questPreviouslyCompleted: false,
        questProgress: null,
        ...(isMulti ? { isMulti: true, isMultiHost: true } : {}),
    }
}

function prepareBattlePlayer(runtime) {
    const playerId = createPlayer(runtime)
    prepareAwakeCharacter(runtime, playerId)
    runtime.getDb().prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, ?, 4, 0, 0, 0, 0)
    `).run(playerId, AWAKE_CHARACTER_ID)
    return playerId
}

function summarizeSettlement(result) {
    return {
        missionInfo: result.missionInfo.map(info => [
            info.mission_category_id,
            info.mission_id,
            info.mission_reward_id,
        ]),
        itemIds: Object.keys(result.itemList).map(Number).sort((left, right) => left - right),
        characterIds: idsFromList(result.characterList, ["character_id", "id"]),
        equipmentIds: idsFromList(result.equipmentList, ["equipment_id", "id"]),
        degreeIds: [...result.degreeIds].sort((left, right) => left - right),
    }
}

function summarizeStoredMissionProgress(runtime, playerId, missionRefs) {
    const rows = []
    const missionIdsByCategory = new Map()
    for (const [category, missionId] of missionRefs) {
        const missionIds = missionIdsByCategory.get(category) ?? new Set()
        missionIds.add(missionId)
        missionIdsByCategory.set(category, missionIds)
    }
    for (const [category, missionIds] of missionIdsByCategory) {
        const persisted = runtime.getPlayerCategoryMissionsSync(playerId, category)
        for (const missionId of missionIds) {
            const progress = persisted[String(missionId)]?.progress ?? 0
            rows.push({
                mission_category: category,
                mission_id: missionId,
                progress_value: progress,
                stage: runtime.getCurrentStage(category, missionId, progress),
            })
        }
    }
    return createMissionProgressSummary(rows)
}

function executeBattleFinish(runtime, playerId, fixedTime, isMulti) {
    const context = createFinishContext(runtime, playerId, isMulti)
    const facts = runtime.recordMissionBattleFacts(context, fixedTime)
    const standardScopes = runtime.buildBattleMissionSettlementScopes([AWAKE_CHARACTER_ID])
    const standardMissionRefs = []
    const standard = runtime.settleMissionCategories(
        playerId,
        standardScopes,
        fixedTime,
        {
            onMissionComputed(category, missionId) {
                standardMissionRefs.push([category, missionId])
            },
        },
    )
    const awakeCandidateIds = runtime.getAwakeBattleMissionIds(
        [AWAKE_CHARACTER_ID],
        facts.awakeMissionIds,
    ).filter(missionId => runtime.isMissionEnabledAt(9, missionId, fixedTime))
    const awake = runtime.settleAwakeMissionCandidates(
        playerId,
        awakeCandidateIds,
        fixedTime,
    )
    return {
        adapter: "mission-finish-boundary",
        mode: isMulti ? "multi" : "single",
        standardResult: standard,
        standardMissionRefs,
        awakeResult: awake,
        awakeCandidateIds,
    }
}

function summarizeBattleFinish(runtime, outcome, playerId) {
    return {
        adapter: outcome.adapter,
        mode: outcome.mode,
        standard: {
            ...summarizeSettlement(outcome.standardResult),
            ...summarizeStoredMissionProgress(
                runtime,
                playerId,
                outcome.standardMissionRefs,
            ),
        },
        awake: {
            candidateIds: outcome.awakeCandidateIds,
            ...summarizeSettlement(outcome.awakeResult),
            ...summarizeStoredMissionProgress(
                runtime,
                playerId,
                outcome.awakeCandidateIds.map(missionId => [9, missionId]),
            ),
        },
    }
}

function createFocusedScenarios(runtime) {
    return [
        {
            name: "degree-focused",
            prepare: () => createPlayer(runtime),
            execute(playerId, fixedTime) {
                const result = runtime.settleMissionCategories(playerId, [{
                    category: 5,
                    missionIds: DEGREE_FOCUSED_MISSION_IDS,
                }], fixedTime)
                return {
                    adapter: "scoped-settlement",
                    missionIds: [...DEGREE_FOCUSED_MISSION_IDS],
                    missionRewards: result.missionInfo.map(info => info.mission_reward_id),
                    degreeIds: [...result.degreeIds].sort((left, right) => left - right),
                }
            },
        },
        {
            name: "awake-character-page",
            prepare() {
                const playerId = createPlayer(runtime)
                prepareAwakeCharacter(runtime, playerId)
                return playerId
            },
            async execute() {
                return summarizeMissionPage(await requestMissionPage(runtime, [
                    { category: 9, character_id: AWAKE_CHARACTER_ID },
                ]))
            },
        },
        {
            name: "get-progress-no-invalidation",
            prepare: () => createPlayer(runtime),
            async execute() {
                return summarizeMissionPage(await requestMissionPage(runtime, [{ category: 1 }]))
            },
        },
        {
            name: "get-progress-item-invalidation",
            prepare: () => prepareReward(runtime, 1, 33, 1),
            async execute() {
                const response = await requestMissionPage(runtime, [
                    { category: 1 },
                    { category: 5 },
                ])
                return {
                    ...summarizeMissionPage(response),
                    invalidationRule: "regular-33-item-100000-to-degree-41000",
                    targetMission: getTargetMission(response.data, 5, 41000),
                }
            },
        },
        {
            name: "get-progress-character-invalidation",
            serverTime: CHARACTER_REWARD_TIME,
            prepare: () => prepareReward(runtime, 3, 2571, 1),
            async execute() {
                const response = await requestMissionPage(runtime, [
                    { category: 3 },
                    { category: 5 },
                ])
                return {
                    ...summarizeMissionPage(response),
                    invalidationRule: "event-2571-character-231003-to-degree-2000",
                    invalidationRuleTime: CHARACTER_REWARD_TIME,
                    targetMission: getTargetMission(response.data, 5, 2000),
                }
            },
        },
        {
            name: "get-progress-equipment-invalidation",
            prepare: () => prepareReward(runtime, 1, 56, 1),
            async execute() {
                const response = await requestMissionPage(runtime, [
                    { category: 1 },
                    { category: 5 },
                ])
                return {
                    ...summarizeMissionPage(response),
                    invalidationRule: "regular-56-equipment-200001-to-degree-43000",
                    targetMission: getTargetMission(response.data, 5, 43000),
                }
            },
        },
        {
            name: "single-battle-finish",
            prepare: () => prepareBattlePlayer(runtime),
            execute: (playerId, fixedTime) => executeBattleFinish(
                runtime,
                playerId,
                fixedTime,
                false,
            ),
            summarize: (outcome, playerId) => summarizeBattleFinish(
                runtime,
                outcome,
                playerId,
            ),
        },
        {
            name: "multi-battle-finish",
            prepare: () => prepareBattlePlayer(runtime),
            execute: (playerId, fixedTime) => executeBattleFinish(
                runtime,
                playerId,
                fixedTime,
                true,
            ),
            summarize: (outcome, playerId) => summarizeBattleFinish(
                runtime,
                outcome,
                playerId,
            ),
        },
    ]
}

module.exports = { createFocusedScenarios }
