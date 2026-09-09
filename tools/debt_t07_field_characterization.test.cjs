"use strict"

// D28 C6-1 — DEBT-T07 字段级 characterization。
//
// 本 suite 以 CN 1.8.1 客户端的 Common Response 解码/apply 语义为框架，固定服务端
// merge core 与实体 adapter 的字段形状。证据（仓库外 evidence-b0-client-draft.md）：
//   - RealRemoteService.as:1960-1976 每个请求成功后组装 Common Response 并派发。
//   - RealRemoteService.as:1537/1933 Optional 读取：null → Option.None，非 null → Option.Some。
//     AS3 读取不存在的属性同样得到 null，因此「字段缺失」与「显式 null」都是 Option.None。
//   - PlayerLogic.as:2716-2973 user_info 字段级 Optional absolute patch。
//   - PlayerLogic.as:3026-3048 item_list 是 Item ID → 绝对 after-count 的 key patch。
//   - PlayerLogic.as:3066-3083 / RealRemoteService.as:870-945 Equipment 五字段整实体替换。
//   - PlayerLogic.as:3097-3227 / OwnedCharacterLogic.as:856-870 Character 字段级 patch，
//     mana_board_awake 按板位 key 合并。
//   - GlobalLogic.as:1399-1445/1735-1773 mission_info 与 over_max 是有序 Toast 事件。
// 只覆盖官方客户端真实 response merge 可达的形状，不构造不可达笛卡尔积。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    mergeCommonResponseFragments,
    projectEquipmentEntity,
} = require("../src/lib/common-response")

const COMMON_FIELDS = [
    "user_info",
    "item_list",
    "character_list",
    "equipment_list",
    "mission_info",
    "over_max",
    "mail_arrived",
]

// 镜像 RealRemote 的 Optional 解码：缺失/undefined（AS3 读不存在属性）与显式 null
// 都归一为 None；其余（含 {} 与 []）是 Some(value)。
function decodeOption(container, field) {
    const raw = container[field]
    if (raw === undefined || raw === null) return { none: true }
    return { some: raw }
}

test("CN client parses both field-missing and explicit null as Option.None for every common field", () => {
    for (const field of COMMON_FIELDS) {
        const missing = mergeCommonResponseFragments([{}])
        assert.deepEqual(decodeOption(missing, field), { none: true },
            `${field}: absent fragment must leave the key absent`)
    }

    const nullFragment = {
        user_info: null,
        item_list: null,
        character_list: null,
        equipment_list: null,
        mission_info: null,
        over_max: null,
        mail_arrived: null,
    }
    const explicitNull = mergeCommonResponseFragments([nullFragment])
    assert.deepEqual(explicitNull, nullFragment)

    for (const field of COMMON_FIELDS) {
        assert.deepEqual(decodeOption(explicitNull, field), { none: true },
            `${field}: explicit null stays null on the wire (SHAPE_FROZEN endpoints rely on it)`)
    }
})

test("empty collections decode as Option.Some(empty) and never clear client repositories", () => {
    const empty = mergeCommonResponseFragments([{
        user_info: {},
        item_list: {},
        character_list: [],
        equipment_list: [],
        mission_info: [],
        over_max: [],
        mail_arrived: false,
    }])
    assert.deepEqual(empty, {
        user_info: {},
        item_list: {},
        character_list: [],
        equipment_list: [],
        mission_info: [],
        over_max: [],
        mail_arrived: false,
    })
    for (const field of COMMON_FIELDS) {
        assert.deepEqual(decodeOption(empty, field), { some: empty[field] },
            `${field}: concrete empty must stay Some(empty), not None and not dropped`)
    }

    // 空 item map 不清背包：后续 fragment 的绝对 patch 正常落地。
    const emptyThenPatch = mergeCommonResponseFragments([
        { item_list: {} },
        { item_list: { 30102: 3 } },
    ])
    assert.deepEqual(emptyThenPatch, { item_list: { 30102: 3 } })
})

test("absolute Optional patches: Some overwrites, None keeps, zero and false are concrete", () => {
    const merged = mergeCommonResponseFragments([
        { user_info: { free_mana: 10, rank_point: 20 }, mail_arrived: true },
        { user_info: { free_mana: 0, free_vmoney: 0 }, item_list: { 1: 0 }, mail_arrived: false },
    ])
    assert.deepEqual(merged, {
        user_info: { free_mana: 0, rank_point: 20, free_vmoney: 0 },
        item_list: { 1: 0 },
        mail_arrived: false,
    })
})

test("a null fragment after a concrete patch does not revoke the published absolute value", () => {
    const merged = mergeCommonResponseFragments([
        { user_info: { free_mana: 5 }, item_list: { 1: 2 }, mail_arrived: true },
        { user_info: null, item_list: null, mail_arrived: null },
    ])
    assert.deepEqual(merged, {
        user_info: { free_mana: 5 },
        item_list: { 1: 2 },
        mail_arrived: true,
    })
})

test("item_list is an absolute Item ID after-count map: last writer per key, never additive", () => {
    const merged = mergeCommonResponseFragments([
        { item_list: { 1: 5, 2: 7 } },
        { item_list: { 1: 8, 3: 9 } },
    ])
    assert.deepEqual(merged, { item_list: { 1: 8, 2: 7, 3: 9 } })
})

test("character_list applies field-level patches per character_id with board-key nested delta", () => {
    const merged = mergeCommonResponseFragments([
        {
            character_list: [
                { character_id: 10, level: 2, mana_board_awake: { 1: 1 } },
                { character_id: 11, exp: 100 },
            ],
        },
        {
            character_list: [
                { character_id: 10, level: 3, mana_board_awake: { 2: 1 } },
            ],
        },
    ])
    assert.deepEqual(merged, {
        character_list: [
            { character_id: 10, level: 3, mana_board_awake: { 1: 1, 2: 1 } },
            { character_id: 11, exp: 100 },
        ],
    })
})

test("equipment_list final entities merge whole per equipment_id and must be complete", () => {
    const merged = mergeCommonResponseFragments([
        { equipment_list: [{ equipment_id: 20, protection: false, level: 1, stack: 2 }] },
        { equipment_list: [{ equipment_id: 20, enhancement_level: 3 }] },
    ])
    assert.deepEqual(merged, {
        equipment_list: [
            { equipment_id: 20, protection: false, level: 1, stack: 2, enhancement_level: 3 },
        ],
    })

    // CN decoder 对五个字段全部直接读取并整实体覆盖；最终实体不允许 partial。
    assert.throws(
        () => projectEquipmentEntity({ equipment_id: 20, protection: false, level: 1 }),
        /enhancement_level/,
    )
})

test("mission_info and over_max stay ordered event appends and are never synthesized", () => {
    const mission = { mission_category_id: 1, mission_id: 10, mission_reward_id: 100 }
    const overflow = { process_type: 1, item: { item_id: 30102, number: 2 } }

    const merged = mergeCommonResponseFragments([
        { mission_info: [mission], over_max: [overflow] },
        { mission_info: [mission], over_max: [overflow] },
    ])
    assert.deepEqual(merged, {
        mission_info: [mission, mission],
        over_max: [overflow, overflow],
    })

    // 无事件 fragment 不合成字段：缺失保持缺失，不产生空 Toast 或占位 mission。
    const quiet = mergeCommonResponseFragments([{ user_info: { free_mana: 1 } }])
    assert.equal("mission_info" in quiet, false)
    assert.equal("over_max" in quiet, false)
})

test("explicit user_info empty object stays Some(empty) refresh, distinct from None", () => {
    // B0-18：single /abort 与 multi /start 发布 user_info: {} 触发客户端 refresh 路径，
    // 不得以“没有字段更新”为由优化为缺失。
    const merged = mergeCommonResponseFragments([{ user_info: {} }])
    assert.deepEqual(merged, { user_info: {} })
    assert.deepEqual(decodeOption(merged, "user_info"), { some: {} })
})
