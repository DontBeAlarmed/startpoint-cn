"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const BetterSqlite3 = require("better-sqlite3")

const importSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mission-category-batch-import-"))
process.env.DATA_DIR = path.join(importSandbox, "data")
process.on("exit", () => fs.rmSync(importSandbox, { recursive: true, force: true }))
require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerCategoryMissionListSync } = require("../src/data/domains/mission")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { resolveRuntimeDataPaths } = require("../src/runtime/data-paths")

test("category mission list performs two bulk reads without per-category calls", () => {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/data/domains/mission.ts"),
        "utf8",
    )
    const functionSource = source.slice(
        source.indexOf("export function getPlayerCategoryMissionListSync"),
        source.indexOf("export function getPlayerClearedCollectItemEventMissionListSync"),
    )
    assert.equal((functionSource.match(/getDb\(\)\.prepare\s*\(/g) ?? []).length, 2)
    assert.doesNotMatch(functionSource, /getPlayerCategoryMissionsSync\s*\(playerId, category\)/)
})

test("category mission list keeps its protocol shape with exactly two player reads", t => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mission-category-batch-"))
    t.after(() => {
        data.closeDatabase()
        fs.rmSync(parent, { recursive: true, force: true })
    })
    let measuring = false
    let selectCount = 0
    data.initializeDatabase({
        paths: resolveRuntimeDataPaths({ DATA_DIR: path.join(parent, "data") }),
        databaseFactory: databasePath => new BetterSqlite3(databasePath, {
            verbose: sql => {
                if (measuring && /^SELECT\b/i.test(String(sql).trim())) selectCount++
            },
        }),
    })
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "mission-category-batch",
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const db = getDb()
    const insertMission = db.prepare(`
        INSERT INTO players_category_missions (category, id, progress, player_id)
        VALUES (?, ?, ?, ?)
    `)
    insertMission.run(1, 101, 3, playerId)
    insertMission.run(9, 901, 1, playerId)
    db.prepare(`
        INSERT INTO players_category_mission_stages
            (category, id, status, player_id, mission_id)
        VALUES (?, ?, ?, ?, ?)
    `).run(9, 1, 1, playerId, 901)

    measuring = true
    const result = getPlayerCategoryMissionListSync(playerId)
    measuring = false

    assert.equal(selectCount, 2)
    assert.deepEqual(result, {
        "1": { "101": { progress: 3, stages: [] } },
        "9": { "901": { progress: 1, stages: { "1": true } } },
    })
})
