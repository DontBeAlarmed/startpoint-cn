"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

let projector = {}
try {
    projector = require("../src/lib/quest/finish/single-response-projector")
} catch {
    // The first TDD run intentionally reaches this branch before the module exists.
}

function missionSettlement({ missionId, itemCount, character, equipment, degreeId, freeMana }) {
    return {
        missionInfo: [{
            mission_category_id: missionId === 9001 ? 1 : 9,
            mission_id: missionId,
            mission_reward_id: missionId + 100,
        }],
        itemList: { 501: itemCount },
        characterList: [character],
        equipmentList: [equipment],
        degreeIds: [degreeId],
        passCardPoints: {},
        userInfo: { free_mana: freeMana },
    }
}

function rewardResult({ mana, vmoney, pool, characterId, equipmentId, itemId }) {
    return {
        user_info: { free_mana: mana, free_vmoney: vmoney, exp_pool: pool },
        character_list: [{ character_id: characterId }],
        joined_character_id_list: [characterId],
        equipment_list: [{
            equipment_id: equipmentId,
            protection: false,
            level: 1,
            enhancement_level: 0,
            stack: 0,
        }],
        items: { [itemId]: 1 },
    }
}

test("projects the complete single finish success envelope without mutating its input", () => {
    assert.equal(typeof projector.buildSingleFinishResponse, "function")

    const result = {
        ok: true,
        body: { viewer_id: 2468, category: 14, add_mana: 6 },
        afterStamina: 33,
        dailyChallengePointList: [{ event_id: 4, point: 2 }],
        scoreRewardsResult: {
            ...rewardResult({ mana: 3, vmoney: 3, pool: 20, characterId: 103, equipmentId: 203, itemId: 303 }),
            drop_score_reward_ids: [{ group_id: 1, index: 2, number: 3 }],
            drop_rare_reward_ids: [{ group_id: 4, index: 5, number: 6 }],
        },
        additionalRewardSettlement: {
            dropAdditionalRewardIds: [{ kind: 2, id: 701 }],
            rewardResult: null,
        },
        rewardCharacterExpResult: {
            exp_pool: 100,
            add_exp_list: { 101: 55 },
            character_list: [{ character_id: 101, level: 9 }],
            bond_token_status_list: { 101: { before: [], after: [] } },
        },
        rushEventData: { high_score: 1234 },
        rushEventRewardsResult: rewardResult({
            mana: 0, vmoney: 0, pool: 0, characterId: 105, equipmentId: 205, itemId: 305,
        }),
        raidEventData: { event_id: 12 },
        carnivalEventData: { total_best_score: 9876 },
        carnivalRewardResult: {
            user_info: { free_mana: 5, free_vmoney: 5, exp_pool: 40 },
            item_list: { 306: 1 },
            equipment_list: [{
                equipment_id: 206,
                protection: false,
                level: 1,
                enhancement_level: 0,
                stack: 0,
            }],
            new_degree_ids: [66],
        },
        scoreAttackFinishResult: {
            oldHighScore: 4321,
            scoreAttackEvent: { main_character_ids: { 0: 101 }, reward_ids: [77] },
        },
        scoreAttackRewardResult: rewardResult({
            mana: 4, vmoney: 4, pool: 30, characterId: 104, equipmentId: 204, itemId: 304,
        }),
        itemList: { 301: 9, 501: 22 },
        characterList: [{ character_id: 101, mana_board_awake: { level: 1 } }],
        clearReward: rewardResult({
            mana: 1, vmoney: 1, pool: 10, characterId: 101, equipmentId: 201, itemId: 301,
        }),
        sPlusClearReward: rewardResult({
            mana: 2, vmoney: 2, pool: 999, characterId: 102, equipmentId: 202, itemId: 302,
        }),
        missionSettlement: missionSettlement({
            missionId: 9001,
            itemCount: 11,
            character: { character_id: 101, stack: 3, mana_board_awake: { unlocked: true } },
            equipment: { equipment_id: 203, enhancement_level: 1 },
            degreeId: 71,
            freeMana: 111,
        }),
        awakeMissionSettlement: missionSettlement({
            missionId: 9002,
            itemCount: 22,
            character: { character_id: 101, mana_board_awake: { level: 2 } },
            equipment: { equipment_id: 203, enhancement_level: 2 },
            degreeId: 72,
            freeMana: 222,
        }),
        activeMissionList: [{ mission_id: 88, progress: 1 }],
        fixedManaReward: 7,
        fixedPoolExpReward: 8,
        newMana: 10,
        beforeRankPoint: 100,
        newRankPoint: 120,
        newBoostPoint: 2,
        newBossBoostPoint: 3,
        clearRank: 4,
        questProgress: { questId: 4001, highScore: 1111 },
    }
    const input = {
        result,
        dataHeaders: { viewer_id: 2468, servertime: 1700000000, api_count: 9 },
        player: {
            freeMana: 777,
            expPool: 888,
            expPooledTime: 1700000010,
            freeVmoney: 999,
            rankPoint: 120,
            degreeId: 55,
            stamina: 33,
            staminaHealTime: 1700000020,
            boostPoint: 2,
            bossBoostPoint: 3,
        },
        mailArrived: true,
    }
    const originalInput = structuredClone(input)

    const response = projector.buildSingleFinishResponse(input)

    assert.deepEqual(response, {
        data_headers: input.dataHeaders,
        data: {
            user_info: {
                free_mana: 777,
                exp_pool: 888,
                exp_pooled_time: 1700000010,
                free_vmoney: 999,
                rank_point: 120,
                degree_id: 55,
                stamina: 33,
                stamina_heal_time: 1700000020,
                boost_point: 2,
                boss_boost_point: 3,
            },
            add_exp_list: { 101: 55 },
            character_list: [{
                character_id: 101,
                stack: 3,
                mana_board_awake: { level: 2, unlocked: true },
            }],
            bond_token_status_list: { 101: { before: [], after: [] } },
            rewards: {
                overflow_pool_exp: 0,
                converted_pool_exp: 0,
                reward_pool_exp: 8,
                reward_mana: 7,
                field_mana: 6,
            },
            old_high_score: 4321,
            joined_character_id_list: [101, 102, 103, 104],
            before_rank_point: 100,
            clear_rank: 4,
            drop_score_reward_ids: [{ group_id: 1, index: 2, number: 3 }],
            drop_rare_reward_ids: [{ group_id: 4, index: 5, number: 6 }],
            drop_additional_reward_ids: [{ kind: 2, id: 701 }],
            drop_periodic_reward_ids: [],
            equipment_list: [
                {
                    equipment_id: 203,
                    protection: false,
                    level: 1,
                    enhancement_level: 2,
                    stack: 0,
                },
                {
                    equipment_id: 201,
                    protection: false,
                    level: 1,
                    enhancement_level: 0,
                    stack: 0,
                },
                {
                    equipment_id: 202,
                    protection: false,
                    level: 1,
                    enhancement_level: 0,
                    stack: 0,
                },
                {
                    equipment_id: 205,
                    protection: false,
                    level: 1,
                    enhancement_level: 0,
                    stack: 0,
                },
                {
                    equipment_id: 204,
                    protection: false,
                    level: 1,
                    enhancement_level: 0,
                    stack: 0,
                },
                {
                    equipment_id: 206,
                    protection: false,
                    level: 1,
                    enhancement_level: 0,
                    stack: 0,
                },
            ],
            category_id: 14,
            start_time: 1700000000,
            is_multi: "single",
            quest_name: "",
            item_list: { 301: 9, 501: 22 },
            raid_event: { event_id: 12 },
            rush_event: { high_score: 1234 },
            carnival_event: { total_best_score: 9876 },
            score_attack_event: { main_character_ids: { 0: 101 }, reward_ids: [77] },
            user_daily_challenge_point_list: [{ event_id: 4, point: 2 }],
            presigned_quest_category: [],
            active_mission_list: [{ mission_id: 88, progress: 1 }],
            mission_info: [
                { mission_category_id: 1, mission_id: 9001, mission_reward_id: 9101 },
                { mission_category_id: 9, mission_id: 9002, mission_reward_id: 9102 },
            ],
            degree_list: [
                { viewer_id: 2468, degree_id: 71 },
                { viewer_id: 2468, degree_id: 72 },
            ],
            mail_arrived: true,
        },
    })
    assert.deepEqual(input, originalInput)
})

test("single finish projection applies the entity whitelist and canonical identity", () => {
    const base = {
        ok: true,
        body: { viewer_id: 2468, category: 14, add_mana: 0 },
        dailyChallengePointList: null,
        scoreRewardsResult: {
            user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
            character_list: [],
            joined_character_id_list: [],
            equipment_list: [{
                equipment_id: 203,
                protection: false,
                level: 1,
                enhancement_level: 0,
                stack: 0,
            }],
            items: {},
            drop_score_reward_ids: [],
            drop_rare_reward_ids: [],
        },
        additionalRewardSettlement: { dropAdditionalRewardIds: [], rewardResult: null },
        rewardCharacterExpResult: {
            exp_pool: 0,
            add_exp_list: {},
            character_list: [],
            bond_token_status_list: {},
        },
        rushEventData: null,
        rushEventRewardsResult: null,
        raidEventData: null,
        carnivalEventData: null,
        carnivalRewardResult: null,
        scoreAttackFinishResult: null,
        scoreAttackRewardResult: null,
        itemList: {},
        characterList: [{ character_id: 101, stack: 2, junk_field: "leak" }],
        clearReward: null,
        sPlusClearReward: null,
        missionSettlement: null,
        awakeMissionSettlement: null,
        activeMissionList: [],
        fixedManaReward: 0,
        fixedPoolExpReward: 0,
        beforeRankPoint: 0,
        clearRank: 4,
        questProgress: null,
    }
    const player = {
        freeMana: 1,
        expPool: 2,
        expPooledTime: 3,
        freeVmoney: 4,
        rankPoint: 5,
        degreeId: 6,
        stamina: 7,
        staminaHealTime: 8,
        boostPoint: 9,
        bossBoostPoint: 10,
    }
    const response = projector.buildSingleFinishResponse({
        result: base,
        dataHeaders: { viewer_id: 2468, servertime: 1700000000 },
        player,
        mailArrived: false,
    })
    assert.deepEqual(response.data.character_list, [{ character_id: 101, stack: 2 }])
    assert.throws(() => projector.buildSingleFinishResponse({
        result: { ...base, characterList: [{ character_id: 0 }] },
        dataHeaders: { viewer_id: 2468, servertime: 1700000000 },
        player,
        mailArrived: false,
    }), TypeError)
    assert.throws(() => projector.buildSingleFinishResponse({
        result: {
            ...base,
            scoreRewardsResult: {
                ...base.scoreRewardsResult,
                equipment_list: [{ equipment_id: 203, stack: 0 }],
            },
            characterList: [],
        },
        dataHeaders: { viewer_id: 2468, servertime: 1700000000 },
        player,
        mailArrived: false,
    }), TypeError)
})

test("single finish projector is dependency-free from DB, Content, and routes", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/lib/quest/finish/single-response-projector.ts"),
        "utf8",
    )
    assert.doesNotMatch(
        source,
        /(?:from\s+["'][^"']*(?:\/data|\/content|\/routes)|require\([^)]*(?:\/data|\/content|\/routes))/i,
    )
    const loaded = Object.keys(require.cache)
    assert.equal(
        loaded.some(file => /\/src\/(data|content|routes)\//.test(file)),
        false,
    )
})
