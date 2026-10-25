"use strict";

// 全表列语义字典守卫（R-dictionary 基座）：
// 1. 完备性审计——高价值表的服务端携带字段必须在客户端字典中有列与状态记录
//    （消灭"从未清点"），丢弃列必须显式分类；
// 2. config 值漂移守卫——assets/config.json 全键 vs config_iosbundled 权威 CSV；
// 3. 字典自身完整性——inventory 每条目都有产出文件、无 unparsed-fragment 的表
//    其列数与客户端 param1 上界一致。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const dictRoot = path.join(projectRoot, "docs/master-dictionary")
const inventory = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "tools/master-dictionary/inventory.json"), "utf8",
))
const aliases = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "tools/master-dictionary/aliases.json"), "utf8",
))
const bundleKeyAliases = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "tools/master-dictionary/bundle-key-aliases.json"), "utf8",
))

function loadDictionary(tableName) {
    const resolved = aliases[tableName] ?? tableName
    return JSON.parse(fs.readFileSync(path.join(dictRoot, `${resolved}.json`), "utf8"))
}

function collectBundleKeys(value, keys, depth = 0) {
    if (depth > 6 || value === null || typeof value !== "object") return
    if (Array.isArray(value)) {
        for (const item of value) collectBundleKeys(item, keys, depth + 1)
        return
    }
    for (const [key, child] of Object.entries(value)) {
        keys.add(key)
        collectBundleKeys(child, keys, depth + 1)
    }
}

test("completeness audit: high-value tables' server-carried fields are all inventoried", () => {
    const audited = [
        "boss_battle_quest", "config", "mission_regular", "mission_daily", "mission_event",
        "main_quest", "ex_quest", "character_quest", "raid_event_quest", "item",
        "gacha", "mail",
    ]
    for (const serverTable of audited) {
        const bundlePath = path.join(projectRoot, "assets", `${serverTable}.json`)
        if (!fs.existsSync(bundlePath)) continue
        const dictionary = loadDictionary(serverTable)
        const dictionaryNames = new Set(dictionary.columns.map(column => column.name))
        const keys = new Set()
        collectBundleKeys(JSON.parse(fs.readFileSync(bundlePath, "utf8")), keys)
        const dataKeys = [...keys].filter(key => (
            // 排除行主键（数字 id / 通用非数据键）——它们不是列语义
            !/^(id|player_id|version|_comment)$/.test(key) && !/^\d+$/.test(key)
        ))
        const aliases = bundleKeyAliases[serverTable] ?? {}
        const missing = []
        for (const key of dataKeys) {
            const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
            const aliased = aliases[key]
            const known = dictionaryNames.has(snake) || dictionaryNames.has(key)
                || (aliased !== undefined && (
                    aliased === "__server-only__"
                    || aliased === "__server-derived__"
                    || aliased === "__cross-table__"
                    || dictionaryNames.has(aliased)
                ))
            if (!known) missing.push(key)
        }
        assert.deepEqual(missing, [],
            `${serverTable}: 服务端携带但客户端字典无此列（键名映射缺口）`)
        // 丢弃列必须显式分类（全部列都有 status 即满足；抽查计数）
        const unclassified = dictionary.columns.filter(column => column.status === undefined)
        assert.equal(unclassified.length, 0, `${serverTable}: 存在未分类列`)
    }
})

test("config drift guard: assets/config.json vs the decoded config_iosbundled authority", () => {
    const csv = fs.readFileSync(
        path.join(projectRoot, "tools/master-dictionary/fixtures/config_iosbundled.csv"), "utf8",
    ).trim()
    const clientValues = csv.split(",")
    const configValues = JSON.parse(fs.readFileSync(
        path.join(projectRoot, "assets/config.json"), "utf8",
    ))
    const configDictionary = loadDictionary("config")
    // 字典列序=ConfigValues 声明序=CSV 序；逐列断言 config.json 值一致
    const mismatches = []
    let compared = 0
    for (const column of configDictionary.columns) {
        if (column.index === null || column.index >= clientValues.length) continue
        const expectedRaw = clientValues[column.index]
        const actual = configValues[column.name]
        if (actual === undefined) { mismatches.push(`${column.name}: missing`); continue }
        const expectedNumber = Number(expectedRaw)
        if (Number.isFinite(expectedNumber) && Number.isFinite(Number(actual))) {
            if (Number(actual) !== expectedNumber) mismatches.push(`${column.name}: ${actual} != ${expectedRaw}`)
        } else if (String(actual) !== expectedRaw) {
            mismatches.push(`${column.name}: ${actual} != ${expectedRaw}`)
        }
        compared++
    }
    assert.deepEqual(mismatches, [], "config.json 与客户端真值漂移")
    assert.ok(compared >= 45, `config 守卫覆盖列数不足（${compared}）`)
})

test("dictionary self-completeness: every inventory entry has a produced file", () => {
    const missing = inventory.entries
        .filter(entry => !fs.existsSync(path.join(dictRoot, `${entry.tableName}.json`)))
        .map(entry => entry.tableName)
    assert.deepEqual(missing, [])
    assert.ok(inventory.entries.length >= 410, "inventory 规模异常")
})

test("dictionary self-completeness: column counts match the client param1 ceiling", () => {
    const drift = []
    for (const entry of inventory.entries) {
        const dictionary = loadDictionary(entry.tableName)
        const hasUnparsed = dictionary.columns.some(column => column.parseRule === "unparsed-fragment")
        if (hasUnparsed) continue
        const withIndex = dictionary.columns.filter(column => column.index !== null)
        if (withIndex.length === 0) continue
        const maxIndex = Math.max(...withIndex.map(column => column.index))
        if (maxIndex > dictionary.authority.clientMaxColumn) {
            drift.push(`${entry.tableName}: col ${maxIndex} > client max ${dictionary.authority.clientMaxColumn}`)
        }
    }
    assert.deepEqual(drift.slice(0, 5), [], "列号越过客户端读取上界（解析错误）")
})

test("generator output is idempotent (byte-stable rerun)", { timeout: 240_000 }, () => {
    const { execFileSync } = require("node:child_process")
    const sampleTables = ["boss_battle_quest", "config", "daily_mission", "gacha"]
    const before = sampleTables.map(table => fs.readFileSync(path.join(dictRoot, `${aliases[table] ?? table}.json`)))
    execFileSync(process.execPath, [path.join(projectRoot, "tools/master-dictionary/generate.cjs")], {
        env: process.env, stdio: "ignore",
    })
    const after = sampleTables.map(table => fs.readFileSync(path.join(dictRoot, `${aliases[table] ?? table}.json`)))
    for (let i = 0; i < sampleTables.length; i++) {
        assert.ok(before[i].equals(after[i]), `${sampleTables[i]} 重跑产物不稳定`)
    }
})
