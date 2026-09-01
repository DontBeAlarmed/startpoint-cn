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
    getPlayerCharacterManaNodeAwakeLevelsSync,
    getPlayerCharactersSync,
    getPlayerCharactersManaNodeAwakeLevelsSync,
    getPlayerCharactersManaNodesSync,
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
const { getPlayerItemsSync } = require("../src/data/domains/item")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { getPlayerSync } = require("../src/data/domains/player")
const { getClientSerializedData } = require("../src/data/utils/player-data")
const { getCharacterDataSync, getCharacterManaNodesSync } = require("../src/lib/assets")
const { characterExpCaps } = require("../src/lib/character")
const {
    reconcileAwakeEvolutionLevelsSync,
} = require("../src/lib/mission/awake-evolution-repair")

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

function setManaNodeAwakeLevel(playerId, characterId, nodeId, awakeLevel) {
    database.prepare(`
        UPDATE players_characters_mana_nodes
        SET awake_level = ?
        WHERE player_id = ? AND character_id = ? AND value = ?
    `).run(awakeLevel, playerId, characterId, nodeId)
}

function setStoredEvolutionLevel(playerId, characterId, evolutionLevel) {
    database.prepare(`
        UPDATE players_characters
        SET evolution_level = ?
        WHERE player_id = ? AND id = ?
    `).run(evolutionLevel, playerId, characterId)
}

function getStoredEvolutionLevel(playerId, characterId) {
    return database.prepare(`
        SELECT evolution_level
        FROM players_characters
        WHERE player_id = ? AND id = ?
    `).get(playerId, characterId).evolution_level
}

function captureRepairSideEffects(playerId, characterId) {
    const player = getPlayerSync(playerId)
    return JSON.parse(JSON.stringify({
        player: {
            freeMana: player.freeMana,
            paidMana: player.paidMana,
        },
        items: getPlayerItemsSync(playerId),
        missions: getPlayerCategoryMissionsSync(playerId, 9),
        awakeUnlocks: [...getPlayerCharacterAwakeUnlocksSync(playerId)]
            .sort((left, right) => Number(left[0]) - Number(right[0])),
        manaNodeAwakeLevels: getPlayerCharacterManaNodeAwakeLevelsSync(playerId, characterId),
    }))
}

function captureCompleteRepairState(playerId) {
    const player = getPlayerSync(playerId)
    return JSON.parse(JSON.stringify({
        player: {
            freeMana: player.freeMana,
            paidMana: player.paidMana,
        },
        items: getPlayerItemsSync(playerId),
        missions: getPlayerCategoryMissionsSync(playerId, 9),
        awakeUnlocks: [...getPlayerCharacterAwakeUnlocksSync(playerId)]
            .sort((left, right) => Number(left[0]) - Number(right[0])),
        characters: getPlayerCharactersSync(playerId),
        learnedNodeIds: getPlayerCharactersManaNodesSync(playerId),
        manaNodeAwakeLevels: getPlayerCharactersManaNodeAwakeLevelsSync(playerId),
    }))
}

function createAwakeEvolutionSnapshot(playerId) {
    return {
        characters: getPlayerCharactersSync(playerId),
        manaNodes: getPlayerCharactersManaNodesSync(playerId),
        manaNodeAwakeLevels: getPlayerCharactersManaNodeAwakeLevelsSync(playerId),
    }
}

function getSkillEvolutionRequisiteNodeId(characterId) {
    const node = Object.entries(getCharacterManaNodesSync(characterId, 1))
        .find(([, manaNode]) => manaNode.field5 === "2")
    assert.ok(node, `character ${characterId} must have a skill evolution requisite`)
    return Number(node[0])
}

function makeRepairCandidate(playerId, characterId) {
    makeReadyCharacter(playerId, characterId)
    setStoredEvolutionLevel(playerId, characterId, 1)
    setManaNodeAwakeLevel(playerId, characterId, getSkillEvolutionRequisiteNodeId(characterId), 1)
}

function assertOnlyTargetEvolutionChanged(before, after, characterId, expectedEvolutionLevel) {
    const beforeCopy = JSON.parse(JSON.stringify(before))
    const afterCopy = JSON.parse(JSON.stringify(after))
    const characterKey = String(characterId)
    assert.equal(afterCopy.characters[characterKey].evolutionLevel, expectedEvolutionLevel)
    beforeCopy.characters[characterKey].evolutionLevel = expectedEvolutionLevel
    assert.deepEqual(afterCopy, beforeCopy)
}

function withContentTableOverrides(tableOverrides, callback) {
    const restoreOverride = require("./helpers/install-bundled-gameplay-snapshot.cjs")
        .installBundledGameplaySnapshot({ tableOverrides })
    try {
        callback()
    } finally {
        restoreOverride()
    }
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

test("load uses an independent full recovery context without deleting permanent unlocks", () => {
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
    assert.equal(getPlayerCharacterAwakeUnlocksSync(playerId).has("311002"), true)
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

test("load repairs legacy skill-evolution awake level 1 to evolution 2", () => {
    const playerId = createPlayer()
    makeReadyCharacter(playerId, 341005)
    setStoredEvolutionLevel(playerId, 341005, 1)
    setManaNodeAwakeLevel(playerId, 341005, 682010219, 1)

    const response = getClientSerializedData(playerId, { viewerId: playerId })

    assert.equal(getStoredEvolutionLevel(playerId, 341005), 2)
    assert.equal(response.user_character_list["341005"].evolution_level, 2)
})

test("load repairs legacy skill-evolution awake level 2 to evolution 3", () => {
    const playerId = createPlayer()
    makeReadyCharacter(playerId, 341005)
    setStoredEvolutionLevel(playerId, 341005, 1)
    setManaNodeAwakeLevel(playerId, 341005, 682010219, 2)

    const response = getClientSerializedData(playerId, { viewerId: playerId })

    assert.equal(getStoredEvolutionLevel(playerId, 341005), 3)
    assert.equal(response.user_character_list["341005"].evolution_level, 3)
})

test("repeat load performs zero evolution repairs and leaves awake resources unchanged", () => {
    const playerId = createPlayer()
    makeReadyCharacter(playerId, 341005)
    setStoredEvolutionLevel(playerId, 341005, 1)
    setManaNodeAwakeLevel(playerId, 341005, 682010219, 1)
    const completeStateBeforeFirstLoad = captureCompleteRepairState(playerId)
    const first = getClientSerializedData(playerId, { viewerId: playerId })
    assert.equal(getStoredEvolutionLevel(playerId, 341005), 2)
    assertOnlyTargetEvolutionChanged(completeStateBeforeFirstLoad, captureCompleteRepairState(playerId), 341005, 2)
    const sideEffectsBeforeSecondLoad = captureRepairSideEffects(playerId, 341005)
    database.prepare(`
        CREATE TRIGGER forbid_repair_character_evolution_update
        BEFORE UPDATE OF evolution_level ON players_characters
        BEGIN
            SELECT RAISE(ABORT, 'unexpected evolution repair');
        END
    `).run()

    try {
        const second = getClientSerializedData(playerId, { viewerId: playerId })
        assert.equal(second.user_character_list["341005"].evolution_level, 2)
        assert.deepEqual(captureRepairSideEffects(playerId, 341005), sideEffectsBeforeSecondLoad)
    } finally {
        database.exec("DROP TRIGGER forbid_repair_character_evolution_update")
    }
})

test("load never lowers a stored evolution above the derived awake evolution", () => {
    const playerId = createPlayer()
    makeReadyCharacter(playerId, 341005)
    setStoredEvolutionLevel(playerId, 341005, 9)
    setManaNodeAwakeLevel(playerId, 341005, 682010219, 2)

    const response = getClientSerializedData(playerId, { viewerId: playerId })

    assert.equal(getStoredEvolutionLevel(playerId, 341005), 9)
    assert.equal(response.user_character_list["341005"].evolution_level, 9)
})

test("evolution repair keeps a concurrently raised database evolution without writing", () => {
    const playerId = createPlayer()
    makeRepairCandidate(playerId, 341005)
    const snapshot = createAwakeEvolutionSnapshot(playerId)
    const snapshotCopy = structuredClone(snapshot)
    setStoredEvolutionLevel(playerId, 341005, 3)

    const result = reconcileAwakeEvolutionLevelsSync(playerId, snapshot)

    assert.deepEqual(result.repairedCharacterIds, [])
    assert.equal(getStoredEvolutionLevel(playerId, 341005), 3)
    assert.equal(result.characters["341005"].evolutionLevel, 3)
    assert.deepEqual(snapshot, snapshotCopy)

    database.prepare(`
        CREATE TRIGGER forbid_concurrent_stale_evolution_update
        BEFORE UPDATE OF evolution_level ON players_characters
        BEGIN
            SELECT RAISE(ABORT, 'unexpected stale snapshot evolution write');
        END
    `).run()
    try {
        const guardedResult = reconcileAwakeEvolutionLevelsSync(playerId, snapshot)
        assert.deepEqual(guardedResult.repairedCharacterIds, [])
        assert.equal(getStoredEvolutionLevel(playerId, 341005), 3)
        assert.equal(guardedResult.characters["341005"].evolutionLevel, 3)
    } finally {
        database.exec("DROP TRIGGER forbid_concurrent_stale_evolution_update")
    }
})

test("evolution repair rolls back earlier characters when a later update aborts", () => {
    const playerId = createPlayer()
    makeRepairCandidate(playerId, 111001)
    makeRepairCandidate(playerId, 341005)
    const snapshot = createAwakeEvolutionSnapshot(playerId)
    database.prepare(`
        CREATE TRIGGER abort_second_character_evolution_repair
        BEFORE UPDATE OF evolution_level ON players_characters
        WHEN NEW.id = 341005
        BEGIN
            SELECT RAISE(ABORT, 'planned second repair failure');
        END
    `).run()

    try {
        assert.throws(
            () => reconcileAwakeEvolutionLevelsSync(playerId, snapshot),
            /planned second repair failure/,
        )
    } finally {
        database.exec("DROP TRIGGER abort_second_character_evolution_repair")
    }

    assert.equal(getStoredEvolutionLevel(playerId, 111001), 1)
    assert.equal(getStoredEvolutionLevel(playerId, 341005), 1)
})

test("evolution repair skips a snapshot row deleted before the guarded update", () => {
    const playerId = createPlayer()
    makeRepairCandidate(playerId, 341005)
    const snapshot = createAwakeEvolutionSnapshot(playerId)
    database.prepare(`
        DELETE FROM players_characters
        WHERE player_id = ? AND id = ?
    `).run(playerId, 341005)

    const result = reconcileAwakeEvolutionLevelsSync(playerId, snapshot)

    assert.deepEqual(result.repairedCharacterIds, [])
    assert.equal(database.prepare(`
        SELECT 1
        FROM players_characters
        WHERE player_id = ? AND id = ?
    `).get(playerId, 341005), undefined)
})

test("first evolution repair changes only the target character evolution", () => {
    const playerId = createPlayer()
    makeRepairCandidate(playerId, 341005)
    const before = captureCompleteRepairState(playerId)
    const snapshot = createAwakeEvolutionSnapshot(playerId)
    const snapshotCopy = structuredClone(snapshot)

    const result = reconcileAwakeEvolutionLevelsSync(playerId, snapshot)

    assert.deepEqual(result.repairedCharacterIds, [341005])
    assert.equal(getStoredEvolutionLevel(playerId, 341005), 2)
    assert.deepEqual(snapshot, snapshotCopy)
    assertOnlyTargetEvolutionChanged(before, captureCompleteRepairState(playerId), 341005, 2)
})

test("evolution repair skips a character missing official character master data", () => {
    const playerId = createPlayer()
    insertDefaultPlayerCharacterSync(playerId, 999998)
    setStoredEvolutionLevel(playerId, 999998, 1)
    const manaNodeTable = structuredClone(require("../assets/mana_node.json"))
    manaNodeTable["999998"] = {
        1: {
            682010219: {
                field1: "0",
                field5: "2",
                field6: "",
            },
        },
    }
    insertPlayerCharacterManaNodesSync(playerId, 999998, [682010219])
    setManaNodeAwakeLevel(playerId, 999998, 682010219, 1)
    withContentTableOverrides({ "mana_node.json": manaNodeTable }, () => {
        const snapshot = createAwakeEvolutionSnapshot(playerId)
        const result = reconcileAwakeEvolutionLevelsSync(playerId, snapshot)

        assert.deepEqual(result.repairedCharacterIds, [])
        assert.equal(getStoredEvolutionLevel(playerId, 999998), 1)
    })
})

test("evolution repair skips empty first-board mana data", () => {
    const playerId = createPlayer()
    makeRepairCandidate(playerId, 341005)
    setStoredEvolutionLevel(playerId, 341005, 0)
    const manaNodeTable = structuredClone(require("../assets/mana_node.json"))
    manaNodeTable["341005"]["1"] = {}
    const snapshot = createAwakeEvolutionSnapshot(playerId)

    withContentTableOverrides({ "mana_node.json": manaNodeTable }, () => {
        const result = reconcileAwakeEvolutionLevelsSync(playerId, snapshot)

        assert.deepEqual(result.repairedCharacterIds, [])
        assert.equal(getStoredEvolutionLevel(playerId, 341005), 0)
    })
})

test("invalid mana-node semantics fail open while another official character repairs", () => {
    const playerId = createPlayer()
    makeRepairCandidate(playerId, 111001)
    makeRepairCandidate(playerId, 341005)
    const manaNodeTable = structuredClone(require("../assets/mana_node.json"))
    manaNodeTable["341005"]["1"][getSkillEvolutionRequisiteNodeId(341005)].field5 = "invalid"
    const snapshot = createAwakeEvolutionSnapshot(playerId)
    const snapshotCopy = structuredClone(snapshot)

    withContentTableOverrides({ "mana_node.json": manaNodeTable }, () => {
        const result = reconcileAwakeEvolutionLevelsSync(playerId, snapshot)

        assert.deepEqual(result.repairedCharacterIds, [111001])
        assert.equal(getStoredEvolutionLevel(playerId, 111001), 2)
        assert.equal(getStoredEvolutionLevel(playerId, 341005), 1)
        assert.deepEqual(snapshot, snapshotCopy)
    })
})

test("load full recovery source does not accept a prior request context or candidate scope", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/data/utils/player-data.ts"), "utf8")
    const loadBlock = source.split("export function getClientSerializedData(")[1]
    assert.match(loadBlock, /createAwakeRequestContext\(\{ playerId \}\)/)
    assert.doesNotMatch(loadBlock, /candidateCharacterIds/)
    assert.doesNotMatch(loadBlock, /options\.context|request\.context|previousContext/)
})
