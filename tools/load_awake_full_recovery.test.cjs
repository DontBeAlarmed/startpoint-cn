"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "load-awake-full-recovery-"))
const previousDataDirectory = process.env.DATA_DIR
const previousDatabaseDirectory = process.env.WDFP_DATABASE_DIR
process.env.DATA_DIR = databaseDirectory
delete process.env.WDFP_DATABASE_DIR

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    getPlayerCharactersSync,
    insertDefaultPlayerCharacterSync,
    insertPlayerCharacterManaNodesSync,
    updatePlayerCharacterSync,
} = require("../src/data/domains/character")
const {
    getPlayerCategoryMissionsSync,
    updatePlayerCategoryMissionStageSync,
    updatePlayerCategoryMissionSync,
} = require("../src/data/domains/mission")
const {
    getPlayerCharacterAwakeUnlocksSync,
    upsertPlayerCharacterAwakeUnlockSync,
} = require("../src/data/domains/character_awake")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getClientSerializedData } = require("../src/data/utils/player-data")
const { getCharacterDataSync, getCharacterManaNodesSync } = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")

let database

function makeReadyCharacter(playerId, characterId) {
    insertDefaultPlayerCharacterSync(playerId, characterId)
    const asset = getCharacterDataSync(characterId)
    updatePlayerCharacterSync(playerId, characterId, {
        exp: characterExpCaps[asset.rarity][0],
    })
    insertPlayerCharacterManaNodesSync(
        playerId,
        characterId,
        Object.keys(getCharacterManaNodesSync(characterId, 1)).map(Number),
    )
}

function createPlayer() {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `load-awake-full-${Date.now()}-${Math.random()}`,
        status: "normal",
    })
    return insertDefaultPlayerSync(account.id).id
}

test.before(() => {
    database = data.initializeDatabase()
})

test.after(() => {
    if (database?.open) database.close()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousDatabaseDirectory === undefined) delete process.env.WDFP_DATABASE_DIR
    else process.env.WDFP_DATABASE_DIR = previousDatabaseDirectory
})

test("load uses an independent full recovery context for missions, stages, and stale unlock cleanup", () => {
    const playerId = createPlayer()
    makeReadyCharacter(playerId, 341005)
    insertDefaultPlayerCharacterSync(playerId, 311002)
    upsertPlayerCharacterAwakeUnlockSync(playerId, 311002, 1, 1)
    updatePlayerCategoryMissionSync(playerId, 9, 3410051, 3)
    updatePlayerCategoryMissionStageSync(playerId, 9, 1, 3410051, true)

    const first = getClientSerializedData(playerId, { viewerId: playerId })
    assert.ok(first)
    const firstMission = first.active_mission_list.find(entry => entry.mission_id === 3410051)
    assert.ok(firstMission)
    assert.equal(firstMission.progress_value >= 3, true)
    assert.deepEqual(firstMission.stages.find(stage => stage.stage === 1), {
        stage: 1,
        received: true,
    })
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("311002"), false)
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("341005"), false)
    assert.equal(Object.keys(getPlayerCharactersSync(playerId)).length, 3)

    const stablePayload = value => {
        const copy = JSON.parse(JSON.stringify(value))
        delete copy.user_info.stamina
        return JSON.stringify(copy)
    }
    const firstPayload = stablePayload(first)
    const second = getClientSerializedData(playerId, { viewerId: playerId })
    assert.ok(second)
    assert.equal(stablePayload(second), firstPayload)
    assert.deepEqual(getPlayerCategoryMissionsSync(playerId, 9)[3410051], {
        progress: 3,
        stages: { 1: true },
    })
})

test("load full recovery source does not accept a prior request context or candidate scope", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/data/utils/player-data.ts"), "utf8")
    const loadBlock = source.split("export function getClientSerializedData(")[1]
    assert.match(loadBlock, /createAwakeRequestContext\(\{ playerId \}\)/)
    assert.doesNotMatch(loadBlock, /candidateCharacterIds/)
    assert.doesNotMatch(loadBlock, /options\.context|request\.context|previousContext/)
})
