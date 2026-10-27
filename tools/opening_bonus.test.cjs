"use strict"

// 开局块加成解析回归：真实主数据（战士棍棒/城门盾/米娅/普莉莉艾队长能力）
// + 合成玛纳盘节点场景。客户端语义依据：
// - 编队槽魂 = power1 定值（AbilitySoulAbilityLogic MinimumLevel）
// - 装备魂 = LevelScale(装备等级, max_level)
// - 玛纳盘能力 = LevelScale(已学同槽节点数, character c36)，任一节点觉醒 → first_max
// - 队长能力（仅 1 号位）= 0 觉 power1 / ≥1 觉 first_max
// - ManaBoost → 玛纳乘数；MyselfExpBoost → 携带者经验乘数；未知 kind 跳过

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => restore())

const { productionContentSnapshotProvider } = require("../src/content/runtime/content-snapshot")
const { resolveOpeningBonus } = require("../src/lib/opening-bonus")

function call(party) {
    const repository = productionContentSnapshotProvider.snapshot.repository
    return resolveOpeningBonus(repository, party)
}

// ---- 战士棍棒（装备魂：MyselfExp 0.5 定值 + Mana 0.05 定值，max_level=1） ----
{
    const result = call({
        characters: [{
            characterId: 1, // 真实角色（无开局块主数据）
            evolutionLevel: 0,
            manaNodes: {},
            equipment: { equipmentId: 3060010, level: 1 },
            abilitySoulId: null,
        }],
    })
    assert.equal(result.manaMultiplier, 1.05, "棍棒 ManaBoost 0.05 计入玛纳乘数")
    assert.equal(result.expMultiplierByCharacter[1], 1.5, "棍棒 MyselfExp 0.5 加成携带者")
}

// ---- 城门盾（Mana 0.05）+ 无开局内容角色：纯 1 基线 ----
{
    const result = call({
        characters: [{
            characterId: 1,
            evolutionLevel: 0,
            manaNodes: {},
            equipment: { equipmentId: 5085000, level: 1 },
            abilitySoulId: null,
        }],
    })
    assert.equal(result.manaMultiplier, 1.05)
    assert.equal(result.expMultiplierByCharacter[1], 1, "无经验加成时乘数为 1")
}

// ---- 编队槽能力魂（ability_soul_1-3 直接装配，power1 定值） ----
{
    const result = call({
        characters: [{
            characterId: 1,
            evolutionLevel: 0,
            manaNodes: {},
            equipment: null,
            abilitySoulId: 3060010, // 同一魂走编队槽：MyselfExp 0.5 + Mana 0.05
        }],
    })
    assert.equal(result.manaMultiplier, 1.05)
    assert.equal(result.expMultiplierByCharacter[1], 1.5)
}

// ---- 米娅玛纳盘能力（槽 6 = ability 2410011，Mana 0.025→0.05，max power 6） ----
// 真实盘面（mana_board 241001）：槽 2 标记节点共 7 个；槽 6 无专属节点，
// 用合成 mana_node_raw 表驱动（helper 快照带的是真实表，米娅槽 6 无节点 → 无加成）
{
    const result = call({
        characters: [{
            characterId: 241001,
            evolutionLevel: 0,
            manaNodes: {},
            equipment: null,
            abilitySoulId: null,
        }],
    })
    // 米娅队长能力（241001 leader r0，Mana 0.03→0.05，0 觉 → power1=0.03）
    assert.equal(result.manaMultiplier, 1.03, "米娅队长能力 0 觉取 power1=0.03")
    assert.equal(result.expMultiplierByCharacter[241001], 1)
}

// ---- 米娅 1 觉：队长能力取 first_max=0.05 ----
{
    const result = call({
        characters: [{
            characterId: 241001,
            evolutionLevel: 1,
            manaNodes: {},
            equipment: null,
            abilitySoulId: null,
        }],
    })
    assert.equal(result.manaMultiplier, 1.05, "米娅队长能力 ≥1 觉取 first_max=0.05")
}

// ---- 合成玛纳盘节点：槽 1（ability 2410011 在 c19=槽 1）已学 3 节点 → 线性插值 ----
// 插值 t = (3-1)/(6-1) = 0.4 → 0.025 + (0.05-0.025)*0.4 = 0.035；队长 0.03 → 1.065
{
    const repository = productionContentSnapshotProvider.snapshot.repository
    const realManaNodeRaw = repository.table("mana_node_raw.json")
    const synthetic = {
        "241001": {
            ...realManaNodeRaw["241001"],
            // 追加一块合成盘：节点 id 2410012xx → board = floor(id/200)%10，
            // 需要落进已有 board 键；直接复用真实 board 结构外挂节点行不可行
            // （board/pos 由 id 解码），改为覆盖整表：
        },
    }
    // 构造：board 键 = floor(id/200)%10，pos = id%200。取 id = 241001*200 + 200*k + 6
    // 不行——board 必须命中真实表的键。直接读真实表 241001 的 board 键：
    const boardKey = Object.keys(realManaNodeRaw["241001"] ?? { "1": {} })[0] ?? "1"
    const boardNumber = Number(boardKey)
    // 节点 id = boardNumber*200 + pos；槽 1 节点行 c1="0" c5="0" c6="1"
    const posA = 21
    const posB = 22
    const posC = 23
    const nodeA = boardNumber * 200 + posA
    const nodeB = boardNumber * 200 + posB
    const nodeC = boardNumber * 200 + posC
    synthetic["241001"][boardKey] = {
        ...realManaNodeRaw["241001"][boardKey],
        [String(posA)]: [["0", "0", "0", "0", "0", "0", "1"]],
        [String(posB)]: [["0", "0", "0", "0", "0", "0", "1"]],
        [String(posC)]: [["0", "0", "0", "0", "0", "0", "1"]],
    }
    const previous = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = {
        ...previous,
        repository: { ...previous.repository, table: (name) => name === "mana_node_raw.json" ? synthetic : previous.repository.table(name) },
    }
    try {
        const result = call({
            characters: [{
                characterId: 241001,
                evolutionLevel: 0,
                manaNodes: {
                    [String(nodeA)]: 0,
                    [String(nodeB)]: 0,
                    [String(nodeC)]: 0,
                },
                equipment: null,
                abilitySoulId: null,
            }],
        })
        const expected = 1 + 0.03 + (0.025 + (0.05 - 0.025) * ((3 - 1) / (6 - 1)))
        assert.ok(
            Math.abs(result.manaMultiplier - expected) < 1e-9,
            `槽 1 三节点插值 0.035 + 队长 0.03 → ${expected}，实际 ${result.manaMultiplier}`,
        )
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }
}

// ---- 觉醒节点 → 槽位取 first_max ----
{
    const repository = productionContentSnapshotProvider.snapshot.repository
    const realManaNodeRaw = repository.table("mana_node_raw.json")
    const boardKey = Object.keys(realManaNodeRaw["241001"] ?? { "1": {} })[0] ?? "1"
    const boardNumber = Number(boardKey)
    const synthetic = {
        "241001": {
            ...realManaNodeRaw["241001"],
            [boardKey]: {
                ...realManaNodeRaw["241001"][boardKey],
                "31": [["0", "0", "0", "0", "0", "0", "1"]],
            },
        },
    }
    const previous = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = {
        ...previous,
        repository: { ...previous.repository, table: (name) => name === "mana_node_raw.json" ? synthetic : previous.repository.table(name) },
    }
    try {
        const result = call({
            characters: [{
                characterId: 241001,
                evolutionLevel: 0,
                manaNodes: { [String(boardNumber * 200 + 31)]: 1 }, // 觉醒节点
                equipment: null,
                abilitySoulId: null,
            }],
        })
        const expected = 1 + 0.03 + 0.05 // 槽位觉醒 → first_max 0.05 + 队长 0.03
        assert.ok(Math.abs(result.manaMultiplier - expected) < 1e-9, `觉醒槽取 first_max：${result.manaMultiplier}`)
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }
}

// ---- 双角色聚合 + 未知 kind 跳过（防御） ----
{
    const result = call({
        characters: [
            { characterId: 241001, evolutionLevel: 0, manaNodes: {}, equipment: { equipmentId: 3060010, level: 1 }, abilitySoulId: null },
            { characterId: 111009, evolutionLevel: 0, manaNodes: {}, equipment: { equipmentId: 5085000, level: 1 }, abilitySoulId: null },
        ],
    })
    // 米娅队长 0.03 + 棍棒 0.05 + 城门盾 0.05 = 0.13；棍棒 Myself 0.5 只加 241001
    assert.ok(Math.abs(result.manaMultiplier - 1.13) < 1e-9, `玛纳聚合：${result.manaMultiplier}`)
    assert.ok(Math.abs(result.expMultiplierByCharacter[241001] - 1.5) < 1e-9)
    assert.equal(result.expMultiplierByCharacter[111009], 1, "MyselfExp 不跨角色")
}

// ---- fail-open：内容表缺失 → 乘数 1 ----
{
    const previous = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = {
        ...previous,
        repository: { ...previous.repository, table: (name) => { throw new Error("snapshot unavailable") } },
    }
    try {
        const result = call({
            characters: [{ characterId: 3060010, evolutionLevel: 0, manaNodes: {}, equipment: null, abilitySoulId: null }],
        })
        assert.equal(result.manaMultiplier, 1, "表缺失 fail-open")
        assert.equal(result.expMultiplierByCharacter[3060010], 1)
    } finally {
        productionContentSnapshotProvider.snapshot = previous
    }
}

// ---- 夏日米娅（111009）：队长能力缺行（无 leader）+ 槽 1 能力 1110091 存在 ----
{
    const result = call({
        characters: [{
            characterId: 111009,
            evolutionLevel: 0,
            manaNodes: {},
            equipment: null,
            abilitySoulId: null,
        }],
    })
    // 夏日米娅无队长开局行（leader_ability 无 111009 引用）→ 仅 1 基线
    assert.equal(result.manaMultiplier, 1)
}

console.log("opening bonus: all assertions passed")
void fs
void os
void path
