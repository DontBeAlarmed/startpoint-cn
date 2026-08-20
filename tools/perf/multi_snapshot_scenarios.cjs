"use strict"

require("ts-node/register/transpile-only")

const { createHash } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const BetterSqlite3 = require("better-sqlite3")

const { closeDatabase, initializeDatabase } = require("../../src/data")
const { insertAccountSync } = require("../../src/data/domains/account")
const {
    getPlayerCharacterManaNodeAwakeLevelsSync,
    getPlayerCharacterSync,
    insertPlayerCharactersManaNodesSync,
    insertPlayerCharactersSync,
} = require("../../src/data/domains/character")
const {
    getPlayerEquipmentSync,
    insertPlayerEquipmentListSync,
} = require("../../src/data/domains/equipment")
const {
    getPlayerPartyGroupListSync,
    insertPlayerPartyGroupListSync,
} = require("../../src/data/domains/party")
const {
    getPlayerSync,
    insertDefaultPlayerSync,
    updatePlayerSync,
} = require("../../src/data/domains/player")
const { PartyCategory } = require("../../src/data/types")
const { buildPlayerSnapshot } = require("../../src/multi/snapshot/player-snapshot")
const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
const {
    installBundledGameplaySnapshot,
} = require("../helpers/install-bundled-gameplay-snapshot.cjs")

const VIEWER_ID = 101
const PLAYER_ID = 77

function signature(value) {
    return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function makeParty(name, characterIds, equipmentIds, category) {
    return {
        abilitySoulIds: equipmentIds.map(id => id + 100_000),
        category,
        characterIds: characterIds.slice(0, 3),
        edited: true,
        equipmentIds: equipmentIds.slice(0, 3),
        name,
        options: { allowOtherPlayersToHealMe: true },
        unisonCharacterIds: characterIds.slice(3, 6),
    }
}

function createScenarioFixture(repeated) {
    const characterSequence = Array.from({ length: 18 }, (_, index) => repeated ? 101001 : 101001 + index)
    const equipmentSequence = Array.from({ length: 9 }, (_, index) => repeated ? 501001 : 501001 + index)
    const currentParty = makeParty(
        "Current",
        characterSequence.slice(0, 6),
        equipmentSequence.slice(0, 3),
        PartyCategory.NORMAL,
    )
    const firstNpcParty = makeParty(
        "NPC Alpha",
        characterSequence.slice(6, 12),
        equipmentSequence.slice(3, 6),
        PartyCategory.NORMAL,
    )
    const secondNpcParty = makeParty(
        "NPC Beta",
        characterSequence.slice(12, 18),
        equipmentSequence.slice(6, 9),
        PartyCategory.EVENT,
    )
    const normalGroups = {
        1: {
            category: PartyCategory.NORMAL,
            colorId: 1,
            list: { 1: currentParty, 2: firstNpcParty },
        },
    }
    const eventGroups = {
        1: {
            category: PartyCategory.EVENT,
            colorId: 2,
            list: { 1: secondNpcParty },
        },
    }
    const characters = new Map(characterSequence.map((id, index) => [id, {
        evolutionLevel: index % 6,
        exBoost: index === 0 ? { abilityIdList: [11, 12], statusId: 7 } : null,
        exp: 1000 + index,
        overLimitStep: index % 5,
    }]))
    const equipments = new Map(equipmentSequence.map((id, index) => [id, {
        enhancementLevel: index % 5,
        level: index % 6,
    }]))
    const calls = {
        character: 0,
        equipment: 0,
        manaNode: 0,
        partyGroup: 0,
        playerContext: 0,
    }
    const player = {
        degreeId: 8,
        leaderCharacterId: characterSequence[0],
        name: repeated ? "Repeated" : "Unique",
        partySlot: 1,
        rankPoint: 9_999,
        role: 2,
        tutorialStep: 0,
    }
    const dependencies = {
        getCharacter: (_playerId, characterId) => {
            calls.character++
            return characters.get(characterId) ?? null
        },
        getEquipment: (_playerId, equipmentId) => {
            calls.equipment++
            return equipments.get(equipmentId) ?? null
        },
        getManaNodeAwakeLevels: (_playerId, characterId) => {
            calls.manaNode++
            return { [characterId + 200_000]: characterId % 3 }
        },
        getPartyGroups: (_playerId, category) => {
            calls.partyGroup++
            return category === PartyCategory.NORMAL ? normalGroups : eventGroups
        },
        getRankLevel: () => 42,
        resolvePlayerContext: async viewerId => {
            calls.playerContext++
            return viewerId === VIEWER_ID ? { player, playerId: PLAYER_ID } : null
        },
    }
    return { calls, dependencies }
}

function scenario(name, repeated) {
    return Object.freeze({
        name,
        async run() {
            const fixture = createScenarioFixture(repeated)
            const snapshot = await buildPlayerSnapshot(VIEWER_ID, 1, fixture.dependencies)
            if (!snapshot) throw new Error(`${name} produced no player snapshot`)
            return {
                calls: fixture.calls,
                outputSignature: signature(snapshot),
                sqlSelectStatements: 0,
            }
        },
    })
}

function playerCharacter(index) {
    const now = new Date("2024-08-14T12:00:00.000Z")
    return {
        bondTokenList: [],
        entryCount: 1,
        evolutionLevel: index % 6,
        exBoost: index === 0 ? { abilityIdList: [11, 12], statusId: 7 } : undefined,
        exp: 1_000 + index,
        joinTime: now,
        manaBoardIndex: 1,
        overLimitStep: index % 5,
        protection: false,
        stack: 0,
        updateTime: now,
    }
}

function createDatabaseFixture(repeated) {
    const characterSequence = Array.from(
        { length: 18 },
        (_, index) => repeated ? 101001 : 101001 + index,
    )
    const equipmentSequence = Array.from(
        { length: 9 },
        (_, index) => repeated ? 501001 : 501001 + index,
    )
    const normalGroups = {
        1: {
            category: PartyCategory.NORMAL,
            colorId: 1,
            list: {
                1: makeParty(
                    "Current",
                    characterSequence.slice(0, 6),
                    equipmentSequence.slice(0, 3),
                    PartyCategory.NORMAL,
                ),
                2: makeParty(
                    "NPC Alpha",
                    characterSequence.slice(6, 12),
                    equipmentSequence.slice(3, 6),
                    PartyCategory.NORMAL,
                ),
            },
        },
    }
    const eventGroups = {
        1: {
            category: PartyCategory.EVENT,
            colorId: 2,
            list: {
                1: makeParty(
                    "NPC Beta",
                    characterSequence.slice(12, 18),
                    equipmentSequence.slice(6, 9),
                    PartyCategory.EVENT,
                ),
            },
        },
    }
    const characterIds = [...new Set(characterSequence)]
    const equipmentIds = [...new Set(equipmentSequence)]
    return {
        characterSequence,
        characters: Object.fromEntries(characterIds.map((id, index) => [id, playerCharacter(index)])),
        equipments: Object.fromEntries(equipmentIds.map((id, index) => [id, {
            enhancementLevel: index % 5,
            level: index % 6,
            protection: false,
            stack: 1,
        }])),
        manaNodes: Object.fromEntries(characterIds.map(id => [id, [id + 200_000]])),
        partyGroups: { normalGroups, eventGroups },
    }
}

function sqliteScenario(name, repeated) {
    return Object.freeze({
        name,
        async run() {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-snapshot-baseline-"))
            const originalConsole = { error: console.error, log: console.log, warn: console.warn }
            const calls = {
                character: 0,
                equipment: 0,
                manaNode: 0,
                partyGroup: 0,
                playerContext: 0,
            }
            const measurement = { active: false, selectStatements: 0 }
            let restoreContent = () => {}
            let primaryError = null
            let result

            try {
                console.error = console.log = console.warn = () => {}
                restoreContent = installBundledGameplaySnapshot()
                initializeDatabase({
                    paths: resolveRuntimeDataPaths({ DATA_DIR: directory }),
                    databaseFactory: databasePath => new BetterSqlite3(databasePath, {
                        verbose: sql => {
                            if (measurement.active && /^\s*SELECT\b/i.test(String(sql))) {
                                measurement.selectStatements++
                            }
                        },
                    }),
                })
                const account = insertAccountSync({
                    appId: "wf_cn",
                    idpAlias: "",
                    idpCode: "snapshot-baseline",
                    idpId: `${name}-account`,
                    status: "normal",
                })
                const playerId = insertDefaultPlayerSync(account.id).id
                const fixture = createDatabaseFixture(repeated)
                const db = require("../../src/data/db").getDb()
                db.transaction(() => {
                    db.prepare("DELETE FROM players_parties WHERE player_id = ?").run(playerId)
                    db.prepare("DELETE FROM players_party_groups WHERE player_id = ?").run(playerId)
                    db.prepare("DELETE FROM players_characters_mana_nodes WHERE player_id = ?").run(playerId)
                    db.prepare("DELETE FROM players_characters_bond_tokens WHERE player_id = ?").run(playerId)
                    db.prepare("DELETE FROM players_characters WHERE player_id = ?").run(playerId)
                    db.prepare("DELETE FROM players_equipment WHERE player_id = ?").run(playerId)
                    insertPlayerCharactersSync(playerId, fixture.characters)
                    insertPlayerCharactersManaNodesSync(playerId, fixture.manaNodes)
                    insertPlayerEquipmentListSync(playerId, fixture.equipments)
                    insertPlayerPartyGroupListSync(playerId, fixture.partyGroups.normalGroups)
                    insertPlayerPartyGroupListSync(playerId, fixture.partyGroups.eventGroups)
                    updatePlayerSync({
                        degreeId: 8,
                        id: playerId,
                        leaderCharacterId: fixture.characterSequence[0],
                        name: repeated ? "Repeated" : "Unique",
                        partySlot: 1,
                        rankPoint: 9_999,
                        role: 2,
                        tutorialStep: 0,
                    })
                })()

                const dependencies = {
                    getCharacter: (id, characterId) => {
                        calls.character++
                        return getPlayerCharacterSync(id, characterId)
                    },
                    getEquipment: (id, equipmentId) => {
                        calls.equipment++
                        return getPlayerEquipmentSync(id, equipmentId)
                    },
                    getManaNodeAwakeLevels: (id, characterId) => {
                        calls.manaNode++
                        return getPlayerCharacterManaNodeAwakeLevelsSync(id, characterId)
                    },
                    getPartyGroups: (id, category) => {
                        calls.partyGroup++
                        return getPlayerPartyGroupListSync(id, category)
                    },
                    getRankLevel: () => 42,
                    resolvePlayerContext: async viewerId => {
                        calls.playerContext++
                        return viewerId === VIEWER_ID
                            ? { player: getPlayerSync(playerId), playerId }
                            : null
                    },
                }
                measurement.active = true
                const snapshot = await buildPlayerSnapshot(VIEWER_ID, 1, dependencies)
                measurement.active = false
                if (!snapshot) throw new Error(`${name} produced no player snapshot`)
                result = {
                    calls,
                    outputSignature: signature(snapshot),
                    sqlSelectStatements: measurement.selectStatements,
                }
            } catch (error) {
                primaryError = error
            }

            const cleanupErrors = []
            for (const cleanup of [
                () => closeDatabase(),
                () => restoreContent(),
                () => fs.rmSync(directory, { force: true, recursive: true }),
                () => Object.assign(console, originalConsole),
            ]) {
                try { cleanup() } catch (error) { cleanupErrors.push(error) }
            }
            if (primaryError) throw primaryError
            if (cleanupErrors.length === 1) throw cleanupErrors[0]
            if (cleanupErrors.length > 1) {
                throw new AggregateError(cleanupErrors, "snapshot baseline cleanup failed")
            }
            return result
        },
    })
}

const SCENARIOS = Object.freeze([
    scenario("full_unique", false),
    scenario("repeated_assets", true),
    sqliteScenario("sqlite_full_unique", false),
    sqliteScenario("sqlite_repeated_assets", true),
])

module.exports = { SCENARIOS }
