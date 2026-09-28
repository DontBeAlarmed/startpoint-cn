require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const { mergeMissionSettlementResponse } = require("../src/lib/mission/response")

const data = {
    mission_info: [{ mission_category_id: 9, mission_id: 100, mission_reward_id: 1 }],
    user_info: { free_mana: 10, rank_point: 20 },
    item_list: { 1: 5, 2: 7 },
    character_list: [
        { character_id: 10, evolution_level: 2, mana_board_awake: { 1: 1 } },
        { character_id: 11, evolution_level: 1 },
    ],
    equipment_list: [
        { equipment_id: 20, level: 1 },
        { equipment_id: 21, level: 1 },
    ],
    degree_list: [{ viewer_id: 99, degree_id: 30 }],
}

mergeMissionSettlementResponse(data, {
    missionInfo: [{ mission_category_id: 1, mission_id: 6, mission_reward_id: 6001 }],
    userInfo: { free_mana: 50, free_vmoney: 60 },
    itemList: { 1: 8, 3: 9 },
    characterList: [
        { character_id: 10, evolution_level: 3, mana_board_awake: { 2: 1 } },
        { character_id: 12, evolution_level: 1 },
    ],
    equipmentList: [
        { equipment_id: 20, level: 2 },
        { equipment_id: 22, level: 1 },
    ],
    degreeIds: [30, 31],
}, 99)

assert.deepEqual(data.mission_info.map(entry => entry.mission_id), [100, 6])
assert.deepEqual(data.user_info, { free_mana: 50, rank_point: 20, free_vmoney: 60 })
assert.deepEqual(data.item_list, { 1: 8, 2: 7, 3: 9 })
assert.deepEqual(data.character_list, [
    { character_id: 10, evolution_level: 3, mana_board_awake: { 1: 1, 2: 1 } },
    { character_id: 11, evolution_level: 1 },
    { character_id: 12, evolution_level: 1 },
])
assert.deepEqual(data.equipment_list, [
    { equipment_id: 20, level: 2 },
    { equipment_id: 21, level: 1 },
    { equipment_id: 22, level: 1 },
])
assert.deepEqual(data.degree_list, [
    { viewer_id: 99, degree_id: 30 },
    { viewer_id: 99, degree_id: 31 },
])

const loadDataWithoutIncrementalLists = {
    mission_info: [],
    user_character_list: { 10: { character_id: 10, level: 2 } },
    user_equipment_list: {},
}
mergeMissionSettlementResponse(loadDataWithoutIncrementalLists, {
    missionInfo: [],
    userInfo: undefined,
    itemList: {},
    characterList: [],
    equipmentList: [],
    degreeIds: [],
}, 99)
assert.equal(
    Object.hasOwn(loadDataWithoutIncrementalLists, "character_list"),
    false,
    "empty mission rewards must not shadow the serialized load character list",
)
assert.equal(
    Object.hasOwn(loadDataWithoutIncrementalLists, "equipment_list"),
    false,
    "empty mission rewards must not shadow the serialized load equipment list",
)

const responseWithoutCommonKeys = { event_status: 1 }
mergeMissionSettlementResponse(responseWithoutCommonKeys, {
    missionInfo: [{ mission_category_id: 9, mission_id: 40, mission_reward_id: 4001 }],
    userInfo: { free_mana: 2 },
    itemList: { 5: 6 },
    characterList: [{ character_id: 12, stack: 1 }],
    equipmentList: [{ equipment_id: 22, level: 1, protection: false, enhancement_level: 0, stack: 0 }],
    degreeIds: [41],
}, 99)
assert.deepEqual(responseWithoutCommonKeys, {
    event_status: 1,
    mission_info: [{ mission_category_id: 9, mission_id: 40, mission_reward_id: 4001 }],
    user_info: { free_mana: 2 },
    item_list: { 5: 6 },
    character_list: [{ character_id: 12, stack: 1 }],
    equipment_list: [{ equipment_id: 22, level: 1, protection: false, enhancement_level: 0, stack: 0 }],
    degree_list: [{ viewer_id: 99, degree_id: 41 }],
})
assert.equal(
    Object.hasOwn(responseWithoutCommonKeys, "mail_arrived"),
    false,
    "facade must not fabricate common keys the endpoint never published",
)

const responseSource = fs.readFileSync(
    path.join(__dirname, "../src/lib/mission/response.ts"),
    "utf8",
)
assert.doesNotMatch(
    responseSource,
    /from\s+["'][^"']*(?:\/data|\/content|\/routes|mail|growth)/i,
    "compatibility facade must remain a pure projection path",
)
assert.equal(
    Object.keys(require.cache).some(file => /\/src\/(data|content|routes)\//.test(file)),
    false,
    "compatibility facade must not load database, content, or route owners",
)

const activeMissionSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/api/activeMission.ts"),
    "utf8",
)
assert.match(
    activeMissionSource,
    /getPlayerMailCountSync\(playerId, true\)\s*>\s*0/,
    "Active Mission 响应必须返回当前未领取邮件状态",
)

console.log("mission response merge tests passed")
