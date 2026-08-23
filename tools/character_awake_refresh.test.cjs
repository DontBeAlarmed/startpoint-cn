require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "awake-refresh-db-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
delete process.env.DATA_DIR
process.env.WDFP_DATABASE_DIR = databaseDirectory
let db

function cleanupDatabase() {
    if (db?.open) db.close()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
}

process.once("exit", cleanupDatabase)

const {
    buildManaBoardAwakeCharacterList,
    mergeManaBoardAwakeMaps,
    validateManaBoardAwakeRequest,
} = require("../src/lib/character-helpers")
require("../src/data").initializeDatabase()
db = require("../src/data/db").getDb()

function testIndependentUnlockAndNodeStateAreMergedByMaximum() {
    const independentUnlocks = new Map([
        ["101", { 1: 1 }],
        ["102", { 1: 1 }],
    ])
    const nodeState = new Map([
        ["101", { 1: 2 }],
        ["103", { 1: 1 }],
    ])

    assert.deepEqual(
        [...mergeManaBoardAwakeMaps(independentUnlocks, nodeState).entries()],
        [
            ["101", { 1: 2 }],
            ["102", { 1: 1 }],
            ["103", { 1: 1 }],
        ]
    )
}

function testAwakeAuthorizationUsesIndependentUnlockState() {
    const awakeRouteSource = fs.readFileSync(
        path.join(__dirname, "../src/routes/api/character/mana-awake.ts"),
        "utf8"
    )

    assert.match(
        awakeRouteSource,
        /const unlockedAwakeLevel = getPlayerCharacterAwakeUnlocksSync\(playerId\)/,
    )
    assert.doesNotMatch(awakeRouteSource, /computeManaBoardAwakeFromNodes/)
    assert.doesNotMatch(awakeRouteSource, /computeAwakeSummary/)
}

function testLoadReconcilesFromComputedAwakeSummary() {
    const playerDataSource = fs.readFileSync(
        path.join(__dirname, "../src/data/utils/player-data.ts"),
        "utf8"
    )
    const loadBlock = playerDataSource.split("export function getClientSerializedData(")[1]
    const summaryIndex = loadBlock.indexOf("computeAwakeSummary(playerId)")
    const reconcileIndex = loadBlock.indexOf("reconcileAwakeUnlocksFromProgress(")

    assert.notEqual(reconcileIndex, -1)
    assert.equal(summaryIndex < reconcileIndex, true)
    assert.equal(loadBlock.includes("reconcileAwakeUnlocksFromProgress("), true)
    assert.equal(
        loadBlock.includes("awakeSummary.manaBoardAwakeMap = reconcileAwakeUnlocksFromProgress("),
        true
    )
    assert.equal(loadBlock.includes("const awakeContext = createAwakeRequestContext({"), true)
    assert.equal(loadBlock.includes("computeAwakeSummary(playerId, awakeContext)"), true)
    assert.equal(loadBlock.includes("awakeContext.resolver"), true)
}

function testAwakeSummaryAcceptsRequestContextWithoutMigratingLoadOwner() {
    const summarySource = fs.readFileSync(
        path.join(__dirname, "../src/lib/mission/compute-awake-summary.ts"),
        "utf8"
    )
    assert.match(summarySource, /AwakeRequestContext/)
    assert.match(summarySource, /readAwakeRequestContextCategoryMissions/)
}

function testAwakeRequestGate() {
    const boardNodeIds = [101, 102, 103]
    const learnedNodeIds = [101, 102, 103]

    assert.equal(validateManaBoardAwakeRequest([101, 102], 1, 1, boardNodeIds, learnedNodeIds), null)
    assert.equal(validateManaBoardAwakeRequest([101], 1, 0, boardNodeIds, learnedNodeIds), "Awake missions are not complete.")
    assert.equal(validateManaBoardAwakeRequest([101], 2, 1, boardNodeIds, learnedNodeIds), "Invalid awake level.")
    assert.equal(validateManaBoardAwakeRequest([101], 1, 1, boardNodeIds, [101, 102]), "Base mana board is not complete.")
    assert.equal(validateManaBoardAwakeRequest([101, 101], 1, 1, boardNodeIds, learnedNodeIds), "Invalid mana node list.")
    assert.equal(validateManaBoardAwakeRequest([999], 1, 1, boardNodeIds, learnedNodeIds), "Mana node is outside the awake board.")
}

function testAwakeUnlockUsesCommonCharacterResponseShape() {
    const joinedAt = new Date("2026-07-01T01:02:03.000Z")
    const updatedAt = new Date("2026-07-02T04:05:06.000Z")
    const characters = {
        101: {
            entryCount: 1,
            evolutionLevel: 0,
            overLimitStep: 0,
            protection: false,
            joinTime: joinedAt,
            updateTime: updatedAt,
            exp: 123,
            stack: 0,
            manaBoardIndex: 1,
            bondTokenList: [],
        },
    }

    const entries = buildManaBoardAwakeCharacterList(
        characters,
        new Map([
            ["101", { 1: 1 }],
            ["999", { 1: 1 }],
        ])
    )

    assert.equal(entries.length, 1)
    assert.equal(entries[0].character_id, 101)
    assert.equal(entries[0].exp, 123)
    assert.deepEqual(entries[0].mana_board_awake, { 1: 1 })
    assert.equal(typeof entries[0].join_time, "string")
    assert.equal(typeof entries[0].update_time, "string")
}

try {
    testIndependentUnlockAndNodeStateAreMergedByMaximum()
    testAwakeAuthorizationUsesIndependentUnlockState()
    testLoadReconcilesFromComputedAwakeSummary()
    testAwakeSummaryAcceptsRequestContextWithoutMigratingLoadOwner()
    testAwakeUnlockUsesCommonCharacterResponseShape()
    testAwakeRequestGate()
    console.log("character awake refresh tests passed")
} finally {
    cleanupDatabase()
    process.removeListener("exit", cleanupDatabase)
}
